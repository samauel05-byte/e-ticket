const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { boot, client } = require('./_setup');

// IMAP lento (300 ms por LOGIN) para comprobar el tope de conexiones simultáneas
let active = 0, peak = 0;
const imap = net.createServer((s) => {
  s.write('* OK slow IMAP\r\n');
  let buf = '';
  s.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const [tag, cmd] = buf.slice(0, i).split(' '); buf = buf.slice(i + 2);
      const c = (cmd || '').toUpperCase();
      if (c === 'CAPABILITY') s.write(`* CAPABILITY IMAP4rev1\r\n${tag} OK done\r\n`);
      else if (c === 'LOGIN') { active++; peak = Math.max(peak, active); setTimeout(() => { active--; s.write(`${tag} NO [AUTHENTICATIONFAILED] bad\r\n`); }, 300); }
      else if (c === 'LOGOUT') { s.write(`* BYE\r\n${tag} OK bye\r\n`); s.end(); }
      else s.write(`${tag} OK\r\n`);
    }
  });
});

let ctx;
before(async () => {
  await new Promise((r) => imap.listen(0, '127.0.0.1', r));
  ctx = boot({ IMAP_HOST: '127.0.0.1', IMAP_PORT: String(imap.address().port), IMAP_SECURE: 'false', IMAP_MAX_CONCURRENT: '2', LOGIN_MAX_PER_IP: '1000' });
});
after(async () => { await ctx.close(); imap.close(); });

test('IMAP: máximo de comprobaciones simultáneas; el excedente recibe 503 y el servidor IMAP no se satura', async () => {
  const results = await Promise.all([1, 2, 3, 4, 5, 6].map((i) =>
    client(ctx.base).post('/api/login', { email: `u${i}@empresa.com`, password: 'x' })));
  const codes = results.map((r) => r.status);
  assert.ok(codes.includes(503), 'alguna petición debe rechazarse por exceso de carga: ' + codes);
  assert.ok(codes.includes(401), 'las aceptadas se validan contra IMAP: ' + codes);
  assert.ok(peak <= 2, `pico de conexiones simultáneas al IMAP: ${peak}`);
});
