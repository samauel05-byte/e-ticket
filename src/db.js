const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(process.env.DB_PATH || path.join(__dirname, '..', 'data', 'eticket.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS departments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  department_id INTEGER NOT NULL REFERENCES departments(id),
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','leader','agent','coordinator','manager','admin')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'media' CHECK (priority IN ('baja','media','alta','urgente')),
  status TEXT NOT NULL DEFAULT 'abierto' CHECK (status IN ('abierto','en_progreso','en_espera','resuelto','cerrado')),
  requester_id INTEGER NOT NULL REFERENCES users(id),
  department_id INTEGER NOT NULL REFERENCES departments(id),
  assignee_id INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  original_name TEXT NOT NULL,
  stored_name TEXT NOT NULL UNIQUE,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_attach_ticket ON attachments(ticket_id);
CREATE INDEX IF NOT EXISTS idx_tickets_requester ON tickets(requester_id);
CREATE INDEX IF NOT EXISTS idx_tickets_status ON tickets(status);
`);

// Migración: columnas para tiempos de respuesta y resolución
const cols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
if (!cols.includes('first_response_at')) db.exec('ALTER TABLE tickets ADD COLUMN first_response_at TEXT');
if (!cols.includes('resolved_at')) db.exec('ALTER TABLE tickets ADD COLUMN resolved_at TEXT');

if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'lunch_shift'))
  db.exec('ALTER TABLE users ADD COLUMN lunch_shift TEXT');

// Migración: los roles "manager", "leader" y "coordinator" no existían en la restricción CHECK de las bases anteriores.
// SQLite no permite modificarla: se reconstruye la tabla conservando los datos.
if (!/'coordinator'/.test(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql)) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      department_id INTEGER NOT NULL REFERENCES departments(id),
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','leader','agent','coordinator','manager','admin')),
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      lunch_shift TEXT
    );
    INSERT INTO users_new (id, email, name, password_hash, department_id, role, created_at, lunch_shift)
      SELECT id, email, name, password_hash, department_id, role, created_at, lunch_shift FROM users;
    DROP TABLE users;
    ALTER TABLE users_new RENAME TO users;`);
  })();
  db.pragma('foreign_keys = ON');
}

// Cuentas desactivables (personas que ya no trabajan en la empresa) y notas internas de TI en los comentarios
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'active'))
  db.exec('ALTER TABLE users ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
if (!db.prepare('PRAGMA table_info(comments)').all().some((c) => c.name === 'internal'))
  db.exec('ALTER TABLE comments ADD COLUMN internal INTEGER NOT NULL DEFAULT 0');

// Seguridad: sesiones revocables (época), verificación en dos pasos y códigos de recuperación
for (const [col, ddl] of [
  ['session_epoch', 'ALTER TABLE users ADD COLUMN session_epoch INTEGER NOT NULL DEFAULT 0'],
  ['totp_secret', 'ALTER TABLE users ADD COLUMN totp_secret TEXT'],
  ['totp_enabled', 'ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0'],
  ['totp_last', 'ALTER TABLE users ADD COLUMN totp_last INTEGER NOT NULL DEFAULT 0'],
  ['recovery_codes', 'ALTER TABLE users ADD COLUMN recovery_codes TEXT'],
]) if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === col)) db.exec(ddl);

// Automatización: asignación automática, escalamiento, respuestas rápidas y formularios por categoría
if (!db.prepare('PRAGMA table_info(users)').all().some((c) => c.name === 'last_assigned_at'))
  db.exec('ALTER TABLE users ADD COLUMN last_assigned_at TEXT');
if (!db.prepare('PRAGMA table_info(tickets)').all().some((c) => c.name === 'form_data'))
  db.exec('ALTER TABLE tickets ADD COLUMN form_data TEXT');
const tableExists = (n) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(n));
const hadTemplates = tableExists('reply_templates');
const hadForms = tableExists('category_forms');
db.exec(`
CREATE TABLE IF NOT EXISTS automation_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS assign_pool (
  category TEXT NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (category, user_id)
);
CREATE TABLE IF NOT EXISTS escalation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  priority TEXT NOT NULL DEFAULT '*',
  condition TEXT NOT NULL CHECK (condition IN ('no_response','unassigned','not_resolved')),
  minutes INTEGER NOT NULL CHECK (minutes > 0),
  action TEXT NOT NULL CHECK (action IN ('notify','priority_up','reassign')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS escalation_log (
  ticket_id INTEGER NOT NULL,
  rule_id INTEGER NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticket_id, rule_id)
);
CREATE TABLE IF NOT EXISTS reply_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS category_forms (category TEXT PRIMARY KEY, fields TEXT NOT NULL DEFAULT '[]');`);
if (!hadTemplates) {
  const ins = db.prepare('INSERT INTO reply_templates (title, body) VALUES (?, ?)');
  ins.run('Estamos revisando', 'Hola {{nombre}}, recibimos tu solicitud {{ticket}} y ya la estamos revisando. Te avisaremos en cuanto haya novedades.\n\nSaludos,\n{{tecnico}}');
  ins.run('Necesitamos más información', 'Hola {{nombre}}, para avanzar con {{ticket}} necesitamos algunos datos más:\n\n- \n\nResponde a este mensaje y lo retomamos de inmediato.\n\nSaludos,\n{{tecnico}}');
  ins.run('Resuelto, ¿puedes confirmar?', 'Hola {{nombre}}, dejamos resuelto {{ticket}}. Por favor confirma en el sistema que todo funciona; si algo sigue fallando, puedes reabrirlo desde el mismo ticket.\n\nSaludos,\n{{tecnico}}');
}
if (!hadForms) {
  db.prepare('INSERT INTO category_forms (category, fields) VALUES (?, ?)').run('Alta de usuario', JSON.stringify([
    { key: 'nombre_del_nuevo_empleado', label: 'Nombre completo del nuevo empleado', type: 'text', required: true, options: [] },
    { key: 'cargo', label: 'Cargo', type: 'text', required: true, options: [] },
    { key: 'fecha_de_ingreso', label: 'Fecha de ingreso', type: 'date', required: true, options: [] },
    { key: 'equipo', label: 'Equipo que necesita', type: 'select', required: true, options: ['Laptop', 'PC de escritorio', 'Ninguno (usa el suyo)'] },
    { key: 'accesos', label: 'Sistemas y accesos que necesita', type: 'textarea', required: false, options: [] },
  ]));
}

// Solución escrita por TI al resolver, y origen del ticket (web o correo)
const ticketCols = db.prepare('PRAGMA table_info(tickets)').all().map((c) => c.name);
if (!ticketCols.includes('resolution')) db.exec('ALTER TABLE tickets ADD COLUMN resolution TEXT');
if (!ticketCols.includes('source')) db.exec("ALTER TABLE tickets ADD COLUMN source TEXT NOT NULL DEFAULT 'web'");

// Historial de estado/responsable por ticket: permite pausar el SLA con exactitud
db.exec(`CREATE TABLE IF NOT EXISTS ticket_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL,
  assignee_id INTEGER
);
CREATE INDEX IF NOT EXISTS idx_events_ticket ON ticket_events(ticket_id);`);
// Historial visible: quién hizo el cambio y qué otro cambio se hizo (prioridad, categoría, reapertura…)
{
  const cols = db.prepare('PRAGMA table_info(ticket_events)').all().map((c) => c.name);
  if (!cols.includes('actor_id')) db.exec('ALTER TABLE ticket_events ADD COLUMN actor_id INTEGER');
  if (!cols.includes('note')) db.exec('ALTER TABLE ticket_events ADD COLUMN note TEXT');
}
// Avisos de SLA ya enviados (uno por ticket y tipo)
db.exec(`CREATE TABLE IF NOT EXISTS sla_alerts (
  ticket_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (ticket_id, kind)
)`);
db.exec(`INSERT INTO ticket_events (ticket_id, at, status, assignee_id)
  SELECT id, created_at, status, assignee_id FROM tickets
  WHERE id NOT IN (SELECT ticket_id FROM ticket_events)`);

// Configuración editable desde Administración (correo). Las contraseñas se guardan cifradas.
db.exec(`CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER
)`);

// Correos ya procesados (evita duplicados al recibir tickets por correo)
db.exec(`CREATE TABLE IF NOT EXISTS ingested_mail (
  message_id TEXT PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  result TEXT NOT NULL,
  ticket_id INTEGER
)`);

const DEFAULT_DEPARTMENTS = [
  'Administración', 'Recursos Humanos', 'Finanzas', 'Ventas', 'Marketing',
  'Operaciones', 'Logística', 'Legal', 'Tecnología',
];
const ins = db.prepare('INSERT OR IGNORE INTO departments (name) VALUES (?)');
for (const d of DEFAULT_DEPARTMENTS) ins.run(d);

module.exports = db;
