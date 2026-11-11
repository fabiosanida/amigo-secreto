import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import handler from '../api/index.js';
import { getPool, query, transaction } from '../lib/db.js';
import { hashToken, newToken } from '../lib/auth.js';
import { hashPassword } from '../lib/passwords.js';

// All outbound calls are intercepted; these tests never deliver real messages.
test('password and invitation authentication: ownership, recovery, session revocation and races', {
  skip: process.env.RUN_DB_TESTS !== '1', timeout: 240000,
}, async t => {
  assert(process.env.DATABASE_URL && process.env.AUTH_SECRET, 'Configure a database with migrations applied before opting in.');
  const fixture = `password-${randomUUID()}`;
  const emails = [], userIds = [], groupIds = [], ips = new Set(), captured = [];
  const email = name => { const address = `${fixture}-${name}@example.test`; if (!emails.includes(address)) emails.push(address); return address; };
  const password = 'Senha de integração inicial 2026';
  const replacement = 'Outra senha de integração 2027';
  const savedEnv = Object.fromEntries(['APP_URL', 'VERCEL', 'NOTIFICATIONS_API_URL', 'NOTIFICATIONS_API_KEY'].map(key => [key, process.env[key]]));
  const originalFetch = globalThis.fetch;
  process.env.NOTIFICATIONS_API_URL = 'https://mail.integration.invalid';
  process.env.NOTIFICATIONS_API_KEY = 'fixture-only-mail-key';
  delete process.env.VERCEL;
  globalThis.fetch = async (url, options) => {
    assert.equal(String(url), 'https://mail.integration.invalid/api/v1/emails', 'No external network access is allowed in this suite');
    const body = JSON.parse(options.body);
    assert(emails.includes(body.to), 'Only test fixture recipients may reach the simulated mail provider');
    captured.push(body);
    return Response.json({ id: randomUUID(), status: 'sent', emailMessageId: randomUUID() });
  };
  const server = createServer((req, res) => { handler(req, res).catch(() => { res.statusCode = 500; res.end('{}'); }); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  process.env.APP_URL = origin;
  let requestNumber = 0;
  const api = async (path, { method = 'GET', body, cookie } = {}) => {
    const ip = `${fixture}-${++requestNumber}`; ips.add(ip);
    const response = await originalFetch(`${origin}/api/${path}`, { method,
      headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-For': ip, ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const post = (path, body, cookie) => api(path, { method: 'POST', body, cookie });
  const lastMail = address => captured.filter(message => message.to === address).at(-1);
  const codeOf = address => lastMail(address)?.text.match(/\b(\d{6})\b/)?.[1];
  const inviteOf = address => lastMail(address)?.text.match(/#invitation\?token=([A-Za-z0-9_-]{43})/)?.[1];
  const register = (address, overrides = {}) => post('auth/register', { email: address, firstName: 'Teste', lastName: fixture, password, passwordConfirm: password, ...overrides });
  const signIn = (address, secret = password) => post('auth/login', { email: address, password: secret });
  const seedUser = async (name, encodedPassword) => {
    const id = randomUUID(), address = email(name); userIds.push(id);
    await query('INSERT INTO as_users(id,email,first_name,last_name,password_hash) VALUES($1,$2,$3,$4,$5)', [id, address, 'Teste', fixture, encodedPassword]);
    return { id, email: address };
  };
  const requestReset = address => post('auth/password/request', { email: address });
  const verifyReset = async address => {
    const requested = await requestReset(address);
    assert.equal(requested.status, 200); assert(codeOf(address));
    return { requested, verified: await post('auth/password/verify', { challengeId: requested.data.challengeId, code: codeOf(address) }) };
  };
  const grant = async address => {
    const { verified } = await verifyReset(address);
    assert.equal(verified.status, 200); assert(verified.data.resetToken); assert(!verified.cookie);
    return verified.data.resetToken;
  };
  try {
    const encoded = await hashPassword(password);
    const owner = await seedUser('owner', encoded), invitedExisting = await seedUser('existing', encoded), outsider = await seedUser('outsider', encoded);
    const ownerLogin = await signIn(owner.email), invitedLogin = await signIn(invitedExisting.email), outsiderLogin = await signIn(outsider.email);
    assert.equal(ownerLogin.status, 200); assert.equal(invitedLogin.status, 200); assert.equal(outsiderLogin.status, 200);
    const future = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    const created = await post('groups', { name: fixture, date: future, budget: 20 }, ownerLogin.cookie);
    assert.equal(created.status, 201); const groupId = created.data.group.id; groupIds.push(groupId);
    const invitedNew = email('invited-new'), invitedRace = email('invited-race'), invitedUnrelated = email('invited-unrelated');
    const batch = await post(`groups/${groupId}/invites`, { emails: [invitedNew, invitedExisting.email, invitedRace, invitedUnrelated] }, ownerLogin.cookie);
    assert.equal(batch.status, 200);
    const newInvite = inviteOf(invitedNew), raceInvite = inviteOf(invitedRace), existingInvite = inviteOf(invitedExisting.email);
    assert(newInvite && raceInvite && existingInvite);
    let newUser;

    await t.test('valid invitation proves only its recipient email; exact-match signup creates a session without another email', async () => {
      const page = await api(`invitations/${newInvite}`);
      assert.equal(page.status, 200); assert.equal(page.data.recipientEmail, invitedNew); assert.equal(page.data.accountExists, false);
      const availability = await post('auth/account', { email: invitedNew.toUpperCase(), inviteToken: newInvite });
      assert.equal(availability.data.emailVerified, true); assert.equal(availability.data.exists, false);
      const different = await post('auth/account', { email: email('different'), inviteToken: newInvite });
      assert.equal(different.data.emailVerified, false);
      const before = captured.length;
      const signup = await register(invitedNew.toUpperCase(), { inviteToken: newInvite });
      assert.equal(signup.status, 200); assert.equal(signup.data.emailVerified, true); assert(signup.cookie);
      assert.equal(signup.data.user.email, invitedNew); assert.equal(captured.length, before, 'Invitation signup skips the redundant verification email');
      newUser = { ...signup.data.user, cookie: signup.cookie }; userIds.push(newUser.id);
      assert.equal((await api('session', { cookie: signup.cookie })).data.user.id, newUser.id);
      assert.notEqual((await query('SELECT status FROM as_memberships WHERE group_id=$1 AND email=$2', [groupId, invitedNew])).rows[0].status, 'accepted', 'Account creation does not silently accept membership');
    });

    await t.test('existing account cannot be replaced or signed in through its invitation', async () => {
      const before = captured.length;
      const duplicate = await register(invitedExisting.email, { password: replacement, passwordConfirm: replacement, inviteToken: existingInvite });
      assert.equal(duplicate.status, 409); assert.equal(duplicate.data.error.code, 'ACCOUNT_EXISTS'); assert(!duplicate.cookie);
      assert.equal(captured.length, before);
      assert.equal((await signIn(invitedExisting.email, replacement)).status, 401);
      assert.equal((await signIn(invitedExisting.email)).status, 200);
      assert.equal((await post('auth/account', { email: invitedExisting.email })).data.exists, true);
    });

    await t.test('two invited signups cannot overwrite one another or create two sessions', async () => {
      const before = captured.length;
      const replies = await Promise.all([password, replacement].map(secret => register(invitedRace, { inviteToken: raceInvite, password: secret, passwordConfirm: secret })));
      assert.equal(replies.filter(reply => reply.status === 200).length, 1);
      assert(replies.some(reply => [409, 429].includes(reply.status)), 'Concurrent duplicate is rejected or rate limited');
      assert.equal(replies.filter(reply => reply.cookie).length, 1);
      assert.equal(captured.length, before);
      const winningIndex = replies.findIndex(reply => reply.status === 200);
      userIds.push(replies[winningIndex].data.user.id);
      assert.equal((await signIn(invitedRace, [password, replacement][winningIndex])).status, 200);
      assert.equal((await signIn(invitedRace, [replacement, password][winningIndex])).status, 401);
    });

    await t.test('different email follows normal OTP signup and no existing account can be captured by a raced pending signup', async () => {
      const address = email('otp-signup');
      const requested = await register(address, { inviteToken: newInvite });
      assert.equal(requested.status, 200); assert(requested.data.challengeId); assert(!requested.cookie);
      const code = codeOf(address); assert(code);
      assert.equal((await query('SELECT count(*) FROM as_users WHERE email=$1', [address])).rows[0].count, '0');
      const verified = await post('auth/verify', { challengeId: requested.data.challengeId, code });
      assert.equal(verified.status, 200); userIds.push(verified.data.user.id);
      assert.equal((await signIn(address)).status, 200);
      assert.equal((await post('auth/verify', { challengeId: requested.data.challengeId, code })).status, 401);
      const racedEmail = email('pending-race');
      const pending = await register(racedEmail); assert.equal(pending.status, 200);
      const racedId = randomUUID(); userIds.push(racedId);
      await query('INSERT INTO as_users(id,email,first_name,last_name,password_hash) VALUES($1,$2,$3,$4,$5)', [racedId, racedEmail, 'Existing', fixture, await hashPassword(replacement)]);
      const racedProof = await post('auth/verify', { challengeId: pending.data.challengeId, code: codeOf(racedEmail) });
      assert(racedProof.status >= 400); assert(!racedProof.cookie);
      assert.equal((await signIn(racedEmail, replacement)).status, 200);
      assert.equal((await signIn(racedEmail, password)).status, 401);
    });

    await t.test('expired, revoked and closed invitations cannot verify a new account', async () => {
      const scenarios = ['expired', 'revoked', 'closed'];
      for (const scenario of scenarios) {
        const address = email(`invite-${scenario}`), token = newToken(), membershipId = randomUUID();
        await query(`INSERT INTO as_memberships(id,group_id,email,invite_token_hash,invite_expires_at) VALUES($1,$2,$3,$4,now()+interval '1 hour')`, [membershipId, groupId, address, hashToken(token)]);
        if (scenario === 'expired') await query("UPDATE as_memberships SET invite_expires_at=now()-interval '1 second' WHERE id=$1", [membershipId]);
        if (scenario === 'revoked') await query('UPDATE as_memberships SET invite_token_hash=NULL WHERE id=$1', [membershipId]);
        if (scenario === 'closed') await query('UPDATE as_groups SET drawn_at=now() WHERE id=$1', [groupId]);
        const response = await register(address, { inviteToken: token });
        assert(!response.cookie); assert(!response.data.user, `${scenario} invitation must not grant immediate identity`);
        if (response.status === 200) assert(response.data.challengeId, 'If signup continues it must require separate mailbox verification');
        if (scenario === 'closed') await query('UPDATE as_groups SET drawn_at=NULL WHERE id=$1', [groupId]);
      }
    });

    await t.test('invitation landing identifies the signed-in account and accepts its own eligible membership only', async () => {
      const loggedOut = await api(`invitations/${newInvite}`);
      assert(!loggedOut.data.currentUserInvited);
      const uninvited = await api(`invitations/${newInvite}`, { cookie: outsiderLogin.cookie });
      assert.equal(uninvited.data.currentUserInvited, false);
      assert.equal(uninvited.data.currentUserEmail, outsider.email);
      const blocked = await post(`invitations/${newInvite}/accept`, {}, outsiderLogin.cookie);
      assert([403, 409].includes(blocked.status));
      const otherInvite = await api(`invitations/${newInvite}`, { cookie: invitedLogin.cookie });
      assert.equal(otherInvite.data.currentUserInvited, true);
      assert.equal(otherInvite.data.currentUserEmail, invitedExisting.email);
      assert.equal((await post(`invitations/${newInvite}/accept`, {}, invitedLogin.cookie)).status, 200);
      const memberships = (await query('SELECT email,status,user_id FROM as_memberships WHERE group_id=$1 AND email=ANY($2::text[])', [groupId, [invitedExisting.email, invitedNew]])).rows;
      assert.equal(memberships.find(member => member.email === invitedExisting.email).user_id, invitedExisting.id);
      assert.notEqual(memberships.find(member => member.email === invitedNew).status, 'accepted', 'Another invited account cannot claim the token recipient');
      assert.equal((await post(`invitations/${newInvite}/accept`, {}, newUser.cookie)).status, 200);
      assert.equal((await api(`invitations/${newInvite}`, { cookie: newUser.cookie })).data.currentUserAccepted, true);
    });

    await t.test('unknown and wrong credentials never create sessions; legacy OTP login no longer bypasses passwords', async () => {
      const wrong = await signIn(owner.email, replacement), unknown = await signIn(email('missing'));
      assert.equal(wrong.status, 401); assert.equal(unknown.status, 401);
      assert.equal(wrong.data.error.code, unknown.data.error.code);
      assert(!wrong.cookie && !unknown.cookie);
      const before = captured.length;
      const legacy = await post('auth/request', { email: owner.email });
      assert(legacy.status >= 400); assert(!legacy.cookie); assert.equal(captured.length, before);
    });

    await t.test('recovery proof is scoped, one-use, and does not log in before setting a password', async () => {
      const address = email('reset-scope'), person = await seedUser('reset-scope', encoded);
      const current = await signIn(address);
      const requested = await requestReset(address); assert.equal(requested.status, 200);
      const code = codeOf(address); assert(code);
      const signupBypass = await post('auth/verify', { challengeId: requested.data.challengeId, code });
      assert.equal(signupBypass.status, 401); assert(!signupBypass.cookie);
      const verified = await post('auth/password/verify', { challengeId: requested.data.challengeId, code });
      assert.equal(verified.status, 200); assert(!verified.cookie);
      assert.equal((await api('session')).data.user, null);
      assert.equal((await post('auth/password/verify', { challengeId: requested.data.challengeId, code })).status, 401);
      const token = verified.data.resetToken; assert(token);
      const badConfirm = await post('auth/password/reset', { resetToken: token, password: replacement, passwordConfirm: password });
      assert.equal(badConfirm.status, 400);
      assert.equal((await api('session', { cookie: current.cookie })).data.user.id, person.id, 'Validation failure must not revoke valid sessions');
      const changes = await Promise.all([1, 2].map(() => post('auth/password/reset', { resetToken: token, password: replacement, passwordConfirm: replacement })));
      assert.deepEqual(changes.map(change => change.status).sort(), [200, 401]);
      assert.equal((await api('session', { cookie: current.cookie })).data.user, null);
      assert.equal((await signIn(address, password)).status, 401);
      assert.equal((await signIn(address, replacement)).status, 200);
      assert.equal((await post('auth/password/reset', { resetToken: token, password, passwordConfirm: password })).status, 401);
    });

    await t.test('signup verification cannot become a password reset grant', async () => {
      const address = email('signup-scope'), pending = await register(address);
      assert.equal(pending.status, 200);
      const bypass = await post('auth/password/verify', { challengeId: pending.data.challengeId, code: codeOf(address) });
      assert.equal(bypass.status, 401); assert(!bypass.data.resetToken);
      const legitimate = await post('auth/verify', { challengeId: pending.data.challengeId, code: codeOf(address) });
      assert.equal(legitimate.status, 200); userIds.push(legitimate.data.user.id);
    });

    await t.test('unknown recovery requests do not disclose account existence or send email', async () => {
      const address = email('missing-recovery'), before = captured.length;
      const response = await requestReset(address);
      assert.equal(response.status, 200); assert(response.data.challengeId); assert.equal(response.data.email, address);
      assert.equal(captured.length, before);
      assert.equal((await post('auth/password/verify', { challengeId: response.data.challengeId, code: '123456' })).status, 401);
    });

    await t.test('recovery enforces expiry, attempt limits and reset-grant expiry', async () => {
      const locked = await seedUser('reset-locked', encoded), expired = await seedUser('reset-expired', encoded), grantExpired = await seedUser('grant-expired', encoded);
      const pending = await requestReset(locked.email), correct = codeOf(locked.email), wrong = correct === '000000' ? '000001' : '000000';
      for (let attempt = 0; attempt < 5; attempt++) assert.equal((await post('auth/password/verify', { challengeId: pending.data.challengeId, code: wrong })).status, 401);
      assert.equal((await post('auth/password/verify', { challengeId: pending.data.challengeId, code: correct })).status, 401);
      const expiring = await requestReset(expired.email);
      await query("UPDATE as_auth_challenges SET expires_at=now()-interval '1 second' WHERE id=$1", [expiring.data.challengeId]);
      assert.equal((await post('auth/password/verify', { challengeId: expiring.data.challengeId, code: codeOf(expired.email) })).data.error.code, 'EXPIRED_CODE');
      const token = await grant(grantExpired.email);
      await query("UPDATE as_password_resets SET expires_at=now()-interval '1 second' WHERE token_hash=$1", [hashToken(token)]);
      assert.equal((await post('auth/password/reset', { resetToken: token, password: replacement, passwordConfirm: replacement })).data.error.code, 'RESET_EXPIRED');
      assert.equal((await signIn(grantExpired.email)).status, 200);
    });

    await t.test('existing passwordless accounts can set their first password through recovery', async () => {
      const legacy = await seedUser('legacy-no-password', null);
      const before = await signIn(legacy.email); assert.equal(before.status, 409); assert.equal(before.data.error.code, 'PASSWORD_SETUP_REQUIRED'); assert(!before.cookie);
      const token = await grant(legacy.email);
      assert.equal((await post('auth/password/reset', { resetToken: token, password, passwordConfirm: password })).status, 200);
      const signedIn = await signIn(legacy.email); assert.equal(signedIn.status, 200); assert.equal(signedIn.data.user.id, legacy.id);
    });
  } finally {
    await new Promise(resolve => server.close(resolve));
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(savedEnv)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    // Delete only fixture-owned records; no real accounts, groups or credentials are touched.
    const scopes = ['auth-request-ip', 'auth-verify-ip', 'public-invitations', 'auth-register-ip', 'auth-login-ip', 'auth-login-email', 'auth-account-ip', 'auth-account-email', 'auth-reset-ip', 'auth-reset-email', 'auth-reset-verify-ip', 'auth-reset-complete-ip', 'auth-request-email', 'auth-cooldown', 'auth-register-email', 'password-request-ip', 'password-request-email', 'password-verify-ip', 'password-reset-ip', 'password-cooldown', 'auth-signup-ip', 'auth-signup-email', 'auth-signup-cooldown', 'password-reset-ip', 'password-reset-email', 'password-reset-cooldown', 'password-reset-verify-ip', 'password-reset-finish-ip', 'create-group', 'invite-people'];
    const subjects = [...ips, ...emails, ...userIds];
    const rateKeys = subjects.flatMap(subject => scopes.map(scope => createHmac('sha256', process.env.AUTH_SECRET).update(`${scope}:${subject}`).digest('hex')));
    await transaction(async client => {
      await client.query('DELETE FROM as_draw_results WHERE group_id=ANY($1::uuid[])', [groupIds]);
      await client.query('DELETE FROM as_groups WHERE id=ANY($1::uuid[])', [groupIds]);
      await client.query('DELETE FROM as_auth_challenges WHERE email=ANY($1::text[])', [emails]);
      await client.query('DELETE FROM as_password_resets WHERE user_id IN (SELECT id FROM as_users WHERE email=ANY($1::text[]))', [emails]);
      await client.query('DELETE FROM as_users WHERE email=ANY($1::text[])', [emails]);
      await client.query('DELETE FROM as_rate_limits WHERE key=ANY($1::text[])', [rateKeys]);
    });
    await getPool().end();
  }
});
