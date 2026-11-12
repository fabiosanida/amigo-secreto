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
    SELECT m.id,COALESCE(d.first_name || ' ' || d.last_name,u.first_name || ' ' || u.last_name) AS name,
      m.dependent_id AS "dependentId",m.dependent_id IS NOT NULL AS "isDependent",
      CASE WHEN d.deleted_at IS NULL AND guardian.deleted_at IS NULL THEN guardian.id ELSE NULL END AS "guardianId",
      CASE WHEN d.deleted_at IS NULL AND guardian.deleted_at IS NULL THEN guardian.first_name || ' ' || guardian.last_name ELSE '' END AS "responsibleName"
    FROM as_draw_results r JOIN as_memberships m ON m.group_id=r.group_id AND m.id=r.giver_id
    LEFT JOIN as_users u ON u.id=m.user_id LEFT JOIN as_dependents d ON d.id=m.dependent_id LEFT JOIN as_users guardian ON guardian.id=d.guardian_id
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
    giver.id AS giver_id,COALESCE(gd.first_name || ' ' || gd.last_name,gu.first_name || ' ' || gu.last_name) AS giver_name,
    giver.dependent_id AS giver_dependent_id,
    CASE WHEN gd.deleted_at IS NULL AND gg.deleted_at IS NULL THEN gg.id ELSE NULL END AS giver_guardian_id,
    CASE WHEN gd.deleted_at IS NULL AND gg.deleted_at IS NULL THEN gg.first_name || ' ' || gg.last_name ELSE '' END AS giver_responsible_name,
    receiver.id AS receiver_id,COALESCE(rd.first_name || ' ' || rd.last_name,ru.first_name || ' ' || ru.last_name) AS receiver_name,
    receiver.dependent_id AS receiver_dependent_id,
    CASE WHEN rd.deleted_at IS NULL AND rg.deleted_at IS NULL THEN rg.id ELSE NULL END AS receiver_guardian_id,
    CASE WHEN rd.deleted_at IS NULL AND rg.deleted_at IS NULL THEN rg.first_name || ' ' || rg.last_name ELSE '' END AS receiver_responsible_name
    FROM as_groups g JOIN as_draw_results r ON r.group_id=g.id AND r.giver_id=$2
    JOIN as_memberships giver ON giver.group_id=g.id AND giver.id=r.giver_id LEFT JOIN as_users gu ON gu.id=giver.user_id
    LEFT JOIN as_dependents gd ON gd.id=giver.dependent_id LEFT JOIN as_users gg ON gg.id=gd.guardian_id
    JOIN as_draw_results recipient_draw ON recipient_draw.group_id=g.id AND recipient_draw.giver_id=$3
    JOIN as_memberships receiver ON receiver.group_id=g.id AND receiver.id=recipient_draw.giver_id LEFT JOIN as_users ru ON ru.id=receiver.user_id
    LEFT JOIN as_dependents rd ON rd.id=receiver.dependent_id LEFT JOIN as_users rg ON rg.id=rd.guardian_id
    WHERE g.id=$1 AND g.drawn_at IS NOT NULL`, [groupId, giverId, receiverId]);
  if (!rows[0]) throw new ApiError(404, 'NOT_FOUND', 'Escolha duas pessoas que participaram deste sorteio.');
  const row = rows[0];
  const identity = side => ({ id: row[`${side}_id`], name: row[`${side}_name`],
    ...(row[`${side}_dependent_id`] ? { dependentId: row[`${side}_dependent_id`], isDependent: true,
      guardianId: row[`${side}_guardian_id`] || null, responsibleName: row[`${side}_responsible_name`] || '' } : {}) });
  return { matches: row.matches, group: { id: row.id, name: row.name }, giver: identity('giver'), receiver: identity('receiver') };
}
