const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { boot, client } = require('./_setup');

// Servidor IMAP mínimo: solo acepta ana@empresa.com / secreta123
const imap = net.createServer((s) => {
  s.write('* OK fake IMAP ready\r\n');
  let buf = '';
  s.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const [tag, cmd, ...a] = buf.slice(0, i).split(' '); buf = buf.slice(i + 2);
      const c = (cmd || '').toUpperCase();
      if (c === 'CAPABILITY') s.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
      else if (c === 'LOGIN') {
        const ok = a[0].replace(/"/g, '') === 'ana@empresa.com' && a[1].replace(/"/g, '') === 'secreta123';
        s.write(ok ? `${tag} OK [CAPABILITY IMAP4rev1] logged in\r\n` : `${tag} NO [AUTHENTICATIONFAILED] bad creds\r\n`);
      } else if (c === 'LOGOUT') { s.write(`* BYE\r\n${tag} OK bye\r\n`); s.end(); }
      else s.write(`${tag} OK\r\n`);
    }
  });
});

let ctx;
before(async () => {
  await new Promise((r) => imap.listen(0, '127.0.0.1', r));
  ctx = boot({ IMAP_HOST: '127.0.0.1', IMAP_PORT: String(imap.address().port), IMAP_SECURE: 'false' });
});
after(async () => { await ctx.close(); imap.close(); });

test('IMAP: contraseña incorrecta, dominio ajeno y registro local deshabilitado', async () => {
  const c = client(ctx.base);
  assert.equal((await c.post('/api/login', { email: 'ana@empresa.com', password: 'mala' })).status, 401);
  assert.equal((await c.post('/api/login', { email: 'ana@gmail.com', password: 'secreta123' })).status, 401);
  assert.equal((await c.post('/api/register', { email: 'ana@empresa.com', name: 'A', password: 'Segura-2026-ok', department_id: 1 })).status, 404);
});

test('IMAP: primer acceso pide departamento, crea la cuenta y no guarda la contraseña', async () => {
  const c = client(ctx.base);
  const first = await c.post('/api/login', { email: 'ana@empresa.com', password: 'secreta123' });
  assert.deepEqual(first.data, { needs_department: true });
  assert.equal((await c.get('/api/me')).status, 401);

  assert.equal((await c.post('/api/login', { email: 'ana@empresa.com', password: 'secreta123', department_id: 999 })).status, 400);
  const ok = await c.post('/api/login', { email: 'ana@empresa.com', password: 'secreta123', department_id: 3, name: 'Ana' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.department, 'Finanzas');

  const db = require('../src/db');
  const row = db.prepare("SELECT password_hash FROM users WHERE email = 'ana@empresa.com'").get();
  assert.equal(row.password_hash, '!imap');

  const again = client(ctx.base);
  assert.equal((await again.post('/api/login', { email: 'ana@empresa.com', password: 'secreta123' })).status, 200);
  // la contraseña de IMAP cambió/incorrecta: no entra aunque exista la cuenta
  assert.equal((await client(ctx.base).post('/api/login', { email: 'ana@empresa.com', password: '!imap' })).status, 401);
});
