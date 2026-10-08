const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, register } = require('./_setup');

let ctx, db, admin, tec, enc, ana, luis, ger, mailer, sent;
const uid = (e) => db.prepare('SELECT id FROM users WHERE email = ?').get(e).id;
const nuevo = (c, o = {}) => c.post('/api/tickets', { title: 'Falla', description: 'd', category: 'Hardware', ...o }).then((r) => r.data);
const art = (o = {}) => ({ title: 'Cómo configurar el escáner', body: 'Pasos para configurar el escáner de red del piso 2.', category: 'Impresoras', ...o });

before(async () => {
  ctx = boot({});
  db = require('../src/db'); mailer = require('../src/mailer');
  admin = await register(ctx.base, 'admin@empresa.com', 'Admin', 1);
  tec = await register(ctx.base, 'tec@empresa.com', 'Técnico', 1);
  enc = await register(ctx.base, 'enc@empresa.com', 'Encargado', 1);
  ana = await register(ctx.base, 'ana@empresa.com', 'Ana', 3);
  luis = await register(ctx.base, 'luis@empresa.com', 'Luis', 4);
  ger = await register(ctx.base, 'ger@empresa.com', 'Gerencia', 2);
  for (const [e, r] of [['tec@empresa.com', 'agent'], ['enc@empresa.com', 'coordinator'], ['ger@empresa.com', 'manager']]) await admin.patch('/api/admin/users/' + uid(e), { role: r });
  sent = []; mailer.notify = (to, subject, ticket, text) => sent.push({ to, subject, text });
});
after(() => ctx.close());

test('base de conocimiento: vienen artículos de ejemplo y todos los usuarios los leen', async () => {
  const r = (await ana.get('/api/kb')).data;
  assert.ok(r.articles.length >= 4);
  assert.ok(r.categories.some((c) => c.category === 'Red / Internet'));
  const a = (await ana.get('/api/kb/' + r.articles[0].id)).data;
  assert.ok(a.body.length > 20); assert.equal(a.my_vote, null);
  assert.equal((await client0().get('/api/kb')).status, 401); // hay que iniciar sesión
});
const client0 = () => require('./_setup').client(ctx.base);

test('búsqueda: por palabras, ordena por título y no se deja engañar por % o _', async () => {
  const vpn = (await ana.get('/api/kb?q=vpn')).data.articles;
  assert.ok(vpn.length >= 1 && /VPN/i.test(vpn[0].title));
  assert.deepEqual((await ana.get('/api/kb?q=zzzinexistente')).data.articles, []);
  const comodin = (await ana.get('/api/kb?q=' + encodeURIComponent('%%%'))).data.articles;
  assert.deepEqual(comodin, []);                                              // "%%%" no es un comodín
  const total = (await ana.get('/api/kb')).data.articles.length;
  assert.ok((await ana.get('/api/kb?q=' + encodeURIComponent('conectar impresora'))).data.articles.length <= total);
  assert.ok((await ana.get('/api/kb?category=' + encodeURIComponent('Impresoras'))).data.articles.every((x) => x.category === 'Impresoras'));
  assert.ok((await ana.get('/api/kb?limit=2')).data.articles.length <= 2);
});

test('solo TI crea y edita; los borradores solo los ve TI; gerencia solo lee', async () => {
  assert.equal((await ana.post('/api/kb', art())).status, 403);
  assert.equal((await ger.post('/api/kb', art())).status, 403);
  assert.equal((await tec.post('/api/kb', { ...art(), title: 'ab' })).status, 400);
  assert.equal((await tec.post('/api/kb', { ...art(), body: 'corto' })).status, 400);
  const borrador = (await tec.post('/api/kb', art({ title: 'Escáner (borrador)', published: false }))).data.id;
  assert.ok(!(await ana.get('/api/kb?q=borrador')).data.articles.some((x) => x.id === borrador));
  assert.equal((await ana.get('/api/kb/' + borrador)).status, 404);
  assert.equal((await ana.post(`/api/kb/${borrador}/vote`, { helpful: true })).status, 404);
  assert.ok((await tec.get('/api/kb?q=borrador')).data.articles.some((x) => x.id === borrador && x.published === 0));
  assert.equal((await tec.patch('/api/kb/' + borrador, { published: true, title: 'Cómo usar el escáner' })).status, 200);
  assert.equal((await ana.get('/api/kb/' + borrador)).data.title, 'Cómo usar el escáner');
  assert.equal((await ana.patch('/api/kb/' + borrador, { title: 'hack' })).status, 403);
});

test('votos: uno por persona (se puede cambiar) y cuentan las visitas', async () => {
  const id = (await tec.post('/api/kb', art({ title: 'Artículo para votar' }))).data.id;
  assert.equal((await ana.post(`/api/kb/${id}/vote`, { helpful: true })).status, 200);
  await luis.post(`/api/kb/${id}/vote`, { helpful: false });
  await ana.post(`/api/kb/${id}/vote`, { helpful: true });           // repetir no suma otra vez
  let a = (await ana.get('/api/kb/' + id)).data;
  assert.equal(a.helpful, 1); assert.equal(a.not_helpful, 1); assert.equal(a.my_vote, 1); assert.ok(a.views >= 1);
  await ana.post(`/api/kb/${id}/vote`, { helpful: false });          // cambió de opinión
  a = (await ana.get('/api/kb/' + id)).data;
  assert.equal(a.helpful, 0); assert.equal(a.not_helpful, 2);
});

test('eliminar: solo administrador o encargado; queda en la bitácora', async () => {
  const id = (await tec.post('/api/kb', art({ title: 'Artículo a borrar' }))).data.id;
  assert.equal((await tec.del('/api/kb/' + id)).status, 403);
  assert.equal((await ana.del('/api/kb/' + id)).status, 403);
  assert.equal((await enc.del('/api/kb/' + id)).status, 200);
  assert.equal((await ana.get('/api/kb/' + id)).status, 404);
  const log = (await admin.get('/api/admin/audit?action=kb')).data.map((r) => r.action);
  assert.ok(log.includes('kb.create') && log.includes('kb.delete'));
});

test('encuesta: solo el solicitante califica, y solo con el ticket resuelto', async () => {
  const t = await nuevo(ana);
  assert.equal((await ana.post(`/api/tickets/${t.id}/rating`, { rating: 5 })).status, 400);   // aún no está resuelto
  await tec.patch('/api/tickets/' + t.id, { status: 'resuelto', resolution: 'Se cambió el cable' });
  assert.equal((await ana.get('/api/tickets/' + t.id)).data.can_rate, true);
  assert.equal((await luis.post(`/api/tickets/${t.id}/rating`, { rating: 5 })).status, 404);   // otra persona
  assert.equal((await tec.post(`/api/tickets/${t.id}/rating`, { rating: 5 })).status, 404);    // ni siquiera TI
  for (const bad of [0, 6, 2.5, 'x', null]) assert.equal((await ana.post(`/api/tickets/${t.id}/rating`, { rating: bad })).status, 400);
  assert.equal((await ana.post(`/api/tickets/${t.id}/rating`, { rating: 4, comment: 'Rápido y amable' })).status, 200);
  const d = (await tec.get('/api/tickets/' + t.id)).data;
  assert.equal(d.rating_detail.rating, 4); assert.equal(d.rating_detail.comment, 'Rápido y amable'); assert.equal(d.can_rate, false);
  await ana.post(`/api/tickets/${t.id}/rating`, { rating: 5, comment: 'Excelente' });          // puede cambiarla
  assert.equal((await tec.get('/api/tickets/' + t.id)).data.rating_detail.rating, 5);
  assert.ok(!sent.some((m) => m.subject === 'Calificación baja'));
});

test('calificación baja avisa al encargado; el promedio sale en dashboard, reportes y CSV', async () => {
  sent.length = 0;
  const t = await nuevo(luis);
  await admin.patch('/api/tickets/' + t.id, { assignee_id: uid('tec@empresa.com') });
  await tec.patch('/api/tickets/' + t.id, { status: 'resuelto', resolution: 'Listo' });
  assert.equal((await luis.post(`/api/tickets/${t.id}/rating`, { rating: 1, comment: 'No sirvió' })).status, 200);
  const alerta = sent.find((m) => m.subject === 'Calificación baja');
  assert.ok(alerta && alerta.to.includes('enc@empresa.com') && /No sirvió/.test(alerta.text));
  const dash = (await enc.get('/api/dashboard?days=30')).data;
  assert.ok(dash.summary.rating_count >= 2 && dash.summary.avg_rating > 0 && dash.summary.avg_rating < 5);
  const t1 = dash.team.find((x) => x.email === 'tec@empresa.com');
  assert.equal(t1.rating_count, 1); assert.equal(t1.avg_rating, 1);
  assert.ok((await enc.get('/api/reports')).data.by_assignee.some((x) => x.rating_count >= 1));
  const csv = await (await fetch(ctx.base + '/api/reports/export.csv', { headers: { cookie: enc.cookie } })).text();
  assert.match(csv.split('\r\n')[0], /calificacion$/);
  assert.ok(csv.split('\r\n').some((l) => /,web,1$/.test(l)));
});

test('el aviso de ticket resuelto invita a calificar', async () => {
  sent.length = 0;
  const t = await nuevo(ana);
  await tec.patch('/api/tickets/' + t.id, { status: 'resuelto', resolution: 'Hecho' });
  const aviso = sent.find((m) => /Estado/.test(m.subject));
  assert.match(aviso.text, /califícala/);
});
