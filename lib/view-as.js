import { requireAdmin } from './admin-access.js';
import { ApiError, query, requireUUID } from './db.js';
import { listDependents } from './dependents.js';
import { getGroup, listGroups } from './groups.js';
import { publicUser } from './profile.js';
import { participantWishlist } from './wishlists.js';

export async function viewAs(actor, targetId, parts, search) {
  requireAdmin(actor);
  requireUUID(targetId);
  const unknown = () => new ApiError(404, 'NOT_FOUND', 'Esta tela não está disponível no modo de visualização.');
  const [family, groupId, section, membershipId, detail] = parts;
  const route = parts.length === 0 ? 'identity'
    : family === 'dependents' && parts.length === 1 ? 'dependents'
    : family === 'groups' && parts.length === 1 ? 'dashboard'
    : family === 'groups' && parts.length === 2 ? 'group'
    : family === 'groups' && parts.length === 5 && section === 'participants' && detail === 'wishlist' ? 'wishlist'
    : null;
  if (!route) throw unknown();
  const { rows } = await query(`SELECT id,email,first_name,last_name${route === 'identity' ? ',avatar' : ''}
    FROM as_users WHERE id=$1 AND id<>$2 AND deleted_at IS NULL AND verified_at IS NOT NULL`, [targetId, actor.id]);
  if (!rows[0]) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Não encontramos essa conta ativa.');
  const user = { ...publicUser(rows[0]), isAdmin: false };
  switch (route) {
    case 'identity': return { user };
    case 'dashboard': return listGroups(user);
    case 'group': return getGroup(user, groupId, { maintenance: false });
    case 'dependents': return listDependents(user, { groupId: search.get('groupId'), cursor: search.get('cursor') });
    case 'wishlist': return participantWishlist(user, groupId, membershipId, { cursor: search.get('cursor') });
    default: throw unknown();
  }
}
