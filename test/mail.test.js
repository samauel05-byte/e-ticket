const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startFakeMailbox, buildMail } = require('../scripts/fakeMailbox');
const { boot, client, register } = require('./_setup');

let ctx, mailbox, ingest, db, admin, ana;
before(async () => {
  mailbox = await startFakeMailbox({ user: 'soporte@empresa.com', pass: 'clave-de-prueba' });
  ctx = boot({
    INBOX_HOST: '127.0.0.1', INBOX_PORT: String(mailbox.port), INBOX_SECURE: 'false',
    INBOX_USER: 'soporte@empresa.com', INBOX_PASS: 'clave-de-prueba', INBOX_MAX_PER_SENDER_HOUR: '100',
  });
  ingest = require('../src/mailIngest');
  db = require('../src/db');
  admin = await register(ctx.base, 'admin@empresa.com', 'Admin', 9);
  ana = await register(ctx.base, 'ana@empresa.com', 'Ana Ruiz', 3);
  await register(ctx.base, 'luis@empresa.com', 'Luis Pérez', 4);
  await register(ctx.base, 'marta@empresa.com', 'Marta Gil', 2);
});
after(async () => { await ctx.close(); await mailbox.close(); });

const mail = (o) => buildMail({ to: 'soporte@empresa.com', ...o });

test('un correo de un usuario crea un ticket a su nombre, con categoría por palabras clave', async () => {
  const r = await ingest.processRaw(mail({ from: 'Ana Ruiz <ana@empresa.com>', subject: 'No me funciona la VPN desde casa', text: 'Desde ayer no conecta la VPN.\r\nGracias.' }));
  assert.equal(r.status, 'ticket');
  const t = (await ana.get('/api/tickets/' + r.ticket_id)).data;
  assert.equal(t.title, 'No me funciona la VPN desde casa');
  assert.match(t.description, /Desde ayer no conecta/);
  assert.equal(t.category, 'Red / Internet');
  assert.equal(t.source, 'email');
  assert.equal(t.requester_email, 'ana@empresa.com');
  assert.equal(t.department, 'Finanzas'); // el departamento del usuario
  assert.equal((await admin.get('/api/tickets/' + r.ticket_id)).status, 200); // TI lo ve
});

test('el mismo correo no se procesa dos veces', async () => {
  const raw = mail({ from: 'ana@empresa.com', subject: 'Impresora sin tóner', text: 'Piso 2', messageId: '<unico-1@prueba>' });
  assert.equal((await ingest.processRaw(raw)).status, 'ticket');
  const again = await ingest.processRaw(raw);
  assert.equal(again.status, 'ignored');
  assert.equal(again.reason, 'ya procesado');
});

test('responder al aviso "[Ticket #N]" agrega un comentario (sin el texto citado)', async () => {
  const t = await ingest.processRaw(mail({ from: 'ana@empresa.com', subject: 'Correo no sincroniza', text: 'En el celular.' }));
  const r = await ingest.processRaw(mail({
    from: 'ana@empresa.com', subject: `Re: [Ticket #${t.ticket_id}] Recibimos tu solicitud`,
    text: 'Ya probé reiniciar y sigue igual.\r\n\r\nEl lun, TI escribió:\r\n> Hola, ya estoy revisando\r\n> saludos',
  }));
  assert.equal(r.status, 'comment');
  const det = (await ana.get('/api/tickets/' + t.ticket_id)).data;
  assert.equal(det.comments.length, 1);
  assert.equal(det.comments[0].body, 'Ya probé reiniciar y sigue igual.');
});

test('personal de TI puede responder por correo; otro usuario NO puede comentar un ticket ajeno (se crea uno nuevo)', async () => {
  const t = await ingest.processRaw(mail({ from: 'ana@empresa.com', subject: 'Instalar Excel', text: 'Necesito Excel.' }));
  const r1 = await ingest.processRaw(mail({ from: 'admin@empresa.com', subject: `RE: [Ticket #${t.ticket_id}] Recibimos tu solicitud`, text: 'Listo, ya lo instalamos.' }));
  assert.equal(r1.status, 'comment');
  assert.ok((await ana.get('/api/tickets/' + t.ticket_id)).data.first_response_at, 'una respuesta de TI cuenta como primera respuesta');
  const r2 = await ingest.processRaw(mail({ from: 'luis@empresa.com', subject: `Re: [Ticket #${t.ticket_id}] algo`, text: 'Yo también tengo ese problema.' }));
  assert.equal(r2.status, 'ticket');
  assert.notEqual(r2.ticket_id, t.ticket_id);
});

test('se ignoran: remitentes externos, respuestas automáticas, rebotes, remitentes que fallan SPF/DKIM', async () => {
  const casos = [
    [{ from: 'cliente@gmail.com', subject: 'Hola', text: 'x' }, /fuera de la empresa/],
    [{ from: 'ana@empresa.com', subject: 'Fuera de la oficina', text: 'x', headers: { 'Auto-Submitted': 'auto-replied' } }, /automática/],
    [{ from: 'ana@empresa.com', subject: 'Boletín', text: 'x', headers: { Precedence: 'bulk' } }, /masivo/],
    [{ from: 'Mail Delivery <mailer-daemon@empresa.com>', subject: 'Undelivered Mail Returned to Sender', text: 'x' }, /automático|automática/],
    [{ from: 'ana@empresa.com', subject: 'Parece de Ana', text: 'x', headers: { 'Authentication-Results': 'mx.empresa.com; dkim=fail; spf=fail' } }, /SPF\/DKIM/],
    [{ from: 'soporte@empresa.com', subject: 'Eco de la propia bandeja', text: 'x' }, /propia bandeja/],
  ];
  for (const [m, re] of casos) {
    const r = await ingest.processRaw(mail(m));
    assert.equal(r.status, 'ignored', JSON.stringify(m));
    assert.match(r.reason, re, JSON.stringify(m));
  }
});

test('remitente nuevo de la empresa: se crea su cuenta (departamento "Sin departamento") y su ticket', async () => {
  // las cuentas nuevas solo se crean cuando el login es con la clave del correo (IMAP)
  const imapAuth = require('../src/imapAuth');
  const orig = imapAuth.enabled; imapAuth.enabled = () => true;
  let r;
  try { r = await ingest.processRaw(mail({ from: 'Pedro Gómez <pedro.gomez@empresa.com>', subject: 'Mi laptop no enciende', text: 'No prende.' })); }
  finally { imapAuth.enabled = orig; }
  assert.equal(r.status, 'ticket');
  const u = db.prepare("SELECT u.name, u.role, d.name AS dep FROM users u JOIN departments d ON d.id = u.department_id WHERE u.email = 'pedro.gomez@empresa.com'").get();
  assert.deepEqual(u, { name: 'Pedro Gómez', role: 'user', dep: 'Sin departamento' });
  assert.equal(db.prepare('SELECT category FROM tickets WHERE id = ?').get(r.ticket_id).category, 'Hardware');
});

test('adjuntos: se guardan los permitidos y se omiten los peligrosos', async () => {
  const r = await ingest.processRaw(mail({
    from: 'ana@empresa.com', subject: 'Error en pantalla', text: 'Adjunto la captura.',
    attachments: [{ name: 'captura.png', type: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]) }, { name: 'virus.exe', content: 'MZ' }, { name: 'falso.pdf', type: 'application/pdf', content: 'MZ esto es un ejecutable renombrado' }, { name: 'informe ñ.txt', type: 'text/plain', content: 'hola' }],
  }));
  assert.equal(r.status, 'ticket');
  const d = (await ana.get('/api/tickets/' + r.ticket_id)).data;
  assert.deepEqual(d.attachments.map((a) => a.original_name).sort(), ['captura.png', 'informe ñ.txt']);
  const dl = await ana.get('/api/attachments/' + d.attachments[0].id);
  assert.equal(dl.status, 200);
});

test('límite por remitente y hora (anti-inundación)', async () => {
  process.env.INBOX_MAX_PER_SENDER_HOUR = '3';
  try {
    let last;
    for (let i = 0; i < 5; i++) last = await ingest.processRaw(mail({ from: 'marta@empresa.com', subject: 'Ticket ' + i, text: 'x' }));
    assert.equal(last.status, 'ignored');
    assert.match(last.reason, /demasiados/);
  } finally { process.env.INBOX_MAX_PER_SENDER_HOUR = '100'; }
});

test('sin login por IMAP no se crean cuentas para remitentes desconocidos', async () => {
  const r = await ingest.processRaw(mail({ from: 'nuevo.sin.cuenta@empresa.com', subject: 'Hola', text: 'x' }));
  assert.equal(r.status, 'ignored');
  assert.match(r.reason, /sin cuenta/);
});

test('bandeja IMAP real (simulada): lee los correos no leídos, crea tickets y los marca como leídos', async () => {
  const before = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE source = 'email'").get().n;
  mailbox.deliver(mail({ from: 'luis@empresa.com', subject: 'Teclado con teclas pegadas', text: 'Se pegan la E y la R.' }));
  mailbox.deliver(mail({ from: 'externo@otra.com', subject: 'Spam', text: 'compra ya' }));
  mailbox.deliver(mail({ from: 'ana@empresa.com', subject: 'Wi-Fi caído en el piso 3', text: 'Desde la mañana.' }));
  const sum = await ingest.pollOnce();
  assert.deepEqual(sum, { ticket: 2, comment: 0, ignored: 1, errors: 0 });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE source = 'email'").get().n, before + 2);
  assert.ok(mailbox.messages.every((m) => m.seen), 'todos quedan marcados como leídos');
  // segunda vuelta: ya no hay nada nuevo
  assert.deepEqual(await ingest.pollOnce(), { ticket: 0, comment: 0, ignored: 0, errors: 0 });
});

test('bandeja con clave incorrecta: falla la conexión sin romper nada', async () => {
  const saved = process.env.INBOX_PASS; process.env.INBOX_PASS = 'mala';
  try { await assert.rejects(ingest.pollOnce()); } finally { process.env.INBOX_PASS = saved; }
});

test('utilidades: categoría, asunto y texto citado', () => {
  assert.equal(ingest.guessCategory('Olvidé mi contraseña de Windows'), 'Accesos / Contraseñas');
  assert.equal(ingest.guessCategory('algo raro pasó'), 'Otro');
  assert.equal(ingest.cleanSubject('RE: Fwd: [Ticket #12] No imprime'), 'No imprime');
  assert.equal(ingest.stripQuoted('Hola\nGracias\n\n> cita\nmás'), 'Hola\nGracias');
});

test('NOTIFY_NEW_TO agrega destinatarios a los avisos de ticket nuevo', () => {
  process.env.NOTIFY_NEW_TO = 'Jefe.TI@empresa.com, no-valido';
  try {
    const list = require('../src/tickets').staffEmails(0);
    assert.ok(list.includes('jefe.ti@empresa.com'));
    assert.ok(!list.includes('no-valido'));
  } finally { delete process.env.NOTIFY_NEW_TO; }
});
