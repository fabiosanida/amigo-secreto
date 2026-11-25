import { createHash, timingSafeEqual } from 'node:crypto';
import { ApiError, query } from '../lib/db.js';
import { accountAvailability, clientIP, loginAuthentication, logout, rateLimit, registerAuthentication, requestAuthentication, requestPasswordReset, resetPassword, sessionUser, verifyAuthentication, verifyPasswordReset } from '../lib/auth.js';
import { acceptGroupInvitation, acceptInvitation, createGroup, deleteGroup, drainOutbox, drawGroup, getGroup, getInvitation, getResult, invitePeople, listGroups, removeParticipant, resendInvite, retryNotifications, trackOpen, updateGroupEvent } from '../lib/groups.js';
import { updateProfile } from '../lib/profile.js';
import { createDependent, createGroupDependent, listDependents, setDependentParticipation } from '../lib/dependents.js';
import { listWishlist, participantWishlist, recipientWishlist, saveWishlist } from '../lib/wishlists.js';
import { adminGroup, adminGroups, adminOverview, adminUser, adminUsers } from '../lib/admin.js';
import { requireAdmin } from '../lib/admin-access.js';
import { viewAsUser } from '../lib/view-as.js';
import { beginPasskeyLogin, beginPasskeyRegistration, finishPasskeyLogin, finishPasskeyRegistration } from '../lib/passkeys.js';
import { adminDeleteGroup, adminDeleteUser, adminGroupDeletePreview, adminUserDeletePreview } from '../lib/admin-delete.js';
import { checkMarmelada, loadMarmeladaGroup, marmeladaGroup, marmeladaGroups } from '../lib/admin-marmelada.js';
import { checkGroupMarmelada, issueMarmeladaToken, listMarmeladaTokens } from '../lib/group-marmelada.js';

const MAX_BODY = 400000;
export function verifyCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret || secret.length < 32) throw new ApiError(503, 'UNAVAILABLE', 'Rotina indisponível.');
  const expected = createHash('sha256').update(`Bearer ${secret}`).digest();
  const supplied = createHash('sha256').update(String(req.headers.authorization || '')).digest();
  if (!timingSafeEqual(expected, supplied)) throw new ApiError(401, 'UNAUTHORIZED', 'Acesso não autorizado.');
}
export function checkOrigin(req) {
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') throw new ApiError(403, 'INVALID_ORIGIN', 'Atualize a página e tente novamente.');
  const origin = req.headers.origin;
  if (!origin) return; // JSON-only writes prevent cross-origin HTML form requests; CLI clients have no Origin.
  const allowed = new Set();
  for (const value of [process.env.APP_URL, process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : null]) {
    if (value) { try { allowed.add(new URL(value).origin); } catch {} }
  }
  if (!process.env.VERCEL) {
    try { const url = new URL(origin); if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && ['http:', 'https:'].includes(url.protocol)) return; } catch {}
  }
  if (!allowed.has(origin)) throw new ApiError(403, 'INVALID_ORIGIN', 'Atualize a página e tente novamente.');
}
async function readBody(req) {
  if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ApiError(415, 'INVALID_CONTENT_TYPE', 'Envie os dados em JSON.');
  if (Number(req.headers['content-length'] || 0) > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'Os dados enviados são muito grandes.');
  let body = req.body;
  if (body === undefined) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'Os dados enviados são muito grandes.'); chunks.push(chunk); }
    body = Buffer.concat(chunks).toString('utf8');
  }
  if (Buffer.isBuffer(body)) body = body.toString('utf8');
  if (typeof body === 'string') {
    if (Buffer.byteLength(body) > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'Os dados enviados são muito grandes.');
    try { body = JSON.parse(body || '{}'); } catch { throw new ApiError(400, 'INVALID_JSON', 'Os dados enviados são inválidos.'); }
  }
  if (!body || Array.isArray(body) || typeof body !== 'object') throw new ApiError(400, 'INVALID_JSON', 'Os dados enviados são inválidos.');
  if (Buffer.byteLength(JSON.stringify(body)) > MAX_BODY) throw new ApiError(413, 'BODY_TOO_LARGE', 'Os dados enviados são muito grandes.');
  return body;
}
function send(res, status, body) { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(body)); }
async function accountRequest(user, parts, method, search, body, reply, { delegated = false } = {}) {
  const path = parts.length === 1 ? parts[0] : '';
  if (method === 'POST' && path === 'profile') { await rateLimit('profile', user.id, 30, 3600); return reply(200, await updateProfile(user, body)); }
  if (path === 'dependents' && method === 'GET') return reply(200, await listDependents(user, { groupId: search.get('groupId'), cursor: search.get('cursor') }));
  if (path === 'dependents' && method === 'POST') return reply(201, await createDependent(user, body));
  if (path === 'groups' && method === 'GET') return reply(200, await listGroups(user));
  if (path === 'groups' && method === 'POST') return reply(201, await createGroup(user, body));
  if (parts[0] === 'invitations' && parts[2] === 'accept' && parts.length === 3 && method === 'POST') return reply(200, await acceptInvitation(user, parts[1]));
  if (parts[0] === 'groups') {
    const id = parts[1];
    if (parts.length === 3 && parts[2] === 'marmelada' && method === 'GET') return reply(200, await loadMarmeladaGroup(id, user.id));
    if (parts.length === 4 && parts[2] === 'marmelada' && method === 'POST') {
      if (parts[3] === 'check') return reply(200, await checkGroupMarmelada(user, id, body));
      if (!delegated && parts[3] === 'token') return reply(201, await issueMarmeladaToken(user, id, body));
      if (!delegated && parts[3] === 'tokens') return reply(200, await listMarmeladaTokens(user, id, body));
    }
    if (parts.length === 3 && parts[2] === 'wishlist') {
      if (method === 'GET') return reply(200, await listWishlist(user, id, { dependentId: search.get('dependentId'), cursor: search.get('cursor') }));
      if (method === 'POST') return reply(200, await saveWishlist(user, id, body));
    }
    if (parts.length === 5 && parts[2] === 'participants' && parts[4] === 'wishlist' && method === 'GET') {
      return reply(200, await participantWishlist(user, id, parts[3], { cursor: search.get('cursor') }));
    }
    if (!delegated && parts.length === 4 && parts[2] === 'result' && parts[3] === 'wishlist' && method === 'GET') {
      return reply(200, await recipientWishlist(user, id, { dependentId: search.get('dependentId'), cursor: search.get('cursor') }));
    }
    if (parts.length === 2 && method === 'GET') return reply(200, await getGroup(user, id, { maintenance: !delegated }));
    if (parts.length === 3 && ['date', 'budget', 'location'].includes(parts[2]) && method === 'POST') {
      return reply(200, await updateGroupEvent(user, id, parts[2], body));
    }
    if (parts.length === 3 && parts[2] === 'dependents' && method === 'POST') return reply(201, await createGroupDependent(user, id, body));
    if (parts.length === 4 && parts[2] === 'dependents' && method === 'POST') return reply(200, await setDependentParticipation(user, id, parts[3], body));
    if (parts.length === 5 && parts[2] === 'participants' && parts[4] === 'remove' && method === 'POST') return reply(200, await removeParticipant(user, id, parts[3], body));
    if (parts.length === 3 && parts[2] === 'accept' && method === 'POST') return reply(200, await acceptGroupInvitation(user, id));
    if (parts.length === 3 && parts[2] === 'delete' && method === 'POST') return reply(200, await deleteGroup(user, id, body));
    if (parts.length === 3 && parts[2] === 'invites' && method === 'POST') return reply(200, await invitePeople(user, id, body));
    if (parts.length === 5 && parts[2] === 'invites' && parts[4] === 'resend' && method === 'POST') return reply(200, await resendInvite(user, id, parts[3]));
    if (parts.length === 3 && parts[2] === 'draw' && method === 'POST') return reply(200, await drawGroup(user, id));
    if (!delegated && parts.length === 3 && parts[2] === 'result' && method === 'GET') return reply(200, await getResult(user, id));
    if (parts.length === 4 && parts[2] === 'notifications' && parts[3] === 'retry' && method === 'POST') return reply(200, await retryNotifications(user, id));
  }
  throw new ApiError(404, 'NOT_FOUND', 'Não encontramos essa página.');
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store, max-age=0');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  try {
    const url = new URL(req.url, 'http://localhost');
    const raw = req.query?.path || url.searchParams.get('path') || url.pathname.replace(/^\/api(?:\/index\.js)?\/?/, '');
    const path = String(Array.isArray(raw) ? raw.join('/') : raw).replace(/^\/+|\/+$/g, '');
    const parts = path.split('/').map(part => decodeURIComponent(part));
    const method = String(req.method || 'GET').toUpperCase();
    if (!['GET', 'POST'].includes(method)) throw new ApiError(405, 'METHOD_NOT_ALLOWED', 'Método não permitido.');
    if (method === 'GET' && parts[0] === 'track' && parts[1] === 'open' && parts.length === 3) {
      await trackOpen(parts[2]).catch(() => {});
      res.statusCode = 200; res.setHeader('Content-Type', 'image/png');
      res.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')); return;
    }
    let body;
    if (method === 'POST') { checkOrigin(req); body = await readBody(req); }
    if (method === 'GET' && path === 'health') { await query('SELECT 1'); return send(res, 200, { ok: true }); }
    if (method === 'GET' && path === 'internal/notifications/drain') { verifyCron(req); return send(res, 200, await drainOutbox()); }
    if (method === 'GET' && path === 'session') return send(res, 200, { user: await sessionUser(req) });
    if (method === 'POST' && path === 'auth/register') return send(res, 200, await registerAuthentication(body, req, res));
    if (method === 'POST' && path === 'auth/passkeys/register/options') return send(res, 200, await beginPasskeyRegistration(req));
    if (method === 'POST' && path === 'auth/passkeys/register/verify') return send(res, 200, await finishPasskeyRegistration(body, req));
    if (method === 'POST' && path === 'auth/passkeys/login/options') return send(res, 200, await beginPasskeyLogin(req, res));
    if (method === 'POST' && path === 'auth/passkeys/login/verify') return send(res, 200, await finishPasskeyLogin(body, req, res));
    if (method === 'POST' && path === 'auth/login') return send(res, 200, await loginAuthentication(body, req, res));
    if (method === 'POST' && path === 'auth/account') return send(res, 200, await accountAvailability(body, req));
    if (method === 'POST' && path === 'auth/password/request') return send(res, 200, await requestPasswordReset(body, req));
    if (method === 'POST' && path === 'auth/password/verify') return send(res, 200, await verifyPasswordReset(body, req));
    if (method === 'POST' && path === 'auth/password/reset') return send(res, 200, await resetPassword(body, req, res));
    if (method === 'POST' && path === 'auth/request') return send(res, 200, await requestAuthentication(body, req));
    if (method === 'POST' && path === 'auth/verify') return send(res, 200, await verifyAuthentication(body, req, res));
    if (method === 'POST' && path === 'auth/logout') return send(res, 200, await logout(req, res));
    if (method === 'GET' && parts[0] === 'invitations' && parts.length === 2) {
      await rateLimit('public-invitations', clientIP(req), 120, 3600);
      return send(res, 200, await getInvitation(parts[1], await sessionUser(req, false, { includeAvatar: false })));
    }
    const user = await sessionUser(req, true, { includeAvatar: path === 'profile' });
    if (parts[0] === 'admin') {
      requireAdmin(user);
      if (parts[1] === 'view-as') {
        const scoped = parts.slice(3);
        const target = await viewAsUser(user, parts[2], { includeAvatar: !scoped.length || (scoped[0] === 'profile' && scoped.length === 1) });
        if (method === 'GET' && !scoped.length) return send(res, 200, { user: target });
        const reply = (status, data) => {
          if (method === 'POST') {
            const family = scoped[0];
            // Keep the actual actor and target in the audit, without storing values or invite links.
            console.info('view_as_change', { actorId: user.id, targetId: target.id, family,
              ...(family === 'groups' && scoped.length > 2 ? { groupId: scoped[1], operation: scoped[2] } : {}) });
          }
          return send(res, status, data);
        };
        return await accountRequest(target, scoped, method, url.searchParams, body, reply, { delegated: true });
      }
      const filters = { ...Object.fromEntries(url.searchParams), ...(req.query || {}) };
      if (method === 'GET' && path === 'admin/overview') return send(res, 200, await adminOverview(user));
      if (method === 'GET' && path === 'admin/groups') return send(res, 200, await adminGroups(user, filters));
      if (method === 'GET' && path === 'admin/users') return send(res, 200, await adminUsers(user, filters));
      if (method === 'GET' && path === 'admin/marmelada/groups') return send(res, 200, await marmeladaGroups(user, filters));
      if (method === 'GET' && parts.length === 4 && parts[1] === 'marmelada' && parts[2] === 'groups') return send(res, 200, await marmeladaGroup(user, parts[3]));
      if (method === 'POST' && path === 'admin/marmelada/check') return send(res, 200, await checkMarmelada(user, body));
      if (method === 'GET' && parts.length === 4 && parts[3] === 'delete-preview') {
        if (parts[1] === 'groups') return send(res, 200, await adminGroupDeletePreview(user, parts[2]));
        if (parts[1] === 'users') return send(res, 200, await adminUserDeletePreview(user, parts[2]));
      }
      if (method === 'POST' && parts.length === 4 && parts[3] === 'delete') {
        if (parts[1] === 'groups') return send(res, 200, await adminDeleteGroup(user, parts[2], body));
        if (parts[1] === 'users') return send(res, 200, await adminDeleteUser(user, parts[2], body));
      }
      if (method === 'GET' && parts.length === 3 && parts[1] === 'groups') return send(res, 200, await adminGroup(user, parts[2]));
      if (method === 'GET' && parts.length === 3 && parts[1] === 'users') return send(res, 200, await adminUser(user, parts[2], filters));
    }
    return await accountRequest(user, parts, method, url.searchParams, body, (status, data) => send(res, status, data));
  } catch (error) {
    const known = error instanceof ApiError;
    if (!known) {
      // Only log the route family and error class/code; URLs may contain secrets.
      const rawPath = String(req.query?.path || new URL(req.url || '/', 'http://localhost').pathname);
      const family = rawPath.replace(/^\/api\/?/, '').split(/[/?]/)[0];
      console.error('api_request_failed', { path: ['auth', 'groups', 'invitations', 'session', 'profile', 'dependents', 'health', 'internal', 'track'].includes(family) ? family : 'unknown', code: String(error?.code || error?.name || 'Error').slice(0, 64) });
    }
    if (known && error.retryAfter) res.setHeader('Retry-After', String(error.retryAfter));
    send(res, known ? error.status : 500, { error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : 'Não foi possível concluir agora. Tente novamente em instantes.' } });
  }
}
