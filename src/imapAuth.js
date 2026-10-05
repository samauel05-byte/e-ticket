const { ImapFlow } = require('imapflow');

const HOST = process.env.IMAP_HOST || '';
const PORT = Number(process.env.IMAP_PORT) || 993;
const SECURE = process.env.IMAP_SECURE !== 'false'; // true = TLS directo (993)
const REJECT_UNAUTHORIZED = process.env.IMAP_TLS_REJECT_UNAUTHORIZED !== 'false';
const USER_FORMAT = process.env.IMAP_USER_FORMAT || 'email'; // 'email' o 'local' (parte antes de @)

const enabled = () => Boolean(HOST);

// Máximo de comprobaciones simultáneas contra el servidor de correo (protege al servidor IMAP)
const MAX_CONCURRENT = Number(process.env.IMAP_MAX_CONCURRENT) || 5;
let inflight = 0;

// Devuelve true si el servidor IMAP acepta las credenciales. No guarda la contraseña.
async function verify(email, password) {
  if (inflight >= MAX_CONCURRENT) {
    const err = new Error('El servidor está ocupado, intenta de nuevo en un momento');
    err.unavailable = true;
    throw err;
  }
  inflight++;
  try { return await check(email, password); } finally { inflight--; }
}

async function check(email, password) {
  const user = USER_FORMAT === 'local' ? email.split('@')[0] : email;
  const client = new ImapFlow({
    host: HOST, port: PORT, secure: SECURE,
    auth: { user, pass: password },
    logger: false,
    tls: { rejectUnauthorized: REJECT_UNAUTHORIZED },
    greetingTimeout: 10000, socketTimeout: 15000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    return true;
  } catch (e) {
    if (e.authenticationFailed || /auth|login|credentials/i.test(e.responseText || e.message || '')) return false;
    const err = new Error('No se pudo contactar el servidor de correo');
    err.unavailable = true;
    throw err;
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

module.exports = { enabled, verify };
