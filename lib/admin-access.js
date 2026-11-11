import { ApiError } from './db.js';

// The principal comes from the authenticated database session, never a request body.
const ADMIN_EMAIL = 'fabiosanida@gmail.com';
export const isAdmin = user => typeof user?.email === 'string' && user.email.trim().toLowerCase() === ADMIN_EMAIL;
export function requireAdmin(user) {
  if (!isAdmin(user)) throw new ApiError(403, 'FORBIDDEN', 'Sua conta não tem acesso a esta área.');
}
