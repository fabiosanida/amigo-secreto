import { randomUUID } from 'node:crypto';
import { ApiError, query, requireUUID, transaction } from './db.js';
import { rateLimit } from './auth.js';
import { normalizeName } from './profile.js';

export const DEPENDENTS_PAGE_SIZE = 50;
export function dependentView(row) {
  return { id: row.id, firstName: row.first_name, lastName: row.last_name, name: `${row.first_name} ${row.last_name}`, createdAt: row.created_at };
}
export function validateDependent(body) {
  return { firstName: normalizeName(body?.firstName, 'o nome do dependente', 80), lastName: normalizeName(body?.lastName, 'o sobrenome do dependente', 120) };
}
async function lockGuardian(client, user) {
  // Account deletion takes this lock before any group/dependent mutation, too.
  const guardian = (await client.query('SELECT id FROM as_users WHERE id=$1 AND deleted_at IS NULL AND verified_at IS NOT NULL FOR UPDATE', [user.id])).rows[0];
  if (!guardian) throw new ApiError(401, 'UNAUTHORIZED', 'Entre na sua conta para continuar.');
}
function decodeCursor(value, userId, groupId) {
  if (value == null || value === '') return null;
  try {
    if (typeof value !== 'string' || value.length > 600 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (cursor.userId !== userId || cursor.groupId !== groupId || typeof cursor.createdAt !== 'string'
      || !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(cursor.createdAt)
      || !Number.isFinite(Date.parse(cursor.createdAt))
      || new Date(cursor.createdAt).toISOString().slice(0, 10) !== cursor.createdAt.slice(0, 10)) throw new Error();
    return { id: requireUUID(cursor.id), createdAt: cursor.createdAt };
  } catch { throw new ApiError(400, 'INVALID_CURSOR', 'Não foi possível carregar mais dependentes. Abra a lista novamente.'); }
}
export function dependentsPage(rows, userId, groupId = null) {
  const page = rows.slice(0, DEPENDENTS_PAGE_SIZE), last = page.at(-1);
  return {
    dependents: page.map(row => ({ ...dependentView(row), ...(groupId ? { active: Boolean(row.membership_id), membershipId: row.membership_id || null } : {}) })),
    nextCursor: rows.length > DEPENDENTS_PAGE_SIZE ? Buffer.from(JSON.stringify({
      userId, groupId, id: last.id, createdAt: last.cursor_created_at,
    })).toString('base64url') : null,
  };
}
// Keep microseconds in the cursor, independently of node-postgres Date rounding.
export const dependentCursorColumn = `to_char(d.created_at AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US') || '+00' AS cursor_created_at`;
export async function listDependents(user, options = {}) {
  const groupId = options.groupId ? requireUUID(options.groupId).toLowerCase() : null;
  const cursor = decodeCursor(options.cursor, user.id, groupId);
  if (groupId) {
    const group = (await query(`SELECT g.id FROM as_groups g JOIN as_users o ON o.id=g.organizer_id
      WHERE g.id=$1 AND o.deleted_at IS NULL AND (g.organizer_id=$2 OR EXISTS(
        SELECT 1 FROM as_memberships m WHERE m.group_id=g.id AND m.user_id=$2 AND m.status='accepted'))`, [groupId, user.id])).rows[0];
    if (!group) throw new ApiError(404, 'NOT_FOUND', 'Não encontramos esse grupo.');
  }
  const { rows } = await query(`SELECT d.id,d.first_name,d.last_name,d.created_at,${dependentCursorColumn},m.id AS membership_id
    FROM as_dependents d JOIN as_users u ON u.id=d.guardian_id
    LEFT JOIN as_memberships m ON m.dependent_id=d.id AND m.group_id=$2::uuid
    WHERE d.guardian_id=$1 AND d.deleted_at IS NULL AND u.deleted_at IS NULL
      AND ($3::timestamptz IS NULL OR (d.created_at,d.id)>($3::timestamptz,$4::uuid))
    ORDER BY d.created_at,d.id LIMIT $5`, [user.id, groupId, cursor?.createdAt || null, cursor?.id || null, DEPENDENTS_PAGE_SIZE + 1]);
  return dependentsPage(rows, user.id, groupId);
}
async function insertDependent(client, user, value, id) {
  const row = (await client.query(`INSERT INTO as_dependents(id,guardian_id,first_name,last_name) VALUES($1,$2,$3,$4)
    ON CONFLICT(id) DO NOTHING RETURNING id,first_name,last_name,created_at`, [id, user.id, value.firstName, value.lastName])).rows[0];
  if (row) return row;
  // A retry may reuse only the same caller's original identity. Never take over
  // an existing dependent or silently change the name behind a repeated key.
  const previous = (await client.query(`SELECT id,first_name,last_name,created_at FROM as_dependents
    WHERE id=$1 AND guardian_id=$2 AND deleted_at IS NULL`, [id, user.id])).rows[0];
  if (!previous || previous.first_name !== value.firstName || previous.last_name !== value.lastName) {
    throw new ApiError(409, 'DEPENDENT_CONFLICT', 'Esse cadastro já foi usado. Atualize a página antes de cadastrar outra pessoa.');
  }
  return previous;
}
export async function createDependent(user, body) {
  const value = validateDependent(body), id = body?.id === undefined ? randomUUID() : requireUUID(body.id).toLowerCase();
  await rateLimit('create-dependent', user.id, 300, 86400);
  return transaction(async client => {
    await lockGuardian(client, user);
    const row = await insertDependent(client, user, value, id);
    return { dependent: dependentView(row) };
  });
}
export async function createGroupDependent(user, groupId, body) {
  requireUUID(groupId);
  const value = validateDependent(body), id = requireUUID(body?.id).toLowerCase();
  await rateLimit('create-dependent', user.id, 300, 86400);
  return transaction(async client => {
    await lockGuardian(client, user);
    const group = (await client.query(`SELECT g.id,g.organizer_id,g.drawn_at FROM as_groups g JOIN as_users o ON o.id=g.organizer_id
      WHERE g.id=$1 AND o.deleted_at IS NULL FOR UPDATE OF g`, [groupId])).rows[0];
    if (!group) throw new ApiError(404, 'NOT_FOUND', 'Não encontramos esse grupo.');
    if (group.organizer_id !== user.id) throw new ApiError(403, 'FORBIDDEN', 'Apenas quem organiza pode cadastrar diretamente neste grupo.');
    if (group.drawn_at) throw new ApiError(409, 'GROUP_DRAWN', 'Os participantes não podem mudar depois do sorteio.');
    const child = await insertDependent(client, user, value, id);
    let member = (await client.query('SELECT id FROM as_memberships WHERE group_id=$1 AND dependent_id=$2', [groupId, id])).rows[0];
    if (!member) {
      const count = Number((await client.query('SELECT count(*) FROM as_memberships WHERE group_id=$1', [groupId])).rows[0].count);
      if (count >= 200) throw new ApiError(400, 'GROUP_FULL', 'O grupo pode ter até 200 pessoas.');
      member = (await client.query(`INSERT INTO as_memberships(id,group_id,dependent_id,status,accepted_at)
        VALUES($1,$2,$3,'accepted',now()) RETURNING id`, [randomUUID(), groupId, id])).rows[0];
    }
    return { dependent: { ...dependentView(child), active: true, membershipId: member.id }, active: true };
  });
}
export async function setDependentParticipation(user, groupId, dependentId, body) {
  requireUUID(groupId); requireUUID(dependentId);
  if (typeof body?.active !== 'boolean') throw new ApiError(400, 'INVALID_PARTICIPATION', 'Escolha se o dependente vai participar deste grupo.');
  await rateLimit('dependent-participation', user.id, 120, 3600);
  return transaction(async client => {
    await lockGuardian(client, user);
    const group = (await client.query(`SELECT g.id,g.drawn_at FROM as_groups g JOIN as_users o ON o.id=g.organizer_id
      WHERE g.id=$1 AND o.deleted_at IS NULL FOR UPDATE OF g`, [groupId])).rows[0];
    if (!group) throw new ApiError(403, 'NOT_PARTICIPATING', 'Confirme sua participação no grupo antes de incluir um dependente.');
    // Read membership after acquiring the group lock. A concurrent organizer
    // removal may have committed while this statement was waiting on that lock.
    const participating = (await client.query("SELECT id FROM as_memberships WHERE group_id=$1 AND user_id=$2 AND status='accepted'", [groupId, user.id])).rows[0];
    if (!participating) throw new ApiError(403, 'NOT_PARTICIPATING', 'Confirme sua participação no grupo antes de incluir um dependente.');
    if (group.drawn_at) throw new ApiError(409, 'GROUP_DRAWN', 'A participação dos dependentes não pode mudar depois do sorteio.');
    const child = (await client.query(`SELECT id,first_name,last_name,created_at FROM as_dependents
      WHERE id=$1 AND guardian_id=$2 AND deleted_at IS NULL FOR UPDATE`, [dependentId, user.id])).rows[0];
    if (!child) throw new ApiError(404, 'DEPENDENT_NOT_FOUND', 'Não encontramos esse dependente na sua conta.');
    let membership = (await client.query('SELECT id FROM as_memberships WHERE group_id=$1 AND dependent_id=$2', [groupId, dependentId])).rows[0];
    if (body.active && !membership) {
      const count = Number((await client.query('SELECT count(*) FROM as_memberships WHERE group_id=$1', [groupId])).rows[0].count);
      if (count >= 200) throw new ApiError(400, 'GROUP_FULL', 'O grupo pode ter até 200 pessoas.');
      membership = (await client.query(`INSERT INTO as_memberships(id,group_id,dependent_id,status,accepted_at)
        VALUES($1,$2,$3,'accepted',now()) RETURNING id`, [randomUUID(), groupId, dependentId])).rows[0];
    } else if (!body.active && membership) {
      await client.query('DELETE FROM as_memberships WHERE id=$1', [membership.id]);
      membership = null;
    }
    return { dependent: { ...dependentView(child), active: Boolean(membership), membershipId: membership?.id || null }, active: Boolean(membership) };
  });
}
