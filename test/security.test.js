const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, register } = require('./_setup');
const netAcl = require('../src/netAcl');

let ctx;
before(async () => {
  ctx = boot({ LOGIN_MAX_PER_IP: '5', LOGIN_MAX_PER_EMAIL: '50', INTERNAL_CIDRS: '10.0.0.0/8,192.168.1.5', TRUST_PROXY: 'true' });
  await register(ctx.base, 'admin@empresa.com', 'Admin', 9);
  await register(ctx.base, 'ana@empresa.com', 'Ana', 3);
});
after(() => ctx.close());

const login = (c, email, password, ip = '203.0.113.9') =>
  c.post('/api/login', { email, password }, { 'X-Forwarded-For': ip });

test('límite por IP: tras N fallos se bloquea a esa IP aunque cambie de correo o acierte', async () => {
  const c = client(ctx.base);
  for (let i = 0; i < 5; i++) assert.equal((await login(c, `x${i}@empresa.com`, 'mala', '198.51.100.7')).status, 401);
  const blocked = await login(c, 'ana@empresa.com', 'password123', '198.51.100.7'); // credenciales correctas
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // otra IP no se ve afectada
  assert.equal((await login(client(ctx.base), 'ana@empresa.com', 'password123', '198.51.100.8')).status, 200);
});

test('el bloqueo se guarda en la base de datos (sobrevive a reinicios)', () => {
  const db = require('../src/db');
  const row = db.prepare("SELECT n FROM login_attempts WHERE key = 'ip:198.51.100.7'").get();
  assert.ok(row && row.n >= 5);
});

test('un login correcto reinicia el contador del correo pero no el de la IP', async () => {
  const db = require('../src/db');
  const ip = '198.51.100.20';
  await login(client(ctx.base), 'ana@empresa.com', 'mala', ip);
  assert.equal(db.prepare("SELECT n FROM login_attempts WHERE key = 'email:ana@empresa.com'").get().n >= 1, true);
  assert.equal((await login(client(ctx.base), 'ana@empresa.com', 'password123', ip)).status, 200);
  assert.equal(db.prepare("SELECT n FROM login_attempts WHERE key = 'email:ana@empresa.com'").get(), undefined);
  assert.equal(db.prepare(`SELECT n FROM login_attempts WHERE key = 'ip:${ip}'`).get().n, 1);
});

test('/api/meta sin sesión expone solo lo mínimo; con sesión, todo', async () => {
  const anon = (await client(ctx.base).get('/api/meta')).data;
  assert.deepEqual(Object.keys(anon).sort(), ['departments', 'domain', 'imap']);
  const c = client(ctx.base);
  await login(c, 'ana@empresa.com', 'password123', '198.51.100.30');
  const full = (await c.get('/api/meta')).data;
  assert.ok(full.statuses && full.sla && full.categories);
});

test('INTERNAL_CIDRS: Administración y Reportes solo desde la red interna; Tickets desde cualquier IP', async () => {
  const c = client(ctx.base);
  await login(c, 'admin@empresa.com', 'password123', '198.51.100.40');
  const from = (ip) => ({ 'X-Forwarded-For': ip });
  assert.equal((await c.get('/api/admin/users', from('8.8.8.8'))).status, 403);
  assert.equal((await c.get('/api/reports', from('8.8.8.8'))).status, 403);
  assert.equal((await c.get('/api/admin/users', from('10.1.2.3'))).status, 200);
  assert.equal((await c.get('/api/reports', from('192.168.1.5'))).status, 200);
  assert.equal((await c.get('/api/tickets', from('8.8.8.8'))).status, 200); // los tickets sí
});

test('netAcl: rangos CIDR, IP exacta e IPv4 mapeada', () => {
  const r = netAcl.parse('10.0.0.0/8, 192.168.1.5, 172.16.0.0/12');
  assert.equal(netAcl.allowed(r, '10.255.1.1'), true);
  assert.equal(netAcl.allowed(r, '11.0.0.1'), false);
  assert.equal(netAcl.allowed(r, '192.168.1.5'), true);
  assert.equal(netAcl.allowed(r, '192.168.1.6'), false);
  assert.equal(netAcl.allowed(r, '172.31.255.255'), true);
  assert.equal(netAcl.allowed(r, '172.32.0.1'), false);
  assert.equal(netAcl.allowed(r, '::ffff:10.0.0.9'), true);
  assert.equal(netAcl.allowed(r, '2001:db8::1'), false);
  assert.throws(() => netAcl.parse('10.0.0.0/40'));
});
