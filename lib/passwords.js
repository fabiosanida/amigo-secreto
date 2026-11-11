import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ApiError } from './db.js';

const derive = promisify(scrypt);
const parameters = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
export function validatePassword(password, passwordConfirm) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
    throw new ApiError(400, 'INVALID_PASSWORD', 'Use uma senha com 12 a 128 caracteres.');
  }
  if (password !== passwordConfirm) throw new ApiError(400, 'PASSWORD_MISMATCH', 'As senhas precisam ser iguais.');
  return password;
}
export async function hashPassword(password) {
  validatePassword(password, password);
  const salt = randomBytes(16);
  const key = await derive(password, salt, 64, parameters);
  return `scrypt$${parameters.N}$${parameters.r}$${parameters.p}$${salt.toString('hex')}$${key.toString('hex')}`;
}
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || password.length > 128 || typeof encoded !== 'string') return false;
  const match = /^scrypt\$131072\$8\$1\$([a-f\d]{32})\$([a-f\d]{128})$/.exec(encoded);
  if (!match) return false;
  const key = await derive(password, Buffer.from(match[1], 'hex'), 64, parameters);
  return timingSafeEqual(key, Buffer.from(match[2], 'hex'));
}
