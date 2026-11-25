import { randomInt } from 'node:crypto';
import { hashCode, rateLimit, sealSecret, unsealSecret } from './auth.js';
import { ApiError, query, requireUUID } from './db.js';

const digest = token => hashCode('group-marmelada', token);
const unavailable = () => new ApiError(404, 'NOT_FOUND', 'Esta função está disponível para quem criou o grupo após o sorteio.');
const tokenRejected = () => new ApiError(422, 'MARMELADA_TOKEN_UNAVAILABLE',
  'Confira os nomes e o token da pessoa da etapa 2.');
const invalidTokenWindow = 10 * 60 * 1000;
const invalidTokenAttempts = new Map();

function checkInvalidTokenLimit(key) {
  const attempts = invalidTokenAttempts.get(key), now = Date.now();
  if (attempts?.until > now && attempts.count >= 5) {
    const error = new ApiError(429, 'RATE_LIMITED', 'Aguarde alguns minutos antes de tentar esse token novamente.');
    error.retryAfter = Math.ceil((attempts.until - now) / 1000);
    throw error;
  }
}

function rememberInvalidToken(key) {
  const now = Date.now(), current = invalidTokenAttempts.get(key);
  if (current?.until > now) {
    current.count++;
    return;
  }
  // Short-lived abuse protection only. No tokens, pairs or results are recorded.
  const attempts = { count: 1, until: now + invalidTokenWindow };
  invalidTokenAttempts.set(key, attempts);
  setTimeout(() => {
    if (invalidTokenAttempts.get(key) === attempts) invalidTokenAttempts.delete(key);
  }, invalidTokenWindow).unref();
}

async function ownMarmeladaTokens(user, groupId, membershipIds, list = false) {
  requireUUID(groupId);
  const ids = [...new Set(membershipIds.map(id => requireUUID(id).toLowerCase()))];
  await (list ? rateLimit('marmelada-tokens-list', user.id, 120, 600) : rateLimit('marmelada-token-issue', user.id, 40, 3600));
  for (let attempt = 0; attempt < 4; attempt++) {
    const proposed = ids.map(() => String(randomInt(100_000_000)).padStart(8, '0'));
    try {
      const { rows } = await query(`WITH proposals AS (
          SELECT * FROM unnest($3::uuid[],$4::text[],$5::text[]) AS item(id,token_hash,token_ciphertext)
        ), participation AS (
          SELECT r.group_id,r.giver_id,t.token_ciphertext,
            item.token_hash AS proposed_hash,item.token_ciphertext AS proposed_ciphertext
          FROM proposals item JOIN as_draw_results r ON r.group_id=$1 AND r.giver_id=item.id
          JOIN as_groups g ON g.id=r.group_id AND g.drawn_at IS NOT NULL
          JOIN as_users organizer ON organizer.id=g.organizer_id AND organizer.deleted_at IS NULL
          JOIN as_users caller ON caller.id=$2 AND caller.deleted_at IS NULL AND caller.verified_at IS NOT NULL
          JOIN as_memberships m ON m.group_id=r.group_id AND m.id=r.giver_id AND m.status='accepted'
          LEFT JOIN as_dependents d ON d.id=m.dependent_id AND d.deleted_at IS NULL
          LEFT JOIN as_marmelada_tokens t ON t.group_id=r.group_id AND t.giver_id=r.giver_id
          WHERE (m.user_id=$2 OR d.guardian_id=$2)
            AND EXISTS (SELECT 1 FROM as_memberships own WHERE own.group_id=$1 AND own.user_id=$2 AND own.status='accepted')
        ), issued AS (
          INSERT INTO as_marmelada_tokens AS current(group_id,giver_id,token_hash,token_ciphertext,expires_at)
          SELECT group_id,giver_id,proposed_hash,proposed_ciphertext,'infinity'::timestamptz FROM participation
          WHERE token_ciphertext IS NULL
            AND (SELECT count(*) FROM participation)=cardinality($3)
          ORDER BY giver_id
          ON CONFLICT (group_id,giver_id) DO UPDATE SET token_hash=excluded.token_hash,
            token_ciphertext=excluded.token_ciphertext,expires_at=excluded.expires_at
            WHERE current.token_ciphertext IS NULL
          RETURNING giver_id,token_ciphertext
        )
        SELECT giver_id,coalesce(issued.token_ciphertext,participation.token_ciphertext) AS token_ciphertext
        FROM participation LEFT JOIN issued USING(giver_id)`,
      [groupId, user.id, ids, proposed.map(digest), proposed.map(sealSecret)]);
      if (rows.length !== ids.length) throw new ApiError(404, 'NOT_FOUND', 'Esse token só pode ser consultado pela pessoa que participou do sorteio ou por seu responsável.');
      // A concurrent first request may have saved a code after this statement's snapshot.
      if (rows.some(row => !row.token_ciphertext)) continue;
      const tokens = rows.map(row => ({ membershipId: row.giver_id, token: unsealSecret(row.token_ciphertext) }));
      if (tokens.every(item => item.token)) return tokens;
      break;
    } catch (error) {
      if (error.code !== '23505' || error.constraint !== 'as_marmelada_tokens_token_hash_key') throw error;
    }
  }
  throw new ApiError(503, 'UNAVAILABLE', 'Não foi possível exibir o token. Tente de novo.');
}

export async function issueMarmeladaToken(user, groupId, body) {
  const [item] = await ownMarmeladaTokens(user, groupId, [body?.membershipId]);
  return { token: item.token };
}

export async function listMarmeladaTokens(user, groupId, body) {
  const ids = body?.membershipIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 200) {
    throw new ApiError(400, 'INVALID_MEMBERSHIPS', 'Envie as participações deste sorteio para consultar os tokens.');
  }
  return { tokens: await ownMarmeladaTokens(user, groupId, ids, true) };
}

export async function checkGroupMarmelada(user, groupId, body) {
  requireUUID(groupId);
  const giverId = requireUUID(body?.giverId), receiverId = requireUUID(body?.receiverId);
  if (typeof body?.token !== 'string' || !/^\d{8}$/.test(body.token)) {
    throw new ApiError(400, 'INVALID_MARMELADA_TOKEN', 'Digite os oito números do token.');
  }
  const key = `${user.id}:${groupId.toLowerCase()}:${receiverId.toLowerCase()}`;
  checkInvalidTokenLimit(key);

  const { rows: [row] } = await query(`WITH hosted AS (
      SELECT g.id FROM as_groups g
      JOIN as_users organizer ON organizer.id=g.organizer_id AND organizer.deleted_at IS NULL
      WHERE g.id=$1 AND g.organizer_id=$2 AND g.drawn_at IS NOT NULL
    ), active AS (
      SELECT m.id FROM hosted g
      JOIN as_memberships m ON m.group_id=g.id AND m.id IN ($3,$4) AND m.status='accepted'
      LEFT JOIN as_dependents d ON d.id=m.dependent_id AND d.deleted_at IS NULL
      JOIN as_users holder ON holder.id=coalesce(m.user_id,d.guardian_id) AND holder.deleted_at IS NULL
    ), claim AS (
      SELECT r.receiver_id=$4 AS matches, t.token_hash=$5 AS valid_token FROM hosted g
      JOIN as_draw_results r ON r.group_id=g.id AND r.giver_id=$3
      JOIN as_marmelada_tokens t ON t.group_id=g.id AND t.giver_id=$4 AND t.token_ciphertext IS NOT NULL
      WHERE (SELECT count(*) FROM active)=2
    )
    SELECT EXISTS(SELECT 1 FROM hosted) AS hosted,
      EXISTS(SELECT 1 FROM claim) AS has_claim,
      (SELECT matches FROM claim WHERE valid_token) AS verdict`,
  [groupId, user.id, giverId, receiverId, digest(body.token)]);
  if (!row.hosted) throw unavailable();
  checkInvalidTokenLimit(key);
  if (typeof row.verdict !== 'boolean') {
    if (row.has_claim) rememberInvalidToken(key);
    throw tokenRejected();
  }
  return { matches: row.verdict };
}
