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

// Base de conocimiento y encuesta de satisfacción
const hadKb = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = 'kb_articles'").get());
db.exec(`
CREATE TABLE IF NOT EXISTS kb_articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  published INTEGER NOT NULL DEFAULT 1,
  views INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_by INTEGER REFERENCES users(id)
);
CREATE TABLE IF NOT EXISTS kb_votes (
  article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  helpful INTEGER NOT NULL,
  PRIMARY KEY (article_id, user_id)
);
CREATE TABLE IF NOT EXISTS ticket_ratings (
  ticket_id INTEGER PRIMARY KEY REFERENCES tickets(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);`);
if (!hadKb) {
  const ins = db.prepare('INSERT INTO kb_articles (title, body, category) VALUES (?, ?, ?)');
  ins.run('No puedo conectarme a la VPN', 'Antes de crear un ticket, prueba esto:\n\n1. Comprueba que tienes internet abriendo cualquier página web.\n2. Cierra la aplicación de la VPN por completo y vuélvela a abrir.\n3. Verifica que tu usuario y contraseña sean los de siempre (los mismos de tu correo).\n4. Si cambiaste tu contraseña hace poco, cierra sesión en la VPN y entra con la nueva.\n5. Reinicia el equipo e inténtalo otra vez.\n\nSi sigue fallando, crea un ticket e indica el **mensaje de error exacto** que te aparece.', 'Red / Internet');
  ins.run('Olvidé mi contraseña del correo', 'La contraseña de tu correo la restablece Tecnología.\n\n- Crea un ticket de categoría **Accesos / Contraseñas** con prioridad alta.\n- Indica tu nombre completo y desde qué teléfono o equipo escribes.\n- Por seguridad, TI puede pedirte un dato extra para confirmar que eres tú.\n\nNunca compartas tu contraseña con nadie, ni siquiera con TI: no la necesitamos para ayudarte.', 'Accesos / Contraseñas');
  ins.run('La impresora no imprime', 'Revisa en este orden:\n\n1. Que la impresora esté encendida y sin luces de error.\n2. Que tenga papel y tóner.\n3. Que sea la impresora elegida en el cuadro de impresión (a veces cambia sola).\n4. Cancela los trabajos pendientes en la cola de impresión y vuelve a imprimir.\n\nSi es la impresora de red, prueba imprimir desde otro equipo: si tampoco funciona, el problema es de la impresora y no de tu computadora.', 'Impresoras');
  ins.run('El Wi-Fi no conecta o va muy lento', '1. Apaga y enciende el Wi-Fi de tu equipo.\n2. Acércate al punto de acceso y comprueba si otras personas tienen el mismo problema.\n3. Olvida la red y vuelve a conectarte con tu usuario.\n4. Reinicia tu equipo.\n\nSi varias personas de tu zona no tienen señal, avísanos con un ticket **urgente** e indica el piso o la sala.', 'Red / Internet');
}

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
