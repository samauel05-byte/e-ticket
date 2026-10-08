#!/usr/bin/env node
// Revisa la configuración de seguridad del .env actual.   npm run security:check
const path = require('path');
const { loadEnv, describe } = require('../src/loadEnv');
const sc = require('../src/securityCheck');

const st = loadEnv();
console.log('ETIQUE · revisión de seguridad\n' + describe(st) + '\n');
const list = sc.run(process.env, { envFile: st.file });
const icon = { ok: '  ✔', warn: '  ⚠', bad: '  ✘' };
for (const c of list) { console.log(`${icon[c.level]} ${c.msg}`); if (c.fix && c.level !== 'ok') console.log(`      → ${c.fix}`); }
const s = sc.summary(list);
console.log(`\n${s.ok} bien · ${s.warn} por mejorar · ${s.bad} crítico(s)`);
process.exit(s.bad ? 1 : 0);
