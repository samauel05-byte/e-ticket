const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { startFakeMailbox } = require('../scripts/fakeMailbox');
const { boot, register } = require('./_setup');

// SMTP mínimo de prueba: acepta EHLO, AUTH PLAIN (usuario/clave fijos), MAIL/RCPT/DATA y QUIT
function fakeSmtp(user, pass) {
  const got = [];
  const server = net.createServer((s) => {
    s.on('error', () => {});
    s.write('220 fake ESMTP\r\n');
    let buf = ''; let data = false;
    s.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        if (data) { if (line === '.') { data = false; s.write('250 queued\r\n'); } continue; }
        const c = line.toUpperCase();
        if (c.startsWith('EHLO')) s.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (c.startsWith('AUTH PLAIN')) {
          const [, , u, p] = Buffer.from(line.split(' ')[2], 'base64').toString().split('\0').length === 3 ? ['', ...Buffer.from(line.split(' ')[2], 'base64').toString().split('\0')] : [];
          s.write(u === user && p === pass ? '235 ok\r\n' : '535 5.7.8 bad credentials\r\n');
        } else if (c.startsWith('RCPT')) { got.push(line); s.write('250 ok\r\n'); }
        else if (c === 'DATA') { data = true; s.write('354 go\r\n'); }
        else if (c === 'QUIT') { s.write('221 bye\r\n'); s.end(); }
        else s.write('250 ok\r\n');
      }
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ port: server.address().port, got, close: () => new Promise((x) => server.close(x)) })));
}

let ctx, mailbox, smtp, admin, user;
before(async () => {
  mailbox = await startFakeMailbox({ user: 'soporte@empresa.com', pass: 'clave-ok' });
  smtp = await fakeSmtp('soporte@empresa.com', 'clave-ok');
  ctx = boot({});
  admin = await register(ctx.base, 'admin@empresa.com', 'Admin', 9);
  user = await register(ctx.base, 'ana@empresa.com', 'Ana', 3);
});
after(async () => { await ctx.close(); await mailbox.close(); await smtp.close(); });

const inbox = (pass) => ({ INBOX_HOST: '127.0.0.1', INBOX_PORT: String(mailbox.port), INBOX_SECURE: 'false', INBOX_USER: 'soporte@empresa.com', INBOX_PASS: pass });

test('solo administradores ven y cambian la configuración de correo', async () => {
  assert.equal((await user.get('/api/admin/mail')).status, 403);
  assert.equal((await user.post('/api/admin/mail/test', { what: 'inbox', values: {} })).status, 403);
  assert.equal((await admin.get('/api/admin/mail')).status, 200);
});

test('probar la bandeja: éxito con la clave correcta, error claro con la incorrecta', async () => {
  const ok = (await admin.post('/api/admin/mail/test', { what: 'inbox', values: inbox('clave-ok') })).data;
  assert.equal(ok.ok, true);
  assert.match(ok.message, /Conexión exitosa/);
  const bad = (await admin.post('/api/admin/mail/test', { what: 'inbox', values: inbox('mala') })).data;
  assert.equal(bad.ok, false);
  assert.match(bad.message, /usuario o la contraseña/);
});

test('probar SMTP y enviar correo de prueba', async () => {
  const v = { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.port), SMTP_SECURE: 'false', SMTP_USER: 'soporte@empresa.com', SMTP_PASS: 'clave-ok' };
  const ok = (await admin.post('/api/admin/mail/test', { what: 'smtp', values: v, send_to: 'yo@empresa.com' })).data;
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.match(ok.message, /enviado a yo@empresa.com/);
  assert.ok(smtp.got.some((l) => /yo@empresa\.com/.test(l)));
  const bad = (await admin.post('/api/admin/mail/test', { what: 'smtp', values: { ...v, SMTP_PASS: 'x' } })).data;
  assert.equal(bad.ok, false);
});

test('probar el inicio de sesión con un usuario (no se guarda)', async () => {
  const v = { IMAP_HOST: '127.0.0.1', IMAP_PORT: String(mailbox.port), IMAP_SECURE: 'false' };
  assert.equal((await admin.post('/api/admin/mail/test', { what: 'login', values: v, email: 'soporte@empresa.com', password: 'clave-ok' })).data.ok, true);
  assert.equal((await admin.post('/api/admin/mail/test', { what: 'login', values: v, email: 'soporte@empresa.com', password: 'no' })).data.ok, false);
});

test('rechaza servidores con formato peligroso o prueba desconocida', async () => {
  assert.equal((await admin.post('/api/admin/mail/test', { what: 'inbox', values: { INBOX_HOST: 'http://x' } })).status, 400);
  assert.equal((await admin.put('/api/admin/mail', { values: { SMTP_HOST: '169.254.169.254' } })).status, 400);
  assert.equal((await admin.post('/api/admin/mail/test', { what: 'otra', values: {} })).status, 400);
});

test('guardar: aplica al instante, cifra la contraseña y nunca la devuelve', async () => {
  const r = await admin.put('/api/admin/mail', { values: { ...inbox('clave-ok'), INBOX_POLL_SECONDS: '30' } });
  assert.equal(r.status, 200);
  assert.equal(r.data.config.INBOX_HOST.value, '127.0.0.1');
  assert.equal(r.data.config.INBOX_HOST.source, 'database');
  assert.deepEqual(r.data.config.INBOX_PASS, { set: true, source: 'database' });
  assert.equal(r.data.inbox.enabled, true);
  assert.ok(!JSON.stringify(r.data).includes('clave-ok'));
  const stored = require('../src/db').prepare("SELECT value FROM settings WHERE key = 'INBOX_PASS'").get().value;
  assert.match(stored, /^enc:v1:/);
  assert.ok(!stored.includes('clave-ok'));
  // probar sin escribir la contraseña usa la guardada
  const t = (await admin.post('/api/admin/mail/test', { what: 'inbox', values: { INBOX_PASS: '' } })).data;
  assert.equal(t.ok, true);
  // borrar un campo vuelve al .env (aquí, vacío)
  const d = await admin.put('/api/admin/mail', { values: { INBOX_HOST: '' } });
  assert.equal(d.data.config.INBOX_HOST.source, null);
  require('../src/mailIngest').stop();
});
