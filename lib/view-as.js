import { requireAdmin } from './admin-access.js';
import { ApiError, query, requireUUID } from './db.js';
import { publicUser } from './profile.js';

export async function viewAsUser(actor, targetId, { includeAvatar = false } = {}) {
  requireAdmin(actor);
  requireUUID(targetId);
  const { rows } = await query(`SELECT id,email,first_name,last_name${includeAvatar ? ',avatar' : ''}
    FROM as_users WHERE id=$1 AND id<>$2 AND deleted_at IS NULL AND verified_at IS NOT NULL`, [targetId, actor.id]);
  if (!rows[0]) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Não encontramos essa conta ativa.');
  return { ...publicUser(rows[0]), isAdmin: false };
}
