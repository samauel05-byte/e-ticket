// Tickets por correo: lee una bandeja IMAP y convierte cada correo nuevo en un ticket
// (o en un comentario, si es la respuesta a un aviso "[Ticket #N]").
//
//   INBOX_HOST, INBOX_PORT (993), INBOX_SECURE (true), INBOX_USER, INBOX_PASS   bandeja de soporte (clave SOLO en .env)
//   INBOX_MAILBOX (INBOX)  INBOX_POLL_SECONDS (60)  INBOX_MAX_AGE_DAYS (2)
//   INBOX_REQUIRE_AUTH (false)  INBOX_MAX_PER_SENDER_HOUR (20)  INBOX_DEFAULT_PRIORITY (media)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const db = require('./db');
const imapAuth = require('./imapAuth');
const T = require('./tickets');
const up = require('./uploads');

const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const cfg = () => ({
  host: env('INBOX_HOST', ''),
  port: Number(env('INBOX_PORT', 993)),
  secure: env('INBOX_SECURE', 'true') !== 'false',
  user: env('INBOX_USER', ''),
  pass: env('INBOX_PASS', ''),
  mailbox: env('INBOX_MAILBOX', 'INBOX'),
  pollMs: Math.max(5, Number(env('INBOX_POLL_SECONDS', 60))) * 1000,
  maxAgeDays: Number(env('INBOX_MAX_AGE_DAYS', 2)),
  requireAuth: env('INBOX_REQUIRE_AUTH', 'false') === 'true',
  maxPerSenderHour: Number(env('INBOX_MAX_PER_SENDER_HOUR', 20)),
  priority: T.PRIORITIES.includes(env('INBOX_DEFAULT_PRIORITY', 'media')) ? env('INBOX_DEFAULT_PRIORITY', 'media') : 'media',
  allowedDomain: env('ALLOWED_DOMAIN', 'empresa.com').toLowerCase().replace(/^@/, ''),
  rejectUnauthorized: env('INBOX_TLS_REJECT_UNAUTHORIZED', 'true') !== 'false',
});
const enabled = () => Boolean(cfg().host && cfg().user);

const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const clean = (s, n) => String(s || '').replace(/\u0000/g, '').trim().slice(0, n);

// Categoría por palabras clave (TI puede cambiarla después)
const CATEGORY_RULES = [
  ['Red / Internet', /\b(vpn|internet|wifi|wi-fi|red|conexion|router|switch|lento|ethernet)\b/],
  ['Correo', /\b(correo|outlook|email|e-mail|mail|buzon|gmail)\b/],
  ['Impresoras', /\b(impresora|imprimir|toner|tinta|escaner|scanner|fotocopiadora)\b/],
  ['Accesos / Contrasenas', /\b(contrasena|clave|password|acceso|accesos|usuario|permiso|permisos|bloqueado|cuenta)\b/],
  ['Software', /\b(instalar|instalacion|licencia|programa|software|excel|word|office|windows|actualizar|aplicacion|sistema)\b/],
  ['Hardware', /\b(pc|computadora|laptop|teclado|mouse|raton|monitor|pantalla|disco|equipo|camara|audifonos)\b/],
];
function guessCategory(text) {
  const t = norm(text);
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat === 'Accesos / Contrasenas' ? 'Accesos / Contraseñas' : cat;
  return 'Otro';
}

const cleanSubject = (s) => {
  let t = String(s || '').replace(/\[Ticket #\d+\]\s*/gi, '').trim();
  while (/^(re|rv|fw|fwd|enc|resp)(\[\d+\])?\s*:\s*/i.test(t)) t = t.replace(/^(re|rv|fw|fwd|enc|resp)(\[\d+\])?\s*:\s*/i, '');
  return t.trim();
};
// Quita el texto citado de una respuesta ("El … escribió:", "> …", "De: …")
function stripQuoted(text) {
  const out = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (/^\s*(>|on .+ wrote:|el .+ escribi[oó]:|-{2,}\s*(original message|mensaje original)|_{5,}|de:\s|from:\s|enviado( el)?:\s|sent from my|enviado desde)/i.test(line)) break;
    out.push(line);
  }
  return out.join('\n').trim();
}

// ¿El correo parece una respuesta automática o un rebote? Se ignora para no crear ciclos.
function isAutomatic(parsed, inboxUser) {
  const h = parsed.headers;
  const get = (k) => String(h.get(k) ?? '').toLowerCase();
  if (h.has('auto-submitted') && get('auto-submitted') !== 'no') return 'respuesta automática';
  if (/^(bulk|junk|list|auto_reply)/.test(get('precedence'))) return 'correo masivo';
  if (h.has('list-id') || h.has('x-autoreply') || h.has('x-autorespond') || h.has('x-auto-response-suppress')) return 'correo automático';
  const addr = String(parsed.from?.value?.[0]?.address || '').toLowerCase();
  if (inboxUser && addr === String(inboxUser).toLowerCase()) return 'enviado por la propia bandeja';
  if (/^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/.test(addr.split('@')[0])) return 'remitente automático';
  if (/^(automatic reply|respuesta autom|out of office|fuera de la oficina|undeliverable|delivery status|no se pudo entregar)/i.test(parsed.subject || '')) return 'respuesta automática';
  return null;
}

// Autenticación del remitente según las cabeceras que añade el servidor receptor (SPF/DKIM/DMARC).
function senderAuth(parsed, requireAuth) {
  const raw = parsed.headers.get('authentication-results');
  const text = raw === undefined ? '' : JSON.stringify(raw).toLowerCase();
  if (/(dkim|spf|dmarc)=fail/.test(text)) return 'falló la verificación SPF/DKIM/DMARC del remitente';
  if (requireAuth && !/(dkim|spf|dmarc)=pass/.test(text)) return 'no se pudo verificar al remitente (INBOX_REQUIRE_AUTH)';
  return null;
}

function ensureUser(address, displayName, c) {
  const existing = T.getUserByEmail(address);
  if (existing) return existing;
  // Alta automática solo si el login es con la clave del correo (IMAP): así el usuario podrá entrar después
  if (!imapAuth.enabled()) return null;
  db.prepare("INSERT OR IGNORE INTO departments (name) VALUES ('Sin departamento')").run();
  const dep = db.prepare("SELECT id FROM departments WHERE name = 'Sin departamento'").get().id;
  const local = address.split('@')[0].replace(/[._-]+/g, ' ');
  const name = clean(displayName, 100) || local.replace(/\b\w/g, (m) => m.toUpperCase());
  const info = db.prepare("INSERT INTO users (email, name, password_hash, department_id, role) VALUES (?,?,'!email',?, 'user')")
    .run(address, name, dep);
  return T.getUser(info.lastInsertRowid);
}

function saveAttachments(parsed, ticketId, userId) {
  const c = [];
  const list = (parsed.attachments || []).filter((a) => !(a.related && a.contentDisposition === 'inline')).slice(0, up.MAX_FILES);
  const ins = db.prepare('INSERT INTO attachments (ticket_id, user_id, original_name, stored_name, size) VALUES (?,?,?,?,?)');
  for (const a of list) {
    const original = clean(String(a.filename || 'adjunto').replace(/[\\/\r\n]/g, '_'), 200);
    if (!up.ALLOWED_EXT.has(up.extOf(original)) || !a.content || a.content.length > up.MAX_MB * 1024 * 1024) { c.push(`omitido: ${original}`); continue; }
    const stored = up.storedName(original);
    fs.writeFileSync(path.join(up.UPLOAD_DIR, stored), a.content);
    ins.run(ticketId, userId, original, stored, a.content.length);
    c.push(original);
  }
  return c;
}

const record = (messageId, result, ticketId = null) =>
  db.prepare('INSERT OR REPLACE INTO ingested_mail (message_id, result, ticket_id) VALUES (?,?,?)').run(messageId, result, ticketId);

// Procesa un correo completo (Buffer/string RFC 822). Devuelve { status, ... } y registra el resultado.
async function processRaw(raw) {
  const c = cfg();
  const parsed = await simpleParser(raw);
  const messageId = parsed.messageId || 'sha1:' + crypto.createHash('sha1').update(raw).digest('hex');
  if (db.prepare('SELECT 1 FROM ingested_mail WHERE message_id = ?').get(messageId)) return { status: 'ignored', reason: 'ya procesado' };
  const ignore = (reason) => { record(messageId, 'ignorado: ' + reason); console.log(`correo ignorado (${reason}): ${parsed.from?.text || '?'} · ${clean(parsed.subject, 60)}`); return { status: 'ignored', reason }; };

  const auto = isAutomatic(parsed, c.user);
  if (auto) return ignore(auto);
  const from = parsed.from?.value?.[0];
  const address = String(from?.address || '').toLowerCase();
  if (!address || !address.endsWith('@' + c.allowedDomain)) return ignore('remitente fuera de la empresa');
  const bad = senderAuth(parsed, c.requireAuth);
  if (bad) return ignore(bad);

  const user = ensureUser(address, from?.name, c);
  if (!user) return ignore('remitente sin cuenta en el sistema');

  const subject = clean(parsed.subject, 400);
  const text = clean(parsed.text, 20000);

  // ¿Es la respuesta a un ticket existente?  Asunto con "[Ticket #123]"
  const ref = /\[Ticket #(\d+)\]/i.exec(subject);
  if (ref) {
    const ticket = db.prepare('SELECT * FROM tickets WHERE id = ?').get(Number(ref[1]));
    const allowed = ticket && user.role !== 'manager' && (ticket.requester_id === user.id || user.role === 'agent' || user.role === 'admin');
    if (allowed) {
      const body = clean(stripQuoted(text), 5000);
      if (!body) return ignore('respuesta sin contenido');
      T.addComment({ ticket, user, body });
      saveAttachments(parsed, ticket.id, user.id);
      record(messageId, 'comentario', ticket.id);
      console.log(`correo → comentario en ticket #${ticket.id} (${address})`);
      return { status: 'comment', ticket_id: ticket.id, user: address };
    }
  }

  // Control anti-inundación por remitente
  const recent = db.prepare("SELECT COUNT(*) AS n FROM tickets WHERE source = 'email' AND requester_id = ? AND created_at >= datetime('now','-1 hour')").get(user.id).n;
  if (recent >= c.maxPerSenderHour) return ignore('demasiados correos de este remitente en una hora');

  const title = clean(cleanSubject(subject), 150) || '(sin asunto)';
  const description = clean(text, 5000) || '(El correo no traía texto. Revisa los adjuntos.)';
  const ticket = T.createTicket({
    requester: user, title, description, category: guessCategory(`${title} ${description}`),
    priority: c.priority, source: 'email',
  });
  const files = saveAttachments(parsed, ticket.id, user.id);
  record(messageId, 'ticket', ticket.id);
  console.log(`correo → ticket #${ticket.id} (${address})${files.length ? ' con ' + files.length + ' adjunto(s)' : ''}`);
  return { status: 'ticket', ticket_id: ticket.id, user: address, files };
}

// Una vuelta: conecta, procesa los correos no leídos recientes y los marca como leídos.
const attempts = new Map();
async function pollOnce() {
  const c = cfg();
  const client = new ImapFlow({
    host: c.host, port: c.port, secure: c.secure, auth: { user: c.user, pass: c.pass }, logger: false,
    tls: { rejectUnauthorized: c.rejectUnauthorized }, greetingTimeout: 10000, socketTimeout: 30000,
  });
  client.on('error', () => {});
  await client.connect();
  const summary = { ticket: 0, comment: 0, ignored: 0, errors: 0 };
  try {
    const lock = await client.getMailboxLock(c.mailbox);
    try {
      const since = new Date(Date.now() - c.maxAgeDays * 86400000);
      const uids = (await client.search({ seen: false, since }, { uid: true })) || [];
      for (const uid of uids.slice(0, 50)) {
        try {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          const r = await processRaw(msg.source);
          summary[r.status === 'ticket' ? 'ticket' : r.status === 'comment' ? 'comment' : 'ignored']++;
          await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
          attempts.delete(uid);
        } catch (e) {
          summary.errors++;
          const n = (attempts.get(uid) || 0) + 1; attempts.set(uid, n);
          console.error(`error procesando el correo uid=${uid} (intento ${n}):`, e.message);
          if (n >= 3) { await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true }); attempts.delete(uid); }
        }
      }
    } finally { lock.release(); }
  } finally { try { await client.logout(); } catch { client.close(); } }
  return summary;
}

let timer = null;
let running = false;
function start() {
  if (!enabled() || timer) return false;
  const c = cfg();
  const tick = async () => {
    if (running) return;
    running = true;
    try { await pollOnce(); } catch (e) { console.error('bandeja de soporte:', e.message); } finally { running = false; }
  };
  console.log(`Tickets por correo activos: ${c.user} @ ${c.host} cada ${c.pollMs / 1000} s`);
  setTimeout(tick, 3000).unref();
  timer = setInterval(tick, c.pollMs); timer.unref();
  return true;
}
const stop = () => { if (timer) clearInterval(timer); timer = null; };

module.exports = { enabled, start, stop, pollOnce, processRaw, guessCategory, stripQuoted, cleanSubject };
