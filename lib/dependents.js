import { randomUUID } from 'node:crypto';
import { ApiError, query, requireUUID, transaction } from './db.js';
import { rateLimit } from './auth.js';
import { normalizeName } from './profile.js';

export const MAX_DEPENDENTS = 20;
export function dependentView(row) {
  return { id: row.id, firstName: row.first_name, lastName: row.last_name, name: `${row.first_name} ${row.last_name}`, createdAt: row.created_at };
}
export function validateDependent(body) {
  return { firstName: normalizeName(body.firstName, 'o nome do dependente', 80), lastName: normalizeName(body.lastName, 'o sobrenome do dependente', 120) };
}
async function lockGuardian(client, user) {
  // Account deletion takes this lock before any group/dependent mutation, too.
  const guardian = (await client.query('SELECT id FROM as_users WHERE id=$1 AND deleted_at IS NULL AND verified_at IS NOT NULL FOR UPDATE', [user.id])).rows[0];
  if (!guardian) throw new ApiError(401, 'UNAUTHORIZED', 'Entre na sua conta para continuar.');
}
export async function listDependents(user) {
  const { rows } = await query(`SELECT d.id,d.first_name,d.last_name,d.created_at FROM as_dependents d JOIN as_users u ON u.id=d.guardian_id
    WHERE d.guardian_id=$1 AND d.deleted_at IS NULL AND u.deleted_at IS NULL ORDER BY d.created_at,d.id LIMIT $2`, [user.id, MAX_DEPENDENTS]);
  return { dependents: rows.map(dependentView) };
}
export async function createDependent(user, body) {
  const value = validateDependent(body);
  await rateLimit('create-dependent', user.id, 30, 86400);
  return transaction(async client => {
    await lockGuardian(client, user);
    const count = Number((await client.query('SELECT count(*) FROM as_dependents WHERE guardian_id=$1 AND deleted_at IS NULL', [user.id])).rows[0].count);
    if (count >= MAX_DEPENDENTS) throw new ApiError(400, 'DEPENDENTS_LIMIT', `Você pode cadastrar até ${MAX_DEPENDENTS} dependentes.`);
    const row = (await client.query(`INSERT INTO as_dependents(id,guardian_id,first_name,last_name) VALUES($1,$2,$3,$4)
      RETURNING id,first_name,last_name,created_at`, [randomUUID(), user.id, value.firstName, value.lastName])).rows[0];
    return { dependent: dependentView(row) };
  });
}
export async function setDependentParticipation(user, groupId, dependentId, body) {
  requireUUID(groupId); requireUUID(dependentId);
  if (typeof body?.active !== 'boolean') throw new ApiError(400, 'INVALID_PARTICIPATION', 'Escolha se o dependente vai participar deste grupo.');
  await rateLimit('dependent-participation', user.id, 120, 3600);
  return transaction(async client => {
    await lockGuardian(client, user);
    const group = (await client.query(`SELECT g.id,g.drawn_at FROM as_groups g JOIN as_users o ON o.id=g.organizer_id
      WHERE g.id=$1 AND o.deleted_at IS NULL AND EXISTS(SELECT 1 FROM as_memberships m
        WHERE m.group_id=g.id AND m.user_id=$2 AND m.status='accepted') FOR UPDATE OF g`, [groupId, user.id])).rows[0];
    if (!group) throw new ApiError(403, 'NOT_PARTICIPATING', 'Confirme sua participação no grupo antes de incluir um dependente.');
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
