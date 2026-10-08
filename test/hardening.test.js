const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { boot, register, client } = require('./_setup');

let ctx, db, admin, ana, luis, totp, settings;
const PASS = 'Segura-2026-ok';
const uid = (e) => db.prepare('SELECT id FROM users WHERE email = ?').get(e).id;

before(async () => {
  ctx = boot({});
  db = require('../src/db'); totp = require('../src/totp'); settings = require('../src/settings');
  admin = await register(ctx.base, 'admin@empresa.com', 'Admin', 1);
  ana = await register(ctx.base, 'ana@empresa.com', 'Ana', 3);
  luis = await register(ctx.base, 'luis@empresa.com', 'Luis', 4);
});
after(() => ctx.close());

test('cabeceras: CSP estricta, sin caché en la API, cookie HttpOnly y SameSite=Strict', async () => {
  const r = await fetch(ctx.base + '/api/me');
  const csp = r.headers.get('content-security-policy');
  assert.match(csp, /frame-ancestors 'none'/); assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('permissions-policy'), /camera=\(\)/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('referrer-policy'), 'no-referrer');
  const l = await fetch(ctx.base + '/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ana@empresa.com', password: PASS }) });
  const cookie = l.headers.getSetCookie().join(';');
  assert.match(cookie, /HttpOnly/i); assert.match(cookie, /SameSite=Strict/i);
});

test('contraseñas: se rechazan las débiles, comunes o con el usuario', async () => {
  const reg = (email, password) => client(ctx.base).post('/api/register', { email, name: 'X', password, department_id: 1 });
  assert.equal((await reg('n1@empresa.com', 'corta')).status, 400);
  assert.match((await reg('n1@empresa.com', 'password123')).data.error, /común/);
  assert.match((await reg('n1@empresa.com', 'qwertyuiop')).data.error, /común/);
  assert.match((await reg('nuevousuario@empresa.com', 'xx-nuevousuario-xx')).data.error, /usuario/);
  assert.equal((await reg('n2@empresa.com', 'Una-clave-larga-y-rara')).status, 201);
});

test('cambiar la contraseña cierra las demás sesiones y exige la actual', async () => {
  const a2 = client(ctx.base);
  assert.equal((await a2.post('/api/login', { email: 'ana@empresa.com', password: PASS })).status, 200);
  assert.equal((await a2.get('/api/me')).status, 200);
  assert.equal((await ana.post('/api/me/password', { current: 'incorrecta', next: 'Otra-clave-segura-1' })).status, 403);
  assert.equal((await ana.post('/api/me/password', { current: PASS, next: 'abc' })).status, 400);
  assert.equal((await ana.post('/api/me/password', { current: PASS, next: PASS })).status, 400);
  assert.equal((await ana.post('/api/me/password', { current: PASS, next: 'Otra-clave-segura-1' })).status, 200);
  assert.equal((await a2.get('/api/me')).status, 401);              // la otra sesión murió
  assert.equal((await ana.get('/api/me')).status, 200);             // la actual sigue
  assert.equal((await client(ctx.base).post('/api/login', { email: 'ana@empresa.com', password: PASS })).status, 401);
  assert.equal((await client(ctx.base).post('/api/login', { email: 'ana@empresa.com', password: 'Otra-clave-segura-1' })).status, 200);
  await ana.post('/api/me/password', { current: 'Otra-clave-segura-1', next: PASS });
});

test('verificación en dos pasos: activar, entrar con código, no reutilizar, recuperación y desactivar', async () => {
  const setup = (await luis.post('/api/me/2fa/setup', {})).data;
  assert.match(setup.uri, /^otpauth:\/\/totp\//);
  assert.ok(!JSON.stringify(db.prepare('SELECT totp_secret FROM users WHERE email = ?').get('luis@empresa.com')).includes(setup.secret)); // cifrado en la base
  const now = Date.now();
  assert.equal((await luis.post('/api/me/2fa/enable', { code: '000000' })).status, 400);
  const en = await luis.post('/api/me/2fa/enable', { code: totp.codeAt(setup.secret, Math.floor(now / 30000)) });
  assert.equal(en.status, 200); assert.equal(en.data.recovery_codes.length, 8);
  assert.equal((await luis.get('/api/me')).data.totp_enabled, 1);
  assert.ok(!JSON.stringify((await luis.get('/api/me')).data).includes('totp_secret'));

  // inicio de sesión: contraseña OK -> pide el código
  const c = client(ctx.base);
  const l = await c.post('/api/login', { email: 'luis@empresa.com', password: PASS });
  assert.equal(l.status, 200); assert.equal(l.data.needs_2fa, true);
  assert.equal((await c.get('/api/me')).status, 401);                 // todavía no hay sesión
  assert.equal((await c.post('/api/login/2fa', { code: '123456' })).status, 401);
  const next = totp.codeAt(setup.secret, Math.floor(now / 30000) + 1);  // el paso siguiente (admite ±1) y distinto al ya usado al activar
  const ok = await c.post('/api/login/2fa', { code: next });
  assert.equal(ok.status, 200); assert.equal((await c.get('/api/me')).status, 200);
  // el mismo código no sirve dos veces
  const c2 = client(ctx.base); await c2.post('/api/login', { email: 'luis@empresa.com', password: PASS });
  assert.equal((await c2.post('/api/login/2fa', { code: next })).status, 401);
  // código de recuperación: sirve una vez
  const rec = en.data.recovery_codes[0];
  const c3 = client(ctx.base); await c3.post('/api/login', { email: 'luis@empresa.com', password: PASS });
  assert.equal((await c3.post('/api/login/2fa', { code: rec })).status, 200);
  const c4 = client(ctx.base); await c4.post('/api/login', { email: 'luis@empresa.com', password: PASS });
  assert.equal((await c4.post('/api/login/2fa', { code: rec })).status, 401);
  // 2fa sin haber pasado la contraseña
  assert.equal((await client(ctx.base).post('/api/login/2fa', { code: next })).status, 401);
  // desactivar exige un código válido
  assert.equal((await c.post('/api/me/2fa/disable', { code: '111111' })).status, 400);
  assert.equal((await c.post('/api/me/2fa/disable', { code: en.data.recovery_codes[1] })).status, 200);
  assert.equal((await client(ctx.base).post('/api/login', { email: 'luis@empresa.com', password: PASS })).data.needs_2fa, undefined);
});

test('el administrador restablece la verificación en dos pasos y cierra sesiones', async () => {
  luis = client(ctx.base); await luis.post('/api/login', { email: 'luis@empresa.com', password: PASS }); // las sesiones anteriores se cerraron al desactivar el 2FA
  const setup = (await luis.post('/api/me/2fa/setup', {})).data;
  const en = await luis.post('/api/me/2fa/enable', { code: totp.codeAt(setup.secret, Math.floor(Date.now() / 30000)) });
  assert.equal(en.status, 200);
  assert.equal((await luis.post('/api/admin/users/' + uid('luis@empresa.com') + '/2fa-reset', {})).status, 403);
  assert.equal((await admin.post('/api/admin/users/' + uid('luis@empresa.com') + '/2fa-reset', {})).data.totp_enabled, 0);
  const c = client(ctx.base);
  await c.post('/api/login', { email: 'luis@empresa.com', password: PASS });
  assert.equal((await c.get('/api/me')).status, 200);
  assert.equal((await admin.post('/api/admin/users/' + uid('luis@empresa.com') + '/logout-all', {})).status, 200);
  assert.equal((await c.get('/api/me')).status, 401);
});

test('sesiones: caducan por duración máxima', async () => {
  const c = client(ctx.base);
  await c.post('/api/login', { email: 'ana@empresa.com', password: PASS });
  assert.equal((await c.get('/api/me')).status, 200);
  db.prepare("UPDATE sessions SET data = json_set(data, '$.createdAt', 1) WHERE rowid = (SELECT MAX(rowid) FROM sessions)").run(); // la sesión recién creada
  assert.equal((await c.get('/api/me')).status, 401);
});

test('límites de uso: tickets por hora y registros por IP', async () => {
  const limits = require('../src/limits');
  const max = limits.LIMITS.ticket.max;
  limits.LIMITS.ticket.max = 2;
  try {
    const c = client(ctx.base); await c.post('/api/login', { email: 'ana@empresa.com', password: PASS });
    const mk = () => c.post('/api/tickets', { title: 't', description: 'd', category: 'Hardware' });
    assert.equal((await mk()).status, 201); assert.equal((await mk()).status, 201);
    const r = await mk();
    assert.equal(r.status, 429); assert.ok(Number(r.headers.get('retry-after')) > 0);
  } finally { limits.LIMITS.ticket.max = max; limits._reset(); }
  const reg = limits.LIMITS.register.max; limits.LIMITS.register.max = 1;
  try { assert.equal(limits.hit('register', '1.2.3.4'), 0); assert.ok(limits.hit('register', '1.2.3.4') > 0); assert.equal(limits.hit('register', '5.6.7.8'), 0); }
  finally { limits.LIMITS.register.max = reg; limits._reset(); }
});

test('adjuntos: el contenido debe corresponder a la extensión', async () => {
  const t = (await ana.post('/api/tickets', { title: 't', description: 'd', category: 'Hardware' })).data;
  const send = (name, bytes) => { const f = new FormData(); f.append('files', new Blob([bytes]), name); return ana.post(`/api/tickets/${t.id}/attachments`, f); };
  assert.equal((await send('falso.pdf', 'MZ ejecutable renombrado')).status, 400);
  assert.equal((await send('falso.png', '<html><script>alert(1)</script>')).status, 400);
  assert.equal((await send('bien.pdf', '%PDF-1.4 contenido')).status, 201);
  assert.equal((await send('nota.txt', 'texto normal')).status, 201);
  assert.equal((await send('bin.txt', Buffer.from([65, 0, 66]))).status, 400);
  const d = (await ana.get('/api/tickets/' + t.id)).data;
  const dl = await fetch(ctx.base + '/api/attachments/' + d.attachments[0].id, { headers: { cookie: ana.cookie } });
  assert.match(dl.headers.get('content-security-policy'), /sandbox/); assert.match(dl.headers.get('content-disposition'), /attachment/);
});

test('bitácora: registra accesos y cambios, solo la ve el administrador y no guarda contraseñas', async () => {
  await client(ctx.base).post('/api/login', { email: 'ana@empresa.com', password: 'mala-clave-1' });
  await admin.patch('/api/admin/users/' + uid('ana@empresa.com'), { role: 'leader' });
  await admin.put('/api/admin/mail', { values: { SMTP_HOST: 'mail.ejemplo.com', SMTP_PASS: 'super-secreta-xyz' } });
  const rows = (await admin.get('/api/admin/audit?limit=500')).data;
  const has = (a, f = () => true) => rows.some((r) => r.action === a && f(r));
  assert.ok(has('login.ok')); assert.ok(has('login.fail', (r) => r.target === 'ana@empresa.com'));
  assert.ok(has('user.update', (r) => /rol: user → leader/.test(r.detail)));
  assert.ok(has('admin.change', (r) => /\/api\/admin\/mail/.test(r.target)));
  assert.ok(!JSON.stringify(rows).includes('super-secreta-xyz') && !JSON.stringify(rows).includes(PASS));
  assert.equal((await ana.get('/api/admin/audit')).status, 403);
  assert.equal((await ana.get('/api/admin/security')).status, 403);
  const csv = await fetch(ctx.base + '/api/admin/audit.csv', { headers: { cookie: admin.cookie } });
  assert.match(await csv.text(), /fecha_utc,usuario,ip,accion/);
  const f = (await admin.get('/api/admin/audit?action=login.fail')).data;
  assert.ok(f.length && f.every((r) => r.action === 'login.fail'));
  await admin.patch('/api/admin/users/' + uid('ana@empresa.com'), { role: 'user' });
});

test('revisión de seguridad: detecta secretos débiles y el panel la expone al administrador', async () => {
  const sc = require('../src/securityCheck');
  assert.equal(sc.weakSecret('cambia-esto'), true); assert.equal(sc.weakSecret('corto'), true); assert.equal(sc.weakSecret('a3f9c1d7e5b2486f90ab12cd34ef5678a3f9c1d7e5b2486f90ab12cd34ef5678'), false);
  const list = sc.run({ SESSION_SECRET: 'cambia-esto', COOKIE_SECURE: 'false', NODE_ENV: 'production' });
  assert.ok(list.find((c) => c.id === 'secret').level === 'bad'); assert.ok(list.find((c) => c.id === 'https').level === 'bad');
  const r = (await admin.get('/api/admin/security')).data;
  assert.ok(Array.isArray(r.checks) && r.stats.users >= 3 && typeof r.stats.failed_logins_24h === 'number');
});

test('producción: se niega a arrancar con un SESSION_SECRET débil', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], {
    env: { ...process.env, NODE_ENV: 'production', SESSION_SECRET: 'cambia-esto', PORT: '0', DB_PATH: ':memory:' }, encoding: 'utf8', timeout: 15000 });
  assert.notEqual(r.status, 0); assert.match(r.stderr, /SESSION_SECRET/);
});
