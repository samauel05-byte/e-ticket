const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

test('npm run demo: arranca solo con Node, siembra datos y permite entrar', async () => {
  const port = 3300 + Math.floor(Math.random() * 500);
  // La demostración usa data/demo; se limpia al empezar (--reset) y al terminar
  const mailPort = port + 1000;
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'demo.js'), '--reset', '--port', String(port), '--mail-port', String(mailPort)],
    { env: { ...process.env, SLA_TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  try {
    const base = `http://127.0.0.1:${port}`;
    let ok = false;
    for (let i = 0; i < 60 && !ok; i++) {
      try { ok = (await fetch(base + '/healthz')).ok; } catch { await new Promise((r) => setTimeout(r, 250)); }
    }
    assert.ok(ok, 'el servidor de la demostración no arrancó:\n' + out);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tecnico@empresa.com', password: 'prueba1234' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const tickets = await (await fetch(base + '/api/tickets', { headers: { cookie } })).json();
    assert.ok(tickets.length >= 8, 'deben existir los tickets de ejemplo');

    // Tickets por correo: se entrega un correo a la bandeja simulada y aparece como ticket
    const { buildMail } = require('../scripts/fakeMailbox');
    const mail = buildMail({ from: 'ana@empresa.com', subject: 'Impresora sin tóner (prueba de la demo)', text: 'Se me traba la impresora.' });
    const sent = await fetch(`http://127.0.0.1:${mailPort}/deliver`, { method: 'POST', body: mail });
    assert.equal(sent.status, 200);
    let creado = null;
    for (let i = 0; i < 40 && !creado; i++) {
      const lista = await (await fetch(base + '/api/tickets', { headers: { cookie } })).json();
      creado = lista.find((t) => t.title === 'Impresora sin tóner (prueba de la demo)');
      if (!creado) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(creado, 'el correo debe convertirse en ticket:\n' + out);
    assert.equal(creado.source, 'email');
    assert.equal(creado.category, 'Impresoras');
  } finally {
    child.kill();
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(path.join(__dirname, '..', 'data', 'demo'), { recursive: true, force: true });
  }
});

test('la siembra se niega a correr sin DEMO_SEED', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, [path.join(__dirname, '..', 'src', 'seedDemo.js')],
    { env: { ...process.env, DEMO_SEED: 'false', DB_PATH: path.join(os.tmpdir(), 'no-debe-crearse.db') }, encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /DEMO_SEED/);
  assert.equal(fs.existsSync(path.join(os.tmpdir(), 'no-debe-crearse.db')), false);
});
