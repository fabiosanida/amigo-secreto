import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, query, transaction } from './db.js';
import { normalizeName, publicUser, sanitizeAvatar } from './profile.js';
import { sendNotification } from './mail.js';
import { hashPassword, validatePassword, verifyPassword } from './passwords.js';

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
const validUUID = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const validInviteToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const userColumns = 'id,email,first_name,last_name,avatar,password_hash';
const accountExists = () => new ApiError(409, 'ACCOUNT_EXISTS', 'Já existe uma conta com este e-mail. Entre com sua senha ou recupere o acesso.');
async function lockEmail(client, email) {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [`account:${email}`]);
}
async function activeInvitation(client, token, email, lock = false) {
  if (!validInviteToken(token)) return null;
  const lookup = (await client.query(`SELECT m.group_id FROM as_memberships m LEFT JOIN as_users u ON u.id=m.user_id
    WHERE m.invite_token_hash=$1 AND m.email=$2 AND u.deleted_at IS NULL`, [hashToken(token), email])).rows[0];
  if (!lookup) return null;
  const group = (await client.query(`SELECT id,drawn_at FROM as_groups WHERE id=$1${lock ? ' FOR UPDATE' : ''}`, [lookup.group_id])).rows[0];
  if (!group || group.drawn_at) return null;
  return (await client.query(`SELECT id FROM as_memberships WHERE group_id=$1 AND invite_token_hash=$2 AND email=$3
    AND invite_expires_at>now() AND status<>'accepted'${lock ? ' FOR UPDATE' : ''}`, [group.id, hashToken(token), email])).rows[0] || null;
}
async function issueSession(client, userId, token) {
  await client.query("INSERT INTO as_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')", [hashToken(token), userId]);
}
async function requestLimits(email, req, scope) {
  await rateLimit(`${scope}-ip`, clientIP(req), 20, 3600);
  await rateLimit(`${scope}-email`, email, 10, 3600);
  await rateLimit(`${scope}-cooldown`, email, 1, 60);
}
export async function accountAvailability(body, req) {
  const email = normalizeEmail(body.email);
  await rateLimit('auth-account-ip', clientIP(req), 120, 3600);
  const existing = (await query('SELECT password_hash FROM as_users WHERE email=$1 AND deleted_at IS NULL', [email])).rows[0];
  const invitation = await activeInvitation({ query }, body.inviteToken, email);
  return { exists: Boolean(existing), hasPassword: Boolean(existing?.password_hash), emailVerified: Boolean(invitation) };
}
async function sendChallenge({ email, firstName, lastName, avatar, passwordHash, inviteToken, purpose, userId, sourceChallengeId }) {
  const challengeId = randomUUID(), code = String(randomInt(0, 1000000)).padStart(6, '0'), token = newToken();
  inviteToken = validInviteToken(inviteToken) ? inviteToken : undefined;
  await transaction(async client => {
    // Match deletion's email -> user -> challenge order, so proofs cannot outlive it.
    await lockEmail(client, email);
    if (purpose === 'password_reset') {
      const user = (await client.query('SELECT id FROM as_users WHERE id=$1 AND email=$2 AND deleted_at IS NULL FOR UPDATE', [userId, email])).rows[0];
      if (!user) throw new ApiError(400, 'INVALID_REQUEST', 'Solicite um novo código de recuperação.');
    }
    if (sourceChallengeId && !(await client.query("SELECT id FROM as_auth_challenges WHERE id=$1 AND email=$2 AND purpose='signup' AND used_at IS NULL", [sourceChallengeId, email])).rows[0]) {
      throw new ApiError(401, 'EXPIRED_CODE', 'Esse cadastro expirou. Preencha seus dados novamente.');
    }
    if (purpose === 'signup' && (await client.query('SELECT id FROM as_users WHERE email=$1', [email])).rows.length) throw accountExists();
    await client.query('UPDATE as_auth_challenges SET used_at=now() WHERE email=$1 AND purpose=$2 AND used_at IS NULL', [email, purpose]);
    await client.query(`INSERT INTO as_auth_challenges(id,email,user_id,first_name,last_name,avatar,code_hash,token_hash,expires_at,invite_token_cipher,purpose,password_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, [challengeId, email, userId || null, firstName || null, lastName || null, avatar || null, hashCode(challengeId, code), hashToken(token), new Date(Date.now() + OTP_TTL_MS), validInviteToken(inviteToken) ? sealSecret(inviteToken) : null, purpose, passwordHash || null]);
  });
  try {
    await sendNotification({ kind: purpose === 'password_reset' ? 'password-reset' : 'verify', to: email,
      user: { firstName: firstName || 'amigo', lastName: lastName || '', email }, code, token, challengeId, inviteToken, idempotencyKey: `${purpose}:${challengeId}` });
  } catch {
    await query('UPDATE as_auth_challenges SET used_at=now() WHERE id=$1', [challengeId]);
    throw new ApiError(503, 'EMAIL_UNAVAILABLE', 'Não conseguimos enviar o código agora. Tente novamente em instantes.');
  }
  return { challengeId, email, resendAfter: 60 };
}
export async function registerAuthentication(body, req, res) {
  const email = normalizeEmail(body.email);
  const firstName = normalizeName(body.firstName, 'seu nome', 80), lastName = normalizeName(body.lastName, 'seu sobrenome', 120);
  validatePassword(body.password, body.passwordConfirm);
  await requestLimits(email, req, 'auth-signup');
  if ((await query('SELECT id FROM as_users WHERE email=$1', [email])).rows.length) throw accountExists();
  const avatar = await sanitizeAvatar(body.avatar), passwordHash = await hashPassword(body.password), sessionToken = newToken();
  const user = await transaction(async client => {
    // Lock the group before its membership, matching acceptance/draw lock order.
    const invitation = await activeInvitation(client, body.inviteToken, email, true);
    if (!invitation) return null;
    await lockEmail(client, email);
    const inserted = await client.query(`INSERT INTO as_users(id,email,first_name,last_name,avatar,password_hash,password_changed_at)
      VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(email) DO NOTHING RETURNING ${userColumns}`, [randomUUID(), email, firstName, lastName, avatar, passwordHash]);
    if (!inserted.rows[0]) throw accountExists();
    await client.query('UPDATE as_auth_challenges SET used_at=now() WHERE email=$1 AND used_at IS NULL', [email]);
    await issueSession(client, inserted.rows[0].id, sessionToken);
    return publicUser(inserted.rows[0]);
  });
  if (user) { res.setHeader('Set-Cookie', sessionCookie(sessionToken)); return { user, emailVerified: true }; }
  return sendChallenge({ email, firstName, lastName, avatar, passwordHash, inviteToken: body.inviteToken, purpose: 'signup' });
}
export async function requestAuthentication(body, req) {
  const email = normalizeEmail(body.email);
  if (!validUUID(body.challengeId)) throw new ApiError(400, 'PASSWORD_REQUIRED', 'Entre com sua senha ou crie sua conta para continuar.');
  await requestLimits(email, req, 'auth-signup');
  const pending = (await query(`SELECT first_name,last_name,avatar,password_hash,invite_token_cipher FROM as_auth_challenges
    WHERE id=$1 AND email=$2 AND purpose='signup' AND password_hash IS NOT NULL AND used_at IS NULL AND created_at>now()-interval '24 hours'`, [body.challengeId, email])).rows[0];
  if (!pending) throw new ApiError(401, 'EXPIRED_CODE', 'Esse cadastro expirou. Preencha seus dados novamente.');
  return sendChallenge({ email, firstName: pending.first_name, lastName: pending.last_name, avatar: pending.avatar,
    passwordHash: pending.password_hash, inviteToken: unsealSecret(pending.invite_token_cipher), purpose: 'signup', sourceChallengeId: body.challengeId });
}
function challengeError(code) {
  return new ApiError(401, code, code === 'EXPIRED_CODE' ? 'Esse código expirou. Solicite um novo.' : 'O código não confere ou já foi usado. Confira e tente novamente.');
}
export async function verifyAuthentication(body, req, res) {
  await rateLimit('auth-verify-ip', clientIP(req), 40, 900);
  const usingToken = validInviteToken(body.token);
  if (!usingToken && !validUUID(body.challengeId)) throw challengeError('INVALID_CODE');
  const sessionToken = newToken();
  const result = await transaction(async client => {
    // Email lock first keeps concurrent signup attempts from authenticating an existing account.
    const lookup = (await client.query(`SELECT email FROM as_auth_challenges WHERE ${usingToken ? 'token_hash=$1' : 'id=$1'} AND purpose='signup'`, [usingToken ? hashToken(body.token) : body.challengeId])).rows[0];
    if (!lookup) return { error: 'INVALID_CODE' };
    await lockEmail(client, lookup.email);
    const challenge = (await client.query(`SELECT * FROM as_auth_challenges WHERE ${usingToken ? 'token_hash=$1' : 'id=$1'} AND purpose='signup' FOR UPDATE`, [usingToken ? hashToken(body.token) : body.challengeId])).rows[0];
    if (!challengeIsUsable(challenge) || !challenge.password_hash) return { error: challenge && new Date(challenge.expires_at).getTime() <= Date.now() ? 'EXPIRED_CODE' : 'INVALID_CODE' };
    if (!usingToken && !verifyCode(challenge.id, body.code, challenge.code_hash)) {
      await client.query('UPDATE as_auth_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]); return { error: 'INVALID_CODE' };
    }
    await client.query('UPDATE as_auth_challenges SET used_at=now() WHERE id=$1', [challenge.id]);
    const inserted = await client.query(`INSERT INTO as_users(id,email,first_name,last_name,avatar,password_hash,password_changed_at)
      VALUES($1,$2,$3,$4,$5,$6,now()) ON CONFLICT(email) DO NOTHING RETURNING ${userColumns}`, [randomUUID(), challenge.email, challenge.first_name, challenge.last_name, challenge.avatar, challenge.password_hash]);
    if (!inserted.rows[0]) return { error: 'ACCOUNT_EXISTS' };
    await issueSession(client, inserted.rows[0].id, sessionToken);
    return { user: publicUser(inserted.rows[0]) };
  });
  if (result.error === 'ACCOUNT_EXISTS') throw accountExists();
  if (result.error) throw challengeError(result.error);
  res.setHeader('Set-Cookie', sessionCookie(sessionToken)); return result;
}
export async function loginAuthentication(body, req, res) {
  const email = normalizeEmail(body.email);
  await rateLimit('auth-login-ip', clientIP(req), 40, 900);
  await rateLimit('auth-login-email', email, 15, 900);
  const user = (await query(`SELECT ${userColumns} FROM as_users WHERE email=$1 AND deleted_at IS NULL`, [email])).rows[0];
  if (user && !user.password_hash) throw new ApiError(409, 'PASSWORD_SETUP_REQUIRED', 'Sua conta ainda não tem senha. Use Recuperar senha para definir a primeira.');
  const valid = user && await verifyPassword(body.password, user.password_hash);
  if (!valid) throw new ApiError(401, 'INVALID_CREDENTIALS', 'E-mail ou senha incorretos. Confira e tente novamente.');
  const token = newToken();
  await transaction(async client => {
    const current = (await client.query('SELECT password_hash FROM as_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [user.id])).rows[0];
    if (current?.password_hash !== user.password_hash) throw new ApiError(401, 'INVALID_CREDENTIALS', 'Sua senha mudou. Entre novamente.');
    await issueSession(client, user.id, token);
  });
  res.setHeader('Set-Cookie', sessionCookie(token)); return { user: publicUser(user) };
}
export async function requestPasswordReset(body, req) {
  const email = normalizeEmail(body.email);
  await requestLimits(email, req, 'password-reset');
  const user = (await query(`SELECT ${userColumns} FROM as_users WHERE email=$1 AND deleted_at IS NULL`, [email])).rows[0];
  if (!user) return { challengeId: randomUUID(), email, resendAfter: 60 };
  return sendChallenge({ email, firstName: user.first_name, lastName: user.last_name, userId: user.id, purpose: 'password_reset', inviteToken: body.inviteToken });
}
export async function verifyPasswordReset(body, req) {
  await rateLimit('password-reset-verify-ip', clientIP(req), 40, 900);
  if (!validUUID(body.challengeId)) throw challengeError('INVALID_CODE');
  const resetToken = newToken();
  const result = await transaction(async client => {
    const lookup = (await client.query("SELECT user_id FROM as_auth_challenges WHERE id=$1 AND purpose='password_reset'", [body.challengeId])).rows[0];
    if (!lookup?.user_id) return { error: 'INVALID_CODE' };
    // Same user-first lock order as reset/login. Reset cannot leave a fresh grant behind.
    const activeUser = (await client.query('SELECT id FROM as_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [lookup.user_id])).rows[0];
    if (!activeUser) return { error: 'INVALID_CODE' };
    const challenge = (await client.query("SELECT * FROM as_auth_challenges WHERE id=$1 AND purpose='password_reset' FOR UPDATE", [body.challengeId])).rows[0];
    if (!challengeIsUsable(challenge)) return { error: challenge && new Date(challenge.expires_at).getTime() <= Date.now() ? 'EXPIRED_CODE' : 'INVALID_CODE' };
    if (!verifyCode(challenge.id, body.code, challenge.code_hash)) {
      await client.query('UPDATE as_auth_challenges SET attempts=attempts+1 WHERE id=$1', [challenge.id]); return { error: 'INVALID_CODE' };
    }
    await client.query('UPDATE as_auth_challenges SET used_at=now() WHERE id=$1', [challenge.id]);
    await client.query("INSERT INTO as_password_resets(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '10 minutes')", [hashToken(resetToken), challenge.user_id]);
    return { resetToken, email: challenge.email };
  });
  if (result.error) throw challengeError(result.error);
  return result;
}
export async function resetPassword(body, req, res) {
  await rateLimit('password-reset-finish-ip', clientIP(req), 20, 900);
  validatePassword(body.password, body.passwordConfirm);
  if (!validInviteToken(body.resetToken)) throw new ApiError(401, 'RESET_EXPIRED', 'Esse acesso expirou. Solicite outro código de recuperação.');
  const digest = hashToken(body.resetToken);
  const lookup = (await query('SELECT user_id FROM as_password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now()', [digest])).rows[0];
  if (!lookup) throw new ApiError(401, 'RESET_EXPIRED', 'Esse acesso expirou. Solicite outro código de recuperação.');
  const passwordHash = await hashPassword(body.password);
  await transaction(async client => {
    const user = (await client.query('SELECT id,email FROM as_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [lookup.user_id])).rows[0];
    const grant = (await client.query('SELECT user_id FROM as_password_resets WHERE token_hash=$1 AND used_at IS NULL AND expires_at>now() FOR UPDATE', [digest])).rows[0];
    if (!user || !grant || grant.user_id !== user.id) throw new ApiError(401, 'RESET_EXPIRED', 'Esse acesso expirou. Solicite outro código de recuperação.');
    await client.query('UPDATE as_users SET password_hash=$2,password_changed_at=now(),updated_at=now() WHERE id=$1', [user.id, passwordHash]);
    await client.query('UPDATE as_password_resets SET used_at=now() WHERE user_id=$1 AND used_at IS NULL', [user.id]);
    await client.query('UPDATE as_auth_challenges SET used_at=now() WHERE email=$1 AND used_at IS NULL', [user.email]);
    await client.query('DELETE FROM as_sessions WHERE user_id=$1', [user.id]);
  });
  res.setHeader('Set-Cookie', sessionCookie('', true)); return { ok: true };
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
export async function sessionUser(req, required = false, { includeAvatar = true } = {}) {
  const token = readSessionToken(req);
  const row = token ? (await query(`SELECT u.id,u.email,u.first_name,u.last_name${includeAvatar ? ',u.avatar' : ''} FROM as_sessions s JOIN as_users u ON u.id=s.user_id
    WHERE s.token_hash=$1 AND s.expires_at>now() AND u.deleted_at IS NULL`, [hashToken(token)])).rows[0] : null;
  if (!row && required) throw new ApiError(401, 'UNAUTHORIZED', 'Entre na sua conta para continuar.');
  return row ? publicUser(row) : null;
}
export async function logout(req, res) {
  const token = readSessionToken(req);
  if (token) await query('DELETE FROM as_sessions WHERE token_hash=$1', [hashToken(token)]);
  res.setHeader('Set-Cookie', sessionCookie('', true));
  return { ok: true };
}
