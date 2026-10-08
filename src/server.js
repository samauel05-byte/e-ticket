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
const forms = require('./forms');
const automation = require('./automation');
const audit = require('./audit');
const limits = require('./limits');
const totp = require('./totp');
const passwords = require('./passwords');
const securityCheck = require('./securityCheck');
settings.applyToEnv(); // lo guardado en Administración tiene prioridad sobre .env
const { targets: SLA_TARGETS } = sla;

const ALLOWED_DOMAIN = (process.env.ALLOWED_DOMAIN || 'empresa.com').toLowerCase().replace(/^@/, '');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').toLowerCase();
const PORT = process.env.PORT || 3000;

const { STATUSES, PRIORITIES, CATEGORIES, categoryList, ASSIGNABLE, resolveCategory, extraCategories, USER_SELECT, getUser, TICKET_SELECT, logEvent, staffEmails, isStaff, createTicket, addComment } = require('./tickets');

const { UPLOAD_DIR, MAX_MB, MAX_FILES, ALLOWED_EXT, extOf, storedName, sniffFile } = require('./uploads');
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
if (process.env.NODE_ENV === 'production' && securityCheck.weakSecret(process.env.SESSION_SECRET)) {
  console.error('SESSION_SECRET es demasiado débil o es el valor de ejemplo. Genera uno nuevo: openssl rand -hex 32');
  process.exit(1);
}
// Cabeceras de seguridad. HSTS solo con HTTPS (COOKIE_SECURE=true). La interfaz usa estilos en línea, pero ningún script en línea.
const HTTPS = process.env.COOKIE_SECURE === 'true';
app.use(helmet({
  strictTransportSecurity: HTTPS ? { maxAge: 31536000, includeSubDomains: true } : false,
  contentSecurityPolicy: {
    useDefaults: false,
    directives: {
      'default-src': ["'self'"], 'script-src': ["'self'"], 'style-src': ["'self'", "'unsafe-inline'"], 'img-src': ["'self'", 'data:'],
      'font-src': ["'self'"], 'connect-src': ["'self'"], 'object-src': ["'none'"], 'frame-ancestors': ["'none'"], 'base-uri': ["'self'"],
      'form-action': ["'self'"], ...(HTTPS ? { 'upgrade-insecure-requests': [] } : {}),
    },
  },
  referrerPolicy: { policy: 'no-referrer' },
  crossOriginResourcePolicy: { policy: 'same-origin' },
  crossOriginOpenerPolicy: { policy: 'same-origin' },
}));
app.use((req, res, next) => { res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()'); next(); });
// Las respuestas de la API nunca se guardan en caché (equipos compartidos, proxys)
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
app.use(express.json({ limit: '100kb' }));
app.use('/api', limits.middleware('api')); // tope de peticiones por IP

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

const IDLE_MS = (Number(process.env.SESSION_IDLE_MIN) > 0 ? Number(process.env.SESSION_IDLE_MIN) : 120) * 60 * 1000;      // inactividad
const MAX_MS = (Number(process.env.SESSION_MAX_HOURS) > 0 ? Number(process.env.SESSION_MAX_HOURS) : 12) * 3600 * 1000;      // duración máxima
app.use(session({
  name: HTTPS ? '__Host-eticket.sid' : 'eticket.sid',
  store: new SqliteStore(db),
  secret: process.env.SESSION_SECRET || 'cambia-este-secreto-en-produccion',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'strict', maxAge: IDLE_MS, secure: HTTPS, path: '/' },
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

const epochStmt = db.prepare('SELECT session_epoch FROM users WHERE id = ?');
const bumpEpoch = (id) => db.prepare('UPDATE users SET session_epoch = session_epoch + 1 WHERE id = ?').run(id); // cierra todas las sesiones de esa persona
// Roles que deben usar verificación en dos pasos (REQUIRE_2FA_ROLES="admin,coordinator")
const REQUIRE_2FA = String(process.env.REQUIRE_2FA_ROLES || '').split(',').map((r) => r.trim()).filter(Boolean);
const must2fa = (u) => REQUIRE_2FA.includes(u.role) && !u.totp_enabled;
const OPEN_WHEN_2FA_PENDING = /^\/api\/(me|logout|me\/2fa\/.*)$/;

function auth(req, res, next) {
  const u = req.session.userId && getUser(req.session.userId);
  if (!u) return res.status(401).json({ error: 'No autenticado' });
  if (!u.active) return req.session.destroy(() => res.status(401).json({ error: 'Tu cuenta está desactivada. Contacta a Tecnología.' }));
  if ((req.session.epoch ?? 0) !== epochStmt.get(u.id).session_epoch || Date.now() - (req.session.createdAt || 0) > MAX_MS)
    return req.session.destroy(() => res.status(401).json({ error: 'Tu sesión terminó. Entra de nuevo.' }));
  if (must2fa(u) && !OPEN_WHEN_2FA_PENDING.test(req.path))
    return res.status(403).json({ error: 'Tu rol exige la verificación en dos pasos: actívala en Mi perfil para continuar.', code: '2fa_required' });
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
    domain: ALLOWED_DOMAIN, imap: imap.enabled(), sla: sla.config, statuses: STATUSES, priorities: PRIORITIES, categories: categoryList(), forms: forms.all(), extra_categories: extraCategories(),
    departments,
  });
}));

app.post('/api/register', limits.middleware('register'), wrap((req, res) => {
  if (imap.enabled()) return res.status(404).json({ error: 'Registro deshabilitado: usa tu correo de la empresa para entrar' });
  const email = str(req.body.email, 200).toLowerCase();
  const name = str(req.body.name, 100);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  const departmentId = Number(req.body.department_id);
  if (!/^[^@\s]+@[^@\s]+$/.test(email) || !email.endsWith('@' + ALLOWED_DOMAIN))
    return res.status(400).json({ error: `Solo se permiten correos @${ALLOWED_DOMAIN}` });
  if (!name) return res.status(400).json({ error: 'El nombre es obligatorio' });
  const weak = passwords.check(password, email);
  if (weak) return res.status(400).json({ error: weak });
  if (!db.prepare('SELECT 1 FROM departments WHERE id = ?').get(departmentId))
    return res.status(400).json({ error: 'Departamento inválido' });
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email))
    return res.status(409).json({ error: 'Ese correo ya está registrado' });
  const role = email === ADMIN_EMAIL ? 'admin' : 'user';
  const info = db.prepare('INSERT INTO users (email, name, password_hash, department_id, role) VALUES (?,?,?,?,?)')
    .run(email, name, passwords.hash(password), departmentId, role);
  audit.log(req, 'user.register', email, `rol ${role}`, { id: info.lastInsertRowid, email });
  req.session.regenerate(() => {
    req.session.userId = info.lastInsertRowid; req.session.epoch = 0; req.session.createdAt = Date.now();
    res.status(201).json(meView(getUser(info.lastInsertRowid)));
  });
}));

const startSession = (req, res, id, how = 'login') => {
  const user = getUser(id);
  const epoch = epochStmt.get(id).session_epoch;
  // Con verificación en dos pasos activa, la sesión queda "pendiente" hasta que se escriba el código
  if (user.totp_enabled && how === 'login')
    return req.session.regenerate(() => { req.session.pending2fa = { id, at: Date.now() }; res.json({ needs_2fa: true }); });
  req.session.regenerate(() => {
    req.session.userId = id; req.session.epoch = epoch; req.session.createdAt = Date.now();
    audit.log(req, 'login.ok', user.email, how === 'login' ? null : how, user);
    res.json(meView(getUser(id)));
  });
};

app.post('/api/login', async (req, res) => {
  try {
    const email = str(req.body.email, 200).toLowerCase();
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const ip = req.ip;
    const bad = async () => { audit.log(req, 'login.fail', email); await limiter.recordFailure(ip, email); return res.status(401).json({ error: 'Correo o contraseña incorrectos' }); };
    const wait = limiter.blockedFor(ip, email);
    if (wait) {
      res.set('Retry-After', String(wait));
      audit.log(req, 'login.blocked', email, `${wait} s`);
      return res.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${Math.ceil(wait / 60)} min.` });
    }
    const row = db.prepare('SELECT id, password_hash, active FROM users WHERE email = ?').get(email);
    const off = () => { audit.log(req, 'login.disabled', email); return res.status(403).json({ error: 'Tu cuenta está desactivada. Contacta a Tecnología.' }); };

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

app.post('/api/logout', (req, res) => { if (req.session.userId) audit.log(req, 'logout', null, null, getUser(req.session.userId)); req.session.destroy(() => res.json({ ok: true })); });
const meView = (u) => ({ ...u, must_2fa: must2fa(u), local_password: !String(db.prepare('SELECT password_hash FROM users WHERE id = ?').get(u.id).password_hash).startsWith('!') });
app.get('/api/me', auth, (req, res) => res.json(meView(req.user)));
const refreshEpoch = (req) => { req.session.epoch = epochStmt.get(req.user.id).session_epoch; };

// ── Verificación en dos pasos (TOTP) ──
app.post('/api/login/2fa', wrap(async (req, res) => {
  const p = req.session.pending2fa;
  if (!p || Date.now() - p.at > 5 * 60 * 1000) return res.status(401).json({ error: 'El inicio de sesión expiró. Vuelve a escribir tu correo y contraseña.' });
  const row = db.prepare('SELECT id, email, active, totp_secret, totp_last, recovery_codes FROM users WHERE id = ?').get(p.id);
  const wait = limiter.blockedFor(req.ip, row.email);
  if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${Math.ceil(wait / 60)} min.` }); }
  const code = str(req.body.code, 40);
  let how = null;
  const secret = row.totp_secret ? settings.decrypt(row.totp_secret) : null;
  const counter = secret ? totp.verify(secret, code) : null;
  if (counter && counter > row.totp_last) { db.prepare('UPDATE users SET totp_last = ? WHERE id = ?').run(counter, row.id); how = '2fa'; } // un código no se puede reutilizar
  else {
    const hashes = JSON.parse(row.recovery_codes || '[]'); const i = hashes.indexOf(totp.hashCode(code));
    if (i >= 0) { hashes.splice(i, 1); db.prepare('UPDATE users SET recovery_codes = ? WHERE id = ?').run(JSON.stringify(hashes), row.id); how = '2fa (código de recuperación)'; }
  }
  if (!how || !row.active) { audit.log(req, 'login.2fa_fail', row.email); await limiter.recordFailure(req.ip, row.email); return res.status(401).json({ error: 'Código incorrecto' }); }
  limiter.recordSuccess(row.email);
  startSession(req, res, row.id, how);
}));

app.post('/api/me/2fa/setup', auth, wrap((req, res) => {
  if (req.user.totp_enabled) return res.status(400).json({ error: 'La verificación en dos pasos ya está activada' });
  const secret = totp.newSecret();
  db.prepare('UPDATE users SET totp_secret = ?, totp_enabled = 0 WHERE id = ?').run(settings.encrypt(secret), req.user.id);
  res.json({ secret, uri: totp.uri(secret, req.user.email) });
}));
app.post('/api/me/2fa/enable', auth, wrap((req, res) => {
  const row = db.prepare('SELECT totp_secret, totp_enabled FROM users WHERE id = ?').get(req.user.id);
  if (row.totp_enabled || !row.totp_secret) return res.status(400).json({ error: 'Primero genera la clave (paso 1)' });
  const secret = settings.decrypt(row.totp_secret);
  const counter = secret ? totp.verify(secret, req.body.code) : null;
  if (!counter) return res.status(400).json({ error: 'Código incorrecto. Revisa la hora de tu teléfono e inténtalo de nuevo.' });
  const codes = totp.newRecoveryCodes();
  db.prepare('UPDATE users SET totp_enabled = 1, totp_last = ?, recovery_codes = ? WHERE id = ?').run(counter, JSON.stringify(codes.map(totp.hashCode)), req.user.id);
  bumpEpoch(req.user.id); refreshEpoch(req); // cierra las demás sesiones abiertas
  audit.log(req, '2fa.enable', req.user.email);
  res.json({ ok: true, recovery_codes: codes });
}));
app.post('/api/me/2fa/disable', auth, wrap((req, res) => {
  if (REQUIRE_2FA.includes(req.user.role)) return res.status(403).json({ error: 'Tu rol exige la verificación en dos pasos: no se puede desactivar.' });
  const row = db.prepare('SELECT totp_secret, totp_last, recovery_codes FROM users WHERE id = ?').get(req.user.id);
  const secret = row.totp_secret ? settings.decrypt(row.totp_secret) : null;
  const counter = secret ? totp.verify(secret, req.body.code) : null;
  const rec = JSON.parse(row.recovery_codes || '[]').includes(totp.hashCode(req.body.code || ''));
  if (!(counter && counter > row.totp_last) && !rec) { audit.log(req, '2fa.disable_fail', req.user.email); return res.status(400).json({ error: 'Código incorrecto' }); }
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, totp_last = 0 WHERE id = ?').run(req.user.id);
  bumpEpoch(req.user.id); refreshEpoch(req);
  audit.log(req, '2fa.disable', req.user.email);
  res.json({ ok: true });
}));

// Cambiar la contraseña propia (solo cuentas con contraseña del sistema; con el login por correo se cambia en el correo)
app.post('/api/me/password', auth, wrap(async (req, res) => {
  const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.user.id);
  if (String(row.password_hash).startsWith('!')) return res.status(400).json({ error: 'Tu cuenta usa la contraseña de tu correo: cámbiala allí.' });
  const wait = limiter.blockedFor(req.ip, req.user.email);
  if (wait) { res.set('Retry-After', String(wait)); return res.status(429).json({ error: `Demasiados intentos. Intenta de nuevo en ${Math.ceil(wait / 60)} min.` }); }
  if (!bcrypt.compareSync(String(req.body.current || ''), row.password_hash)) { audit.log(req, 'password.fail', req.user.email); await limiter.recordFailure(req.ip, req.user.email); return res.status(403).json({ error: 'La contraseña actual no es correcta' }); }
  const next = String(req.body.next || '');
  const weak = passwords.check(next, req.user.email);
  if (weak) return res.status(400).json({ error: weak });
  if (bcrypt.compareSync(next, row.password_hash)) return res.status(400).json({ error: 'La contraseña nueva debe ser distinta de la actual' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(passwords.hash(next), req.user.id);
  bumpEpoch(req.user.id); refreshEpoch(req); // cierra las demás sesiones
  audit.log(req, 'password.change', req.user.email);
  res.json({ ok: true });
}));
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
  res.json(meView(getUser(req.user.id)));
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

app.post('/api/tickets', auth, limits.middleware('ticket', 'user'), wrap((req, res) => {
  const title = str(req.body.title, 150);
  const description = str(req.body.description, 5000);
  const category = resolveCategory(req.body.category, req.body.category_other);
  const priority = PRIORITIES.includes(req.body.priority) ? req.body.priority : 'media';
  if (!title || !description || !category)
    return res.status(400).json({ error: 'Título, descripción y categoría son obligatorios (si eliges "Otra", escribe la categoría, de 2 a 60 caracteres)' });
  let formData = null;
  try { formData = forms.validate(category, req.body.form); } catch (e) { return res.status(e.status || 400).json({ error: e.message }); }
  const created = createTicket({ requester: req.user, title, description, category, priority, formData });
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
  try { t.form = t.form_data ? JSON.parse(t.form_data) : []; } catch { t.form = []; }
  delete t.form_data;
  t.rating_detail = db.prepare('SELECT rating, comment, updated_at FROM ticket_ratings WHERE ticket_id = ?').get(t.id) || null;
  t.can_rate = ['resuelto', 'cerrado'].includes(t.status) && t.requester_id === req.user.id;
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
      (done(status) && resolution ? `\n\nSolución:\n${resolution}\n\n¿Cómo fue la atención? Abre el ticket y califícala de 1 a 5 estrellas; si algo sigue fallando, puedes reabrirlo.` : ''));
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

app.post('/api/tickets/:id/comments', auth, notManager, limits.middleware('comment', 'user'), wrap((req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Ticket no encontrado' });
  const body = str(req.body.body, 5000);
  if (!body) return res.status(400).json({ error: 'El comentario está vacío' });
  const internal = req.body.internal === true || req.body.internal === 'true' || req.body.internal === 'on';
  if (internal && !isStaff(req.user)) return res.status(403).json({ error: 'Solo TI puede dejar notas internas' });
  addComment({ ticket: t, user: req.user, body, internal });
  res.status(201).json({ ok: true });
}));

// ---------- Encuesta de satisfacción ----------
app.post('/api/tickets/:id/rating', auth, wrap((req, res) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!t || t.requester_id !== req.user.id) return res.status(404).json({ error: 'Ticket no encontrado' });
  if (!['resuelto', 'cerrado'].includes(t.status)) return res.status(400).json({ error: 'Solo puedes calificar un ticket resuelto' });
  const rating = Number(req.body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'La calificación va de 1 a 5 estrellas' });
  const comment = str(req.body.comment, 1000) || null;
  db.prepare(`INSERT INTO ticket_ratings (ticket_id, rating, comment, user_id) VALUES (?,?,?,?)
    ON CONFLICT(ticket_id) DO UPDATE SET rating = excluded.rating, comment = excluded.comment, updated_at = datetime('now')`).run(t.id, rating, comment, req.user.id);
  if (rating <= 2) { // calificación baja: se avisa al encargado para que lo atienda
    const full = withSla(db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(t.id));
    const to = automation.escalationRecipients(t);
    if (to.length) mailer.notify(to, 'Calificación baja', full, `${req.user.name} calificó con ${rating} de 5 la atención de este ticket.${comment ? `\n\nComentario:\n${comment}` : ''}`);
  }
  res.json({ rating, comment });
}));

// ---------- Base de conocimiento ----------
const kbManager = (req, res, next) => (isStaff(req.user) ? next() : res.status(403).json({ error: 'Solo el equipo de TI puede editar la base de conocimiento' }));
const KB_LIST = `SELECT a.id, a.title, a.category, a.published, a.views, a.updated_at, substr(a.body, 1, 200) AS snippet,
  (SELECT COUNT(*) FROM kb_votes v WHERE v.article_id = a.id AND v.helpful = 1) AS helpful,
  (SELECT COUNT(*) FROM kb_votes v WHERE v.article_id = a.id AND v.helpful = 0) AS not_helpful FROM kb_articles a`;
const likeEsc = (w) => '%' + w.replace(/[\\%_]/g, (c) => '\\' + c) + '%';

app.get('/api/kb', auth, wrap((req, res) => {
  const where = []; const args = [];
  if (!isStaff(req.user)) where.push('a.published = 1');
  const cat = str(req.query.category, 60);
  if (cat) { where.push('a.category = ?'); args.push(cat); }
  const words = String(req.query.q || '').toLowerCase().split(/\s+/).filter((w) => w.length >= 3).slice(0, 6);
  for (const w of words) { where.push("(lower(a.title) LIKE ? ESCAPE '\\' OR lower(a.body) LIKE ? ESCAPE '\\' OR lower(a.category) LIKE ? ESCAPE '\\')"); args.push(likeEsc(w), likeEsc(w), likeEsc(w)); }
  const titleHits = words.length ? words.map(() => "(lower(a.title) LIKE ? ESCAPE '\\')").join(' + ') : '(0+0)';
  const order = `${titleHits} DESC, helpful DESC, a.views DESC, a.updated_at DESC`;
  const rows = db.prepare(`${KB_LIST} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY ${order} LIMIT ?`)
    .all(...args, ...words.map(likeEsc), Math.min(Number(req.query.limit) || 100, 100));
  res.json({ articles: rows, categories: db.prepare(`SELECT category, COUNT(*) AS n FROM kb_articles ${isStaff(req.user) ? '' : 'WHERE published = 1'} GROUP BY category ORDER BY category`).all() });
}));

app.get('/api/kb/:id', auth, wrap((req, res) => {
  const a = db.prepare(`${KB_LIST.replace('substr(a.body, 1, 200) AS snippet', 'a.body, a.created_by, a.updated_by')} WHERE a.id = ?`).get(Number(req.params.id));
  if (!a || (!a.published && !isStaff(req.user))) return res.status(404).json({ error: 'Artículo no encontrado' });
  db.prepare('UPDATE kb_articles SET views = views + 1 WHERE id = ?').run(a.id);
  a.views += 1;
  a.my_vote = db.prepare('SELECT helpful FROM kb_votes WHERE article_id = ? AND user_id = ?').get(a.id, req.user.id)?.helpful ?? null;
  res.json(a);
}));

const kbFields = (b, cur = {}) => {
  const title = str(b.title ?? cur.title, 150), body = typeof (b.body ?? cur.body) === 'string' ? String(b.body ?? cur.body).replace(/\u0000/g, '').trim().slice(0, 20000) : '';
  const category = str(b.category ?? cur.category ?? 'General', 60) || 'General';
  const published = b.published === undefined ? (cur.published ?? 1) : b.published === true || b.published === 'true' || b.published === 1 ? 1 : 0;
  if (title.length < 3) return { error: 'El título debe tener al menos 3 caracteres' };
  if (body.length < 10) return { error: 'Escribe el contenido del artículo (mínimo 10 caracteres)' };
  return { title, body, category, published };
};
app.post('/api/kb', auth, kbManager, wrap((req, res) => {
  const f = kbFields(req.body);
  if (f.error) return res.status(400).json({ error: f.error });
  const id = db.prepare('INSERT INTO kb_articles (title, body, category, published, created_by, updated_by) VALUES (?,?,?,?,?,?)').run(f.title, f.body, f.category, f.published, req.user.id, req.user.id).lastInsertRowid;
  audit.log(req, 'kb.create', f.title);
  res.status(201).json({ id });
}));
app.patch('/api/kb/:id', auth, kbManager, wrap((req, res) => {
  const cur = db.prepare('SELECT * FROM kb_articles WHERE id = ?').get(Number(req.params.id));
  if (!cur) return res.status(404).json({ error: 'Artículo no encontrado' });
  const f = kbFields(req.body, cur);
  if (f.error) return res.status(400).json({ error: f.error });
  db.prepare("UPDATE kb_articles SET title=?, body=?, category=?, published=?, updated_at=datetime('now'), updated_by=? WHERE id=?").run(f.title, f.body, f.category, f.published, req.user.id, cur.id);
  audit.log(req, 'kb.update', f.title);
  res.json({ id: cur.id });
}));
app.delete('/api/kb/:id', auth, wrap((req, res) => {
  if (!['admin', 'coordinator'].includes(req.user.role)) return res.status(403).json({ error: 'Solo el administrador o el encargado pueden eliminar artículos' });
  const cur = db.prepare('SELECT title FROM kb_articles WHERE id = ?').get(Number(req.params.id));
  if (!cur) return res.status(404).json({ error: 'Artículo no encontrado' });
  db.prepare('DELETE FROM kb_articles WHERE id = ?').run(Number(req.params.id));
  audit.log(req, 'kb.delete', cur.title);
  res.json({ ok: true });
}));
app.post('/api/kb/:id/vote', auth, wrap((req, res) => {
  const a = db.prepare('SELECT id, published FROM kb_articles WHERE id = ?').get(Number(req.params.id));
  if (!a || (!a.published && !isStaff(req.user))) return res.status(404).json({ error: 'Artículo no encontrado' });
  const helpful = req.body.helpful === true || req.body.helpful === 'true' ? 1 : 0;
  db.prepare('INSERT INTO kb_votes (article_id, user_id, helpful) VALUES (?,?,?) ON CONFLICT(article_id, user_id) DO UPDATE SET helpful = excluded.helpful').run(a.id, req.user.id, helpful);
  res.json({ ok: true });
}));

// ---------- Adjuntos ----------
const loadTicket = (req, res, next) => {
  const t = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(req.params.id));
  if (!t || !canSee(req.user, t)) return res.status(404).json({ error: 'Ticket no encontrado' });
  req.ticket = t;
  next();
};
const rmFiles = (files) => (files || []).forEach((f) => fs.unlink(f.path, () => {}));

app.post('/api/tickets/:id/attachments', auth, notManager, loadTicket, limits.middleware('upload', 'user'), upload.array('files', 5), wrap((req, res) => {
  if (!req.files || !req.files.length) return res.status(400).json({ error: 'No se recibió ningún archivo' });
  // El contenido real debe corresponder a la extensión (un .exe o .html renombrado como .pdf se rechaza)
  const fake = req.files.filter((f) => !sniffFile(f.path, extOf(f.originalname)));
  if (fake.length) { rmFiles(req.files); audit.log(req, 'upload.rejected', `ticket #${req.ticket.id}`, fake.map((f) => Buffer.from(f.originalname, 'latin1').toString('utf8')).join(', ')); return res.status(400).json({ error: 'El contenido del archivo no corresponde a su tipo (' + Buffer.from(fake[0].originalname, 'latin1').toString('utf8') + ')' }); }
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
  res.set('Content-Security-Policy', "sandbox; default-src 'none'"); // un archivo descargado nunca ejecuta scripts en el sitio
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
  audit.log(req, 'attachment.delete', a.original_name, `ticket #${a.ticket_id}`);
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
    avg_rating: round1(avg(list.filter((t) => t.rating != null).map((t) => t.rating))),
    rating_count: list.filter((t) => t.rating != null).length,
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
    'primera_respuesta_utc', 'resuelto_utc', 'horas_habiles_hasta_respuesta', 'horas_habiles_hasta_resolucion', 'sla_respuesta_vencido', 'sla_resolucion_vencido', 'solucion', 'origen', 'calificacion'];
  const lines = [head.join(',')].concat(rows.map((t) => [t.id, t.title, t.category, t.priority, t.status, t.requester_name,
    t.department, t.assignee_name, t.created_at, t.first_response_at, t.resolved_at, round1(t.response_hours),
    round1(t.resolve_hours), t.sla_response_breached ? 'si' : 'no', t.sla_resolve_breached ? 'si' : 'no', t.resolution, t.source, t.rating].map(csvCell).join(',')));
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
// Todo cambio hecho desde Administración queda en la bitácora (sin valores: nunca se registran contraseñas)
app.use('/api/admin', (req, res, next) => {
  if (req.method !== 'GET' && !req.path.startsWith('/users') && !req.path.endsWith('/test'))
    res.on('finish', () => { if (res.statusCode < 400) audit.log(req, 'admin.change', `${req.method} ${req.originalUrl.split('?')[0]}`); });
  next();
});
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
  const ch = [];
  if (name !== u.name) ch.push(`nombre: ${u.name} → ${name}`);
  if (email !== u.email) ch.push(`correo: ${u.email} → ${email}`);
  if (role !== u.role) ch.push(`rol: ${u.role} → ${role}`);
  if (dep !== u.department_id) ch.push('departamento');
  if (active !== u.active) ch.push(active ? 'cuenta activada' : 'cuenta desactivada');
  if (lunch !== u.lunch_shift) ch.push('turno de almuerzo');
  if (ch.length) audit.log(req, 'user.update', u.email, ch.join('; '));
  if (!active && u.active) bumpEpoch(u.id); // al desactivar, sus sesiones abiertas mueren (aunque se reactive después). El rol nuevo ya rige al instante: se lee en cada petición.
  res.json(getUser(u.id));
}));

// ── Automatización (solo administradores): asignación, escalamiento, respuestas rápidas y formularios ──
const staffPool = () => db.prepare(`SELECT id, name, role FROM users WHERE active = 1 AND role IN ('agent','admin') ORDER BY name`).all();
const automationState = () => {
  const pools = {};
  for (const r of db.prepare('SELECT category, user_id FROM assign_pool').all()) (pools[r.category] ||= []).push(r.user_id);
  return {
    mode: automation.mode(), pools, staff: staffPool(), categories: ['*', ...categoryList()],
    rules: db.prepare('SELECT id, name, enabled, priority, condition, minutes, action, created_at FROM escalation_rules ORDER BY id').all(),
    templates: db.prepare('SELECT id, title, body FROM reply_templates ORDER BY title').all(),
    forms: forms.all(),
  };
};
app.get('/api/admin/automation', auth, admin, wrap((req, res) => res.json(automationState())));
app.put('/api/admin/automation/assign', auth, admin, wrap((req, res) => {
  const m = req.body.mode;
  if (!automation.MODES.includes(m)) return res.status(400).json({ error: 'Modo de asignación no válido' });
  const pools = req.body.pools && typeof req.body.pools === 'object' ? req.body.pools : {};
  const cats = new Set(['*', ...categoryList(), ...db.prepare('SELECT DISTINCT category FROM assign_pool').all().map((r) => r.category)]);
  const okIds = new Set(staffPool().map((u) => u.id));
  db.transaction(() => {
    automation.cfgSet('assign_mode', m);
    db.prepare('DELETE FROM assign_pool').run();
    const ins = db.prepare('INSERT OR IGNORE INTO assign_pool (category, user_id) VALUES (?, ?)');
    for (const [cat, ids] of Object.entries(pools)) {
      if (!cats.has(cat) || !Array.isArray(ids)) continue;
      for (const id of ids) if (okIds.has(Number(id))) ins.run(cat, Number(id));
    }
  })();
  res.json(automationState());
}));

const ruleFields = (b, cur = {}) => {
  const name = str(b.name ?? cur.name, 80);
  const priority = b.priority ?? cur.priority ?? '*';
  const condition = b.condition ?? cur.condition;
  const action = b.action ?? cur.action;
  const minutes = Number(b.minutes ?? cur.minutes);
  if (!name) return { error: 'Escribe un nombre para la regla' };
  if (priority !== '*' && !PRIORITIES.includes(priority)) return { error: 'Prioridad no válida' };
  if (!['no_response', 'unassigned', 'not_resolved'].includes(condition)) return { error: 'Condición no válida' };
  if (!['notify', 'priority_up', 'reassign'].includes(action)) return { error: 'Acción no válida' };
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 100000) return { error: 'Los minutos deben ser un número entero mayor que 0' };
  return { name, priority, condition, action, minutes };
};
app.post('/api/admin/escalation', auth, admin, wrap((req, res) => {
  const r = ruleFields(req.body);
  if (r.error) return res.status(400).json({ error: r.error });
  db.prepare('INSERT INTO escalation_rules (name, priority, condition, minutes, action) VALUES (?,?,?,?,?)').run(r.name, r.priority, r.condition, r.minutes, r.action);
  res.status(201).json(automationState());
}));
app.patch('/api/admin/escalation/:id', auth, admin, wrap((req, res) => {
  const cur = db.prepare('SELECT * FROM escalation_rules WHERE id = ?').get(Number(req.params.id));
  if (!cur) return res.status(404).json({ error: 'Regla no encontrada' });
  const r = ruleFields(req.body, cur);
  if (r.error) return res.status(400).json({ error: r.error });
  const enabled = req.body.enabled === undefined ? cur.enabled : req.body.enabled === true || req.body.enabled === 'true' ? 1 : 0;
  db.prepare('UPDATE escalation_rules SET name=?, priority=?, condition=?, minutes=?, action=?, enabled=? WHERE id=?').run(r.name, r.priority, r.condition, r.minutes, r.action, enabled, cur.id);
  res.json(automationState());
}));
app.delete('/api/admin/escalation/:id', auth, admin, wrap((req, res) => {
  db.prepare('DELETE FROM escalation_rules WHERE id = ?').run(Number(req.params.id));
  db.prepare('DELETE FROM escalation_log WHERE rule_id = ?').run(Number(req.params.id));
  res.json(automationState());
}));

// Respuestas rápidas: TI las usa al comentar; el administrador las gestiona
app.get('/api/templates', auth, staff, wrap((req, res) => res.json(db.prepare('SELECT id, title, body FROM reply_templates ORDER BY title').all())));
app.post('/api/admin/templates', auth, admin, wrap((req, res) => {
  const title = str(req.body.title, 80), body = str(req.body.body, 3000);
  if (!title || !body) return res.status(400).json({ error: 'Título y texto son obligatorios' });
  db.prepare('INSERT INTO reply_templates (title, body) VALUES (?, ?)').run(title, body);
  res.status(201).json(automationState());
}));
app.patch('/api/admin/templates/:id', auth, admin, wrap((req, res) => {
  const cur = db.prepare('SELECT * FROM reply_templates WHERE id = ?').get(Number(req.params.id));
  if (!cur) return res.status(404).json({ error: 'Plantilla no encontrada' });
  const title = str(req.body.title ?? cur.title, 80), body = str(req.body.body ?? cur.body, 3000);
  if (!title || !body) return res.status(400).json({ error: 'Título y texto son obligatorios' });
  db.prepare('UPDATE reply_templates SET title = ?, body = ? WHERE id = ?').run(title, body, cur.id);
  res.json(automationState());
}));
app.delete('/api/admin/templates/:id', auth, admin, wrap((req, res) => {
  db.prepare('DELETE FROM reply_templates WHERE id = ?').run(Number(req.params.id));
  res.json(automationState());
}));

// Formularios por categoría (la categoría también queda disponible en la lista al crear tickets)
app.put('/api/admin/forms', auth, admin, wrap((req, res) => {
  try { forms.save(req.body.category, req.body.fields || []); } catch (e) { return res.status(400).json({ error: e.message }); }
  res.json(automationState());
}));
app.delete('/api/admin/forms', auth, admin, wrap((req, res) => {
  if (!forms.remove(req.query.category)) return res.status(404).json({ error: 'Formulario no encontrado' });
  res.json(automationState());
}));

// Seguridad: quitar la verificación en dos pasos a quien perdió su teléfono y sus códigos
app.post('/api/admin/users/:id/2fa-reset', auth, admin, wrap((req, res) => {
  const u = getUser(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, recovery_codes = NULL, totp_last = 0 WHERE id = ?').run(u.id);
  bumpEpoch(u.id);
  audit.log(req, '2fa.reset', u.email);
  res.json(getUser(u.id));
}));

// Cerrar todas las sesiones abiertas de una persona (por ejemplo, si perdió un equipo)
app.post('/api/admin/users/:id/logout-all', auth, admin, wrap((req, res) => {
  const u = getUser(Number(req.params.id));
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  bumpEpoch(u.id);
  audit.log(req, 'session.revoke', u.email);
  if (u.id === req.user.id) refreshEpoch(req);
  res.json({ ok: true });
}));

app.get('/api/admin/security', auth, admin, wrap((req, res) => {
  const checks = securityCheck.run({ ...process.env, ...(imap.enabled() ? {} : {}) }, { envFile: process.env.ENV_FILE || path.join(__dirname, '..', '.env') });
  const q = (sql) => db.prepare(sql).get().n;
  res.json({
    checks, summary: securityCheck.summary(checks),
    stats: {
      users: q("SELECT COUNT(*) AS n FROM users WHERE active = 1"),
      with_2fa: q("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND totp_enabled = 1"),
      staff_without_2fa: q("SELECT COUNT(*) AS n FROM users WHERE active = 1 AND totp_enabled = 0 AND role IN ('admin','coordinator','agent')"),
      failed_logins_24h: q("SELECT COUNT(*) AS n FROM audit_log WHERE action IN ('login.fail','login.2fa_fail') AND at >= datetime('now','-1 day')"),
      blocked_24h: q("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'login.blocked' AND at >= datetime('now','-1 day')"),
    },
    retention_days: audit.RETENTION_DAYS,
  });
}));
app.get('/api/admin/audit', auth, admin, wrap((req, res) => res.json(audit.list(req.query))));
app.get('/api/admin/audit.csv', auth, admin, wrap((req, res) => {
  audit.log(req, 'audit.export');
  const lines = ['fecha_utc,usuario,ip,accion,objetivo,detalle'].concat(audit.list({ ...req.query, limit: 2000 }).map((r) => [r.at, r.actor, r.ip, r.action, r.target, r.detail].map(csvCell).join(',')));
  res.set('Content-Type', 'text/csv; charset=utf-8'); res.set('Content-Disposition', 'attachment; filename="bitacora.csv"');
  res.send('﻿' + lines.join('\r\n'));
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
    automation.start(sla.withSla);
    const hm = (a) => a.map((n) => String(n).padStart(2, '0')).join(':');
    console.log(`SLA: ${hm(sla.config.START)}–${hm(sla.config.END)} zona ${sla.config.TZ}`);
    if (!process.env.SLA_TZ && sla.config.TZ === 'UTC')
      console.warn('AVISO: SLA_TZ no está definido y el servidor usa UTC; define SLA_TZ (p. ej. America/Bogota) para que el horario laboral sea el correcto.');
  });

module.exports = app;
