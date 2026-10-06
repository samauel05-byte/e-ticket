// Pruebas de conexión de correo con resultado estructurado (las usa Administración → Correo).
// Reciben la configuración (claves IMAP_*, INBOX_*, SMTP_*) y nunca devuelven ni registran contraseñas.
const { ImapFlow } = require('imapflow');
const nodemailer = require('nodemailer');

const yes = (v, d = true) => (v === '' || v === undefined || v === null ? d : String(v) !== 'false');

function explain(e, tlsVar) {
  const code = e.code || '';
  const text = String(e.responseText || e.response || e.message || e);
  const hints = [];
  if (e.authenticationFailed || code === 'EAUTH' || (/auth|credentials|login|535|invalid/i.test(text) && !/ECONN|ETIMEDOUT|certificate/i.test(code + text))) {
    hints.push('Revisa que la contraseña sea la actual y que el usuario sea el correo completo.', 'Si el servidor espera solo la primera parte, prueba con "soporte" en lugar de "soporte@dominio".');
    return { message: 'El servidor rechazó el usuario o la contraseña.', hints };
  }
  if (/cert|self.signed|altname|issuer/i.test(code + text)) {
    hints.push(`El nombre del servidor debe coincidir con su certificado. Como último recurso (red interna) puedes poner ${tlsVar}=false en .env.`);
    return { message: `Problema con el certificado de seguridad del servidor (${code || text}).`, hints };
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH|ESOCKET|ECONNECTION|ECONNRESET|Greeting|timeout/i.test(code + text)) {
    hints.push('Revisa el servidor y el puerto, y que el firewall de este equipo permita la salida a ese puerto.', 'Puertos habituales: IMAP 993 (SSL) o 143; SMTP 465 (SSL) o 587 (STARTTLS).');
    return { message: `No se pudo conectar al servidor (${code || text}).`, hints };
  }
  return { message: text, hints };
}

const imapClient = (c, user, pass, tls) => {
  const client = new ImapFlow({
    host: c.host, port: c.port, secure: c.secure, auth: { user, pass }, logger: false,
    tls: { rejectUnauthorized: tls }, greetingTimeout: 10000, socketTimeout: 20000,
  });
  client.on('error', () => {});
  return client;
};

// Bandeja de soporte: conecta y abre la carpeta en solo lectura
async function checkInbox(cfg) {
  if (!cfg.INBOX_HOST) return { ok: false, skipped: true, message: 'Falta el servidor de la bandeja.', hints: [] };
  if (!cfg.INBOX_USER || !cfg.INBOX_PASS) return { ok: false, message: 'Faltan el usuario o la contraseña de la bandeja.', hints: [] };
  const client = imapClient({ host: cfg.INBOX_HOST, port: Number(cfg.INBOX_PORT) || 993, secure: yes(cfg.INBOX_SECURE) }, cfg.INBOX_USER, cfg.INBOX_PASS, process.env.INBOX_TLS_REJECT_UNAUTHORIZED !== 'false');
  try {
    await client.connect();
    const mailbox = process.env.INBOX_MAILBOX || 'INBOX';
    const lock = await client.getMailboxLock(mailbox, { readOnly: true });
    let unseen = 0;
    try { unseen = ((await client.search({ seen: false, since: new Date(Date.now() - 2 * 86400000) }, { uid: true })) || []).length; } finally { lock.release(); }
    await client.logout();
    return { ok: true, message: `Conexión exitosa. Carpeta "${mailbox}" abierta (solo lectura): ${unseen} correo(s) sin leer de los últimos 2 días.`, hints: [] };
  } catch (e) { try { client.close(); } catch { /* */ } return { ok: false, ...explain(e, 'INBOX_TLS_REJECT_UNAUTHORIZED') }; }
}

// Envío (SMTP); con sendTo manda además un correo de prueba
async function checkSmtp(cfg, sendTo) {
  if (!cfg.SMTP_HOST) return { ok: false, skipped: true, message: 'Falta el servidor de envío.', hints: [] };
  const port = Number(cfg.SMTP_PORT) || 587;
  const secure = String(cfg.SMTP_SECURE) === 'true';
  const hints = port === 465 && !secure ? ['El puerto 465 usa SSL directo: activa "SSL directo".'] : [];
  const t = nodemailer.createTransport({
    host: cfg.SMTP_HOST, port, secure, auth: cfg.SMTP_USER ? { user: cfg.SMTP_USER, pass: cfg.SMTP_PASS } : undefined,
    tls: { rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false' },
    connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
  });
  try {
    await t.verify();
    let message = 'Conexión exitosa.';
    if (sendTo) {
      const from = cfg.SMTP_FROM || (cfg.SMTP_USER ? `ETIQUE <${cfg.SMTP_USER}>` : 'ETIQUE <no-reply@localhost>');
      await t.sendMail({ from, to: sendTo, subject: 'Prueba de ETIQUE', text: 'Si lees esto, el envío de avisos de ETIQUE funciona correctamente.' });
      message = `Conexión exitosa. Correo de prueba enviado a ${sendTo}; revisa su bandeja (y el spam).`;
    }
    return { ok: true, message, hints };
  } catch (e) { const x = explain(e, 'SMTP_TLS_REJECT_UNAUTHORIZED'); return { ok: false, message: x.message, hints: [...hints, ...x.hints] }; }
}

// Inicio de sesión: prueba un usuario y contraseña (no se guardan) contra el servidor IMAP
async function checkLogin(cfg, email, password) {
  if (!cfg.IMAP_HOST) return { ok: false, skipped: true, message: 'Falta el servidor de inicio de sesión.', hints: [] };
  if (!email || !password) return { ok: false, message: 'Escribe un correo y su contraseña para probar el inicio de sesión (no se guardan).', hints: [] };
  const user = cfg.IMAP_USER_FORMAT === 'local' ? String(email).split('@')[0] : email;
  const client = imapClient({ host: cfg.IMAP_HOST, port: Number(cfg.IMAP_PORT) || 993, secure: yes(cfg.IMAP_SECURE) }, user, password, process.env.IMAP_TLS_REJECT_UNAUTHORIZED !== 'false');
  try { await client.connect(); await client.logout(); return { ok: true, message: 'Conexión exitosa: el servidor aceptó ese usuario y contraseña.', hints: [] }; }
  catch (e) { try { client.close(); } catch { /* */ } return { ok: false, ...explain(e, 'IMAP_TLS_REJECT_UNAUTHORIZED') }; }
}

module.exports = { checkInbox, checkSmtp, checkLogin };
