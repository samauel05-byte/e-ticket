const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, register } = require('./_setup');

let ctx, db, admin, t1, t2, enc, ana, mails;
const uid = (e) => db.prepare('SELECT id FROM users WHERE email = ?').get(e).id;
const nuevo = (c, o = {}) => c.post('/api/tickets', { title: 'Falla', description: 'd', category: 'Hardware', ...o });
const setAssign = (mode, pools = {}) => admin.put('/api/admin/automation/assign', { mode, pools });

before(async () => {
  ctx = boot({});
  db = require('../src/db');
  admin = await register(ctx.base, 'admin@empresa.com', 'Admin', 1);
  t1 = await register(ctx.base, 'tec1@empresa.com', 'Técnico Uno', 1);
  t2 = await register(ctx.base, 'tec2@empresa.com', 'Técnico Dos', 1);
  enc = await register(ctx.base, 'enc@empresa.com', 'Encargado', 1);
  ana = await register(ctx.base, 'ana@empresa.com', 'Ana', 3);
  for (const [e, r] of [['tec1@empresa.com', 'agent'], ['tec2@empresa.com', 'agent'], ['enc@empresa.com', 'coordinator']])
    await admin.patch('/api/admin/users/' + uid(e), { role: r });
});
after(() => ctx.close());

test('solo el administrador configura la automatización', async () => {
  for (const c of [t1, enc, ana]) {
    assert.equal((await c.get('/api/admin/automation')).status, 403);
    assert.equal((await c.put('/api/admin/automation/assign', { mode: 'off' })).status, 403);
    assert.equal((await c.post('/api/admin/escalation', {})).status, 403);
    assert.equal((await c.post('/api/admin/templates', { title: 'x', body: 'y' })).status, 403);
    assert.equal((await c.put('/api/admin/forms', { category: 'X' })).status, 403);
  }
  assert.equal((await ana.get('/api/templates')).status, 403); // los usuarios no ven las plantillas de TI
});

test('asignación desactivada por defecto: el ticket queda sin responsable', async () => {
  const t = (await nuevo(ana)).data;
  assert.equal((await admin.get('/api/tickets/' + t.id)).data.assignee_id, null);
  assert.equal((await setAssign('bogus')).status, 400);
});

test('por turnos: reparte parejo, no usa al encargado ni a desactivados, y queda en el historial', async () => {
  assert.equal((await setAssign('round_robin')).status, 200);
  const who = [];
  for (let i = 0; i < 4; i++) who.push((await admin.get('/api/tickets/' + (await nuevo(ana)).data.id)).data.assignee_name);
  assert.equal(new Set(who.slice(0, 2)).size, 2);          // los dos primeros son distintos
  assert.deepEqual(who.slice(0, 2), who.slice(2));          // y se repite el ciclo
  assert.ok(who.every((n) => ['Técnico Uno', 'Técnico Dos'].includes(n)));
  const id = (await nuevo(ana)).data.id;
  assert.ok((await ana.get('/api/tickets/' + id)).data.history.some((h) => /Asignado automáticamente/.test(h.text)));
  await admin.patch('/api/admin/users/' + uid('tec2@empresa.com'), { active: false });
  const solo = [];
  for (let i = 0; i < 2; i++) solo.push((await admin.get('/api/tickets/' + (await nuevo(ana)).data.id)).data.assignee_name);
  assert.deepEqual(solo, ['Técnico Uno', 'Técnico Uno']);
  await admin.patch('/api/admin/users/' + uid('tec2@empresa.com'), { active: true });
});

test('por carga: va al técnico con menos tickets abiertos', async () => {
  db.prepare("UPDATE tickets SET status = 'cerrado' WHERE assignee_id IS NOT NULL").run();
  const a = uid('tec1@empresa.com');
  for (let i = 0; i < 3; i++) db.prepare("INSERT INTO tickets (title, description, category, requester_id, department_id, assignee_id) VALUES ('c','d','Hardware',?,3,?)").run(uid('ana@empresa.com'), a);
  assert.equal((await setAssign('least_load')).status, 200);
  const t = (await nuevo(ana)).data;
  assert.equal((await admin.get('/api/tickets/' + t.id)).data.assignee_name, 'Técnico Dos');
});

test('grupos por categoría: Red solo va al técnico indicado; sin grupo propio usa el general', async () => {
  const red = [uid('tec2@empresa.com')];
  assert.equal((await setAssign('round_robin', { 'Red / Internet': red, Hardware: [uid('tec1@empresa.com')] })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await admin.get('/api/tickets/' + (await nuevo(ana, { category: 'Red / Internet' })).data.id)).data.assignee_name, 'Técnico Dos');
  for (let i = 0; i < 2; i++) assert.equal((await admin.get('/api/tickets/' + (await nuevo(ana, { category: 'Hardware' })).data.id)).data.assignee_name, 'Técnico Uno');
  const st = (await admin.get('/api/admin/automation')).data;
  assert.deepEqual(st.pools['Red / Internet'], red);
  // ids que no son técnicos o categorías inexistentes se ignoran
  await setAssign('round_robin', { Software: [uid('enc@empresa.com'), 99999], 'Inventada': [uid('tec1@empresa.com')] });
  const st2 = (await admin.get('/api/admin/automation')).data;
  assert.equal(st2.pools.Software, undefined); assert.equal(st2.pools.Inventada, undefined);
  await setAssign('off');
});

test('escalamiento: sube prioridad, avisa al encargado, una sola vez y solo a tickets posteriores a la regla', async () => {
  const auto = require('../src/automation'); const sla = require('../src/sla');
  const sent = [];
  const notify = (to, subject, ticket) => sent.push({ to, subject, id: ticket.id });
  assert.equal((await admin.post('/api/admin/escalation', { name: 'x', condition: 'no_response', minutes: 0, action: 'notify' })).status, 400);
  assert.equal((await admin.post('/api/admin/escalation', { name: 'x', condition: 'raro', minutes: 5, action: 'notify' })).status, 400);
  const r = await admin.post('/api/admin/escalation', { name: 'Urgente sin respuesta', priority: 'media', condition: 'no_response', minutes: 30, action: 'priority_up' });
  assert.equal(r.status, 201);
  const rule = r.data.rules[0];
  const mk = (created) => {
    const id = (db.prepare("INSERT INTO tickets (title, description, category, priority, requester_id, department_id, created_at) VALUES ('Sin respuesta','d','Hardware','media',?,3,?)").run(uid('ana@empresa.com'), created)).lastInsertRowid;
    db.prepare('INSERT INTO ticket_events (ticket_id, at, status) VALUES (?,?,?)').run(id, created, 'abierto');
    return id;
  };
  const old = mk('2026-10-05 09:00:00');
  db.prepare("UPDATE escalation_rules SET created_at = '2026-10-05 08:00:00' WHERE id = ?").run(rule.id);
  const before = mk('2026-10-05 07:00:00'); // creado antes de la regla: no se toca
  const at = (hhmm) => Date.parse(`2026-10-05T${hhmm}:00Z`);
  assert.equal(auto.runEscalations(sla.withSla, { now: at('09:20'), notify }), 0);
  assert.equal(auto.runEscalations(sla.withSla, { now: at('09:40'), notify }), 1);
  assert.equal(db.prepare('SELECT priority FROM tickets WHERE id = ?').get(old).priority, 'alta');
  assert.equal(db.prepare('SELECT priority FROM tickets WHERE id = ?').get(before).priority, 'media');
  assert.ok(sent[0].to.includes('enc@empresa.com')); assert.match(sent[0].subject, /Escalamiento/);
  assert.equal(auto.runEscalations(sla.withSla, { now: at('11:00'), notify }), 0); // una sola vez
  const h = (await admin.get('/api/tickets/' + old)).data.history;
  assert.ok(h.some((x) => /Prioridad: media → alta/.test(x.text)));
  // se puede pausar y borrar
  assert.equal((await admin.patch('/api/admin/escalation/' + rule.id, { enabled: false })).data.rules[0].enabled, 0);
  assert.equal((await admin.del('/api/admin/escalation/' + rule.id)).data.rules.length, 0);
});

test('escalamiento: reasignar pasa el ticket a otro técnico', async () => {
  const auto = require('../src/automation'); const sla = require('../src/sla');
  await setAssign('round_robin');
  const rr = await admin.post('/api/admin/escalation', { name: 'Reasignar', condition: 'not_resolved', minutes: 60, action: 'reassign' });
  db.prepare("UPDATE escalation_rules SET created_at = '2026-10-05 08:00:00' WHERE id = ?").run(rr.data.rules[0].id);
  const id = (db.prepare("INSERT INTO tickets (title, description, category, requester_id, department_id, assignee_id, created_at) VALUES ('Lento','d','Hardware',?,3,?,'2026-10-05 09:00:00')").run(uid('ana@empresa.com'), uid('tec1@empresa.com'))).lastInsertRowid;
  db.prepare("INSERT INTO ticket_events (ticket_id, at, status, assignee_id) VALUES (?,?,?,?)").run(id, '2026-10-05 09:00:00', 'abierto', uid('tec1@empresa.com'));
  assert.ok(auto.runEscalations(sla.withSla, { now: Date.parse('2026-10-05T10:30:00Z'), notify: () => {} }) >= 1); // también alcanza a los tickets de las pruebas anteriores
  assert.equal(db.prepare('SELECT assignee_id FROM tickets WHERE id = ?').get(id).assignee_id, uid('tec2@empresa.com'));
  await setAssign('off');
});

test('respuestas rápidas: las usa TI y las gestiona el administrador (hay 3 de ejemplo)', async () => {
  const list = (await t1.get('/api/templates')).data;
  assert.ok(list.length >= 3);
  const c = await admin.post('/api/admin/templates', { title: 'Reinicia el equipo', body: 'Hola {{nombre}}, reinicia el equipo. {{tecnico}}' });
  assert.equal(c.status, 201);
  const mine = c.data.templates.find((x) => x.title === 'Reinicia el equipo');
  assert.equal((await admin.patch('/api/admin/templates/' + mine.id, { body: 'Texto nuevo' })).data.templates.find((x) => x.id === mine.id).body, 'Texto nuevo');
  assert.equal((await admin.post('/api/admin/templates', { title: '', body: 'x' })).status, 400);
  assert.ok(!(await admin.del('/api/admin/templates/' + mine.id)).data.templates.some((x) => x.id === mine.id));
});

test('formularios por categoría: se piden y validan los campos, y se ven en el ticket', async () => {
  const meta = (await ana.get('/api/meta')).data;
  assert.ok(meta.categories.includes('Alta de usuario') && !meta.categories.includes('Otro'));
  assert.ok(meta.forms['Alta de usuario'].length >= 4);
  const campos = {}; // los de ejemplo
  const ok = { nombre_del_nuevo_empleado: 'Pedro Gil', cargo: 'Vendedor', fecha_de_ingreso: '2026-11-02', equipo: 'Laptop', accesos: 'ERP' };
  assert.equal((await nuevo(ana, { category: 'Alta de usuario', form: {} })).status, 400); // faltan obligatorios
  assert.equal((await nuevo(ana, { category: 'Alta de usuario', form: { ...ok, equipo: 'Tablet' } })).status, 400);
  assert.equal((await nuevo(ana, { category: 'Alta de usuario', form: { ...ok, fecha_de_ingreso: 'mañana' } })).status, 400);
  const t = await nuevo(ana, { category: 'Alta de usuario', form: { ...ok, extra_inventado: 'x' } });
  assert.equal(t.status, 201);
  const d = (await t1.get('/api/tickets/' + t.data.id)).data;
  assert.deepEqual(d.form.map((f) => f.label), ['Nombre completo del nuevo empleado', 'Cargo', 'Fecha de ingreso', 'Equipo que necesita', 'Sistemas y accesos que necesita']);
  assert.equal(d.form[0].value, 'Pedro Gil');
  assert.ok(!JSON.stringify(d).includes('extra_inventado'));
  assert.equal(d.form_data, undefined);
});

test('el administrador crea y elimina formularios; la categoría aparece y desaparece de la lista', async () => {
  assert.equal((await admin.put('/api/admin/forms', { category: 'Baja de usuario', fields: [{ label: 'Nombre', type: 'text', required: true }, { label: 'Motivo', type: 'select', options: 'Renuncia, Despido' }] })).status, 200);
  assert.ok((await ana.get('/api/meta')).data.categories.includes('Baja de usuario'));
  assert.equal((await admin.put('/api/admin/forms', { category: 'Mala', fields: [{ label: 'Lista', type: 'select', options: 'una sola' }] })).status, 400);
  assert.equal((await admin.put('/api/admin/forms', { category: 'x', fields: [] })).status, 400);
  const t = await nuevo(ana, { category: 'Baja de usuario', form: { nombre: 'Luis', motivo: 'Renuncia' } });
  assert.equal(t.status, 201);
  assert.equal((await admin.del('/api/admin/forms?category=' + encodeURIComponent('Baja de usuario'))).status, 200);
  assert.ok(!(await ana.get('/api/meta')).data.categories.includes('Baja de usuario'));
  assert.equal((await admin.get('/api/tickets/' + t.data.id)).data.category, 'Baja de usuario'); // el ticket existente no cambia
});
