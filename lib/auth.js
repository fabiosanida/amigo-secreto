import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, query, transaction } from './db.js';
import { normalizeName, publicUser, sanitizeAvatar } from './profile.js';
import { sendNotification } from './mail.js';

export const SESSION_COOKIE = 'as_session';
export const OTP_TTL_MS = 10 * 60 * 1000;
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
function authSecret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) throw new ApiError(503, 'UNAVAILABLE', 'O acesso está temporariamente indisponível.');
  return value;
}
export const hashToken = value => createHash('sha256').update(String(value)).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
export function sealSecret(value) {
  const nonce = randomBytes(12), key = createHash('sha256').update(`sealed:${authSecret()}`).digest();
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64url');
}
export function unsealSecret(value) {
  if (!value) return null;
  try {
    const buffer = Buffer.from(value, 'base64url'), key = createHash('sha256').update(`sealed:${authSecret()}`).digest();
    const decipher = createDecipheriv('aes-256-gcm', key, buffer.subarray(0, 12));
    decipher.setAuthTag(buffer.subarray(12, 28));
    return Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8');
  } catch { return null; }
}
export const hashCode = (challengeId, code) => createHmac('sha256', authSecret()).update(`otp:${challengeId}:${code}`).digest('hex');
export function verifyCode(challengeId, code, digest) {
  if (!/^\d{6}$/.test(String(code)) || !/^[a-f0-9]{64}$/.test(String(digest))) return false;
  return timingSafeEqual(Buffer.from(hashCode(challengeId, code), 'hex'), Buffer.from(digest, 'hex'));
}
export function challengeIsUsable(challenge, now = Date.now()) {
  return Boolean(challenge && !challenge.used_at && Number(challenge.attempts) < 5 && new Date(challenge.expires_at).getTime() > now);
}
export function normalizeEmail(value) {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_EMAIL', 'Informe um e-mail válido.');
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@<>\u0000-\u001f]+@[^\s@<>\u0000-\u001f]+\.[^\s@<>\u0000-\u001f]+$/.test(email)) throw new ApiError(400, 'INVALID_EMAIL', 'Informe um e-mail válido.');
  return email;
}
export function clientIP(req) {
  const header = req.headers['x-vercel-forwarded-for'] || req.headers['x-forwarded-for'];
  return String(Array.isArray(header) ? header[0] : header || req.socket?.remoteAddress || 'unknown').split(',')[0].trim().slice(0, 80);
}
export async function rateLimit(scope, subject, max, windowSeconds) {
  const key = createHmac('sha256', authSecret()).update(`${scope}:${subject}`).digest('hex');
  const { rows } = await query(`INSERT INTO as_rate_limits(key,count,reset_at) VALUES($1,1,now()+$2::integer*interval '1 second')
    ON CONFLICT(key) DO UPDATE SET count=CASE WHEN as_rate_limits.reset_at<=now() THEN 1 ELSE as_rate_limits.count+1 END,
    reset_at=CASE WHEN as_rate_limits.reset_at<=now() THEN now()+$2::integer*interval '1 second' ELSE as_rate_limits.reset_at END
    RETURNING count,reset_at`, [key, windowSeconds]);
  if (rows[0].count > max) {
    const error = new ApiError(429, 'RATE_LIMITED', 'Aguarde um pouco antes de tentar novamente.');
    error.retryAfter = Math.max(1, Math.ceil((new Date(rows[0].reset_at).getTime() - Date.now()) / 1000));
    throw error;
  }
}
export async function requestAuthentication(body, req) {
  const email = normalizeEmail(body.email);
  const signup = body.firstName !== undefined || body.lastName !== undefined;
  const firstName = signup ? normalizeName(body.firstName, 'seu nome', 80) : null;
  const lastName = signup ? normalizeName(body.lastName, 'seu sobrenome', 120) : null;
  await rateLimit('auth-request-ip', clientIP(req), 20, 3600);
  await rateLimit('auth-request-email', email, 10, 3600);
  await rateLimit('auth-cooldown', email, 1, 60);
  const existing = (await query('SELECT id,email,first_name,last_name,avatar FROM as_users WHERE email=$1', [email])).rows[0];
  const pending = !signup ? (await query("SELECT first_name,last_name,avatar,invite_token_cipher FROM as_auth_challenges WHERE email=$1 AND created_at>now()-interval '24 hours' ORDER BY created_at DESC LIMIT 1", [email])).rows[0] : null;
  const avatar = signup && !existing ? await sanitizeAvatar(body.avatar) : pending?.avatar || null;
  const profile = existing || { first_name: firstName || pending?.first_name, last_name: lastName || pending?.last_name, avatar };
  const candidateInvite = typeof body.inviteToken === 'string' ? body.inviteToken : unsealSecret(pending?.invite_token_cipher);
  const invitation = candidateInvite && /^[A-Za-z0-9_-]{43}$/.test(candidateInvite) ? (await query('SELECT id FROM as_memberships WHERE invite_token_hash=$1 AND email=$2 AND invite_expires_at>now()', [hashToken(candidateInvite), email])).rows[0] : null;
  const inviteToken = invitation ? candidateInvite : undefined;
  const challengeId = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0'), token = newToken();
  await transaction(async client => {
    await client.query('UPDATE as_auth_challenges SET used_at=now() WHERE email=$1 AND used_at IS NULL', [email]);
    await client.query(`INSERT INTO as_auth_challenges(id,email,user_id,first_name,last_name,avatar,code_hash,token_hash,expires_at,invite_token_cipher)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [challengeId, email, existing?.id || null, profile.first_name || null, profile.last_name || null, profile.avatar || null, hashCode(challengeId, code), hashToken(token), new Date(Date.now() + OTP_TTL_MS), inviteToken ? sealSecret(inviteToken) : null]);
  });
  // Even an unknown address receives the verification flow. Account existence is
  // disclosed only after proof of mailbox ownership, never by the request endpoint.
  {
    try {
      await sendNotification({ kind: 'verify', to: email, user: { firstName: profile.first_name || 'amigo', lastName: profile.last_name || '', email }, code, token, inviteToken, idempotencyKey: `verify:${challengeId}` });
    } catch {
      await query('UPDATE as_auth_challenges SET used_at=now() WHERE id=$1', [challengeId]);
      throw new ApiError(503, 'EMAIL_UNAVAILABLE', 'Não conseguimos enviar o código agora. Tente novamente em instantes.');
    }
  }
  return { challengeId, email, resendAfter: 60 };
}
export async function verifyAuthentication(body, req, res) {
  await rateLimit('auth-verify-ip', clientIP(req), 40, 900);
  const usingToken = typeof body.token === 'string' && body.token.length >= 32 && body.token.length <= 128;
  const validId = typeof body.challengeId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.challengeId);
  if (!usingToken && !validId) throw new ApiError(401, 'INVALID_CODE', 'O código não confere. Confira e tente novamente.');
  const sessionToken = newToken();
  const result = await transaction(async client => {
    const { rows } = await client.query(`SELECT id,email,user_id,first_name,last_name,avatar,code_hash,expires_at,attempts,used_at
      FROM as_auth_challenges WHERE ${usingToken ? 'token_hash=$1' : 'id=$1'} FOR UPDATE`, [usingToken ? hashToken(body.token) : body.challengeId]);
    const challenge = rows[0];
    if (!challengeIsUsable(challenge)) return { error: challenge && new Date(challenge.expires_at).getTime() <= Date.now() ? 'EXPIRED_CODE' : 'INVALID_CODE' };
    if (!usingToken && !verifyCode(challenge.id, body.code, challenge.code_hash)) {
      await client.query('UPDATE as_auth_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]);
      return { error: 'INVALID_CODE' };
    }
    let user = (await client.query('SELECT id,email,first_name,last_name,avatar FROM as_users WHERE email=$1', [challenge.email])).rows[0];
    if (!user) {
      if (!challenge.first_name || !challenge.last_name) {
        await client.query('UPDATE as_auth_challenges SET used_at=now() WHERE id=$1', [challenge.id]);
        return { error: 'ACCOUNT_NOT_FOUND' };
      }
      const inserted = await client.query(`INSERT INTO as_users(id,email,first_name,last_name,avatar) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(email) DO UPDATE SET email=EXCLUDED.email RETURNING id,email,first_name,last_name,avatar`, [randomUUID(), challenge.email, challenge.first_name, challenge.last_name, challenge.avatar]);
      user = inserted.rows[0];
    }
    await client.query('UPDATE as_auth_challenges SET used_at=now() WHERE id=$1', [challenge.id]);
    await client.query("INSERT INTO as_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [hashToken(sessionToken), user.id]);
    return { user: publicUser(user) };
  });
  if (result.error) throw new ApiError(401, result.error, result.error === 'EXPIRED_CODE' ? 'Esse código expirou. Solicite um novo.' : result.error === 'ACCOUNT_NOT_FOUND' ? 'Seu e-mail foi conferido. Crie sua conta com nome e sobrenome para continuar.' : 'O código não confere ou já foi usado. Confira e tente novamente.');
  res.setHeader('Set-Cookie', sessionCookie(sessionToken));
  return result;
}
export function readSessionToken(req) {
  const cookies = String(req.headers.cookie || '').split(';');
  const value = cookies.map(part => part.trim()).find(part => part.startsWith(`${SESSION_COOKIE}=`))?.slice(SESSION_COOKIE.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}
export function sessionCookie(token, expired = false) {
  const secure = process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
  return `${SESSION_COOKIE}=${expired ? '' : token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expired ? 0 : SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`;
}
export async function sessionUser(req, required = false) {
  const token = readSessionToken(req);
  const row = token ? (await query(`SELECT u.id,u.email,u.first_name,u.last_name,u.avatar FROM as_sessions s JOIN as_users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now()`, [hashToken(token)])).rows[0] : null;
  if (!row && required) throw new ApiError(401, 'UNAUTHORIZED', 'Entre na sua conta para continuar.');
  return row ? publicUser(row) : null;
}
export async function logout(req, res) {
  const token = readSessionToken(req);
  if (token) await query('DELETE FROM as_sessions WHERE token_hash=$1', [hashToken(token)]);
  res.setHeader('Set-Cookie', sessionCookie('', true));
  return { ok: true };
}
