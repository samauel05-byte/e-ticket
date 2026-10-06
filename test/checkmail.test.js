const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { startFakeMailbox, buildMail } = require('../scripts/fakeMailbox');

let mb;
before(async () => { mb = await startFakeMailbox({ user: 'soporte@grupodupla.com', pass: 'clave-de-prueba' }); });
after(() => mb.close());

const run = (extra = {}) => new Promise((resolve) => {
  const { spawn } = require('node:child_process');
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'check-mail.js')], {
    env: { ...process.env, ENV_FILE: path.join(__dirname, 'no-existe.env'), SMTP_HOST: '', INBOX_HOST: '127.0.0.1', INBOX_PORT: String(mb.port),
      INBOX_SECURE: 'false', INBOX_USER: 'soporte@grupodupla.com', INBOX_PASS: 'clave-de-prueba', ...extra }, encoding: 'utf8' });
  let out = ''; child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (out += d));
  child.on('close', (status) => resolve({ status, out }));
});

test('check:mail: bandeja correcta → todo en orden, cuenta los correos pendientes y NO los marca como leídos', async () => {
  mb.deliver(buildMail({ from: 'ana@grupodupla.com', subject: 'Hola', text: 'x' }));
  const r = await run();
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Conexión y contraseña correctas/);
  assert.match(r.out, /1 correo\(s\) sin leer/);
  assert.match(r.out, /Todo en orden/);
  assert.equal(mb.messages.every((m) => !m.seen), true, 'el diagnóstico no debe modificar la bandeja');
});

test('check:mail: contraseña incorrecta → explica el problema y no imprime la contraseña', async () => {
  const r = await run({ INBOX_PASS: 'incorrecta-secreta' });
  assert.equal(r.status, 1);
  assert.match(r.out, /rechazó el usuario o la contraseña/);
  assert.ok(!r.out.includes('incorrecta-secreta') && !r.out.includes('clave-de-prueba'), 'nunca debe mostrar contraseñas');
});

test('check:mail: servidor inalcanzable → sugiere revisar host, puerto y firewall', async () => {
  const r = await run({ INBOX_PORT: '1' });
  assert.equal(r.status, 1);
  assert.match(r.out, /no se pudo conectar/);
});

test('check:mail: sin configuración → lo indica sin fallar', async () => {
  const r = await run({ INBOX_HOST: '' });
  assert.equal(r.status, 0);
  assert.match(r.out, /desactivados/);
});
