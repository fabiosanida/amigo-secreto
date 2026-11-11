import { ApiError, query, requireUUID } from './db.js';
import { requireAdmin } from './admin-access.js';
import { adminPagination } from './admin.js';

export async function marmeladaGroups(user, params = {}) {
  requireAdmin(user);
  const { page, pageSize, offset, search } = adminPagination(params);
  const { rows } = await query(`WITH filtered AS (
    SELECT id,name,to_char(event_date,'YYYY-MM-DD') AS date,drawn_at FROM as_groups
    WHERE drawn_at IS NOT NULL AND ($1='' OR name ILIKE '%' || $1 || '%')
  ), page_rows AS (SELECT * FROM filtered ORDER BY drawn_at DESC,id DESC LIMIT $2 OFFSET $3)
  SELECT (SELECT count(*) FROM filtered) AS total,COALESCE((SELECT json_agg(item ORDER BY item.drawn_at DESC,item.id DESC)
    FROM (SELECT p.*,(SELECT count(*) FROM as_draw_results r WHERE r.group_id=p.id) AS participant_count FROM page_rows p) item),'[]'::json) AS items`, [search, pageSize, offset]);
  return { groups: rows[0].items.map(row => ({ id: row.id, name: row.name, date: row.date, drawnAt: row.drawn_at, participantCount: Number(row.participant_count) })),
    pagination: { page, pageSize, total: Number(rows[0].total), totalPages: Math.max(1, Math.ceil(Number(rows[0].total) / pageSize)) } };
}
export async function marmeladaGroup(user, id) {
  requireAdmin(user); requireUUID(id);
  const { rows } = await query(`SELECT g.id,g.name,COALESCE((SELECT json_agg(person ORDER BY person.name,person.id) FROM (
    SELECT m.id,u.first_name || ' ' || u.last_name AS name FROM as_draw_results r
    JOIN as_memberships m ON m.group_id=r.group_id AND m.id=r.giver_id JOIN as_users u ON u.id=m.user_id
    WHERE r.group_id=g.id) person),'[]'::json) AS participants FROM as_groups g WHERE g.id=$1 AND g.drawn_at IS NOT NULL`, [id]);
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Não encontramos esse sorteio.');
  return { group: { id: rows[0].id, name: rows[0].name }, participants: rows[0].participants };
}
export async function checkMarmelada(user, body) {
  requireAdmin(user);
  const { groupId, giverId, receiverId } = body || {};
  requireUUID(groupId); requireUUID(giverId); requireUUID(receiverId);
  // Only the predicate crosses the API boundary; a wrong guess never reveals the actual recipient.
  const { rows } = await query(`SELECT g.id,g.name,r.receiver_id=$3 AS matches,
    giver.id AS giver_id,gu.first_name || ' ' || gu.last_name AS giver_name,
    receiver.id AS receiver_id,ru.first_name || ' ' || ru.last_name AS receiver_name
    FROM as_groups g JOIN as_draw_results r ON r.group_id=g.id AND r.giver_id=$2
    JOIN as_memberships giver ON giver.group_id=g.id AND giver.id=r.giver_id JOIN as_users gu ON gu.id=giver.user_id
    JOIN as_draw_results recipient_draw ON recipient_draw.group_id=g.id AND recipient_draw.giver_id=$3
    JOIN as_memberships receiver ON receiver.group_id=g.id AND receiver.id=recipient_draw.giver_id JOIN as_users ru ON ru.id=receiver.user_id
    WHERE g.id=$1 AND g.drawn_at IS NOT NULL`, [groupId, giverId, receiverId]);
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Escolha duas pessoas que participaram deste sorteio.');
  const row = rows[0];
  return { matches: row.matches, group: { id: row.id, name: row.name }, giver: { id: row.giver_id, name: row.giver_name }, receiver: { id: row.receiver_id, name: row.receiver_name } };
}
