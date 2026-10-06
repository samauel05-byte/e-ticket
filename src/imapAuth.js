const { ImapFlow } = require('imapflow');

// La configuración se lee en cada uso: así los cambios hechos en Administración se aplican sin reiniciar.
const cfg = () => ({
  host: process.env.IMAP_HOST || '',
  port: Number(process.env.IMAP_PORT) || 993,
  secure: process.env.IMAP_SECURE !== 'false', // true = TLS directo (993)
  rejectUnauthorized: process.env.IMAP_TLS_REJECT_UNAUTHORIZED !== 'false',
  userFormat: process.env.IMAP_USER_FORMAT || 'email', // 'email' o 'local' (parte antes de @)
  maxConcurrent: Number(process.env.IMAP_MAX_CONCURRENT) || 5,
});
const enabled = () => Boolean(cfg().host);

// Máximo de comprobaciones simultáneas contra el servidor de correo (protege al servidor IMAP)
let inflight = 0;

// Devuelve true si el servidor IMAP acepta las credenciales. No guarda la contraseña.
async function verify(email, password) {
  if (inflight >= cfg().maxConcurrent) {
    const err = new Error('El servidor está ocupado, intenta de nuevo en un momento');
    err.unavailable = true;
    throw err;
  }
  inflight++;
  try { return await check(email, password); } finally { inflight--; }
}

async function check(email, password) {
  const c = cfg();
  const user = c.userFormat === 'local' ? email.split('@')[0] : email;
  const client = new ImapFlow({
    host: c.host, port: c.port, secure: c.secure,
    auth: { user, pass: password },
    logger: false,
    tls: { rejectUnauthorized: c.rejectUnauthorized },
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
