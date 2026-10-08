const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { boot, register } = require('./_setup');

let ctx, admin, ana;
before(async () => {
  ctx = boot({ REQUIRE_2FA_ROLES: 'admin' });
  admin = await register(ctx.base, 'admin@empresa.com', 'Admin', 1);
  ana = await register(ctx.base, 'ana@empresa.com', 'Ana', 3);
});
after(() => ctx.close());

test('REQUIRE_2FA_ROLES: el administrador sin 2FA solo puede activarla; después trabaja normal y no puede quitarla', async () => {
  const me = (await admin.get('/api/me')).data;
  assert.equal(me.must_2fa, true);
  assert.equal((await admin.get('/api/tickets')).status, 403);
  assert.equal((await admin.get('/api/admin/users')).data?.code ?? (await admin.get('/api/admin/users')).data.code, '2fa_required');
  const { codeAt } = require('../src/totp');
  const setup = (await admin.post('/api/me/2fa/setup', {})).data;
  assert.equal((await admin.post('/api/me/2fa/enable', { code: codeAt(setup.secret, Math.floor(Date.now() / 30000)) })).status, 200);
  assert.equal((await admin.get('/api/tickets')).status, 200);
  assert.equal((await admin.get('/api/me')).data.must_2fa, false);
  assert.equal((await admin.post('/api/me/2fa/disable', { code: '123456' })).status, 403);
  assert.equal((await ana.get('/api/tickets')).status, 200); // los demás roles no se ven afectados
});
