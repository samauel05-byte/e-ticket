const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, client, register } = require('./_setup');

let ctx, admin, ana, luis;
before(async () => {
  ctx = boot();
  admin = await register(ctx.base, 'admin@empresa.com', 'Admin TI', 9); // ADMIN_EMAIL => admin
  ana = await register(ctx.base, 'ana@empresa.com', 'Ana', 3);
  luis = await register(ctx.base, 'luis@empresa.com', 'Luis', 4);
});
after(() => ctx.close());

const newTicket = (c, extra = {}) =>
  c.post('/api/tickets', { title: 'VPN', description: 'No conecta', category: 'Red / Internet', priority: 'alta', ...extra });

test('registro: solo dominio de la empresa, contraseña mínima y sin duplicados', async () => {
  const c = client(ctx.base);
  const base = { name: 'X', password: 'Segura-2026-ok', department_id: 1 };
  assert.equal((await c.post('/api/register', { ...base, email: 'x@gmail.com' })).status, 400);
  assert.equal((await c.post('/api/register', { ...base, email: 'x@empresa.com.evil.com' })).status, 400);
  assert.equal((await c.post('/api/register', { ...base, email: 'x@empresa.com', password: 'corta' })).status, 400);
  assert.equal((await c.post('/api/register', { ...base, email: 'x@empresa.com', department_id: 999 })).status, 400);
  assert.equal((await c.post('/api/register', { ...base, email: 'ana@empresa.com' })).status, 409);
});

test('roles: solo ADMIN_EMAIL es admin; los demás son user', async () => {
  assert.equal((await admin.get('/api/me')).data.role, 'admin');
  assert.equal((await ana.get('/api/me')).data.role, 'user');
});

test('login: credenciales correctas e incorrectas, y /api/me exige sesión', async () => {
  assert.equal((await client(ctx.base).get('/api/me')).status, 401);
  const c = client(ctx.base);
  assert.equal((await c.post('/api/login', { email: 'ana@empresa.com', password: 'mala' })).status, 401);
  const ok = await c.post('/api/login', { email: 'ana@empresa.com', password: 'Segura-2026-ok' });
  assert.equal(ok.status, 200);
  assert.equal((await c.get('/api/me')).data.email, 'ana@empresa.com');
  await c.post('/api/logout');
  assert.equal((await c.get('/api/me')).status, 401);
});

test('login: bloqueo temporal tras demasiados intentos fallidos', async () => {
  const c = client(ctx.base);
  let last;
  for (let i = 0; i < 9; i++) last = await c.post('/api/login', { email: 'luis@empresa.com', password: 'mala' });
  assert.equal(last.status, 429);
  const good = await c.post('/api/login', { email: 'luis@empresa.com', password: 'Segura-2026-ok' });
  assert.equal(good.status, 429); // sigue bloqueado aunque la contraseña sea correcta
});

test('tickets: un usuario solo ve los suyos; TI ve todos', async () => {
  const t = (await newTicket(ana)).data;
  assert.equal(t.status, 'abierto');
  assert.equal((await ana.get('/api/tickets/' + t.id)).status, 200);
  assert.equal((await luis.get('/api/tickets/' + t.id)).status, 404);
  assert.equal((await luis.get('/api/tickets')).data.some((x) => x.id === t.id), false);
  assert.equal((await admin.get('/api/tickets')).data.some((x) => x.id === t.id), true);
});

test('tickets: validación de campos obligatorios', async () => {
  assert.equal((await newTicket(ana, { title: '' })).status, 400);
  assert.equal((await newTicket(ana, { category: 'Inventada' })).status, 400);
});

test('permisos: un usuario no puede gestionar tickets ni ver reportes/admin', async () => {
  const t = (await newTicket(ana)).data;
  assert.equal((await ana.patch('/api/tickets/' + t.id, { status: 'cerrado' })).status, 403);
  assert.equal((await ana.get('/api/reports')).status, 403);
  assert.equal((await ana.get('/api/reports/export.csv')).status, 403);
  assert.equal((await ana.get('/api/admin/users')).status, 403);
  assert.equal((await ana.patch('/api/admin/users/1', { role: 'admin' })).status, 403);
  assert.equal((await ana.get('/api/staff')).status, 403);
});

test('comentarios: solo el solicitante y TI; el ticket ajeno responde 404', async () => {
  const t = (await newTicket(ana)).data;
  assert.equal((await ana.post(`/api/tickets/${t.id}/comments`, { body: 'hola' })).status, 201);
  assert.equal((await luis.post(`/api/tickets/${t.id}/comments`, { body: 'intruso' })).status, 404);
  assert.equal((await ana.post(`/api/tickets/${t.id}/comments`, { body: '  ' })).status, 400);
  const d = (await admin.get('/api/tickets/' + t.id)).data;
  assert.equal(d.comments.length, 1);
});

test('SLA: la primera respuesta la registra TI, no el solicitante; resolver y reabrir', async () => {
  const t = (await newTicket(ana)).data;
  await ana.post(`/api/tickets/${t.id}/comments`, { body: 'seguimos?' });
  assert.equal((await ana.get('/api/tickets/' + t.id)).data.first_response_at, null);
  await admin.post(`/api/tickets/${t.id}/comments`, { body: 'revisando' });
  const d = (await ana.get('/api/tickets/' + t.id)).data;
  assert.ok(d.first_response_at);
  assert.equal(d.sla_response_breached, false);

  const r = (await admin.patch('/api/tickets/' + t.id, { status: 'resuelto', resolution: 'Se reinició el servicio' })).data;
  assert.ok(r.resolved_at);
  assert.equal((await admin.patch('/api/tickets/' + t.id, { status: 'en_progreso' })).data.resolved_at, null);
});

test('SLA: un cambio de estado por TI cuenta como primera respuesta', async () => {
  const t = (await newTicket(luis)).data;
  const u = (await admin.patch('/api/tickets/' + t.id, { status: 'en_progreso' })).data;
  assert.ok(u.first_response_at);
});

test('asignación: solo a personal de TI', async () => {
  const t = (await newTicket(ana)).data;
  assert.equal((await admin.patch('/api/tickets/' + t.id, { assignee_id: 2 })).status, 400); // 2 = ana (user)
  assert.equal((await admin.patch('/api/tickets/' + t.id, { assignee_id: 1 })).data.assignee_name, 'Admin TI');
});

test('admin: cambiar rol/departamento; no puede quitarse su propio rol', async () => {
  assert.equal((await admin.patch('/api/admin/users/3', { role: 'agent', department_id: 9 })).data.role, 'agent');
  assert.equal((await admin.patch('/api/admin/users/1', { role: 'user' })).status, 400);
  assert.equal((await admin.post('/api/admin/departments', { name: 'Compras' })).status, 201);
  assert.equal((await admin.post('/api/admin/departments', { name: 'Compras' })).status, 409);
  // luis (id 3) ahora es agent: ya ve todos los tickets
  assert.ok((await luis.get('/api/tickets')).data.length > 1);
});

test('SLA: "en espera" pausa y reanudar lo reactiva; cada cambio queda en el historial', async () => {
  const t = (await newTicket(ana)).data;
  assert.equal((await admin.patch('/api/tickets/' + t.id, { status: 'en_espera' })).data.sla_paused, true);
  const back = (await admin.patch('/api/tickets/' + t.id, { status: 'en_progreso' })).data;
  assert.equal(back.sla_paused, false);
  const db = require('../src/db');
  const ev = db.prepare('SELECT status FROM ticket_events WHERE ticket_id = ? ORDER BY id').all(t.id).map((e) => e.status);
  assert.deepEqual(ev, ['abierto', 'en_espera', 'en_progreso']);
});

test('almuerzo: el admin asigna turno al personal de TI; turnos inválidos se rechazan', async () => {
  const me = (await admin.get('/api/me')).data;
  assert.equal((await admin.patch('/api/admin/users/' + me.id, { lunch_shift: 'A' })).data.lunch_shift, 'A');
  assert.equal((await admin.patch('/api/admin/users/' + me.id, { lunch_shift: 'Z' })).status, 400);
  assert.equal((await admin.patch('/api/admin/users/' + me.id, { lunch_shift: '' })).data.lunch_shift, null);
  assert.equal((await admin.get('/api/meta')).data.sla.LUNCH_SHIFTS.B[1], '14:30');
});

test('reportes: totales, filtro de fechas y CSV seguro', async () => {
  await newTicket(ana, { title: '=HYPERLINK("http://x","clic")' });
  const r = (await admin.get('/api/reports')).data;
  assert.ok(r.summary.total >= 1);
  assert.ok(r.by_priority.length > 0);
  assert.equal((await admin.get('/api/reports?from=2000-01-01&to=2000-01-02')).data.summary.total, 0);
  const csv = await admin.get('/api/reports/export.csv');
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.ok(csv.data.includes("'=HYPERLINK"), 'las celdas que empiezan con = deben neutralizarse');
  assert.ok(!/(^|,)=HYPERLINK/m.test(csv.data));
});

test('adjuntos: tipos permitidos, permisos y descarga', async () => {
  const t = (await newTicket(ana)).data;
  const form = (name, content = 'hola') => { const f = new FormData(); f.append('files', new Blob([content]), name); return f; };

  assert.equal((await ana.post(`/api/tickets/${t.id}/attachments`, form('malware.exe'))).status, 400);
  const ajeno = await register(ctx.base, 'ajeno@empresa.com', 'Ajeno', 2);
  assert.equal((await ajeno.post(`/api/tickets/${t.id}/attachments`, form('a.txt'))).status, 404);
  const up = await ana.post(`/api/tickets/${t.id}/attachments`, form('informe ñ.txt', 'contenido'));
  assert.equal(up.status, 201);

  const att = (await ana.get('/api/tickets/' + t.id)).data.attachments[0];
  assert.equal(att.original_name, 'informe ñ.txt');
  const dl = await ana.get('/api/attachments/' + att.id);
  assert.equal(dl.status, 200);
  assert.equal(dl.data, 'contenido');
  assert.match(dl.headers.get('content-disposition'), /attachment/);
  assert.equal(dl.headers.get('x-content-type-options'), 'nosniff');
});

test('adjuntos: otro usuario no puede descargar ni borrar; el dueño sí', async () => {
  const t = (await newTicket(ana)).data;
  const f = new FormData(); f.append('files', new Blob(['x']), 'a.txt');
  await ana.post(`/api/tickets/${t.id}/attachments`, f);
  const id = (await ana.get('/api/tickets/' + t.id)).data.attachments[0].id;
  const other = await register(ctx.base, 'otro@empresa.com', 'Otro', 2);
  assert.equal((await other.get('/api/attachments/' + id)).status, 404);
  assert.equal((await other.del('/api/attachments/' + id)).status, 404);
  assert.equal((await ana.del('/api/attachments/' + id)).status, 200);
  assert.equal((await ana.get('/api/attachments/' + id)).status, 404);
});

test('seguridad: rechaza Origin de otro sitio y envía cabeceras de helmet', async () => {
  const bad = await ana.post('/api/tickets', { title: 't', description: 'd', category: 'Otro' }, { Origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  const same = await ana.post('/api/tickets', { title: 't', description: 'd', category: 'Otro' }, { Origin: ctx.base });
  assert.equal(same.status, 201);
  const page = await client(ctx.base).get('/');
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
});

test('XSS: el título se devuelve como dato, la UI lo escapa (la API no ejecuta nada)', async () => {
  const t = (await newTicket(ana, { title: '<img src=x onerror=alert(1)>' })).data;
  assert.equal(t.title, '<img src=x onerror=alert(1)>');
  const appjs = await client(ctx.base).get('/app.js');
  assert.match(appjs.data, /const esc = /);
});

test('salud: /healthz responde', async () => {
  assert.deepEqual((await client(ctx.base).get('/healthz')).data, { ok: true });
});

test('solución: es obligatoria para resolver, se guarda y la ve el solicitante', async () => {
  const t = (await newTicket(ana)).data;
  const sin = await admin.patch('/api/tickets/' + t.id, { status: 'resuelto' });
  assert.equal(sin.status, 400);
  assert.match(sin.data.error, /Solución/);
  const ok = await admin.patch('/api/tickets/' + t.id, { status: 'resuelto', resolution: 'Se cambió el cable de red' });
  assert.equal(ok.status, 200);
  const visto = (await ana.get('/api/tickets/' + t.id)).data;
  assert.equal(visto.resolution, 'Se cambió el cable de red');
  assert.equal(visto.status, 'resuelto');
  // reabrir conserva la solución anterior, y cerrar de nuevo no la vuelve a pedir
  assert.equal((await admin.patch('/api/tickets/' + t.id, { status: 'en_progreso' })).status, 200);
  assert.equal((await admin.patch('/api/tickets/' + t.id, { status: 'cerrado' })).status, 200);
});

test('gerencia: ve todo y el dashboard, pero es de solo lectura', async () => {
  const g = await register(ctx.base, 'gerencia@empresa.com', 'Gerencia', 1);
  assert.equal((await admin.patch('/api/admin/users/' + (await g.get('/api/me')).data.id, { role: 'manager' })).data.role, 'manager');
  const t = (await newTicket(ana)).data;
  assert.equal((await g.get('/api/tickets/' + t.id)).status, 200);
  assert.ok((await g.get('/api/tickets')).data.length > 1);
  assert.equal((await g.get('/api/dashboard')).status, 200);
  assert.equal((await g.get('/api/reports')).status, 200);
  assert.equal((await g.get('/api/reports/export.csv')).status, 200);
  // solo lectura
  assert.equal((await g.patch('/api/tickets/' + t.id, { status: 'cerrado' })).status, 403);
  assert.equal((await g.post(`/api/tickets/${t.id}/comments`, { body: 'x' })).status, 403);
  assert.equal((await g.get('/api/admin/users')).status, 403);
  const f = new FormData(); f.append('files', new Blob(['x']), 'a.txt');
  assert.equal((await g.post(`/api/tickets/${t.id}/attachments`, f)).status, 403);
  // un usuario común no ve el dashboard
  assert.equal((await ana.get('/api/dashboard')).status, 403);
  // gerencia sí puede pedir su propio ticket
  assert.equal((await newTicket(g)).status, 201);
});

test('dashboard: avance por técnico (porcentaje resuelto), sin asignar y tendencia', async () => {
  const mk = async (who, asg, resolve) => {
    const t = (await newTicket(who)).data;
    await admin.patch('/api/tickets/' + t.id, { assignee_id: asg, ...(resolve ? { status: 'resuelto', resolution: 'ok' } : {}) });
    return t;
  };
  const adminId = (await admin.get('/api/me')).data.id;
  await mk(ana, adminId, true); await mk(ana, adminId, true); await mk(ana, adminId, false); await mk(luis, adminId, false);
  await newTicket(ana); // sin asignar
  const d = (await admin.get('/api/dashboard?days=30')).data;
  const yo = d.team.find((x) => x.id === adminId);
  assert.ok(yo.total >= 4 && yo.resolved >= 2);
  assert.equal(yo.pct_resolved, Math.round((yo.resolved / yo.total) * 1000) / 10);
  assert.ok(d.unassigned.total >= 1);
  assert.equal(d.trend.length, 14);
  const hoy = d.trend[13];
  assert.ok(hoy.created >= 5 && hoy.resolved >= 2);
  assert.ok(d.summary.total >= yo.total + d.unassigned.total);
  assert.ok(Array.isArray(d.by_department));
});

test('lista: filtro por responsable (y sin asignar)', async () => {
  const adminId = (await admin.get('/api/me')).data.id;
  const mios = (await admin.get('/api/tickets?assignee_id=' + adminId)).data;
  assert.ok(mios.length > 0 && mios.every((t) => t.assignee_id === adminId));
  const libres = (await admin.get('/api/tickets?assignee_id=none')).data;
  assert.ok(libres.length > 0 && libres.every((t) => t.assignee_id === null));
  // un usuario común no puede usar el filtro para ver tickets ajenos
  assert.ok((await ana.get('/api/tickets?assignee_id=' + adminId)).data.every((t) => t.requester_id === 2));
});

test('categoría manual: "Otra" + texto; se normaliza, se valida y TI puede cambiarla', async () => {
  const mk = (extra) => newTicket(ana, { category: '__otra__', ...extra });
  const ok = await mk({ category_other: '  cámaras   de seguridad ' });
  assert.equal(ok.status, 201);
  assert.equal(ok.data.category, 'Cámaras de seguridad');
  assert.equal((await mk({ category_other: 'hardware' })).data.category, 'Hardware'); // coincide con una de la lista
  assert.equal((await mk({ category_other: 'x' })).status, 400); // muy corta
  assert.equal((await mk({})).status, 400); // sin texto
  assert.equal((await mk({ category_other: 'a'.repeat(200) })).data.category.length, 60); // se recorta
  // una categoría inventada sin usar "Otra" sigue siendo inválida
  assert.equal((await newTicket(ana, { category: 'Inventada' })).status, 400);
  // TI la cambia a mano o a una de la lista; una manual inválida no cambia nada
  const id = ok.data.id;
  assert.equal((await admin.patch('/api/tickets/' + id, { category: '__otra__', category_other: 'Telefonía IP' })).data.category, 'Telefonía IP');
  assert.equal((await admin.patch('/api/tickets/' + id, { category: '__otra__', category_other: '' })).status, 400);
  assert.equal((await admin.patch('/api/tickets/' + id, { category: 'Software' })).data.category, 'Software');
  // se sugieren las ya usadas
  const meta = (await admin.get('/api/meta')).data;
  assert.ok(meta.extra_categories.some((c) => c.startsWith('Aaaa')), 'las categorías escritas a mano ya usadas se sugieren');
  // un texto con HTML se guarda como texto (la interfaz lo escapa)
  assert.equal((await mk({ category_other: '<b>hola</b>' })).data.category, '<b>hola</b>');
});

test('admin: editar nombre y correo de un usuario (validaciones y duplicados)', async () => {
  const u = await register(ctx.base, 'editable@empresa.com', 'Editable Uno', 2);
  const id = (await u.get('/api/me')).data.id;
  const ok = await admin.patch('/api/admin/users/' + id, { name: '  Edgar Editado ', email: 'Edgar.Editado@Empresa.com' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.name, 'Edgar Editado');
  assert.equal(ok.data.email, 'edgar.editado@empresa.com');
  assert.equal((await admin.patch('/api/admin/users/' + id, { email: 'alguien@gmail.com' })).status, 400); // dominio ajeno
  assert.equal((await admin.patch('/api/admin/users/' + id, { email: 'ana@empresa.com' })).status, 409); // ya existe
  assert.equal((await admin.patch('/api/admin/users/' + id, { name: 'x' })).status, 400);
  const yo = (await admin.get('/api/me')).data;
  assert.equal((await admin.patch('/api/admin/users/' + yo.id, { email: 'otro@empresa.com' })).status, 400); // no cambiarse el propio correo
  assert.equal((await admin.patch('/api/admin/users/' + yo.id, { name: 'Administrador Principal' })).status, 200); // el nombre sí
  assert.equal((await ana.patch('/api/admin/users/' + id, { name: 'Hack' })).status, 403);
  // los tickets conservan su historia con el correo nuevo
  const t = (await u.post('/api/tickets', { title: 't', description: 'd', category: 'Otro' })).data;
  assert.equal(t.requester_email, 'edgar.editado@empresa.com');
});

test('cada persona edita su nombre y departamento; "Otro" ya no se ofrece como categoría', async () => {
  const u = await register(ctx.base, 'perfil@empresa.com', 'Perfil Uno', 1);
  const r = await u.patch('/api/me', { name: 'Perfil Dos', department_id: 3 });
  assert.equal(r.status, 200);
  assert.equal(r.data.name, 'Perfil Dos');
  assert.equal(r.data.department_id, 3);
  assert.equal(r.data.email, 'perfil@empresa.com');
  assert.equal((await u.patch('/api/me', { name: 'x' })).status, 400);
  assert.equal((await u.patch('/api/me', { department_id: 9999 })).status, 400);
  assert.equal((await u.patch('/api/me', { role: 'admin' })).data.role, 'user'); // no puede subirse el rol
  assert.ok(!(await u.get('/api/meta')).data.categories.includes('Otro'));
});
