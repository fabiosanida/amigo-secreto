import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { isoCBOR } from '@simplewebauthn/server/helpers';
import handler from '../api/index.js';
import { hashToken, newToken } from '../lib/auth.js';
import { getPool, query } from '../lib/db.js';
import { hashPassword } from '../lib/passwords.js';

const sha256 = value => createHash('sha256').update(value).digest();

function testAuthenticator() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const key = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(32), id = credentialId.toString('base64url');
  const publicKeyCose = new Map([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(key.x, 'base64url')], [-3, Buffer.from(key.y, 'base64url')],
  ]);
  const clientData = (type, options, origin) => Buffer.from(JSON.stringify({ type, challenge: options.challenge, origin, crossOrigin: false }));
  const authenticatorData = (rpId, flags, counter = 0) => {
    const tail = Buffer.alloc(5);
    tail[0] = flags;
    tail.writeUInt32BE(counter, 1);
    return Buffer.concat([sha256(rpId), tail]);
  };

  return {
    register(options, origin) {
      const rawData = Buffer.concat([
        authenticatorData(options.rp.id, 0x45),
        Buffer.alloc(16), Buffer.from([0, credentialId.length]), credentialId, isoCBOR.encode(publicKeyCose),
      ]);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
        clientDataJSON: clientData('webauthn.create', options, origin).toString('base64url'),
        attestationObject: Buffer.from(isoCBOR.encode(new Map([
          ['fmt', 'none'], ['attStmt', new Map()], ['authData', rawData],
        ]))).toString('base64url'),
        transports: ['internal'],
      } };
    },
    authenticate(options, origin, userHandle, { counter = 1, verified = true } = {}) {
      const client = clientData('webauthn.get', options, origin);
      const rawData = authenticatorData(options.rpId, verified ? 0x05 : 0x01, counter);
      return { id, rawId: id, type: 'public-key', clientExtensionResults: {}, response: {
        clientDataJSON: client.toString('base64url'), authenticatorData: rawData.toString('base64url'),
        signature: sign('sha256', Buffer.concat([rawData, sha256(client)]), privateKey).toString('base64url'),
        userHandle,
      } };
    },
  };
}

test('passkeys enroll from a recent password session and sign in through one-use browser-bound challenges', {
  skip: process.env.RUN_DB_TESTS !== '1', timeout: 120000,
}, async t => {
  assert.match((await query('SELECT current_schema() AS name')).rows[0].name, /^as_test_/);
  const originalUrl = process.env.APP_URL, originalVercel = process.env.VERCEL;
  delete process.env.VERCEL;
  const server = createServer((req, res) => { void handler(req, res); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_URL = origin;
  const id = randomUUID(), otherId = randomUUID(), email = `passkey-${id}@example.test`;
  const password = 'Passkey fixture password 2026';
  const api = async (path, body, cookie, requestOrigin = origin) => {
    const response = await fetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', headers: {
      'Content-Type': 'application/json', Origin: requestOrigin, 'X-Forwarded-For': id, ...(cookie ? { Cookie: cookie } : {}),
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, data: await response.json(), cookies: response.headers.getSetCookie().map(value => value.split(';')[0]) };
  };
  const optionsPath = kind => `auth/passkeys/${kind}/options`;
  const verifyPath = kind => `auth/passkeys/${kind}/verify`;

  try {
    const passwordHash = await hashPassword(password);
    await query(`INSERT INTO as_users(id,email,first_name,last_name,password_hash) VALUES
      ($1,$2,'Pessoa','Teste',$3),($4,$5,'Outra','Pessoa',$3)`, [id, email, passwordHash, otherId, `passkey-${otherId}@example.test`]);
    const oldSession = newToken();
    await query("INSERT INTO as_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(oldSession), id]);

    const authenticator = testAuthenticator();
    let cookie, userHandle, flow, credential;
    await t.test('only the canonical origin and a recent password sign-in may enroll; verification owns the credential', async () => {
      assert.equal((await api(optionsPath('register'), {})).status, 401);
      assert.equal((await api(optionsPath('register'), {}, `as_session=${oldSession}`)).status, 403);
      assert.equal((await api(optionsPath('login'), {}, null, 'https://other.example.test')).status, 403);
      const login = await api('auth/login', { email, password });
      assert.equal(login.status, 200); assert.equal(login.data.offerPasskey, true);
      [cookie] = login.cookies;
      const registration = await api(optionsPath('register'), {}, cookie);
      assert.equal(registration.status, 200);
      assert.equal(registration.data.options.authenticatorSelection.userVerification, 'required');
      assert.equal(registration.data.options.authenticatorSelection.residentKey, 'required');
      userHandle = registration.data.options.user.id;
      const response = { challengeId: registration.data.challengeId, credential: authenticator.register(registration.data.options, origin) };
      assert.equal((await api(verifyPath('register'), response, `as_session=${oldSession}`)).data.error.code, 'PASSKEY_EXPIRED');
      assert.equal((await api(verifyPath('register'), { ...response, userId: otherId }, cookie)).status, 200);
      assert.equal((await api(verifyPath('register'), response, cookie)).data.error.code, 'PASSKEY_EXPIRED');
      assert.equal((await api(optionsPath('register'), {}, cookie)).data.error.code, 'PASSKEY_EXISTS');
      assert.equal((await api('auth/login', { email, password })).data.offerPasskey, false);
      assert.deepEqual((await query('SELECT user_id,transports FROM as_passkeys WHERE user_id=$1', [id])).rows,
        [{ user_id: id, transports: ['internal'] }]);
    });

    await t.test('discoverable login needs the same browser, a valid signature, user verification and the correct origin', async () => {
      flow = await api(optionsPath('login'), {});
      assert.equal(flow.status, 200);
      assert.equal(flow.data.options.userVerification, 'required');
      assert(!flow.data.options.allowCredentials?.length);
      credential = authenticator.authenticate(flow.data.options, origin, userHandle);
      const payload = { challengeId: flow.data.challengeId, credential };
      assert.equal((await api(verifyPath('login'), payload)).data.error.code, 'PASSKEY_EXPIRED');
      const authenticated = await api(verifyPath('login'), payload, flow.cookies[0]);
      assert.equal(authenticated.status, 200);
      assert.equal(authenticated.data.user.id, id);
      assert.equal((await api('session', undefined, authenticated.cookies[0])).data.user.id, id);
      assert.equal((await api(optionsPath('register'), {}, authenticated.cookies[0])).data.error.code, 'PASSWORD_LOGIN_REQUIRED');
      assert.equal((await api(verifyPath('login'), payload, flow.cookies[0])).data.error.code, 'PASSKEY_EXPIRED');

      for (const scenario of [
        { origin: 'https://other.example.test', handle: userHandle, verified: true },
        { origin, handle: userHandle, verified: false },
        { origin, handle: Buffer.from(otherId).toString('base64url'), verified: true },
      ]) {
        const next = await api(optionsPath('login'), {});
        const assertion = authenticator.authenticate(next.data.options, scenario.origin, scenario.handle, { counter: 2, verified: scenario.verified });
        const invalid = await api(verifyPath('login'), { challengeId: next.data.challengeId, credential: assertion }, next.cookies[0]);
        assert.equal(invalid.data.error.code, 'INVALID_PASSKEY');
        assert.deepEqual(invalid.cookies, []);
      }
    });

    await t.test('password recovery revokes the old passkey and allows a new enrollment', async () => {
      const resetToken = newToken();
      await query("INSERT INTO as_password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '1 hour')", [hashToken(resetToken), id]);
      const nextPassword = password + ' recovery';
      assert.equal((await api('auth/password/reset', { resetToken, password: nextPassword, passwordConfirm: nextPassword })).status, 200);
      const pending = await api(optionsPath('login'), {});
      const assertion = authenticator.authenticate(pending.data.options, origin, userHandle, { counter: 2 });
      assert.equal((await api(verifyPath('login'), { challengeId: pending.data.challengeId, credential: assertion }, pending.cookies[0])).data.error.code, 'INVALID_PASSKEY');
      assert.equal((await api('auth/login', { email, password: nextPassword })).data.offerPasskey, true);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    await query('DELETE FROM as_users WHERE id=ANY($1::uuid[])', [[id, otherId]]);
    if (originalUrl === undefined) delete process.env.APP_URL; else process.env.APP_URL = originalUrl;
    if (originalVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = originalVercel;
    await getPool().end();
  }
});
