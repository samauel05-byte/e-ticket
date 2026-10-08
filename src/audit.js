// Bitácora de seguridad: quién hizo qué, desde dónde y cuándo. Solo se agrega; el administrador la consulta.
const db = require('./db');

db.exec(`CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d %H:%M:%S','now')),
  actor_id INTEGER,
  actor TEXT,
  ip TEXT,
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action);`);

const clip = (v, n) => (v == null ? null : String(v).replace(/[\u0000-\u001f]/g, ' ').slice(0, n));
const ins = db.prepare('INSERT INTO audit_log (actor_id, actor, ip, action, target, detail) VALUES (?,?,?,?,?,?)');

// log(req, 'user.role', 'ana@x.com', 'user → agent')   (req puede ser null en tareas internas)
function log(req, action, target = null, detail = null, actor = null) {
  try {
    const u = actor || req?.user || null;
    ins.run(u?.id ?? null, clip(u?.email, 200), clip(req?.ip, 64), clip(action, 60), clip(target, 200), clip(detail, 500));
  } catch (e) { console.error('bitácora:', e.message); } // la bitácora nunca debe tumbar la operación
}

const RETENTION_DAYS = Number(process.env.AUDIT_DAYS) > 0 ? Number(process.env.AUDIT_DAYS) : 365;
function purge() { db.prepare(`DELETE FROM audit_log WHERE at < datetime('now', ?)`).run(`-${RETENTION_DAYS} days`); }
purge();
setInterval(purge, 24 * 3600 * 1000).unref();

function list({ action, q, from, to, limit = 200 } = {}) {
  const where = []; const args = [];
  if (action) { where.push('action LIKE ?'); args.push(String(action).replace(/[%_]/g, '') + '%'); }
  if (q) { where.push('(actor LIKE ? OR target LIKE ? OR detail LIKE ? OR ip LIKE ?)'); const k = `%${String(q).replace(/[%_]/g, '')}%`; args.push(k, k, k, k); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(from || '')) { where.push('at >= ?'); args.push(from + ' 00:00:00'); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(to || '')) { where.push('at <= ?'); args.push(to + ' 23:59:59'); }
  return db.prepare(`SELECT id, at, actor, ip, action, target, detail FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`)
    .all(...args, Math.min(Number(limit) || 200, 2000));
}

module.exports = { log, list, RETENTION_DAYS };
