import { randomUUID } from 'node:crypto';
import { generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server';
import { clientIP, hashToken, issueSession, newToken, rateLimit, readSessionToken, sessionCookie, sessionUser } from './auth.js';
import { ApiError, query, transaction } from './db.js';
import { passkeySite } from './passkey-site.js';
import { publicUser } from './profile.js';

const FLOW_COOKIE = 'as_passkey_login';
const TTL_SECONDS = 300;
const validId = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validCredentialId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,1366}$/.test(value);
const invalidPasskey = () => new ApiError(400, 'INVALID_PASSKEY', 'Não foi possível confirmar a chave de acesso. Tente novamente.');
const expired = () => new ApiError(400, 'PASSKEY_EXPIRED', 'O pedido expirou. Tente novamente.');
const recentLogin = () => new ApiError(403, 'PASSWORD_LOGIN_REQUIRED', 'Entre novamente com sua senha para cadastrar uma chave de acesso.');
const transports = new Set(['ble', 'cable', 'hybrid', 'internal', 'nfc', 'smart-card', 'usb']);

function requireSite(req) {
  const site = passkeySite(req);
  if (!site) throw new ApiError(403, 'PASSKEY_ORIGIN', 'Use o endereço oficial do Amigo Secreto para continuar com a chave de acesso.');
  return site;
}

function flowCookie(token, site, maxAge = TTL_SECONDS) {
  return `${FLOW_COOKIE}=${token}; Path=/api/auth/passkeys; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${site.secure ? '; Secure' : ''}`;
}
function readFlowToken(req) {
  const token = String(req.headers.cookie || '').split(';').map(part => part.trim())
    .find(part => part.startsWith(`${FLOW_COOKIE}=`))?.slice(FLOW_COOKIE.length + 1);
  return /^[A-Za-z0-9_-]{43}$/.test(token || '') ? token : null;
}

async function issueChallenge(purpose, challenge, binding) {
  const id = randomUUID();
  await query(`WITH expired AS (
      DELETE FROM as_passkey_challenges WHERE id IN (
        SELECT id FROM as_passkey_challenges WHERE expires_at<=now() ORDER BY expires_at LIMIT 100
      )
    ) INSERT INTO as_passkey_challenges(id,purpose,challenge,binding_hash,expires_at)
    VALUES ($1,$2,$3,$4,now()+$5::int*interval '1 second')`,
  [id, purpose, challenge, hashToken(binding), TTL_SECONDS]);
  return id;
}

async function consumeChallenge(body, purpose, binding) {
  if (!binding || !validId(body.challengeId)) throw expired();
  const result = await query(`DELETE FROM as_passkey_challenges
    WHERE id=$1 AND purpose=$2 AND binding_hash=$3 AND expires_at>now() RETURNING challenge`,
  [body.challengeId, purpose, hashToken(binding)]);
  if (!result.rows[0]) throw expired();
  return result.rows[0].challenge;
}

async function requireRecentPassword(client, userId, token, lock = false) {
  const probe = await client.query(`SELECT 1 FROM as_sessions
    WHERE token_hash=$1 AND user_id=$2 AND expires_at>now()
      AND password_verified_at>now()-interval '15 minutes' ${lock ? 'FOR KEY SHARE' : ''}`, [hashToken(token), userId]);
  if (!probe.rows.length) throw recentLogin();
}

function credentialResponse(body) {
  const response = body.credential;
  if (!validCredentialId(response?.id) || response.rawId !== response.id || response.type !== 'public-key' || !response.response) throw invalidPasskey();
  return response;
}

export async function beginPasskeyRegistration(req) {
  const site = requireSite(req);
  const user = await sessionUser(req, true, { includeAvatar: false });
  const token = readSessionToken(req);
  await rateLimit('passkey-register-user', user.id, 15, 900);
  await requireRecentPassword({ query }, user.id, token);
  const { rows } = await query('SELECT id,transports FROM as_passkeys WHERE user_id=$1 AND rp_id=$2', [user.id, site.rpID]);
  if (rows.length) throw new ApiError(409, 'PASSKEY_EXISTS', 'Sua conta já tem uma chave de acesso cadastrada.');
  const options = await generateRegistrationOptions({
    rpName: 'Amigo Secreto', rpID: site.rpID, userID: Buffer.from(user.id), userName: user.email,
    userDisplayName: `${user.firstName} ${user.lastName}`, attestationType: 'none',
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }, timeout: 120000,
  });
  return { options, challengeId: await issueChallenge('register', options.challenge, token) };
}

export async function finishPasskeyRegistration(body, req) {
  const site = requireSite(req);
  const user = await sessionUser(req, true, { includeAvatar: false });
  const token = readSessionToken(req);
  await rateLimit('passkey-register-verify-user', user.id, 20, 900);
  const response = credentialResponse(body), challenge = await consumeChallenge(body, 'register', token);
  let result;
  try {
    result = await verifyRegistrationResponse({ response, expectedChallenge: challenge,
      expectedOrigin: site.origin, expectedRPID: site.rpID, requireUserVerification: true });
  } catch { throw invalidPasskey(); }
  if (!result.verified) throw invalidPasskey();
  const { id, publicKey, counter } = result.registrationInfo.credential;
  const reported = response.response.transports;
  const allowedTransports = Array.isArray(reported) ? [...new Set(reported.filter(value => transports.has(value)))] : [];
  await transaction(async client => {
    const account = await client.query('SELECT id FROM as_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [user.id]);
    if (!account.rows.length) throw recentLogin();
    await requireRecentPassword(client, user.id, token, true);
    const saved = await client.query(`INSERT INTO as_passkeys (id,rp_id,user_id,public_key,counter,transports)
      SELECT $1,$2,$3,$4,$5,$6
      WHERE NOT EXISTS (SELECT 1 FROM as_passkeys WHERE user_id=$3 AND rp_id=$2)
      ON CONFLICT DO NOTHING RETURNING id`,
    [id, site.rpID, user.id, Buffer.from(publicKey), counter, allowedTransports]);
    if (!saved.rows.length) throw new ApiError(409, 'PASSKEY_EXISTS', 'Já existe uma chave cadastrada. Use sua chave de acesso ou entre com senha.');
  });
  return { ok: true };
}

export async function beginPasskeyLogin(req, res) {
  const site = requireSite(req);
  await rateLimit('passkey-login-ip', clientIP(req), 40, 900);
  const binding = newToken();
  const options = await generateAuthenticationOptions({ rpID: site.rpID, userVerification: 'required', timeout: 120000 });
  const challengeId = await issueChallenge('login', options.challenge, binding);
  res.setHeader('Set-Cookie', flowCookie(binding, site));
  return { options, challengeId };
}

export async function finishPasskeyLogin(body, req, res) {
  const site = requireSite(req);
  await rateLimit('passkey-login-verify-ip', clientIP(req), 60, 900);
  const response = credentialResponse(body);
  const challenge = await consumeChallenge(body, 'login', readFlowToken(req));
  const session = newToken();
  const user = await transaction(async client => {
    const hint = (await client.query('SELECT user_id FROM as_passkeys WHERE rp_id=$1 AND id=$2', [site.rpID, response.id])).rows[0];
    if (!hint) throw invalidPasskey();
    // Use the same user-first lock as password recovery and account deletion.
    const account = (await client.query(`SELECT id,email,first_name,last_name,avatar FROM as_users
      WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [hint.user_id])).rows[0];
    if (!account || response.response.userHandle !== Buffer.from(account.id).toString('base64url')) throw invalidPasskey();
    const passkey = (await client.query(`SELECT public_key,counter,transports FROM as_passkeys
      WHERE rp_id=$1 AND id=$2 AND user_id=$3`, [site.rpID, response.id, account.id])).rows[0];
    if (!passkey) throw invalidPasskey();
    let result;
    try {
      result = await verifyAuthenticationResponse({ response, expectedChallenge: challenge, expectedOrigin: site.origin,
        expectedRPID: site.rpID, requireUserVerification: true,
        credential: { id: response.id, publicKey: new Uint8Array(passkey.public_key), counter: Number(passkey.counter), transports: passkey.transports } });
    } catch { throw invalidPasskey(); }
    if (!result.verified) throw invalidPasskey();
    await client.query('UPDATE as_passkeys SET counter=$3,last_used_at=now() WHERE rp_id=$1 AND id=$2',
      [site.rpID, response.id, result.authenticationInfo.newCounter]);
    await issueSession(client, account.id, session);
    return publicUser(account);
  });
  res.setHeader('Set-Cookie', [sessionCookie(session), flowCookie('', site, 0)]);
  return { user };
}
