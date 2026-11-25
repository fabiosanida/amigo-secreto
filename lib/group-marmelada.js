import { randomInt } from 'node:crypto';
import { hashCode, rateLimit, sealSecret, unsealSecret } from './auth.js';
import { ApiError, query, requireUUID } from './db.js';

const digest = token => hashCode('group-marmelada', token);
const unavailable = () => new ApiError(404, 'NOT_FOUND', 'Esta função está disponível para quem criou o grupo após o sorteio.');
const tokenRejected = () => new ApiError(422, 'MARMELADA_TOKEN_UNAVAILABLE',
  'Confira os nomes e o código. Se houve várias tentativas, aguarde alguns minutos. Cada token vale para uma única conferência.');

export async function issueMarmeladaToken(user, groupId, body) {
  requireUUID(groupId);
  const giverId = requireUUID(body?.membershipId);
  await rateLimit('marmelada-token-issue', user.id, 40, 3600);
  for (let attempt = 0; attempt < 4; attempt++) {
    const token = String(randomInt(100_000_000)).padStart(8, '0');
    try {
      const { rows: [row] } = await query(`WITH participation AS (
          SELECT r.group_id,r.giver_id,t.token_ciphertext,t.used_at FROM as_draw_results r
          JOIN as_groups g ON g.id=r.group_id AND g.drawn_at IS NOT NULL
          JOIN as_users organizer ON organizer.id=g.organizer_id AND organizer.deleted_at IS NULL
          JOIN as_users caller ON caller.id=$2 AND caller.deleted_at IS NULL AND caller.verified_at IS NOT NULL
          JOIN as_memberships m ON m.group_id=r.group_id AND m.id=r.giver_id AND m.status='accepted'
          LEFT JOIN as_dependents d ON d.id=m.dependent_id AND d.deleted_at IS NULL
          LEFT JOIN as_marmelada_tokens t ON t.group_id=r.group_id AND t.giver_id=r.giver_id
          WHERE r.group_id=$1 AND r.giver_id=$3 AND (m.user_id=$2 OR d.guardian_id=$2)
            AND EXISTS (SELECT 1 FROM as_memberships own WHERE own.group_id=$1 AND own.user_id=$2 AND own.status='accepted')
        ), issued AS (
          INSERT INTO as_marmelada_tokens AS current(group_id,giver_id,token_hash,token_ciphertext,expires_at)
          SELECT group_id,giver_id,$4,$5,'infinity'::timestamptz FROM participation
          WHERE token_ciphertext IS NULL AND used_at IS NULL
          ON CONFLICT (group_id,giver_id) DO UPDATE SET token_hash=excluded.token_hash,
            token_ciphertext=excluded.token_ciphertext,expires_at=excluded.expires_at,
            failed_attempts=0,attempts_reset_at=NULL
            WHERE current.token_ciphertext IS NULL AND current.used_at IS NULL
          RETURNING token_ciphertext
        )
        SELECT coalesce(issued.token_ciphertext,participation.token_ciphertext) AS token_ciphertext,participation.used_at
        FROM participation LEFT JOIN issued ON true`,
      [groupId, user.id, giverId, digest(token), sealSecret(token)]);
      if (!row) throw new ApiError(404, 'NOT_FOUND', 'Esse token só pode ser consultado pela pessoa que participou do sorteio ou por seu responsável.');
      if (row.used_at) throw new ApiError(409, 'MARMELADA_TOKEN_USED', 'O token desta pessoa já foi usado na conferência.');
      // A concurrent first request may have saved the token after this statement's snapshot.
      if (!row.token_ciphertext) continue;
      const savedToken = unsealSecret(row.token_ciphertext);
      if (savedToken) return { token: savedToken };
      break;
    } catch (error) {
      if (error.code !== '23505' || error.constraint !== 'as_marmelada_tokens_token_hash_key') throw error;
    }
  }
  throw new ApiError(503, 'UNAVAILABLE', 'Não foi possível exibir o token. Tente de novo.');
}

export async function checkGroupMarmelada(user, groupId, body) {
  requireUUID(groupId);
  const giverId = requireUUID(body?.giverId), receiverId = requireUUID(body?.receiverId);
  if (typeof body?.token !== 'string' || !/^\d{8}$/.test(body.token)) {
    throw new ApiError(400, 'INVALID_MARMELADA_TOKEN', 'Digite os oito números do token.');
  }
  await rateLimit('marmelada-token-check', user.id, 120, 600);

  // Update the same row on both success and failure. Concurrent requests cannot
  // reuse a consumed token or bypass the failed-attempt limit.
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
      SELECT g.id, r.receiver_id=$4 AS matches FROM hosted g
      JOIN as_draw_results r ON r.group_id=g.id AND r.giver_id=$3
      JOIN as_draw_results candidate ON candidate.group_id=g.id AND candidate.giver_id=$4
      WHERE (SELECT count(*) FROM active)=2
    ), attempt AS (
      UPDATE as_marmelada_tokens t SET
        used_at=CASE WHEN t.token_hash=$5 THEN now() END,
        failed_attempts=(CASE WHEN t.attempts_reset_at>now() THEN t.failed_attempts ELSE 0 END)+(t.token_hash<>$5)::int,
        attempts_reset_at=CASE WHEN t.attempts_reset_at>now() THEN t.attempts_reset_at ELSE now()+interval '10 minutes' END
      FROM claim c WHERE t.group_id=c.id AND t.giver_id=$4 AND t.used_at IS NULL
        AND t.token_ciphertext IS NOT NULL
        AND (t.attempts_reset_at IS NULL OR t.attempts_reset_at<=now() OR t.failed_attempts<5)
      RETURNING CASE WHEN t.used_at IS NOT NULL THEN c.matches END AS verdict
    )
    SELECT EXISTS(SELECT 1 FROM hosted) AS hosted, (SELECT verdict FROM attempt) AS verdict`,
  [groupId, user.id, giverId, receiverId, digest(body.token)]);
  if (!row.hosted) throw unavailable();
  if (typeof row.verdict !== 'boolean') throw tokenRejected();
  return { matches: row.verdict };
}
