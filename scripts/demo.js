#!/usr/bin/env node
// Demostración local con datos de ejemplo. Solo necesita Node.js (Windows, Linux y macOS), sin Docker.
//   npm run demo               arranca en http://localhost:3000
//   npm run demo -- --reset    borra los datos de la demostración y empieza de cero
//   npm run demo -- --port 3100
// NO usar en producción: crea usuarios con una clave conocida. Usa su propia base de datos (data/demo/).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const arg = (name) => {
  const i = process.argv.indexOf('--' + name);
  return i < 0 ? undefined : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : true);
};
const root = path.join(__dirname, '..');
const dir = path.join(root, 'data', 'demo');
if (arg('reset')) { fs.rmSync(dir, { recursive: true, force: true }); console.log('Datos de la demostración borrados.'); }
fs.mkdirSync(dir, { recursive: true });

// Configuración aislada: no lee .env y no toca la base de datos real
Object.assign(process.env, {
  DB_PATH: path.join(dir, 'demo.db'),
  UPLOAD_DIR: path.join(dir, 'uploads'),
  ALLOWED_DOMAIN: 'empresa.com',
  ADMIN_EMAIL: 'admin@empresa.com',
  SESSION_SECRET: crypto.randomBytes(24).toString('hex'),
  COOKIE_SECURE: 'false',
  DEMO_SEED: 'true',
  IMAP_HOST: '',
  SMTP_HOST: '',
});
if (!process.env.SLA_TZ) process.env.SLA_TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
delete process.env.NODE_ENV;

(async () => {
// Bandeja de soporte simulada: los correos que lleguen a ella se convierten en tickets
const mailPort = Number(arg('mail-port')) || 3198;
const mailbox = await require('./fakeMailbox').startFakeMailbox({ user: 'soporte@empresa.com', pass: 'demo', httpPort: mailPort });
Object.assign(process.env, {
  INBOX_HOST: '127.0.0.1', INBOX_PORT: String(mailbox.port), INBOX_SECURE: 'false', INBOX_USER: 'soporte@empresa.com',
  INBOX_PASS: 'demo', INBOX_POLL_SECONDS: '5',
});

require('../src/seedDemo').seed();
const app = require('../src/server');
const port = Number(arg('port')) || Number(process.env.PORT) || 3000;
const server = app.listen(port, () => {
  require('../src/mailIngest').start();
  console.log(`
  Demostración lista:  http://localhost:${server.address().port}

  Usuarios (clave: prueba1234)
    admin@empresa.com    administrador
    tecnico@, samuel@ y laura@empresa.com  personal de TI
    gerencia@empresa.com  gerencia (dashboard, solo lectura)
    ana@, luis@ y marta@empresa.com   usuarios que piden tickets

  Tickets por correo: abre OTRA ventana y ejecuta
    npm run demo:mail -- --from ana@empresa.com --subject "No tengo internet" --body "Desde las 9 no conecta"
  En unos segundos aparece como ticket nuevo. Para responder a un ticket: añade  --ticket 3

  Aquí no se envían correos de aviso (para verlos usa el ambiente con Docker, ver TEST.md).
  Para detenerla: Ctrl+C.   Para empezar de cero: npm run demo -- --reset
`);
});
})();
