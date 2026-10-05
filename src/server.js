const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');
const imap = require('./imapAuth');
const mailer = require('./mailer');

const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'empresa.com').toLowerCase().replace(/^@/, '');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();
const PORT = process.env.PORT || 3000;

const STATUSES = ['abierto', 'en_progreso', 'en_espera', 'resuelto', 'cerrado'];
const PRIORITIES = ['baja', 'media', 'alta', 'urgente'];
const CATEGORIES = ['Hardware', 'Software', 'Red / Internet', 'Correo', 'Accesos / Contraseñas', 'Impresoras', 'Otro'];

const app = express();
app.use(express.json({ limit: '100kb' }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto-en-produccion',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, secure: process.env.COOKIE_SECURE === 'true' },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => {
  try { fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'Error interno' }); }
};
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const USER_SELECT = `SELECT u.id, u.email, u.name, u.role, u.department_id, d.name AS department
  FROM users u JOIN departments d ON d.id = u.department_id`;
const getUser = (id) => db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id);

function auth(req, res, next) {
  const u = req.session.userId && getUser(req.session.userId);
  if (!u) return res.status(401).json({ error: 'No autenticado' });
  req.user = u;
  next();
}
const staff = (req, res, next) =>
  req.user.role === 'agent' || req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Sin permiso' });
const admin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Sin permiso' });

// ---------- Auth ----------
app.get('/api/meta', wrap((req, res) => {
  res.json({
    domain: ALLOWED_DOMAIN, imap: imap.enabled(), statuses: STATUSES, priorities: PRIORITIES, categories: CATEGORIES,
    departments: db.prepare('SELECT id, name FROM departments ORDER BY name').all(),
  });
}));

app.post('/api/register', wrap((req, res) => {
  if (imap.enabled()) return res.status(404).json({ error: 'Registro deshabilitado: usa tu correo de la empresa para entrar' });
  const email = str(req.body.email, 200).toLowerCase();
  const name = str(req.body.name, 100);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const departmentId = Number(req.body.department_id);
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !email.endsWith('@' + ALLOWED_DOMAIN))
    return res.status(400).json({ error: `Solo se permiten correos @${ALLOWED_DOMAIN}` });
  if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
  if (password.length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(departmentId))
    return res.status(400).json({ error: 'Departamento inválido' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Ese correo ya está registrado' });
  const role = email === ADMIN_EMAIL ? 'admin' : 'user';
  const info = db.prepare('INSERT INTO users (email, name, password_hash, department_id, role) VALUES (?,?,?,?,?)')
    .run(email, name, bcrypt.hashSync(password, 10), departmentId, role);
  req.session.regenerate(() => {
    req.session.userId = info.lastInsertRowid;
    res.status(201).json(getUser(info.lastInsertRowid));
  });
}));

// Intentos fallidos por correo/IP (en memoria) para frenar fuerza bruta
const fails = new Map();
const LOCK_MS = 10 * 60 * 1000, MAX_FAILS = 8;
const keyOf = (req, email) => `${req.ip}|${email}`;
const locked = (k) => { const f = fails.get(k); return f && f.n >= MAX_FAILS && Date.now() - f.t < LOCK_MS; };
const fail = (k) => { const f = fails.get(k); fails.set(k, { n: (f && Date.now() - f.t < LOCK_MS ? f.n : 0) + 1, t: Date.now() }); };

const startSession = (req, res, id) => req.session.regenerate(() => {
  req.session.userId = id;
  res.json(getUser(id));
});

app.post('/api/login', async (req, res) => {
  try {
    const email = str(req.body.email, 200).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const bad = () => res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    const k = keyOf(req, email);
    if (locked(k)) return res.status(429).json({ error: 'Demasiados intentos. Espera unos minutos.' });
    const row = db.prepare('SELECT id, password_hash FROM users WHERE email = ?').get(email);

    if (!imap.enabled()) {
      if (!row || !bcrypt.compareSync(password, row.password_hash)) { fail(k); return bad(); }
      fails.delete(k);
      return startSession(req, res, row.id);
    }

    if (!email.endsWith('@' + ALLOWED_DOMAIN) || !password) return bad();
    // Si el usuario es nuevo y aún no eligió departamento, se valida antes de pedírselo.
    if (!(await imap.verify(email, password))) { fail(k); return bad(); }
    fails.delete(k);
    if (row) return startSession(req, res, row.id);

    const departmentId = Number(req.body.department_id);
    if (!departmentId) return res.status(200).json({ needs_department: true });
    if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(departmentId))
      return res.status(400).json({ error: 'Departamento inválido' });
    const name = str(req.body.name, 100) || email.split('@')[0];
    const role = email === ADMIN_EMAIL ? 'admin' : 'user';
    // La contraseña nunca se guarda: el hash '!' no coincide con ninguna contraseña.
    const info = db.prepare('INSERT INTO users (email, name, password_hash, department_id, role) VALUES (?,?,?,?,?)')
      .run(email, name, '!imap', departmentId, role);
    startSession(req, res, info.lastInsertRowid);
  } catch (e) {
    if (e.unavailable) return res.status(503).json({ error: e.message });
    console.error(e); res.status(500).json({ error: 'Error interno' });
  }
});

app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', auth, (req, res) => res.json(req.user));

// ---------- Tickets ----------
const TICKET_SELECT = `SELECT t.*, r.name AS requester_name, r.email AS requester_email,
  d.name AS department, a.name AS assignee_name
  FROM tickets t JOIN users r ON r.id = t.requester_id
  JOIN departments d ON d.id = t.department_id
  LEFT JOIN users a ON a.id = t.assignee_id`;

const staffEmails = (exceptId) =>
  db.prepare("SELECT email FROM users WHERE role IN ('agent','admin') AND id != ?").all(exceptId || 0).map((r) => r.email);
const isStaff = (u) => u.role === 'agent' || u.role === 'admin';
const canSee = (u, t) => isStaff(u) || t.requester_id === u.id;

app.get('/api/tickets', auth, wrap((req, res) => {
  const where = []; const args = [];
  if (!isStaff(req.user)) { where.push('t.requester_id = ?'); args.push(req.user.id); }
  const { status, department_id, priority, q } = req.query;
  if (STATUSES.includes(status)) { where.push('t.status = ?'); args.push(status); }
  if (PRIORITIES.includes(priority)) { where.push('t.priority = ?'); args.push(priority); }
  if (department_id && isStaff(req.user)) { where.push('t.department_id = ?'); args.push(Number(department_id)); }
  if (q) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); args.push(`%${str(q, 100)}%`, `%${str(q, 100)}%`); }
  const sql = `${TICKET_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.updated_at DESC, t.id DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...args));
}));

app.post('/api/tickets', auth, wrap((req, res) => {
  const title = str(req.body.title, 150);
  const description = str(req.body.description, 5000);
  const category = CATEGORIES.includes(req.body.category) ? req.body.category : null;
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'media';
  if (!title || !description || !category)
    return res.status(400).json({ error: 'Título, descripción y categoría son obligatorios' });
  const info = db.prepare(`INSERT INTO tickets (title, description, category, priority, requester_id, department_id)
    VALUES (?,?,?,?,?,?)`).run(title, description, category, priority, req.user.id, req.user.department_id);
  const created = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(info.lastInsertRowid);
  mailer.notify(req.user.email, 'Recibimos tu solicitud', created,
    `Hola ${req.user.name}, registramos tu ticket. Te avisaremos cuando haya novedades.`);
  mailer.notify(staffEmails(req.user.id), `Nuevo ticket (${priority}) de ${req.user.department}`, created,
    `${req.user.name} (${req.user.email}) creó un ticket de ${category}, prioridad ${priority}.`);
  res.status(201).json(created);
}));

app.get('/api/tickets/:id', auth, wrap((req, res) => {
  const t = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(Number(req.params.id));
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Ticket no encontrado' });
  t.comments = db.prepare(`SELECT c.id, c.body, c.created_at, u.name AS author, u.role
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.ticket_id = ? ORDER BY c.id`).all(t.id);
  res.json(t);
}));

app.patch('/api/tickets/:id', auth, staff, wrap((req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Ticket no encontrado' });
  const status = STATUSES.includes(req.body.status) ? req.body.status : t.status;
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : t.priority;
  let assignee = t.assignee_id;
  if ('assignee_id' in req.body) {
    if (req.body.assignee_id === null || req.body.assignee_id === '') assignee = null;
    else {
      const a = getUser(Number(req.body.assignee_id));
      if (!a || !isStaff(a)) return res.status(400).json({ error: 'Asignado inválido' });
      assignee = a.id;
    }
  }
  db.prepare("UPDATE tickets SET status=?, priority=?, assignee_id=?, updated_at=datetime('now') WHERE id=?")
    .run(status, priority, assignee, t.id);
  const updated = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(t.id);
  if (status !== t.status)
    mailer.notify(updated.requester_email, `Estado: ${status.replace('_', ' ')}`, updated,
      `El estado de tu ticket cambió de "${t.status.replace('_', ' ')}" a "${status.replace('_', ' ')}".`);
  if (assignee && assignee !== t.assignee_id && assignee !== req.user.id)
    mailer.notify(getUser(assignee).email, 'Se te asignó un ticket', updated,
      `${req.user.name} te asignó este ticket (prioridad ${priority}).`);
  res.json(updated);
}));

app.post('/api/tickets/:id/comments', auth, wrap((req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Ticket no encontrado' });
  const body = str(req.body.body, 5000);
  if (!body) return res.status(400).json({ error: 'El comentario está vacío' });
  db.prepare('INSERT INTO comments (ticket_id, user_id, body) VALUES (?,?,?)').run(t.id, req.user.id, body);
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(t.id);
  const full = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(t.id);
  let to;
  if (req.user.id === t.requester_id) {
    to = t.assignee_id ? getUser(t.assignee_id)?.email : staffEmails(req.user.id);
  } else to = full.requester_email;
  mailer.notify(to, 'Nuevo comentario', full, `${req.user.name} comentó:\n\n${body}`);
  res.status(201).json({ ok: true });
}));

app.get('/api/staff', auth, staff, wrap((req, res) => {
  res.json(db.prepare(`${USER_SELECT} WHERE u.role IN ('agent','admin') ORDER BY u.name`).all());
}));

app.get('/api/stats', auth, staff, wrap((req, res) => {
  res.json({
    by_status: db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all(),
    by_department: db.prepare(`SELECT d.name AS department, COUNT(*) AS n FROM tickets t
      JOIN departments d ON d.id = t.department_id GROUP BY d.id ORDER BY n DESC`).all(),
  });
}));

// ---------- Admin ----------
app.get('/api/admin/users', auth, admin, wrap((req, res) => {
  res.json(db.prepare(`${USER_SELECT} ORDER BY u.name`).all());
}));

app.patch('/api/admin/users/:id', auth, admin, wrap((req, res) => {
  const u = getUser(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  const role = ['user', 'agent', 'admin'].includes(req.body.role) ? req.body.role : u.role;
  let dep = u.department_id;
  if (req.body.department_id !== undefined) {
    if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(Number(req.body.department_id)))
      return res.status(400).json({ error: 'Departamento inválido' });
    dep = Number(req.body.department_id);
  }
  if (u.id === req.user.id && role !== 'admin')
    return res.status(400).json({ error: 'No puedes quitarte el rol de administrador' });
  db.prepare('UPDATE users SET role = ?, department_id = ? WHERE id = ?').run(role, dep, u.id);
  res.json(getUser(u.id));
}));

app.post('/api/admin/departments', auth, admin, wrap((req, res) => {
  const name = str(req.body.name, 80);
  if (!name) return res.status(400).json({ error: 'Nombre obligatorio' });
  try {
    const info = db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
    res.status(201).json({ id: info.lastInsertRowid, name });
  } catch { res.status(409).json({ error: 'El departamento ya existe' }); }
}));

app.listen(PORT, () => console.log(`E-Ticket TI en http://localhost:${PORT} (dominio permitido: @${ALLOWED_DOMAIN})`));
