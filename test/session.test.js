const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const SqliteStore = require('../src/sessionStore');

const call = (fn, ...a) => new Promise((res, rej) => fn(...a, (e, v) => (e ? rej(e) : res(v))));

test('sesiones: persisten al reabrir la base (reinicio) y respetan la expiración', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sess-')), 's.db');
  const store1 = new SqliteStore(new Database(file));
  const future = new Date(Date.now() + 60000);
  await call(store1.set.bind(store1), 'abc', { userId: 7, cookie: { expires: future } });
  await call(store1.set.bind(store1), 'viejo', { userId: 8, cookie: { expires: new Date(Date.now() - 1000) } });

  const store2 = new SqliteStore(new Database(file)); // "reinicio"
  assert.equal((await call(store2.get.bind(store2), 'abc')).userId, 7);
  assert.equal(await call(store2.get.bind(store2), 'viejo'), null);
  await call(store2.destroy.bind(store2), 'abc');
  assert.equal(await call(store2.get.bind(store2), 'abc'), null);
});

test('producción: sin SESSION_SECRET el servidor se niega a arrancar', () => {
  const env = { ...process.env, NODE_ENV: 'production', DB_PATH: path.join(os.tmpdir(), 'x-' + Date.now() + '.db') };
  delete env.SESSION_SECRET;
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'server.js')], { env, encoding: 'utf8', timeout: 10000 });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /SESSION_SECRET/);
});
