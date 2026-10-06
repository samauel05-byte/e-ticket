const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, register } = require('./_setup');

let ctx, db, admin, tec, enc, lider, ana, otro, gerencia;
const role = async (c, email, r) => { await admin.patch('/api/admin/users/' + db.prepare('SELECT id FROM users WHERE email = ?').get(email).id, { role: r }); return c; };

before(async () => {
  ctx = boot({});
  db = require('../src/db');
  admin = await register(ctx.base, 'admin@empresa.com', 'Admin', 1);
  tec = await register(ctx.base, 'tec@empresa.com', 'Técnico', 1);
  enc = await register(ctx.base, 'enc@empresa.com', 'Encargado', 1);
  lider = await register(ctx.base, 'lider@empresa.com', 'Líder Finanzas', 3);
  ana = await register(ctx.base, 'ana@empresa.com', 'Ana (Finanzas)', 3);
  otro = await register(ctx.base, 'otro@empresa.com', 'Otro (Ventas)', 4);
  gerencia = await register(ctx.base, 'ger@empresa.com', 'Gerencia', 2);
  await role(tec, 'tec@empresa.com', 'agent'); await role(enc, 'enc@empresa.com', 'coordinator');
  await role(lider, 'lider@empresa.com', 'leader'); await role(gerencia, 'ger@empresa.com', 'manager');
});
after(() => ctx.close());

const nuevo = (c, t = 'Ticket') => c.post('/api/tickets', { title: t, description: 'd', category: 'Hardware' });

test('líder: ve los tickets de su departamento (y no los de otros), solo lectura de gestión', async () => {
  const t1 = (await nuevo(ana, 'De Ana')).data;
  const t2 = (await nuevo(otro, 'De Ventas')).data;
  const list = (await lider.get('/api/tickets')).data.map((t) => t.id);
  assert.ok(list.includes(t1.id)); assert.ok(!list.includes(t2.id));
  assert.equal((await lider.get('/api/tickets/' + t1.id)).status, 200);
  assert.equal((await lider.get('/api/tickets/' + t2.id)).status, 404);
  assert.equal((await lider.patch('/api/tickets/' + t1.id, { status: 'cerrado' })).status, 403);
  assert.equal((await lider.get('/api/dashboard')).status, 403);
  assert.equal((await lider.get('/api/reports')).status, 403);
  assert.equal((await lider.get('/api/admin/users')).status, 403);
  assert.equal((await ana.get('/api/tickets/' + t2.id)).status, 404); // un usuario normal sigue viendo solo lo suyo
});

test('técnico: sin reportes ni administración; su dashboard solo muestra lo suyo', async () => {
  const mine = (await nuevo(ana, 'Para el técnico')).data;
  const other = (await nuevo(otro, 'Para otro')).data;
  const me = (await tec.get('/api/me')).data;
  await admin.patch('/api/tickets/' + mine.id, { assignee_id: me.id });
  await admin.patch('/api/tickets/' + other.id, { assignee_id: (await admin.get('/api/me')).data.id });
  assert.equal((await tec.get('/api/reports')).status, 403);
  assert.equal((await tec.get('/api/reports/export.csv')).status, 403);
  assert.equal((await tec.get('/api/admin/users')).status, 403);
  assert.equal((await tec.get('/api/admin/mail')).status, 403);
  const d = (await tec.get('/api/dashboard')).data;
  assert.equal(d.scope, 'own');
  assert.deepEqual(d.team.map((x) => x.id), [me.id]);
  assert.equal(d.summary.total, 1);
  assert.equal(d.unassigned, null);
  assert.equal((await tec.get('/api/tickets')).status, 200); // sí ve y gestiona tickets
});

test('encargado: ve todo, asigna, dashboard del equipo y reportes; sin administración', async () => {
  const t = (await nuevo(ana, 'Para asignar')).data;
  const tecId = (await tec.get('/api/me')).data.id;
  assert.equal((await enc.patch('/api/tickets/' + t.id, { assignee_id: tecId })).status, 200);
  assert.equal((await enc.get('/api/reports')).status, 200);
  const d = (await enc.get('/api/dashboard')).data;
  assert.equal(d.scope, 'all');
  assert.ok(d.team.length >= 2);
  assert.equal((await enc.get('/api/admin/users')).status, 403);
  assert.equal((await enc.get('/api/admin/mail')).status, 403);
});

test('solo Tecnología y Administración reciben tickets (no el encargado, gerencia, líder ni usuarios)', async () => {
  const t = (await nuevo(ana, 'Asignación')).data;
  const id = (u) => db.prepare('SELECT id FROM users WHERE email = ?').get(u).id;
  for (const email of ['enc@empresa.com', 'ger@empresa.com', 'lider@empresa.com', 'ana@empresa.com'])
    assert.equal((await enc.patch('/api/tickets/' + t.id, { assignee_id: id(email) })).status, 400, email);
  assert.equal((await enc.patch('/api/tickets/' + t.id, { assignee_id: id('admin@empresa.com') })).status, 200);
  const staff = (await enc.get('/api/staff')).data.map((x) => x.email).sort();
  assert.deepEqual(staff, ['admin@empresa.com', 'tec@empresa.com']);
});

test('gerencia: dashboard y reportes, solo lectura; el administrador sigue con todo', async () => {
  assert.equal((await gerencia.get('/api/reports')).status, 200);
  assert.equal((await gerencia.get('/api/dashboard')).status, 200);
  assert.equal((await gerencia.get('/api/admin/users')).status, 403);
  assert.equal((await admin.get('/api/admin/users')).status, 200);
  const roles = (await admin.get('/api/admin/users')).data.map((u) => u.role);
  assert.ok(['leader', 'coordinator', 'agent', 'manager', 'admin', 'user'].every((r) => roles.includes(r)));
  assert.equal((await admin.patch('/api/admin/users/' + db.prepare('SELECT id FROM users WHERE email = ?').get('ana@empresa.com').id, { role: 'jefe' })).data.role, 'user');
});
