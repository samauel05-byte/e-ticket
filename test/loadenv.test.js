const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadEnv, describe } = require('../src/loadEnv');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));

test('lee un .env normal, con comillas y sin pisar variables ya definidas', () => {
  const f = path.join(tmp(), '.env');
  fs.writeFileSync(f, "TEST_ENV_A=uno\nTEST_ENV_B='con # almohadilla'\nTEST_ENV_KEEP=nuevo\n");
  process.env.TEST_ENV_KEEP = 'original';
  const r = loadEnv(f);
  assert.equal(r.loaded, true); assert.equal(r.count, 3);
  assert.equal(process.env.TEST_ENV_A, 'uno'); assert.equal(process.env.TEST_ENV_B, 'con # almohadilla');
  assert.equal(process.env.TEST_ENV_KEEP, 'original');
});

test('tolera BOM UTF-8 y archivos UTF-16 (Bloc de notas / PowerShell)', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, 'bom.env'), '﻿TEST_ENV_BOM=ok\n');
  assert.equal(loadEnv(path.join(d, 'bom.env')).count, 1); assert.equal(process.env.TEST_ENV_BOM, 'ok');
  fs.writeFileSync(path.join(d, 'u16.env'), Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('TEST_ENV_U16=ok\r\nTEST_ENV_U16B=dos\r\n', 'utf16le')]));
  assert.equal(loadEnv(path.join(d, 'u16.env')).count, 2); assert.equal(process.env.TEST_ENV_U16, 'ok');
});

test('si no existe, explica dónde buscó y sugiere el archivo con otro nombre', () => {
  const d = tmp();
  fs.writeFileSync(path.join(d, '.env.txt'), 'X=1\n');
  const r = loadEnv(path.join(d, '.env'));
  assert.equal(r.loaded, false); assert.equal(r.error, 'no existe');
  assert.match(r.hint, /\.env\.txt/);
  assert.match(describe(r), /no se pudo usar el archivo \.env/);
  assert.match(describe(r), new RegExp(d.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')));
});
