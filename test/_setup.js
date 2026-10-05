// Arranca la app con una BD y carpeta de adjuntos temporales (un proceso por archivo de prueba).
const fs = require('fs');
const os = require('os');
const path = require('path');

function boot(env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eticket-test-'));
  Object.assign(process.env, {
    DB_PATH: path.join(dir, 'test.db'), UPLOAD_DIR: path.join(dir, 'up'),
    ALLOWED_DOMAIN: 'empresa.com', ADMIN_EMAIL: 'admin@empresa.com', SESSION_SECRET: 'test-secret',
    SMTP_HOST: '', IMAP_HOST: '',
  }, env);
  const app = require('../src/server');
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, server, dir, close: () => new Promise((r) => server.close(r)) };
}

// Cliente HTTP con cookie propia (una "sesión de navegador").
function client(base) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const isForm = body instanceof FormData;
    const res = await fetch(base + url, {
      method,
      headers: { ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { cookie } : {}), ...headers },
      body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
      redirect: 'manual',
    });
    const set = res.headers.getSetCookie?.() || [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return { status: res.status, data, headers: res.headers };
  };
  return {
    get: (u, h) => call('GET', u, null, h), post: (u, b, h) => call('POST', u, b, h),
    patch: (u, b, h) => call('PATCH', u, b, h), del: (u, h) => call('DELETE', u, null, h),
    get cookie() { return cookie; },
  };
}

async function register(base, email, name, department_id = 1) {
  const c = client(base);
  const r = await c.post('/api/register', { email, name, password: 'password123', department_id });
  if (r.status !== 201) throw new Error('register failed: ' + JSON.stringify(r.data));
  return c;
}

module.exports = { boot, client, register };
