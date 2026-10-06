// Bandeja de correo de PRUEBA (servidor IMAP mínimo en memoria). Sirve para probar "tickets por correo"
// sin una cuenta real: la usan las pruebas automáticas y `npm run demo`. NO es para producción.
//   deliver(raw)        agrega un correo (RFC 822) a la bandeja
//   HTTP opcional       POST /deliver con el correo en el cuerpo (lo usa `npm run demo:mail`)
const net = require('net');
const http = require('http');

function startFakeMailbox({ user = 'soporte@empresa.com', pass = 'prueba', port = 0, httpPort = null } = {}) {
  const messages = []; // { uid, raw: Buffer, seen: boolean }
  let nextUid = 1;
  const deliver = (raw) => { messages.push({ uid: nextUid++, raw: Buffer.from(raw), seen: false }); return nextUid - 1; };

  const server = net.createServer((sock) => {
    sock.write('* OK fake mailbox ready\r\n');
    let buf = '';
    let authed = false;
    const reply = (s) => sock.write(s + '\r\n');
    sock.on('error', () => {});
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 2);
        const m = /^(\S+)\s+(\S+)\s*(.*)$/.exec(line);
        if (!m) continue;
        const [, tag, cmd0, args] = m;
        const cmd = cmd0.toUpperCase();
        if (cmd === 'CAPABILITY') { reply('* CAPABILITY IMAP4rev1 UIDPLUS'); reply(`${tag} OK done`); }
        else if (cmd === 'LOGIN') {
          const parts = [...args.matchAll(/"((?:[^"\\]|\\.)*)"|(\S+)/g)].map((x) => x[1] ?? x[2]);
          if (parts[0] === user && parts[1] === pass) { authed = true; reply(`${tag} OK [CAPABILITY IMAP4rev1 UIDPLUS] logged in`); }
          else reply(`${tag} NO [AUTHENTICATIONFAILED] bad credentials`);
        } else if (!authed) reply(`${tag} NO not authenticated`);
        else if (cmd === 'LIST' || cmd === 'LSUB') {
          const pattern = (/"[^"]*"\s+"?([^"]*)"?/.exec(args) || [])[1] ?? '';
          if (pattern === '') reply(`* ${cmd} (\\Noselect) "/" ""`);
          else if (pattern === '*' || pattern === '%' || /^inbox$/i.test(pattern)) reply(`* ${cmd} (\\HasNoChildren) "/" "INBOX"`);
          reply(`${tag} OK list done`);
        } else if (cmd === 'STATUS') { reply(`* STATUS "INBOX" (MESSAGES ${messages.length} UIDNEXT ${nextUid} UNSEEN ${messages.filter((x) => !x.seen).length})`); reply(`${tag} OK status done`); }
        else if (cmd === 'SELECT' || cmd === 'EXAMINE') {
          reply('* FLAGS (\\Seen \\Answered \\Flagged \\Deleted \\Draft)');
          reply(`* ${messages.length} EXISTS`); reply('* 0 RECENT');
          reply('* OK [UIDVALIDITY 1] ok'); reply(`* OK [UIDNEXT ${nextUid}] ok`);
          reply(`${tag} OK [READ-WRITE] selected`);
        } else if (cmd === 'UID' && /^SEARCH/i.test(args)) {
          const wantUnseen = /UNSEEN/i.test(args);
          const found = messages.filter((x) => !wantUnseen || !x.seen).map((x) => x.uid);
          reply('* SEARCH' + (found.length ? ' ' + found.join(' ') : '')); reply(`${tag} OK search done`);
        } else if (cmd === 'UID' && /^FETCH/i.test(args)) {
          const uid = Number(/^FETCH\s+(\d+)/i.exec(args)[1]);
          const idx = messages.findIndex((x) => x.uid === uid);
          if (idx < 0) { reply(`${tag} OK fetch done`); continue; }
          const msg = messages[idx];
          sock.write(`* ${idx + 1} FETCH (UID ${uid} FLAGS (${msg.seen ? '\\Seen' : ''}) BODY[] {${msg.raw.length}}\r\n`, 'latin1');
          sock.write(msg.raw); sock.write(')\r\n'); reply(`${tag} OK fetch done`);
        } else if (cmd === 'UID' && /^STORE/i.test(args)) {
          const uid = Number(/^STORE\s+(\d+)/i.exec(args)[1]);
          const idx = messages.findIndex((x) => x.uid === uid);
          if (idx >= 0 && /\\Seen/i.test(args) && /\+FLAGS/i.test(args)) messages[idx].seen = true;
          reply(`* ${idx + 1} FETCH (UID ${uid} FLAGS (${idx >= 0 && messages[idx].seen ? '\\Seen' : ''}))`); reply(`${tag} OK store done`);
        } else if (cmd === 'NOOP' || cmd === 'CLOSE' || cmd === 'UNSELECT' || cmd === 'ID' || cmd === 'ENABLE') reply(`${tag} OK done`);
        else if (cmd === 'LOGOUT') { reply('* BYE bye'); reply(`${tag} OK bye`); sock.end(); }
        else reply(`${tag} BAD unsupported command`);
      }
    });
  });

  let httpServer = null;
  const ready = new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)).then(() => {
    if (httpPort === null) return;
    httpServer = http.createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/deliver') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => { const uid = deliver(Buffer.concat(chunks)); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, uid })); });
      } else { res.writeHead(404); res.end(); }
    });
    return new Promise((resolve) => httpServer.listen(httpPort, '127.0.0.1', resolve));
  });

  return ready.then(() => ({
    port: server.address().port, httpPort: httpServer ? httpServer.address().port : null,
    user, pass, messages, deliver,
    close: () => Promise.all([new Promise((r) => server.close(r)), httpServer ? new Promise((r) => httpServer.close(r)) : null]),
  }));
}

// Construye un correo sencillo (texto plano, o con adjuntos si se indican)
function buildMail({ from, to = 'soporte@empresa.com', subject = '', text = '', headers = {}, attachments = [], messageId }) {
  const id = messageId || `<${Date.now()}.${Math.random().toString(36).slice(2)}@prueba>`;
  const extra = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
  const head = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: ${id}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0'];
  if (extra) head.push(extra);
  if (!attachments.length) return head.concat(['Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text]).join('\r\n');
  const b = '----=_Parte_' + Math.random().toString(36).slice(2);
  const parts = [`--${b}`, 'Content-Type: text/plain; charset=utf-8', '', text];
  for (const a of attachments)
    parts.push(`--${b}`, `Content-Type: ${a.type || 'application/octet-stream'}; name="${a.name}"`, 'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${a.name}"`, '', Buffer.from(a.content).toString('base64'));
  parts.push(`--${b}--`, '');
  return head.concat([`Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts]).join('\r\n');
}

module.exports = { startFakeMailbox, buildMail };
