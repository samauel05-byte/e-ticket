const nodemailer = require('nodemailer');

const HOST = process.env.SMTP_HOST || '';
const APP_URL = (process.env.APP_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
const FROM = process.env.SMTP_FROM || (process.env.SMTP_USER ? `E-Ticket TI <${process.env.SMTP_USER}>` : 'E-Ticket TI <no-reply@localhost>');

const enabled = () => Boolean(HOST);

let transport;
const getTransport = () => transport || (transport = nodemailer.createTransport({
  host: HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: process.env.SMTP_SECURE === 'true', // true = TLS directo (465); false = STARTTLS si el servidor lo ofrece
  auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS || '' } : undefined,
  tls: { rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== 'false' },
  connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 20000,
}));

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clean = (s) => String(s ?? '').replace(/[\r\n]+/g, ' '); // evita inyección en cabeceras

// Envía sin bloquear la petición y sin romperla si el SMTP falla.
function notify(to, subject, ticket, text) {
  if (!enabled()) return;
  const list = [...new Set([].concat(to).filter(Boolean))];
  if (!list.length) return;
  const url = `${APP_URL}/#/ticket/${ticket.id}`;
  getTransport().sendMail({
    from: FROM,
    to: list,
    subject: clean(`[Ticket #${ticket.id}] ${subject}`),
    text: `${text}\n\nTicket #${ticket.id}: ${ticket.title}\n${url}`,
    html: `<p style="white-space:pre-wrap">${esc(text)}</p><p><strong>Ticket #${ticket.id}</strong>: ${esc(ticket.title)}<br><a href="${esc(url)}">Abrir ticket</a></p>`,
  }).catch((e) => console.error('SMTP:', e.message));
}

module.exports = { enabled, notify };
