import { ApiError, query, requireUUID, transaction } from './db.js';
import { isAdmin, requireAdmin } from './admin-access.js';

const missing = () => new ApiError(404, 'NOT_FOUND', 'Não encontramos esse registro.');
const protectedAccount = 'A conta administradora não pode ser apagada para preservar seu acesso à administração.';
const affectedMember = `(m.user_id=$1 OR (m.user_id IS NULL AND m.email=$2))`;
const participatesInDraw = `EXISTS(SELECT 1 FROM as_draw_results r WHERE r.group_id=m.group_id AND (r.giver_id=m.id OR r.receiver_id=m.id))`;
const affectedOutbox = `(n.group_id IN (SELECT id FROM as_groups WHERE organizer_id=$1)
  OR n.membership_id IN (SELECT m.id FROM as_memberships m WHERE ${affectedMember})
  OR n.payload->>'to'=$2 OR n.payload->'user'->>'id'=$1::text)`;
function confirmation(value, expected, label) {
  if (typeof value !== 'string' || value !== expected) throw new ApiError(400, 'CONFIRMATION_REQUIRED', `Digite ${label} para confirmar a exclusão.`);
}
function checkSending(rows) {
  if (rows.some(row => row.state === 'sending' && new Date(row.lease_until).getTime() > Date.now())) {
    throw new ApiError(409, 'NOTIFICATIONS_IN_PROGRESS', 'Há um envio de e-mail em andamento. Aguarde alguns instantes e confirme a exclusão novamente.');
  }
}
async function groupEffects(client, id) {
  const row = (await client.query(`SELECT (SELECT count(*) FROM as_memberships WHERE group_id=$1) AS memberships,
    (SELECT count(*) FROM as_draw_results WHERE group_id=$1) AS results,(SELECT count(*) FROM as_outbox WHERE group_id=$1) AS notifications`, [id])).rows[0];
  return { groupsDeleted: 1, membershipsDeleted: Number(row.memberships), resultsDeleted: Number(row.results), notificationsDeleted: Number(row.notifications) };
}
export async function adminGroupDeletePreview(user, id) {
  requireAdmin(user); requireUUID(id);
  const group = (await query('SELECT id,name FROM as_groups WHERE id=$1', [id])).rows[0];
  if (!group) throw missing();
  return { group, effects: await groupEffects({ query }, id), canDelete: true };
}
export async function adminDeleteGroup(user, id, body) {
  requireAdmin(user); requireUUID(id);
  return transaction(async client => {
    const group = (await client.query('SELECT id,name FROM as_groups WHERE id=$1 FOR UPDATE', [id])).rows[0];
    if (!group) throw missing();
    confirmation(body?.confirmation, group.name, 'o nome do amigo secreto');
    checkSending((await client.query('SELECT state,lease_until FROM as_outbox WHERE group_id=$1 ORDER BY id FOR UPDATE', [id])).rows);
    const effects = await groupEffects(client, id);
    await client.query('DELETE FROM as_draw_results WHERE group_id=$1', [id]);
    await client.query('DELETE FROM as_groups WHERE id=$1', [id]);
    return { ok: true, deletedId: id, effects };
  });
}
async function userEffects(client, person) {
  const row = (await client.query(`SELECT (SELECT count(*) FROM as_groups WHERE organizer_id=$1) AS owned_groups,
    (SELECT count(*) FROM as_memberships m JOIN as_groups g ON g.id=m.group_id WHERE ${affectedMember} AND g.organizer_id<>$1 AND NOT ${participatesInDraw}) AS memberships_removed,
    (SELECT count(*) FROM as_memberships m JOIN as_groups g ON g.id=m.group_id WHERE ${affectedMember} AND g.organizer_id<>$1 AND ${participatesInDraw}) AS anonymized,
    (SELECT count(*) FROM as_outbox n WHERE ${affectedOutbox}) AS notifications`, [person.id, person.email])).rows[0];
  return { groupsDeleted: Number(row.owned_groups), membershipsRemoved: Number(row.memberships_removed), drawnParticipationsAnonymized: Number(row.anonymized), notificationsDeleted: Number(row.notifications) };
}
export async function adminUserDeletePreview(user, id) {
  requireAdmin(user); requireUUID(id);
  const person = (await query("SELECT id,email,first_name || ' ' || last_name AS name FROM as_users WHERE id=$1 AND deleted_at IS NULL", [id])).rows[0];
  if (!person) throw missing();
  const canDelete = !isAdmin(person);
  return { user: person, effects: await userEffects({ query }, person), canDelete, blockedReason: canDelete ? null : protectedAccount };
}
export async function adminDeleteUser(user, id, body) {
  requireAdmin(user); requireUUID(id);
  return transaction(async client => {
    const lookup = (await client.query('SELECT email FROM as_users WHERE id=$1 AND deleted_at IS NULL', [id])).rows[0];
    if (!lookup) throw missing();
    // The same email lock serializes signup proofs; the user lock serializes login,
    // recovery and mutations that could attach a fresh group or membership.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`account:${lookup.email}`]);
    const person = (await client.query('SELECT id,email FROM as_users WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id])).rows[0];
    if (!person) throw missing();
    if (isAdmin(person)) throw new ApiError(409, 'ADMIN_ACCOUNT_PROTECTED', protectedAccount);
    confirmation(body?.confirmation, person.email, 'o e-mail da conta');
    const groups = (await client.query(`SELECT g.id,g.organizer_id FROM as_groups g WHERE g.organizer_id=$1 OR EXISTS(
      SELECT 1 FROM as_memberships m WHERE m.group_id=g.id AND ${affectedMember}) ORDER BY g.id FOR UPDATE OF g`, [id, person.email])).rows;
    const owned = groups.filter(group => group.organizer_id === id).map(group => group.id);
    const deliveries = await client.query(`SELECT n.id,n.state,n.lease_until FROM as_outbox n
      WHERE ${affectedOutbox} OR n.payload->'match'->>'id'=$1::text ORDER BY n.id FOR UPDATE OF n`, [id, person.email]);
    checkSending(deliveries.rows);
    const effects = await userEffects(client, person);

    await client.query('DELETE FROM as_sessions WHERE user_id=$1', [id]);
    await client.query('DELETE FROM as_password_resets WHERE user_id=$1', [id]);
    await client.query('DELETE FROM as_auth_challenges WHERE user_id=$1 OR email=$2', [id, person.email]);
    await client.query(`DELETE FROM as_outbox n WHERE ${affectedOutbox}`, [id, person.email]);
    // Other participants keep their draw and receive only the anonymous identity
    // if a result message is still waiting to be delivered.
    await client.query(`UPDATE as_outbox SET payload=jsonb_set(payload,'{match}',$2::jsonb)
      WHERE payload->'match'->>'id'=$1::text`, [id, JSON.stringify({ id, firstName: 'Participante', lastName: 'removido', name: 'Participante removido', email: '', avatar: null })]);
    if (owned.length) {
      await client.query('DELETE FROM as_draw_results WHERE group_id=ANY($1::uuid[])', [owned]);
      await client.query('DELETE FROM as_groups WHERE id=ANY($1::uuid[])', [owned]);
    }
    await client.query(`DELETE FROM as_memberships m WHERE ${affectedMember} AND NOT ${participatesInDraw}`, [id, person.email]);
    const anonymousEmail = `deleted-${id}@removed.invalid`;
    await client.query(`UPDATE as_memberships m SET email=$3,invited_name='Participante removido',invite_token_hash=NULL,
      tracking_token_hash=NULL,invite_expires_at=NULL,sent_at=NULL,delivered_at=NULL,opened_at=NULL,last_invited_at=NULL
      WHERE ${affectedMember}`, [id, person.email, anonymousEmail]);
    await client.query(`UPDATE as_users SET email=$2,first_name='Participante',last_name='removido',avatar=NULL,
      password_hash=NULL,password_changed_at=NULL,deleted_at=now(),updated_at=now() WHERE id=$1`, [id, anonymousEmail]);
    return { ok: true, deletedId: id, effects };
  });
}
