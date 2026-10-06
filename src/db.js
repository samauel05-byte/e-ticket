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
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','agent','admin','manager')),
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

// Migración: el rol "manager" (gerencia) no existía en la restricción CHECK de las bases anteriores.
// SQLite no permite modificarla: se reconstruye la tabla conservando los datos.
if (!/'manager'/.test(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='users'").get().sql)) {
  db.pragma('foreign_keys = OFF');
  db.transaction(() => {
    db.exec(`CREATE TABLE users_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      department_id INTEGER NOT NULL REFERENCES departments(id),
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','agent','admin','manager')),
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
