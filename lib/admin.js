import { ApiError, query, requireUUID } from './db.js';
import { requireAdmin } from './admin-access.js';

export function adminPagination(params = {}) {
  const page = Number(params.page || 1), pageSize = Number(params.limit || 25);
  const search = String(params.search || '').trim();
  if (!Number.isSafeInteger(page) || page < 1 || page > 10000 || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 50 || search.length > 100) {
    throw new ApiError(400, 'INVALID_FILTER', 'Confira a busca e a página solicitada.');
  }
  return { page, pageSize, offset: (page - 1) * pageSize, search: search.replace(/[\\%_]/g, value => `\\${value}`) };
}
const pagination = (total, page, pageSize) => ({ page, pageSize, total: Number(total), totalPages: Math.max(1, Math.ceil(Number(total) / pageSize)) });
const groupFields = `g.id,g.name,to_char(g.event_date,'YYYY-MM-DD') AS event_date,g.budget,g.drawn_at,g.created_at,g.organizer_id,
  o.first_name || ' ' || o.last_name AS organizer_name,o.email AS organizer_email`;
const groupCounts = `count(*) AS participant_count,count(*) FILTER(WHERE status='accepted') AS accepted_count,
  count(*) FILTER(WHERE status<>'accepted') AS pending_count`;
const groupDto = row => ({ id: row.id, name: row.name, date: row.event_date, budget: Number(row.budget), drawn: Boolean(row.drawn_at), drawnAt: row.drawn_at,
  createdAt: row.created_at, organizer: { id: row.organizer_id, name: row.organizer_name, email: row.organizer_email },
  participantCount: Number(row.participant_count || 0), acceptedCount: Number(row.accepted_count || 0), pendingCount: Number(row.pending_count || 0),
  ...(row.location !== undefined ? { location: row.location, description: row.description } : {}),
  ...(row.membership_status ? { membershipStatus: row.membership_status } : {}) });
const userDto = row => ({ id: row.id, firstName: row.first_name, lastName: row.last_name, name: `${row.first_name} ${row.last_name}`, email: row.email,
  createdAt: row.created_at, createdCount: Number(row.created_count || 0), participatingCount: Number(row.participating_count || 0) });

export async function adminOverview(user) {
  requireAdmin(user);
  const { rows } = await query(`SELECT (SELECT count(*) FROM as_groups) AS groups,
    (SELECT count(*) FROM as_groups WHERE drawn_at IS NOT NULL) AS drawn_groups,
    (SELECT count(*) FROM as_users) AS users,
    (SELECT count(*) FROM as_memberships WHERE status='accepted') AS participants,
    (SELECT count(*) FROM as_memberships m JOIN as_groups g ON g.id=m.group_id WHERE m.status<>'accepted' AND g.drawn_at IS NULL AND m.invite_expires_at>now()) AS pending_invitations`);
  const row = rows[0];
  return { summary: { groups: Number(row.groups), drawnGroups: Number(row.drawn_groups), users: Number(row.users), participants: Number(row.participants), pendingInvitations: Number(row.pending_invitations) } };
}
export async function adminGroups(user, params = {}) {
  requireAdmin(user);
  const { page, pageSize, offset, search } = adminPagination(params);
  const { rows } = await query(`WITH filtered AS (
    SELECT ${groupFields} FROM as_groups g JOIN as_users o ON o.id=g.organizer_id
    WHERE $1='' OR g.name ILIKE '%' || $1 || '%' OR o.email ILIKE '%' || $1 || '%' OR (o.first_name || ' ' || o.last_name) ILIKE '%' || $1 || '%'
  ), page_rows AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3)
  SELECT (SELECT count(*) FROM filtered) AS total,
    COALESCE((SELECT json_agg(item ORDER BY item.created_at DESC,item.id DESC) FROM (
      SELECT p.*,c.* FROM page_rows p LEFT JOIN LATERAL (SELECT ${groupCounts} FROM as_memberships WHERE group_id=p.id) c ON true
    ) item),'[]'::json) AS items`, [search, pageSize, offset]);
  return { groups: rows[0].items.map(groupDto), pagination: pagination(rows[0].total, page, pageSize) };
}
export async function adminGroup(user, id) {
  requireAdmin(user); requireUUID(id);
  const group = (await query(`SELECT ${groupFields},g.location,g.description,c.* FROM as_groups g JOIN as_users o ON o.id=g.organizer_id
    LEFT JOIN LATERAL (SELECT ${groupCounts} FROM as_memberships WHERE group_id=g.id) c ON true WHERE g.id=$1`, [id])).rows[0];
  if (!group) throw new ApiError(404, 'NOT_FOUND', 'Não encontramos esse grupo.');
  const [members, results] = await Promise.all([
    query(`SELECT m.id,m.user_id,m.email,m.status,m.accepted_at,m.created_at AS invited_at,
      COALESCE(u.first_name || ' ' || u.last_name,NULLIF(m.invited_name,''),m.email) AS name
      FROM as_memberships m LEFT JOIN as_users u ON u.id=m.user_id WHERE m.group_id=$1 ORDER BY m.created_at,m.id`, [id]),
    query(`SELECT r.giver_id,r.receiver_id,g.user_id AS giver_user_id,g.email AS giver_email,gu.first_name || ' ' || gu.last_name AS giver_name,
      d.user_id AS receiver_user_id,d.email AS receiver_email,du.first_name || ' ' || du.last_name AS receiver_name
      FROM as_draw_results r JOIN as_memberships g ON g.id=r.giver_id AND g.group_id=r.group_id
      JOIN as_memberships d ON d.id=r.receiver_id AND d.group_id=r.group_id
      JOIN as_users gu ON gu.id=g.user_id JOIN as_users du ON du.id=d.user_id WHERE r.group_id=$1 ORDER BY giver_name,r.giver_id`, [id]),
  ]);
  return { group: groupDto(group), participants: members.rows.map(row => ({ id: row.id, userId: row.user_id, name: row.name, email: row.email, status: row.status, acceptedAt: row.accepted_at, invitedAt: row.invited_at })),
    results: results.rows.map(row => ({ giver: { id: row.giver_id, userId: row.giver_user_id, name: row.giver_name, email: row.giver_email }, receiver: { id: row.receiver_id, userId: row.receiver_user_id, name: row.receiver_name, email: row.receiver_email } })) };
}
export async function adminUsers(user, params = {}) {
  requireAdmin(user);
  const { page, pageSize, offset, search } = adminPagination(params);
  const { rows } = await query(`WITH filtered AS (
    SELECT id,first_name,last_name,email,created_at FROM as_users
    WHERE $1='' OR email ILIKE '%' || $1 || '%' OR (first_name || ' ' || last_name) ILIKE '%' || $1 || '%'
  ), page_rows AS (SELECT * FROM filtered ORDER BY created_at DESC,id DESC LIMIT $2 OFFSET $3)
  SELECT (SELECT count(*) FROM filtered) AS total,
    COALESCE((SELECT json_agg(item ORDER BY item.created_at DESC,item.id DESC) FROM (
      SELECT p.*,(SELECT count(*) FROM as_groups WHERE organizer_id=p.id) AS created_count,
        (SELECT count(*) FROM as_memberships WHERE user_id=p.id AND status='accepted') AS participating_count FROM page_rows p
    ) item),'[]'::json) AS items`, [search, pageSize, offset]);
  return { users: rows[0].items.map(userDto), pagination: pagination(rows[0].total, page, pageSize) };
}
export async function adminUser(user, id, params = {}) {
  requireAdmin(user); requireUUID(id);
  // Each association list is bounded independently; changing a page never fetches the entire history.
  const created = adminPagination({ page: params.createdPage, limit: params.limit });
  const participating = adminPagination({ page: params.participatingPage, limit: params.limit });
  const person = (await query(`SELECT id,first_name,last_name,email,created_at,
    (SELECT count(*) FROM as_groups WHERE organizer_id=u.id) AS created_count,
    (SELECT count(*) FROM as_memberships WHERE user_id=u.id AND status='accepted') AS participating_count FROM as_users u WHERE id=$1`, [id])).rows[0];
  if (!person) throw new ApiError(404, 'NOT_FOUND', 'Não encontramos essa conta.');
  const [createdGroups, participatingGroups] = await Promise.all([
    query(`SELECT ${groupFields},c.* FROM as_groups g JOIN as_users o ON o.id=g.organizer_id
      LEFT JOIN LATERAL (SELECT ${groupCounts} FROM as_memberships WHERE group_id=g.id) c ON true
      WHERE g.organizer_id=$1 ORDER BY g.created_at DESC,g.id DESC LIMIT $2 OFFSET $3`, [id, created.pageSize, created.offset]),
    query(`SELECT ${groupFields},m.status AS membership_status,c.* FROM as_memberships m JOIN as_groups g ON g.id=m.group_id JOIN as_users o ON o.id=g.organizer_id
      LEFT JOIN LATERAL (SELECT ${groupCounts} FROM as_memberships WHERE group_id=g.id) c ON true
      WHERE m.user_id=$1 AND m.status='accepted' ORDER BY g.created_at DESC,g.id DESC LIMIT $2 OFFSET $3`, [id, participating.pageSize, participating.offset]),
  ]);
  return { user: userDto(person), groupsCreated: createdGroups.rows.map(groupDto), groupsParticipating: participatingGroups.rows.map(groupDto),
    createdPagination: pagination(person.created_count, created.page, created.pageSize), participatingPagination: pagination(person.participating_count, participating.page, participating.pageSize) };
}
