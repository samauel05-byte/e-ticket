const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
// Instalación nativa: cargar .env (o ENV_FILE) cuando se ejecuta directamente. No pisa variables ya definidas.
let ENV_STATUS = null;
if (require.main === module) ENV_STATUS = require('./loadEnv').loadEnv();
const multer = require('multer');
const helmet = require('helmet');
const SqliteStore = require('./sessionStore');
const db = require('./db');
const imap = require('./imapAuth');
const mailer = require('./mailer');
const limiter = require('./rateLimit');
const netAcl = require('./netAcl');
const sla = require('./sla');
const settings = require('./settings');
const mailCheck = require('./mailCheck');
const mailIngest = require('./mailIngest');
settings.applyToEnv(); // lo guardado en Administración tiene prioridad sobre .env
const { targets: SLA_TARGETS } = sla;

const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'empresa.com').toLowerCase().replace(/^@/, '');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();
const PORT = process.env.PORT || 3000;

const { STATUSES, PRIORITIES, CATEGORIES, resolveCategory, extraCategories, USER_SELECT, getUser, TICKET_SELECT, logEvent, staffEmails, isStaff, createTicket, addComment } = require('./tickets');

const { UPLOAD_DIR, MAX_MB, MAX_FILES, ALLOWED_EXT, extOf, storedName } = require('./uploads');
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => cb(null, storedName(file.originalname)),
  }),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_FILES },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_EXT.has(extOf(file.originalname))) return cb(null, true);
    const e = new Error('Tipo de archivo no permitido'); e.status = 400; cb(e);
  },
});

const app = express();
{
  // TRUST_PROXY: "true" = un proxy delante (Caddy); "false"/vacío = ninguno; un número = saltos; o una lista de IP/redes
  const tp = String(process.env.TRUST_PROXY || '').trim();
  if (tp && !/^(false|0|no)$/i.test(tp)) app.set('trust proxy', /^(true|yes|si)$/i.test(tp) ? 1 : /^\d+$/.test(tp) ? Number(tp) : tp);
}
app.get('/healthz', (req, res) => res.json({ ok: true }));
if (process.env.NODE_ENV === 'production' && !process.env.SESSION_SECRET) {
  console.error('Falta SESSION_SECRET (obligatorio en producción)');
  process.exit(1);
}
// CSP por defecto de helmet; sin HSTS forzado porque depende del proxy HTTPS
app.use(helmet({ strictTransportSecurity: process.env.COOKIE_SECURE === 'true' }));
app.use(express.json({ limit: '100kb' }));

// Anti-CSRF: en peticiones que modifican datos, si el navegador envía Origin debe ser el mismo host.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin) {
    let host = null;
    try { host = new URL(origin).host; } catch { /* origen inválido */ }
    if (host !== req.get('host')) return res.status(403).json({ error: 'Origen no permitido' });
  }
  next();
});

app.use(session({
  store: new SqliteStore(db),
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto-en-produccion',
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', maxAge: 8 * 60 * 60 * 1000, secure: process.env.COOKIE_SECURE === 'true' },
}));
app.use(express.static(path.join(__dirname, '..', 'public')));

const wrap = (fn) => (req, res) => {
  const fail = (e) => { console.error(e); if (!res.headersSent) res.status(500).json({ error: 'Error interno' }); };
  try { const r = fn(req, res); if (r && typeof r.catch === 'function') r.catch(fail); } catch (e) { fail(e); }
};
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// SLA con historial de estado/responsable y almuerzo del responsable
const eventsStmt = db.prepare('SELECT at, status, assignee_id FROM ticket_events WHERE ticket_id = ? ORDER BY id');
const lunchStmt = db.prepare('SELECT lunch_shift FROM users WHERE id = ?');
const withSla = (t) => sla.withSla(t, {
  events: t.id ? eventsStmt.all(t.id) : [],
  lunchFor: (uid) => (uid ? lunchStmt.get(uid)?.lunch_shift : null),
});

function auth(req, res, next) {
  const u = req.session.userId && getUser(req.session.userId);
  if (!u) return res.status(401).json({ error: 'No autenticado' });
  if (!u.active) return req.session.destroy(() => res.status(401).json({ error: 'Tu cuenta está desactivada. Contacta a Tecnología.' }));
  req.user = u;
  next();
}
const staff = (req, res, next) => (isStaff(req.user) ? next() : res.status(403).json({ error: 'Sin permiso' }));
const admin = (req, res, next) =>
  req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Sin permiso' });
// Roles:
//  user        pide tickets y ve los suyos
//  leader      líder de departamento: además ve (solo lectura) los tickets de su departamento
//  agent       técnico de TI: gestiona tickets; su dashboard solo muestra lo suyo; sin reportes ni administración
//  coordinator encargado de TI: ve todo, asigna, dashboard de todo el equipo y reportes; sin administración
//  manager     gerencia: ve todo, dashboard y reportes, solo lectura
//  admin       TI + administración de usuarios y correo
const ROLES = ['user', 'leader', 'agent', 'coordinator', 'manager', 'admin'];
const canViewAll = (u) => ['agent', 'coordinator', 'manager', 'admin'].includes(u.role);
const ASSIGNABLE = ['agent', 'admin']; // a quienes se les asignan tickets: Tecnología y Administración
const canReports = (u) => ['coordinator', 'manager', 'admin'].includes(u.role);
const viewer = (req, res, next) => (canViewAll(req.user) ? next() : res.status(403).json({ error: 'Sin permiso' }));
const reportsViewer = (req, res, next) => (canReports(req.user) ? next() : res.status(403).json({ error: 'Sin permiso' }));
const notManager = (req, res, next) => (req.user.role === 'manager' ? res.status(403).json({ error: 'Gerencia tiene acceso de solo lectura' }) : next());

// Opcional: Administración, Reportes y Dashboard solo desde la red interna (INTERNAL_CIDRS="192.168.0.0/16,10.0.0.0/8")
const internalRules = netAcl.parse(process.env.INTERNAL_CIDRS);
if (internalRules.length)
  app.use(['/api/admin', '/api/reports', '/api/dashboard'], (req, res, next) =>
    netAcl.allowed(internalRules, req.ip) ? next() : res.status(403).json({ error: 'Esta sección solo está disponible desde la red interna' }));

// ---------- Auth ----------
app.get('/api/meta', wrap((req, res) => {
  const departments = db.prepare('SELECT id, name FROM departments ORDER BY name').all();
  // Sin sesión solo se expone lo mínimo para mostrar el login (la app puede estar en internet)
  if (!req.session.userId) return res.json({ domain: ALLOWED_DOMAIN, imap: imap.enabled(), departments });
  res.json({
    domain: ALLOWED_DOMAIN, imap: imap.enabled(), sla: sla.config, statuses: STATUSES, priorities: PRIORITIES, categories: CATEGORIES.filter((c) => c !== 'Otro'), extra_categories: extraCategories(),
    departments,
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

const startSession = (req, res, id) => req.session.regenerate(() => {
  req.session.userId = id;
  res.json(getUser(id));
});

app.post('/api/login', async (req, res) => {
  try {
    const email = str(req.body.email, 200).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const ip = req.ip;
    const bad = async () => { await limiter.recordFailure(ip, email); return res.status(401).json({ error: 'Correo o contraseña incorrectos' }); };
    const wait = limiter.blockedFor(ip, email);
    if (wait) {
      res.set('Retry-After', String(wait));
      return res.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${Math.ceil(wait / 60)} min.` });
    }
    const row = db.prepare('SELECT id, password_hash, active FROM users WHERE email = ?').get(email);
    const off = () => res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta a Tecnología.' });

    if (!imap.enabled()) {
      if (!row || !bcrypt.compareSync(password, row.password_hash)) return bad();
      limiter.recordSuccess(email);
      if (!row.active) return off();
      return startSession(req, res, row.id);
    }

    if (!email.endsWith('@' + ALLOWED_DOMAIN) || !password) return bad();
    // Si el usuario es nuevo y aún no eligió departamento, se valida antes de pedírselo.
    if (!(await imap.verify(email, password))) return bad();
    limiter.recordSuccess(email);
    if (row) return row.active ? startSession(req, res, row.id) : off();

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
// Cada persona edita su propio nombre y departamento (el correo y el rol los cambia un administrador)
app.patch('/api/me', auth, wrap((req, res) => {
  const name = str(req.body.name ?? req.user.name, 100);
  if (name.length < 2) return res.status(400).json({ error: 'Escribe tu nombre (mínimo 2 letras)' });
  let dep = req.user.department_id;
  if (req.body.department_id !== undefined) {
    dep = Number(req.body.department_id);
    if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(dep)) return res.status(400).json({ error: 'Departamento no válido' });
  }
  db.prepare('UPDATE users SET name = ?, department_id = ? WHERE id = ?').run(name, dep, req.user.id);
  res.json(getUser(req.user.id));
}));

// ---------- Tickets ----------
const canSee = (u, t) => canViewAll(u) || t.requester_id === u.id || (u.role === 'leader' && t.department_id === u.department_id);

app.get('/api/tickets', auth, wrap((req, res) => {
  const where = []; const args = [];
  if (req.user.role === 'leader') { where.push('(t.requester_id = ? OR t.department_id = ?)'); args.push(req.user.id, req.user.department_id); }
  else if (!canViewAll(req.user)) { where.push('t.requester_id = ?'); args.push(req.user.id); }
  const { status, department_id, priority, q, assignee_id } = req.query;
  if (STATUSES.includes(status)) { where.push('t.status = ?'); args.push(status); }
  if (PRIORITIES.includes(priority)) { where.push('t.priority = ?'); args.push(priority); }
  if (department_id && canViewAll(req.user)) { where.push('t.department_id = ?'); args.push(Number(department_id)); }
  if (assignee_id && canViewAll(req.user)) {
    if (assignee_id === 'none') where.push('t.assignee_id IS NULL');
    else { where.push('t.assignee_id = ?'); args.push(Number(assignee_id)); }
  }
  if (q) { where.push('(t.title LIKE ? OR t.description LIKE ?)'); args.push(`%${str(q, 100)}%`, `%${str(q, 100)}%`); }
  const sql = `${TICKET_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY t.updated_at DESC, t.id DESC LIMIT 500`;
  res.json(db.prepare(sql).all(...args).map((t) => withSla(t)));
}));

app.post('/api/tickets', auth, wrap((req, res) => {
  const title = str(req.body.title, 150);
  const description = str(req.body.description, 5000);
  const category = resolveCategory(req.body.category, req.body.category_other);
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'media';
  if (!title || !description || !category)
    return res.status(400).json({ error: 'Título, descripción y categoría son obligatorios (si eliges "Otra", escribe la categoría, de 2 a 60 caracteres)' });
  const created = createTicket({ requester: req.user, title, description, category, priority });
  res.status(201).json(created);
}));

const STATUS_ES = { abierto: 'Abierto', en_progreso: 'En progreso', en_espera: 'En espera', resuelto: 'Resuelto', cerrado: 'Cerrado' };
function historyOf(ticketId) {
  const rows = db.prepare(`SELECT e.at, e.status, e.assignee_id, e.note, a.name AS actor, s.name AS assignee
    FROM ticket_events e LEFT JOIN users a ON a.id = e.actor_id LEFT JOIN users s ON s.id = e.assignee_id
    WHERE e.ticket_id = ? ORDER BY e.id`).all(ticketId);
  let prev = null;
  return rows.map((e) => {
    const parts = [];
    if (!prev) parts.push('Ticket creado');
    else {
      if (e.status !== prev.status) parts.push(`Estado: ${STATUS_ES[prev.status] || prev.status} → ${STATUS_ES[e.status] || e.status}`);
      if (e.assignee_id !== prev.assignee_id) parts.push(e.assignee_id ? `Asignado a ${e.assignee}` : 'Quedó sin asignar');
    }
    if (e.note) parts.push(e.note);
    prev = e;
    return { at: e.at, actor: e.actor, text: parts.join(' · ') };
  }).filter((h) => h.text);
}
const REOPEN_DAYS = Number(process.env.REOPEN_DAYS ?? 14); // el solicitante puede reabrir hasta N días después de resolver (0 = sin límite); TI siempre
function canReopen(u, t) {
  if (!['resuelto', 'cerrado'].includes(t.status) || u.role === 'manager') return false;
  if (isStaff(u)) return true;
  if (t.requester_id !== u.id) return false;
  if (!REOPEN_DAYS || !t.resolved_at) return true;
  return Date.now() - new Date(String(t.resolved_at).replace(' ', 'T') + 'Z').getTime() <= REOPEN_DAYS * 86400000;
}

app.get('/api/tickets/:id', auth, wrap((req, res) => {
  const row = db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(Number(req.params.id));
  if (!row || !canSee(req.user, row)) return res.status(404).json({ error: 'Ticket no encontrado' });
  const t = withSla(row);
  t.attachments = db.prepare(`SELECT a.id, a.original_name, a.size, a.created_at, a.user_id, u.name AS author
    FROM attachments a JOIN users u ON u.id = a.user_id WHERE a.ticket_id = ? ORDER BY a.id`).all(t.id);
  const seeInternal = isStaff(req.user) || req.user.role === 'manager';
  t.comments = db.prepare(`SELECT c.id, c.body, c.created_at, c.internal, u.name AS author, u.role
    FROM comments c JOIN users u ON u.id = c.user_id WHERE c.ticket_id = ? ${seeInternal ? '' : 'AND c.internal = 0'} ORDER BY c.id`).all(t.id);
  t.history = historyOf(t.id);
  t.can_reopen = canReopen(req.user, t);
  t.can_confirm = t.status === 'resuelto' && t.requester_id === req.user.id;
  res.json(t);
}));

app.patch('/api/tickets/:id', auth, staff, wrap((req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!t) return res.status(404).json({ error: 'Ticket no encontrado' });
  const status = STATUSES.includes(req.body.status) ? req.body.status : t.status;
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : t.priority;
  let category = t.category;
  if (req.body.category !== undefined && req.body.category !== '') {
    category = resolveCategory(req.body.category, req.body.category_other);
    if (!category) return res.status(400).json({ error: 'Categoría no válida (si eliges "Otra", escríbela, de 2 a 60 caracteres)' });
  }
  let assignee = t.assignee_id;
  if ('assignee_id' in req.body) {
    if (req.body.assignee_id === null || req.body.assignee_id === '') assignee = null;
    else {
      const a = getUser(Number(req.body.assignee_id));
      if (!a || !a.active || !ASSIGNABLE.includes(a.role)) return res.status(400).json({ error: 'Solo se puede asignar a personal de Tecnología o Administración' });
      assignee = a.id;
    }
  }
  const done = (x) => x === 'resuelto' || x === 'cerrado';
  let resolution = t.resolution;
  if (typeof req.body.resolution === 'string') resolution = str(req.body.resolution, 3000) || null;
  if (done(status) && !resolution) return res.status(400).json({ error: 'Escribe cómo se resolvió el ticket (campo Solución) antes de marcarlo como resuelto' });
  const changed = status !== t.status || assignee !== t.assignee_id;
  const firstResp = !t.first_response_at && changed && req.user.id !== t.requester_id;
  db.prepare(`UPDATE tickets SET status=?, priority=?, category=?, assignee_id=?, resolution=?, updated_at=datetime('now'),
      first_response_at = CASE WHEN ? THEN datetime('now') ELSE first_response_at END,
      resolved_at = CASE WHEN ? THEN COALESCE(resolved_at, datetime('now')) ELSE NULL END
      WHERE id=?`)
    .run(status, priority, category, assignee, resolution, firstResp ? 1 : 0, done(status) ? 1 : 0, t.id);
  const notes = [];
  if (priority !== t.priority) notes.push(`Prioridad: ${t.priority} → ${priority}`);
  if (category !== t.category) notes.push(`Categoría: ${t.category} → ${category}`);
  if (changed || notes.length) logEvent.run(t.id, status, assignee, req.user.id, notes.join(' · ') || null);
  const updated = withSla(db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(t.id));
  if (status !== t.status)
    mailer.notify(updated.requester_email, `Estado: ${status.replace('_', ' ')}`, updated,
      `El estado de tu ticket cambió de "${t.status.replace('_', ' ')}" a "${status.replace('_', ' ')}".` +
      (done(status) && resolution ? `\n\nSolución:\n${resolution}` : ''));
  if (assignee && assignee !== t.assignee_id && assignee !== req.user.id)
    mailer.notify(getUser(assignee).email, 'Se te asignó un ticket', updated,
      `${req.user.name} te asignó este ticket (prioridad ${priority}).`);
  res.json(updated);
}));

app.post('/api/tickets/:id/reopen', auth, notManager, wrap((req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Ticket no encontrado' });
  if (!canReopen(req.user, t)) return res.status(403).json({ error: ['resuelto', 'cerrado'].includes(t.status) ? `Ya pasaron más de ${REOPEN_DAYS} días: crea un ticket nuevo` : 'Solo se pueden reabrir tickets resueltos o cerrados' });
  const reason = str(req.body.reason, 2000);
  db.prepare("UPDATE tickets SET status = 'abierto', resolved_at = NULL, updated_at = datetime('now') WHERE id = ?").run(t.id);
  logEvent.run(t.id, 'abierto', t.assignee_id, req.user.id, req.user.id === t.requester_id ? 'Reabierto por el solicitante' : 'Reabierto por TI');
  if (reason) addComment({ ticket: t, user: req.user, body: `Reabrí el ticket: ${reason}` });
  else {
    const full = withSla(db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(t.id));
    const to = req.user.id === t.requester_id ? (t.assignee_id ? getUser(t.assignee_id)?.email : staffEmails(req.user.id)) : full.requester_email;
    mailer.notify(to, 'Ticket reabierto', full, `${req.user.name} reabrió el ticket.`);
  }
  res.json(withSla(db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(t.id)));
}));

// El solicitante confirma que la solución funcionó: el ticket pasa a "cerrado"
app.post('/api/tickets/:id/confirm', auth, wrap((req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!t || t.requester_id !== req.user.id) return res.status(404).json({ error: 'Ticket no encontrado' });
  if (t.status !== 'resuelto') return res.status(400).json({ error: 'Solo se puede confirmar un ticket resuelto' });
  db.prepare("UPDATE tickets SET status = 'cerrado', updated_at = datetime('now') WHERE id = ?").run(t.id);
  logEvent.run(t.id, 'cerrado', t.assignee_id, req.user.id, 'Solución confirmada por el solicitante');
  res.json(withSla(db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(t.id)));
}));

app.post('/api/tickets/:id/comments', auth, notManager, wrap((req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Ticket no encontrado' });
  const body = str(req.body.body, 5000);
  if (!body) return res.status(400).json({ error: 'El comentario está vacío' });
  const internal = req.body.internal === true || req.body.internal === 'true' || req.body.internal === 'on';
  if (internal && !isStaff(req.user)) return res.status(403).json({ error: 'Solo TI puede dejar notas internas' });
  addComment({ ticket: t, user: req.user, body, internal });
  res.status(201).json({ ok: true });
}));

// ---------- Adjuntos ----------
const loadTicket = (req, res, next) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Ticket no encontrado' });
  req.ticket = t;
  next();
};
const rmFiles = (files) => (files || []).forEach((f) => fs.unlink(f.path, () => {}));

app.post('/api/tickets/:id/attachments', auth, notManager, loadTicket, upload.array('files', 5), wrap((req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  const ins = db.prepare('INSERT INTO attachments (ticket_id, user_id, original_name, stored_name, size) VALUES (?,?,?,?,?)');
  try {
    db.transaction(() => req.files.forEach((f) => ins.run(req.ticket.id, req.user.id,
      // multer entrega el nombre como latin1; se recupera el UTF-8 original
      Buffer.from(f.originalname, 'latin1').toString('utf8').replace(/[\\/\r\n]/g, '_').slice(0, 200),
      f.filename, f.size)))();
  } catch (e) { rmFiles(req.files); throw e; }
  db.prepare("UPDATE tickets SET updated_at = datetime('now') WHERE id = ?").run(req.ticket.id);
  res.status(201).json({ ok: true, count: req.files.length });
}));

app.get('/api/attachments/:id', auth, wrap((req, res) => {
  const a = db.prepare('SELECT a.*, t.requester_id, t.department_id FROM attachments a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ?')
    .get(Number(req.params.id));
  if (!a || !canSee(req.user, a)) return res.status(404).json({ error: 'Archivo no encontrado' });
  res.set('X-Content-Type-Options', 'nosniff');
  res.download(path.join(UPLOAD_DIR, a.stored_name), a.original_name, (err) => {
    if (err && !res.headersSent) res.status(404).json({ error: 'Archivo no encontrado' });
  });
}));

app.delete('/api/attachments/:id', auth, wrap((req, res) => {
  const a = db.prepare('SELECT a.*, t.requester_id, t.department_id FROM attachments a JOIN tickets t ON t.id = a.ticket_id WHERE a.id = ?')
    .get(Number(req.params.id));
  if (!a || !canSee(req.user, a)) return res.status(404).json({ error: 'Archivo no encontrado' });
  if (a.user_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'Sin permiso' });
  db.prepare('DELETE FROM attachments WHERE id = ?').run(a.id);
  fs.unlink(path.join(UPLOAD_DIR, a.stored_name), () => {});
  res.json({ ok: true });
}));

app.get('/api/staff', auth, staff, wrap((req, res) => {
  res.json(db.prepare(`${USER_SELECT} WHERE u.role IN ('agent','admin') AND u.active = 1 ORDER BY u.name`).all());
}));

app.get('/api/stats', auth, staff, wrap((req, res) => {
  res.json({
    by_status: db.prepare('SELECT status, COUNT(*) AS n FROM tickets GROUP BY status').all(),
    by_department: db.prepare(`SELECT d.name AS department, COUNT(*) AS n FROM tickets t
      JOIN departments d ON d.id = t.department_id GROUP BY d.id ORDER BY n DESC`).all(),
  });
}));

// ---------- Reportes ----------
const ymd = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !isNaN(Date.parse(v)) ? v : null);
function rangeOf(q) {
  const from = ymd(q.from), to = ymd(q.to);
  const where = []; const args = [];
  if (from) { where.push('t.created_at >= ?'); args.push(from + ' 00:00:00'); }
  if (to) { where.push("t.created_at < date(?, '+1 day')"); args.push(to); }
  return { from, to, sql: where.length ? 'WHERE ' + where.join(' AND ') : '', args };
}
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const round1 = (x) => (x == null ? null : Math.round(x * 10) / 10);

function group(rows, keyFn) {
  const m = new Map();
  for (const r of rows) {
    const k = keyFn(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.entries()].map(([name, list]) => summarize(name, list)).sort((a, b) => b.total - a.total);
}
function summarize(name, list) {
  const responded = list.filter((t) => t.response_hours != null);
  const resolved = list.filter((t) => t.resolve_hours != null);
  return {
    name, total: list.length,
    open: list.filter((t) => !t.resolved_at).length,
    resolved: resolved.length,
    avg_response_h: round1(avg(responded.map((t) => t.response_hours))),
    avg_resolve_h: round1(avg(resolved.map((t) => t.resolve_hours))),
    response_sla_pct: pct(list.filter((t) => !t.sla_response_breached).length, list.length),
    resolve_sla_pct: pct(list.filter((t) => !t.sla_resolve_breached).length, list.length),
  };
}

app.get('/api/reports', auth, reportsViewer, wrap((req, res) => {
  const r = rangeOf(req.query);
  const rows = db.prepare(`${TICKET_SELECT} ${r.sql}`).all(...r.args).map((t) => withSla(t));
  res.json({
    from: r.from, to: r.to, sla_targets: SLA_TARGETS,
    summary: summarize('Total', rows),
    overdue_open: rows.filter((t) => !t.resolved_at && (t.sla_response_breached || t.sla_resolve_breached)).length,
    by_status: group(rows, (t) => t.status),
    by_priority: group(rows, (t) => t.priority),
    by_department: group(rows, (t) => t.department),
    by_category: group(rows, (t) => t.category),
    by_assignee: group(rows, (t) => t.assignee_name || 'Sin asignar'),
  });
}));

const csvCell = (v) => {
  let s = v == null ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // evita fórmulas al abrir en Excel
  return /[",\n\r;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
app.get('/api/reports/export.csv', auth, reportsViewer, wrap((req, res) => {
  const r = rangeOf(req.query);
  const rows = db.prepare(`${TICKET_SELECT} ${r.sql} ORDER BY t.id`).all(...r.args).map((t) => withSla(t));
  const head = ['id', 'titulo', 'categoria', 'prioridad', 'estado', 'solicitante', 'departamento', 'asignado', 'creado_utc',
    'primera_respuesta_utc', 'resuelto_utc', 'horas_habiles_hasta_respuesta', 'horas_habiles_hasta_resolucion', 'sla_respuesta_vencido', 'sla_resolucion_vencido', 'solucion', 'origen'];
  const lines = [head.join(',')].concat(rows.map((t) => [t.id, t.title, t.category, t.priority, t.status, t.requester_name,
    t.department, t.assignee_name, t.created_at, t.first_response_at, t.resolved_at, round1(t.response_hours),
    round1(t.resolve_hours), t.sla_response_breached ? 'si' : 'no', t.sla_resolve_breached ? 'si' : 'no', t.resolution, t.source].map(csvCell).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="tickets.csv"');
  res.send('﻿' + lines.join('\r\n'));
}));

// ---------- Dashboard (TI y gerencia) ----------
const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: sla.config.TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const localDay = (ms) => dayFmt.format(ms);
const toMs = (str2) => new Date(String(str2).replace(' ', 'T') + 'Z').getTime();

app.get('/api/dashboard', auth, viewer, wrap((req, res) => {
  const days = [7, 30, 90, 365].includes(Number(req.query.days)) ? Number(req.query.days) : 30;
  const q = { from: req.query.from, to: req.query.to };
  if (!ymd(q.from) && !ymd(q.to)) q.from = localDay(Date.now() - (days - 1) * 86400000);
  const r = rangeOf(q);
  const own = req.user.role === 'agent'; // el técnico solo ve su propio dashboard
  let rows = db.prepare(`${TICKET_SELECT} ${r.sql}`).all(...r.args).map((t) => withSla(t));
  if (own) rows = rows.filter((t) => t.assignee_id === req.user.id);

  const stat = (name, list) => {
    const x = summarize(name, list);
    x.pct_resolved = x.total ? Math.round((x.resolved / x.total) * 1000) / 10 : null;
    x.overdue_open = list.filter((t) => !t.resolved_at && (t.sla_response_breached || t.sla_resolve_breached)).length;
    return x;
  };
  const team = db.prepare(`${USER_SELECT} WHERE u.role IN ('agent','admin') AND u.active = 1 ${own ? 'AND u.id = ?' : ''} ORDER BY u.name`).all(...(own ? [req.user.id] : []))
    .map((u) => ({ id: u.id, email: u.email, role: u.role, ...stat(u.name, rows.filter((t) => t.assignee_id === u.id)) }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  // Tendencia de los últimos 14 días: tickets creados y resueltos por día (en la zona horaria del SLA)
  const trend = [];
  for (let i = 13; i >= 0; i--) trend.push({ day: localDay(Date.now() - i * 86400000), created: 0, resolved: 0 });
  const idx = new Map(trend.map((d, i) => [d.day, i]));
  for (const t of db.prepare(`SELECT created_at, resolved_at FROM tickets WHERE (created_at >= datetime('now','-16 days') OR resolved_at >= datetime('now','-16 days')) ${own ? 'AND assignee_id = ?' : ''}`).all(...(own ? [req.user.id] : []))) {
    const c = idx.get(localDay(toMs(t.created_at))); if (c !== undefined) trend[c].created++;
    if (t.resolved_at) { const k = idx.get(localDay(toMs(t.resolved_at))); if (k !== undefined) trend[k].resolved++; }
  }
  res.json({
    from: r.from, to: r.to, days,
    summary: stat('Total', rows),
    team,
    unassigned: own ? null : stat('Sin asignar', rows.filter((t) => !t.assignee_id)),
    scope: own ? 'own' : 'all',
    by_department: group(rows, (t) => t.department).slice(0, 8),
    trend,
  });
}));

// ---------- Admin ----------
app.get('/api/admin/users', auth, admin, wrap((req, res) => {
  res.json(db.prepare(`${USER_SELECT} ORDER BY u.name`).all());
}));

app.patch('/api/admin/users/:id', auth, admin, wrap((req, res) => {
  const u = getUser(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  const role = ROLES.includes(req.body.role) ? req.body.role : u.role;
  // Nombre y correo editables
  let name = u.name, email = u.email;
  if (req.body.name !== undefined) {
    name = str(req.body.name, 100);
    if (name.length < 2) return res.status(400).json({ error: 'El nombre debe tener al menos 2 letras' });
  }
  if (req.body.email !== undefined) {
    email = str(req.body.email, 200).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+$/.test(email) || !email.endsWith('@' + ALLOWED_DOMAIN))
      return res.status(400).json({ error: `El correo debe ser de la empresa (@${ALLOWED_DOMAIN})` });
    if (email !== u.email) {
      if (u.id === req.user.id) return res.status(400).json({ error: 'No puedes cambiar tu propio correo (podrías quedarte sin acceso); pídeselo a otro administrador' });
      if (db.prepare('SELECT 1 FROM users WHERE email = ? AND id != ?').get(email, u.id)) return res.status(409).json({ error: 'Ya existe otro usuario con ese correo' });
    }
  }
  let dep = u.department_id;
  if (req.body.department_id !== undefined) {
    if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(Number(req.body.department_id)))
      return res.status(400).json({ error: 'Departamento inválido' });
    dep = Number(req.body.department_id);
  }
  if (u.id === req.user.id && role !== 'admin')
    return res.status(400).json({ error: 'No puedes quitarte el rol de administrador' });
  let lunch = u.lunch_shift;
  if (req.body.lunch_shift !== undefined) {
    lunch = req.body.lunch_shift === '' || req.body.lunch_shift === null ? null : String(req.body.lunch_shift);
    if (lunch && !sla.config.LUNCH_SHIFTS[lunch]) return res.status(400).json({ error: 'Turno de almuerzo inválido' });
  }
  let active = u.active;
  if (req.body.active !== undefined) {
    active = req.body.active === true || req.body.active === 'true' || req.body.active === 1 ? 1 : 0;
    if (!active && u.id === req.user.id) return res.status(400).json({ error: 'No puedes desactivar tu propia cuenta' });
  }
  db.prepare('UPDATE users SET name = ?, email = ?, role = ?, department_id = ?, lunch_shift = ?, active = ? WHERE id = ?').run(name, email, role, dep, lunch, active, u.id);
  res.json(getUser(u.id));
}));

// ── Correo: configuración y pruebas de conexión (solo administradores) ──
const mailState = () => ({ config: settings.publicConfig(), inbox: mailIngest.status(), smtp_enabled: mailer.enabled(), login_enabled: imap.enabled() });
app.get('/api/admin/mail', auth, admin, wrap((req, res) => res.json(mailState())));
app.put('/api/admin/mail', auth, admin, wrap((req, res) => {
  try { settings.save(req.body.values || {}, req.user.id); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  mailIngest.restart();
  res.json(mailState());
}));
// Prueba lo que hay escrito en el formulario (sin guardarlo); contraseña vacía = la guardada
app.post('/api/admin/mail/test', auth, admin, wrap(async (req, res) => {
  let cfg;
  try { cfg = settings.effective(req.body.values || {}); } catch (e) { return res.status(400).json({ error: e.message }); }
  const what = req.body.what;
  if (what === 'inbox') return res.json(await mailCheck.checkInbox(cfg));
  if (what === 'smtp') {
    const to = String(req.body.send_to || '').trim().toLowerCase();
    if (to && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return res.status(400).json({ error: 'Correo de destino no válido' });
    return res.json(await mailCheck.checkSmtp(cfg, to || null));
  }
  if (what === 'login') return res.json(await mailCheck.checkLogin(cfg, String(req.body.email || '').trim(), String(req.body.password || '')));
  res.status(400).json({ error: 'Prueba desconocida' });
}));

app.post('/api/admin/departments', auth, admin, wrap((req, res) => {
  const name = str(req.body.name, 80);
  if (!name) return res.status(400).json({ error: 'Nombre obligatorio' });
  try {
    const info = db.prepare('INSERT INTO departments (name) VALUES (?)').run(name);
    res.status(201).json({ id: info.lastInsertRowid, name });
  } catch { res.status(409).json({ error: 'El departamento ya existe' }); }
}));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError)
    return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `El archivo supera ${MAX_MB} MB` : 'Error al subir el archivo (máx. 5 archivos)' });
  if (err.status === 400) return res.status(400).json({ error: err.message });
  console.error(err); res.status(500).json({ error: 'Error interno' });
});

if (require.main === module)
  app.listen(PORT, () => {
    if (ENV_STATUS) (ENV_STATUS.loaded ? console.log : console.warn)(require('./loadEnv').describe(ENV_STATUS));
    console.log(`ETIQUE en http://localhost:${PORT} (dominio permitido: @${ALLOWED_DOMAIN})`);
    mailIngest.start();
    require('./slaAlerts').start(sla.withSla);
    const hm = (a) => a.map((n) => String(n).padStart(2, '0')).join(':');
    console.log(`SLA: ${hm(sla.config.START)}–${hm(sla.config.END)} zona ${sla.config.TZ}`);
    if (!process.env.SLA_TZ && sla.config.TZ === 'UTC')
      console.warn('AVISO: SLA_TZ no está definido y el servidor usa UTC; define SLA_TZ (p. ej. America/Bogota) para que el horario laboral sea el correcto.');
  });

module.exports = app;
