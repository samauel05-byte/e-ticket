// Configuración de correo editable desde Administración.
// Se guarda en la base de datos (las contraseñas, cifradas) y TIENE PRIORIDAD sobre el archivo .env.
// Al borrar un valor en la pantalla se vuelve al que traiga el .env.
const crypto = require('crypto');
const db = require('./db');

const bool = (v) => (v === true || v === 'true' ? 'true' : v === false || v === 'false' ? 'false' : null);
const FIELDS = {
  // Inicio de sesión con la clave del correo
  IMAP_HOST: { type: 'host' }, IMAP_PORT: { type: 'port' }, IMAP_SECURE: { type: 'bool' }, IMAP_USER_FORMAT: { type: 'enum', values: ['email', 'local'] },
  // Bandeja de soporte (crea tickets)
  INBOX_HOST: { type: 'host' }, INBOX_PORT: { type: 'port' }, INBOX_SECURE: { type: 'bool' }, INBOX_USER: { type: 'text' },
  INBOX_PASS: { type: 'text', secret: true }, INBOX_POLL_SECONDS: { type: 'int', min: 5, max: 3600 }, INBOX_REQUIRE_AUTH: { type: 'bool' },
  // Avisos (SMTP)
  SMTP_HOST: { type: 'host' }, SMTP_PORT: { type: 'port' }, SMTP_SECURE: { type: 'bool' }, SMTP_USER: { type: 'text' },
  SMTP_PASS: { type: 'text', secret: true }, SMTP_FROM: { type: 'text' },
};
const KEYS = Object.keys(FIELDS);
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]])); // lo que trae el .env / el entorno

// ── cifrado de contraseñas en la base de datos (AES-256-GCM, clave derivada de SESSION_SECRET) ──
const key = () => crypto.createHash('sha256').update('eticket-settings:' + (process.env.SESSION_SECRET || 'sin-secreto')).digest();
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return 'enc:v1:' + Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(blob) {
  try {
    const raw = Buffer.from(String(blob).slice(7), 'base64');
    const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch { return null; } // SESSION_SECRET distinta a la que cifró: hay que volver a escribir la contraseña
}

function validate(k, v) {
  const f = FIELDS[k];
  const s = String(v).trim();
  if (/[\r\n\u0000]/.test(s)) throw new Error(`${k}: contiene caracteres no permitidos`);
  if (s.length > 300) throw new Error(`${k}: demasiado largo`);
  switch (f.type) {
    case 'host':
      if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(s)) throw new Error(`${k}: escribe solo el nombre del servidor (por ejemplo mail.empresa.com), sin http:// ni puerto`);
      if (/^169\.254\./.test(s) || s === '0.0.0.0') throw new Error(`${k}: dirección no permitida`);
      return s;
    case 'port': { const n = Number(s); if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(`${k}: el puerto debe ser un número entre 1 y 65535`); return String(n); }
    case 'int': { const n = Number(s); if (!Number.isInteger(n) || n < f.min || n > f.max) throw new Error(`${k}: debe estar entre ${f.min} y ${f.max}`); return String(n); }
    case 'bool': { const b = bool(typeof v === 'string' ? s : v); if (b === null) throw new Error(`${k}: debe ser sí o no`); return b; }
    case 'enum': if (!f.values.includes(s)) throw new Error(`${k}: valor no válido`); return s;
    default: return s;
  }
}

const rows = () => Object.fromEntries(db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
function stored() {
  const out = {};
  for (const [k, v] of Object.entries(rows())) {
    if (!FIELDS[k]) continue;
    out[k] = FIELDS[k].secret ? decrypt(v) : v;
  }
  return out;
}

// Pone en process.env lo guardado en la base (o restaura lo del .env si ya no hay valor guardado)
function applyToEnv() {
  const s = stored();
  for (const k of KEYS) {
    if (s[k] !== undefined && s[k] !== null && s[k] !== '') process.env[k] = s[k];
    else if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
}

// Guarda los valores recibidos. Texto vacío = quitar el valor guardado (vuelve al .env). Contraseña vacía = conservar la actual.
function save(values, userId = null) {
  const clean = {};
  for (const [k, v] of Object.entries(values || {})) {
    if (!FIELDS[k]) continue;
    if (v === undefined || v === null) continue;
    if (FIELDS[k].secret && String(v) === '') continue;
    clean[k] = String(v).trim() === '' && !FIELDS[k].secret ? '' : validate(k, v);
  }
  const put = db.prepare("INSERT INTO settings (key, value, updated_by) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now'), updated_by = excluded.updated_by");
  const del = db.prepare('DELETE FROM settings WHERE key = ?');
  db.transaction(() => {
    for (const [k, v] of Object.entries(clean)) {
      if (v === '') del.run(k); else put.run(k, FIELDS[k].secret ? encrypt(v) : v, userId);
    }
  })();
  applyToEnv();
  return Object.keys(clean);
}

// Lo que se muestra en pantalla: nunca devuelve contraseñas, solo si hay una guardada.
function publicConfig() {
  const dbKeys = new Set(Object.keys(rows()));
  const out = {};
  for (const k of KEYS) {
    const source = dbKeys.has(k) ? 'database' : original[k] ? 'env' : null;
    if (FIELDS[k].secret) out[k] = { set: Boolean(process.env[k]), source };
    else out[k] = { value: process.env[k] ?? '', source };
  }
  return out;
}

// Configuración "efectiva" para probar: lo vigente + lo que se está escribiendo en el formulario (sin guardar)
function effective(overrides = {}) {
  const cfg = {};
  for (const k of KEYS) cfg[k] = process.env[k] ?? '';
  for (const [k, v] of Object.entries(overrides || {})) {
    if (!FIELDS[k] || v === undefined || v === null) continue;
    if (FIELDS[k].secret && String(v) === '') continue; // contraseña vacía: se usa la guardada
    cfg[k] = String(v).trim() === '' ? '' : validate(k, v);
  }
  return cfg;
}

module.exports = { encrypt, decrypt, FIELDS, applyToEnv, save, publicConfig, effective, stored, validate };
