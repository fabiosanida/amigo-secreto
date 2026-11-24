import { ApiError, query, requireUUID, transaction } from './db.js';
import { rateLimit } from './auth.js';

export const WISHLIST_PAGE_SIZE = 50;
export const WISHLIST_MUTATION_SIZE = 50;
const missing = () => new ApiError(404, 'WISHLIST_NOT_FOUND', 'Não encontramos essa lista de presentes para a sua participação.');
const invalidChanges = () => new ApiError(400, 'INVALID_WISHLIST', 'Confira os itens da sua lista de presentes.');
const optionalDependent = value => value == null || value === '' ? null : requireUUID(value);

export function validateWishlistURL(value) {
  if (value == null || value === '') return '';
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_GIFT_URL', 'Informe um link válido começando com https:// ou http://.');
  const input = value.trim();
  if (!input) return '';
  let url;
  try { url = new URL(input); } catch {}
  if (!url || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || /[\s\\\u0000-\u001f\u007f]/u.test(input) || input.length > 2048 || url.href.length > 2048) {
    throw new ApiError(400, 'INVALID_GIFT_URL', 'Informe um link válido começando com https:// ou http://, com até 2.048 caracteres.');
  }
  return url.href;
}

export function validateWishlistChanges(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalidChanges();
  const upserts = body.upserts ?? [], deletedIds = body.deletedIds ?? [];
  if (!Array.isArray(upserts) || !Array.isArray(deletedIds) || upserts.length + deletedIds.length > WISHLIST_MUTATION_SIZE) throw invalidChanges();
  const seen = new Set();
  const itemId = value => {
    const id = requireUUID(value).toLowerCase();
    if (seen.has(id)) throw invalidChanges();
    seen.add(id); return id;
  };
  return {
    dependentId: optionalDependent(body.dependentId),
    upserts: upserts.map(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.text !== 'string') throw invalidChanges();
      const text = item.text.trim();
      if (!text || text.length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text)) {
        throw new ApiError(400, 'INVALID_GIFT_TEXT', 'Descreva cada presente em até 2.000 caracteres ou remova o item vazio.');
      }
      return { id: itemId(item.id), text, url: validateWishlistURL(item.url) };
    }),
    deletedIds: deletedIds.map(itemId),
  };
}

function pageCursor(value) {
  if (value == null || value === '') return '0';
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new ApiError(400, 'INVALID_CURSOR', 'Não foi possível carregar a próxima parte da lista. Abra a lista novamente.');
  }
  return value;
}

const identityColumns = `m.id AS membership_id,m.dependent_id,u.first_name,u.last_name,u.avatar,u.deleted_at,
  d.first_name AS child_first_name,d.last_name AS child_last_name,d.deleted_at AS child_deleted_at,
  guardian.first_name AS guardian_first_name,guardian.last_name AS guardian_last_name,guardian.deleted_at AS guardian_deleted_at`;
const identityJoins = `LEFT JOIN as_users u ON u.id=m.user_id
  LEFT JOIN as_dependents d ON d.id=m.dependent_id LEFT JOIN as_users guardian ON guardian.id=d.guardian_id`;
function ownerView(row) {
  const isDependent = Boolean(row.dependent_id);
  const removed = Boolean(isDependent ? row.child_deleted_at || row.guardian_deleted_at : row.deleted_at);
  const firstName = removed ? 'Participante' : isDependent ? row.child_first_name : row.first_name;
  const lastName = removed ? 'removido' : isDependent ? row.child_last_name : row.last_name;
  return { membershipId: row.membership_id, name: `${firstName} ${lastName}`, firstName, lastName,
    isDependent, dependentId: row.dependent_id || null, avatar: removed || isDependent ? null : row.avatar || null,
    responsibleName: isDependent && !removed ? `${row.guardian_first_name} ${row.guardian_last_name}` : '' };
}

async function ownMembership(client, user, groupId, dependentId, lock = false) {
  const row = (await client.query(`SELECT ${identityColumns} FROM as_memberships m
    JOIN as_groups g ON g.id=m.group_id JOIN as_users organizer ON organizer.id=g.organizer_id
    JOIN as_users caller ON caller.id=$2 AND caller.deleted_at IS NULL AND caller.verified_at IS NOT NULL
    ${identityJoins}
    WHERE m.group_id=$1 AND m.status='accepted' AND organizer.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM as_memberships own WHERE own.group_id=g.id AND own.user_id=$2 AND own.status='accepted')
      AND (($3::uuid IS NULL AND m.user_id=$2 AND u.deleted_at IS NULL)
        OR ($3::uuid IS NOT NULL AND d.id=$3 AND d.guardian_id=$2 AND d.deleted_at IS NULL))
    ${lock ? 'FOR UPDATE OF m' : ''}`, [groupId, user.id, dependentId])).rows[0];
  if (!row) throw missing();
  return row;
}

async function readPage(row, cursor) {
  const removed = row.deleted_at || row.child_deleted_at || row.guardian_deleted_at;
  // Deleted accounts remain as anonymous draw slots; their old wishes must never
  // be exposed, even if a future deletion implementation omits its explicit scrub.
  const rows = removed ? [] : (await query(`SELECT id,text,url,position FROM as_wishlist_items
    WHERE membership_id=$1 AND position>$2::bigint ORDER BY position LIMIT $3`, [row.membership_id, cursor, WISHLIST_PAGE_SIZE + 1])).rows;
  return wishlistPage(row, rows);
}

function wishlistPage(row, rows) {
  const items = rows.slice(0, WISHLIST_PAGE_SIZE);
  return { owner: ownerView(row), items: items.map(({ id, text, url }) => ({ id, text, url })),
    nextCursor: rows.length > WISHLIST_PAGE_SIZE ? String(items.at(-1).position) : null };
}

export async function listWishlist(user, groupId, options = {}) {
  requireUUID(groupId);
  const dependentId = optionalDependent(options.dependentId), cursor = pageCursor(options.cursor);
  return readPage(await ownMembership({ query }, user, groupId, dependentId), cursor);
}

export async function saveWishlist(user, groupId, body) {
  requireUUID(groupId);
  const changes = validateWishlistChanges(body);
  await rateLimit('save-wishlist', user.id, 240, 3600);
  return transaction(async client => {
    // Match guardian deletion and dependent activation order: user -> group ->
    // membership. No new wish can survive account/group deletion or deactivation.
    const active = (await client.query(`SELECT id FROM as_users
      WHERE id=$1 AND deleted_at IS NULL AND verified_at IS NOT NULL FOR UPDATE`, [user.id])).rows[0];
    if (!active) throw new ApiError(401, 'UNAUTHORIZED', 'Entre na sua conta para continuar.');
    const group = (await client.query(`SELECT g.id FROM as_groups g JOIN as_users organizer ON organizer.id=g.organizer_id
      WHERE g.id=$1 AND organizer.deleted_at IS NULL AND EXISTS(SELECT 1 FROM as_memberships m
        WHERE m.group_id=g.id AND m.user_id=$2 AND m.status='accepted') FOR UPDATE OF g`, [groupId, user.id])).rows[0];
    if (!group) throw missing();
    const member = await ownMembership(client, user, groupId, changes.dependentId, true);
    const ids = [...changes.upserts.map(item => item.id), ...changes.deletedIds];
    if (ids.length) {
      const foreign = (await client.query(`SELECT id FROM as_wishlist_items
        WHERE id=ANY($1::uuid[]) AND membership_id<>$2 LIMIT 1`, [ids, member.membership_id])).rows[0];
      if (foreign) throw missing();
    }
    if (changes.deletedIds.length) await client.query('DELETE FROM as_wishlist_items WHERE membership_id=$1 AND id=ANY($2::uuid[])', [member.membership_id, changes.deletedIds]);
    if (changes.upserts.length) {
      const saved = await client.query(`INSERT INTO as_wishlist_items(id,membership_id,text,url)
        SELECT (item->>'id')::uuid,$1,item->>'text',item->>'url'
        FROM jsonb_array_elements($2::jsonb) WITH ORDINALITY AS incoming(item,ord) ORDER BY ord
        ON CONFLICT(id) DO UPDATE SET text=EXCLUDED.text,url=EXCLUDED.url,updated_at=now()
          WHERE as_wishlist_items.membership_id=EXCLUDED.membership_id
        RETURNING id`, [member.membership_id, JSON.stringify(changes.upserts)]);
      // The conditional conflict handles an id concurrently introduced on another
      // list without overwriting it. Roll back the whole request if that happens.
      if (saved.rowCount !== changes.upserts.length) throw missing();
    }
    return { ok: true, items: changes.upserts };
  });
}

export async function recipientWishlist(user, groupId, options = {}) {
  requireUUID(groupId);
  const dependentId = optionalDependent(options.dependentId), cursor = pageCursor(options.cursor);
  // Only the authenticated giver (or their child's guardian) chooses which of
  // their own assignments to view. A caller never supplies the receiver id.
  const row = (await query(`SELECT g.drawn_at,${identityColumns} FROM as_groups g
    JOIN as_users organizer ON organizer.id=g.organizer_id AND organizer.deleted_at IS NULL
    JOIN as_users caller ON caller.id=$2 AND caller.deleted_at IS NULL AND caller.verified_at IS NOT NULL
    JOIN as_memberships own ON own.group_id=g.id AND own.user_id=$2 AND own.status='accepted'
    JOIN as_memberships giver ON giver.group_id=g.id AND giver.status='accepted'
    LEFT JOIN as_dependents child ON child.id=giver.dependent_id AND child.guardian_id=$2 AND child.deleted_at IS NULL
    LEFT JOIN as_draw_results r ON r.group_id=g.id AND r.giver_id=giver.id
    LEFT JOIN as_memberships m ON m.id=r.receiver_id AND m.group_id=g.id
    ${identityJoins}
    WHERE g.id=$1 AND (($3::uuid IS NULL AND giver.user_id=$2) OR ($3::uuid IS NOT NULL AND child.id=$3))`, [groupId, user.id, dependentId])).rows[0];
  if (!row) throw missing();
  if (!row.drawn_at) throw new ApiError(409, 'NOT_DRAWN', 'As sugestões do seu amigo secreto aparecem depois do sorteio.');
  if (!row.membership_id) throw missing();
  return readPage(row, cursor);
}

export async function participantWishlist(user, groupId, membershipId, options = {}) {
  requireUUID(groupId); requireUUID(membershipId);
  const cursor = pageCursor(options.cursor);
  // Authorization and the page use one snapshot. The directory never reads draw pairs.
  const row = (await query(`SELECT g.drawn_at,${identityColumns},wishes.items FROM as_groups g
    JOIN as_users organizer ON organizer.id=g.organizer_id AND organizer.deleted_at IS NULL
    JOIN as_users caller ON caller.id=$2 AND caller.deleted_at IS NULL AND caller.verified_at IS NOT NULL
    JOIN as_memberships own ON own.group_id=g.id AND own.user_id=$2 AND own.status='accepted'
    JOIN as_memberships m ON m.group_id=g.id AND m.id=$3 AND m.status='accepted'
    ${identityJoins}
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object('id',id,'text',text,'url',url,'position',position::text) ORDER BY position) AS items FROM (
        SELECT id,text,url,position FROM as_wishlist_items
        WHERE g.drawn_at IS NOT NULL AND membership_id=m.id AND position>$4::bigint
        ORDER BY position LIMIT $5
      ) item
    ) wishes ON true
    WHERE g.id=$1 AND u.deleted_at IS NULL AND d.deleted_at IS NULL AND guardian.deleted_at IS NULL`,
  [groupId, user.id, membershipId, cursor, WISHLIST_PAGE_SIZE + 1])).rows[0];
  if (!row) throw missing();
  if (!row.drawn_at) throw new ApiError(409, 'NOT_DRAWN', 'As sugestões do grupo ficam disponíveis depois do sorteio.');
  return wishlistPage(row, row.items || []);
}
