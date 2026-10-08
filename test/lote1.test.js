const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, register, client } = require('./_setup');

let ctx, db, admin, tec, ana, otro, ger, mails;
const uid = (e) => db.prepare('SELECT id FROM users WHERE email = ?').get(e).id;
const nuevo = (c, t = 'Falla') => c.post('/api/tickets', { title: t, description: 'd', category: 'Hardware' }).then((r) => r.data);
const resolver = async (id) => (await tec.patch('/api/tickets/' + id, { status: 'resuelto', resolution: 'Se cambió el cable' })).data;

before(async () => {
  ctx = boot({});
  db = require('../src/db');
  admin = await register(ctx.base, 'admin@empresa.com', 'Admin', 1);
  tec = await register(ctx.base, 'tec@empresa.com', 'Técnico', 1);
  ana = await register(ctx.base, 'ana@empresa.com', 'Ana', 3);
  otro = await register(ctx.base, 'otro@empresa.com', 'Otro', 4);
  ger = await register(ctx.base, 'ger@empresa.com', 'Gerencia', 2);
  await admin.patch('/api/admin/users/' + uid('tec@empresa.com'), { role: 'agent' });
  await admin.patch('/api/admin/users/' + uid('ger@empresa.com'), { role: 'manager' });
});
after(() => ctx.close());

test('el solicitante reabre un ticket resuelto y vuelve a "abierto"', async () => {
  const t = await nuevo(ana);
  assert.equal((await ana.post(`/api/tickets/${t.id}/reopen`, {})).status, 403); // aún no está resuelto
  await resolver(t.id);
  const d = (await ana.get('/api/tickets/' + t.id)).data;
  assert.equal(d.can_reopen, true); assert.equal(d.can_confirm, true);
  const r = await ana.post(`/api/tickets/${t.id}/reopen`, { reason: 'Sigue sin funcionar' });
  assert.equal(r.status, 200); assert.equal(r.data.status, 'abierto'); assert.equal(r.data.resolved_at, null);
  const after = (await ana.get('/api/tickets/' + t.id)).data;
  assert.ok(after.comments.some((c) => /Sigue sin funcionar/.test(c.body)));
  assert.ok(after.history.some((h) => /Reabierto por el solicitante/.test(h.text) && h.actor === 'Ana'));
  assert.equal((await otro.post(`/api/tickets/${t.id}/reopen`, {})).status, 404); // otro usuario no puede
  assert.equal((await ger.post(`/api/tickets/${t.id}/reopen`, {})).status, 403); // gerencia es solo lectura
});

test('pasados los días permitidos el solicitante ya no puede reabrir, pero TI sí', async () => {
  const t = await nuevo(ana);
  await resolver(t.id);
  db.prepare("UPDATE tickets SET resolved_at = datetime('now','-30 days') WHERE id = ?").run(t.id);
  assert.equal((await ana.post(`/api/tickets/${t.id}/reopen`, {})).status, 403);
  assert.equal((await tec.post(`/api/tickets/${t.id}/reopen`, { reason: 'Reapareció' })).status, 200);
});

test('el solicitante confirma la solución y el ticket pasa a "cerrado"', async () => {
  const t = await nuevo(ana);
  assert.equal((await ana.post(`/api/tickets/${t.id}/confirm`, {})).status, 400);
  await resolver(t.id);
  assert.equal((await otro.post(`/api/tickets/${t.id}/confirm`, {})).status, 404);
  const r = await ana.post(`/api/tickets/${t.id}/confirm`, {});
  assert.equal(r.status, 200); assert.equal(r.data.status, 'cerrado');
  assert.ok((await ana.get('/api/tickets/' + t.id)).data.history.some((h) => /confirmada/.test(h.text)));
});

test('notas internas: solo las ve TI y gerencia; el solicitante no puede crearlas ni verlas', async () => {
  const t = await nuevo(ana);
  assert.equal((await ana.post(`/api/tickets/${t.id}/comments`, { body: 'hola', internal: true })).status, 403);
  assert.equal((await tec.post(`/api/tickets/${t.id}/comments`, { body: 'Nota: parece la fuente', internal: true })).status, 201);
  assert.equal((await tec.post(`/api/tickets/${t.id}/comments`, { body: 'Estamos revisando' })).status, 201);
  const visto = (c) => c.get('/api/tickets/' + t.id).then((r) => r.data.comments.map((x) => x.body));
  assert.deepEqual(await visto(ana), ['Estamos revisando']);
  assert.deepEqual(await visto(tec), ['Nota: parece la fuente', 'Estamos revisando']);
  assert.equal((await visto(ger)).length, 2);
  // una nota interna no cuenta como primera respuesta
  const t2 = await nuevo(ana, 'Otra');
  await tec.post(`/api/tickets/${t2.id}/comments`, { body: 'solo nota', internal: true });
  assert.equal((await tec.get('/api/tickets/' + t2.id)).data.first_response_at, null);
});

test('historial: quién cambió estado, asignación, prioridad y categoría', async () => {
  const t = await nuevo(ana);
  await tec.patch('/api/tickets/' + t.id, { status: 'en_progreso', assignee_id: uid('tec@empresa.com'), priority: 'alta', category: 'Software' });
  const h = (await ana.get('/api/tickets/' + t.id)).data.history;
  assert.equal(h[0].text, 'Ticket creado'); assert.equal(h[0].actor, 'Ana');
  const last = h[h.length - 1];
  assert.match(last.text, /Estado: Abierto → En progreso/); assert.match(last.text, /Asignado a Técnico/);
  assert.match(last.text, /Prioridad: media → alta/); assert.match(last.text, /Categoría: Hardware → Software/);
  assert.equal(last.actor, 'Técnico');
});

test('desactivar usuarios: no entran, su sesión cae, no se les asigna y no se puede desactivar a uno mismo', async () => {
  const luis = await register(ctx.base, 'luis@empresa.com', 'Luis', 1);
  await admin.patch('/api/admin/users/' + uid('luis@empresa.com'), { role: 'agent' });
  assert.ok((await admin.get('/api/staff')).data.some((s) => s.email === 'luis@empresa.com'));
  assert.equal((await luis.get('/api/me')).status, 200);
  const r = await admin.patch('/api/admin/users/' + uid('luis@empresa.com'), { active: false });
  assert.equal(r.status, 200); assert.equal(r.data.active, 0);
  assert.equal((await luis.get('/api/me')).status, 401); // la sesión abierta deja de valer
  const intento = await client(ctx.base).post('/api/login', { email: 'luis@empresa.com', password: 'Segura-2026-ok' });
  assert.equal(intento.status, 403); assert.match(intento.data.error, /desactivada/);
  const t = await nuevo(ana);
  assert.equal((await admin.patch('/api/tickets/' + t.id, { assignee_id: uid('luis@empresa.com') })).status, 400);
  assert.ok(!(await admin.get('/api/staff')).data.some((s) => s.email === 'luis@empresa.com'));
  assert.equal((await admin.patch('/api/admin/users/' + uid('admin@empresa.com'), { active: false })).status, 400);
  assert.equal((await admin.patch('/api/admin/users/' + uid('luis@empresa.com'), { active: true })).data.active, 1); // se puede reactivar
  assert.equal((await client(ctx.base).post('/api/login', { email: 'luis@empresa.com', password: 'Segura-2026-ok' })).status, 200);
});

test('avisos de SLA: por vencer (80 %) y vencido, una sola vez, sin avisar lo que ya estaba vencido al activarse', async () => {
  const alerts = require('../src/slaAlerts');
  const sla = require('../src/sla');
  const sent = [];
  const notify = (to, subject, ticket) => sent.push({ to, subject, id: ticket.id });
  // primera ejecución: solo registra lo existente (silenciosa)
  assert.equal(alerts.check(sla.withSla, { force: true, notify }), 0);
  const t = await nuevo(ana, 'Urgente de lunes');
  await tec.patch('/api/tickets/' + t.id, { priority: 'urgente' }); // respuesta objetivo: 1 h hábil
  db.prepare("UPDATE tickets SET created_at = '2026-10-05 09:00:00' WHERE id = ?").run(t.id);
  db.prepare("UPDATE ticket_events SET at = '2026-10-05 09:00:00' WHERE ticket_id = ?").run(t.id);
  db.prepare("UPDATE tickets SET first_response_at = NULL, status = 'abierto', assignee_id = NULL WHERE id = ?").run(t.id);
  const at = (hhmm) => Date.parse(`2026-10-05T${hhmm}:00Z`);
  assert.equal(alerts.check(sla.withSla, { force: true, notify, now: at('09:30') }), 0); // 50 %
  assert.equal(alerts.check(sla.withSla, { force: true, notify, now: at('09:50') }), 1); // 83 %
  assert.equal(sent[0].subject, 'SLA por vencer'); assert.equal(sent[0].id, t.id);
  assert.ok(sent[0].to.includes('tec@empresa.com')); // nadie lo tomó: se avisa a todo TI
  assert.equal(alerts.check(sla.withSla, { force: true, notify, now: at('09:55') }), 0); // no repite
  assert.equal(alerts.check(sla.withSla, { force: true, notify, now: at('10:10') }), 1); // ya venció
  assert.equal(sent[1].subject, 'SLA vencido');
  assert.equal(alerts.check(sla.withSla, { force: true, notify, now: at('10:30') }), 0);
});
