// Límite de intentos de login FALLIDOS, guardado en SQLite (sobrevive a reinicios).
// Se cuenta por IP y por correo dentro de una ventana; al superar el máximo se bloquea hasta que
// termina la ventana. Un login correcto solo reinicia el contador del correo, nunca el de la IP.
const db = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS login_attempts (
  key TEXT PRIMARY KEY, n INTEGER NOT NULL, first_at INTEGER NOT NULL)`);

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const WINDOW_MS = num(process.env.LOGIN_WINDOW_MIN, 15) * 60 * 1000;
const MAX = { ip: num(process.env.LOGIN_MAX_PER_IP, 20), email: num(process.env.LOGIN_MAX_PER_EMAIL, 8) };
const FAIL_DELAY_MS = process.env.LOGIN_FAIL_DELAY_MS === undefined ? 400 : Number(process.env.LOGIN_FAIL_DELAY_MS) || 0;

const get = db.prepare('SELECT n, first_at FROM login_attempts WHERE key = ?');
const put = db.prepare('INSERT OR REPLACE INTO login_attempts (key, n, first_at) VALUES (?,?,?)');
const del = db.prepare('DELETE FROM login_attempts WHERE key = ?');
const purge = db.prepare('DELETE FROM login_attempts WHERE first_at < ?');
setInterval(() => purge.run(Date.now() - WINDOW_MS), 10 * 60 * 1000).unref();

const keys = (ip, email) => [['ip:' + ip, MAX.ip], ['email:' + email, MAX.email]];

// Segundos que faltan para poder reintentar, o 0 si no está bloqueado.
function blockedFor(ip, email) {
  const now = Date.now();
  let wait = 0;
  for (const [k, max] of keys(ip, email)) {
    const r = get.get(k);
    if (r && now - r.first_at < WINDOW_MS && r.n >= max) wait = Math.max(wait, Math.ceil((r.first_at + WINDOW_MS - now) / 1000));
  }
  return wait;
}
function recordFailure(ip, email) {
  const now = Date.now();
  for (const [k] of keys(ip, email)) {
    const r = get.get(k);
    put.run(k, r && now - r.first_at < WINDOW_MS ? r.n + 1 : 1, r && now - r.first_at < WINDOW_MS ? r.first_at : now);
  }
  console.warn(`login fallido ip=${ip} correo=${email}`);
  return FAIL_DELAY_MS ? new Promise((r) => setTimeout(r, FAIL_DELAY_MS + Math.random() * FAIL_DELAY_MS * 0.5)) : null;
}
const recordSuccess = (email) => del.run('email:' + email);

module.exports = { blockedFor, recordFailure, recordSuccess, MAX, WINDOW_MS };
