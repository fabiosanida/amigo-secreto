import { ApiError, query } from './db.js';

export function normalizeName(value, field, max) {
  if (typeof value !== 'string') throw new ApiError(400, 'INVALID_PROFILE', `Informe ${field}.`);
  const text = value.normalize('NFC').trim().replace(/\s+/gu, ' ');
  if (!text || text.length > max || /[\u0000-\u001f\u007f]/u.test(text)) throw new ApiError(400, 'INVALID_PROFILE', `Confira ${field}.`);
  return text;
}
export async function sanitizeAvatar(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 350000) throw new ApiError(400, 'INVALID_AVATAR', 'Escolha uma foto de até 256 KB.');
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw new ApiError(400, 'INVALID_AVATAR', 'Use uma imagem PNG, JPEG ou WebP.');
  const input = Buffer.from(match[2], 'base64');
  if (!input.length || input.length > 262144) throw new ApiError(400, 'INVALID_AVATAR', 'Escolha uma foto de até 256 KB.');
  try {
    const { default: sharp } = await import('sharp');
    const image = sharp(input, { limitInputPixels: 16000000, failOn: 'error' });
    const metadata = await image.metadata();
    if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages || 1) > 1) throw new Error('Unsupported image format');
    const output = await image.rotate().resize(256, 256, { fit: 'cover' }).webp({ quality: 80 }).toBuffer();
    return `data:image/webp;base64,${output.toString('base64')}`;
  } catch { throw new ApiError(400, 'INVALID_AVATAR', 'Não foi possível abrir essa foto. Escolha outra imagem.'); }
}
export function publicUser(row) {
  return { id: row.id, firstName: row.first_name, lastName: row.last_name, email: row.email, avatar: row.avatar || null };
}
export async function updateProfile(user, body) {
  const firstName = normalizeName(body.firstName, 'seu nome', 80);
  const lastName = normalizeName(body.lastName, 'seu sobrenome', 120);
  const avatar = body.avatar === undefined ? user.avatar : await sanitizeAvatar(body.avatar);
  const { rows } = await query('UPDATE as_users SET first_name=$2,last_name=$3,avatar=$4,updated_at=now() WHERE id=$1 RETURNING id,email,first_name,last_name,avatar', [user.id, firstName, lastName, avatar]);
  return { user: publicUser(rows[0]) };
}
