#!/usr/bin/env node
// Diagnóstico del correo: comprueba la bandeja de soporte (IMAP) y el envío de avisos (SMTP) con lo que hay en .env.
//   npm run check:mail
//   npm run check:mail -- --send-to tu.correo@grupodupla.com     (además envía un correo de prueba)
// No modifica la bandeja (la abre en solo lectura) y nunca imprime contraseñas.
const path = require('path');
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');

try { process.loadEnvFile(process.env.ENV_FILE || path.join(__dirname, '..', '.env')); } catch { /* sin .env: se usa el entorno */ }
const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const i = process.argv.indexOf('--send-to');
const sendTo = i > 0 ? process.argv[i + 1] : null;

const ok = (m) => console.log('  ✔ ' + m);
const bad = (m) => console.log('  ✘ ' + m);
const hint = (m) => console.log('    → ' + m);
let failures = 0;

function explain(e, what, tlsVar) {
  failures++;
  const code = e.code || '';
  const text = String(e.responseText || e.response || e.message || e);
  if (e.authenticationFailed || code === 'EAUTH' || /auth|credentials|login|535|invalid/i.test(text) && !/ECONN|ETIMEDOUT|certificate/i.test(code + text)) {
    bad(`${what}: el servidor rechazó el usuario o la contraseña.`);
    hint('Revisa que la contraseña sea la actual y que el usuario sea el correo completo.');
    hint('Si tu servidor espera solo la primera parte, prueba con "soporte" en lugar de "soporte@dominio".');
  } else if (/cert|self.signed|altname|issuer/i.test(code + text)) {
    bad(`${what}: problema con el certificado de seguridad del servidor (${code || text}).`);
    hint(`El nombre del servidor debe coincidir con su certificado. Como último recurso (red interna) puedes poner ${tlsVar}=false.`);
  } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ESOCKET|ECONNECTION|ECONNRESET|Greeting|timeout/i.test(code + text)) {
    bad(`${what}: no se pudo conectar al servidor (${code || text}).`);
    hint('Revisa el host y el puerto, y que el firewall de ESTE servidor permita la salida a ese puerto.');
    hint('Puertos habituales: IMAP 993 (SSL) o 143; SMTP 465 (SSL) o 587 (STARTTLS).');
  } else {
    bad(`${what}: ${text}`);
  }
}

async function checkInbox() {
  console.log('\nBandeja de soporte (IMAP) — recibe los correos que se vuelven tickets');
  const host = env('INBOX_HOST');
  if (!host) { console.log('  — INBOX_HOST no está definido: los tickets por correo están desactivados.'); return; }
  const c = {
    host, port: Number(env('INBOX_PORT', 993)), secure: env('INBOX_SECURE', 'true') !== 'false', user: env('INBOX_USER'), pass: env('INBOX_PASS'),
    mailbox: env('INBOX_MAILBOX', 'INBOX'), maxAge: Number(env('INBOX_MAX_AGE_DAYS', 2)),
  };
  console.log(`  Servidor ${c.host}:${c.port} (${c.secure ? 'SSL' : 'sin SSL directo'}), usuario ${c.user || '(falta INBOX_USER)'}`);
  if (!c.user || !c.pass) { failures++; bad('Faltan INBOX_USER o INBOX_PASS en el archivo .env.'); return; }
  const client = new ImapFlow({ host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass }, logger: false,
    tls: { rejectUnauthorized: env('INBOX_TLS_REJECT_UNAUTHORIZED', 'true') !== 'false' }, greetingTimeout: 15000, socketTimeout: 30000 });
  client.on('error', () => {});
  try {
    await client.connect();
    ok('Conexión y contraseña correctas.');
    const lock = await client.getMailboxLock(c.mailbox, { readOnly: true });
    try {
      const unseen = (await client.search({ seen: false, since: new Date(Date.now() - c.maxAge * 86400000) }, { uid: true })) || [];
      ok(`Carpeta "${c.mailbox}" abierta en solo lectura: ${unseen.length} correo(s) sin leer de los últimos ${c.maxAge} día(s) se convertirían en tickets.`);
    } finally { lock.release(); }
    await client.logout();
  } catch (e) { explain(e, 'IMAP', 'INBOX_TLS_REJECT_UNAUTHORIZED'); try { client.close(); } catch { /* */ } }
}

async function checkSmtp() {
  console.log('\nEnvío de avisos (SMTP) — confirmaciones y respuestas a los usuarios');
  const host = env('SMTP_HOST');
  if (!host) { console.log('  — SMTP_HOST no está definido: no se enviarán avisos por correo.'); return; }
  const port = Number(env('SMTP_PORT', 587));
  console.log(`  Servidor ${host}:${port} (${env('SMTP_SECURE') === 'true' ? 'SSL' : 'STARTTLS si el servidor lo ofrece'}), usuario ${env('SMTP_USER') || '(sin autenticación)'}`);
  if (port === 465 && env('SMTP_SECURE') !== 'true') hint('El puerto 465 usa SSL directo: pon SMTP_SECURE=true.');
  const t = nodemailer.createTransport({
    host, port, secure: env('SMTP_SECURE') === 'true',
    auth: env('SMTP_USER') ? { user: env('SMTP_USER'), pass: env('SMTP_PASS') } : undefined,
    tls: { rejectUnauthorized: env('SMTP_TLS_REJECT_UNAUTHORIZED', 'true') !== 'false' },
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  });
  try {
    await t.verify();
    ok('Conexión y contraseña correctas.');
    if (sendTo) {
      const from = env('SMTP_FROM', env('SMTP_USER', 'no-reply@localhost'));
      await t.sendMail({ from, to: sendTo, subject: 'Prueba de E-Ticket TI', text: 'Si lees esto, el envío de avisos funciona correctamente.' });
      ok(`Correo de prueba enviado a ${sendTo} desde ${from}. Revisa su bandeja (y el spam).`);
    }
  } catch (e) { explain(e, 'SMTP', 'SMTP_TLS_REJECT_UNAUTHORIZED'); }
}

(async () => {
  console.log('E-Ticket TI · diagnóstico de correo');
  await checkInbox();
  await checkSmtp();
  console.log(failures ? `\n${failures} problema(s) por resolver.` : '\nTodo en orden.');
  process.exit(failures ? 1 : 0);
})();
