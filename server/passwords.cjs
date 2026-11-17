const crypto = require('node:crypto');

// scrypt встроен в Node.js, отдельный пакет не нужен.
// N=16384 — разумный запас для локального входа. Для более мощного сервера можно поднять степень двойки.
const N = 16384;
const r = 8;
const p = 1;
const length = 32;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, length, {N, r, p});
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

function verifyPassword(password, stored) {
  if (!stored || !String(stored).startsWith('scrypt$')) return false;
  const [, n, rr, pp, salt, hash] = String(stored).split('$');
  const expected = Buffer.from(hash, 'base64');
  const actual = crypto.scryptSync(String(password), Buffer.from(salt, 'base64'), expected.length, {N: Number(n), r: Number(rr), p: Number(pp)});
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

// Ключ интеграции — случайная строка. Для неё достаточно SHA-256: перебор бессмыслен.
function hashApiKey(key) {
  return crypto.createHash('sha256').update(String(key)).digest('hex');
}

function newApiKey() {
  return 'apk_' + crypto.randomBytes(32).toString('base64url');
}

module.exports = {hashPassword, verifyPassword, hashToken, newToken, hashApiKey, newApiKey};
