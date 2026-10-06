const nodemailer = require('nodemailer');

// La configuración se lee en cada uso: así los cambios hechos en Administración se aplican sin reiniciar.
const cfg = () => {
  const user = process.env.SMTP_USER || '';
  return {
    host: process.env.SMTP_HOST || '',
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === 'true', // true = TLS directo (465); false = STARTTLS si el servidor lo ofrece
    user,
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || (user ? `ETIQUE <${user}>` : 'ETIQUE <no-reply@localhost>'),
    rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false',
    appUrl: (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, ''),
  };
};
const enabled = () => Boolean(cfg().host);

let transport = null;
let transportKey = '';
function getTransport(c) {
  const key = JSON.stringify([c.host, c.port, c.secure, c.user, c.pass, c.rejectUnauthorized]);
  if (!transport || key !== transportKey) {
    transport = nodemailer.createTransport({
      host: c.host, port: c.port, secure: c.secure,
      auth: c.user ? { user: c.user, pass: c.pass } : undefined,
      tls: { rejectUnauthorized: c.rejectUnauthorized },
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
    });
    transportKey = key;
  }
  return transport;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' '); // evita inyección en cabeceras

// Envía sin bloquear la petición y sin romperla si el SMTP falla.
function notify(to, subject, ticket, text) {
  const c = cfg();
  if (!c.host) return;
  const list = [...new Set([].concat(to).filter(Boolean))];
  if (!list.length) return;
  const url = `${c.appUrl}/#/ticket/${ticket.id}`;
  getTransport(c).sendMail({
    from: c.from,
    to: list,
    subject: clean(`[Ticket #${ticket.id}] ${subject}`),
    text: `${text}\n\nTicket #${ticket.id}: ${ticket.title}\n${url}`,
    html: `<p style="white-space:pre-wrap">${esc(text)}</p><p><strong>Ticket #${ticket.id}</strong>: ${esc(ticket.title)}<br><a href="${esc(url)}">Abrir ticket</a></p>`,
  }).catch((e) => console.error('SMTP:', e.message));
}

module.exports = { enabled, notify };
