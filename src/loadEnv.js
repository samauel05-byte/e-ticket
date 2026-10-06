// Carga el archivo .env y dice claramente qué pasó (dónde lo buscó, cuántas variables leyó o por qué no pudo).
// Tolera archivos guardados con BOM o en UTF-16 (el Bloc de notas y PowerShell los generan a veces).
// No pisa las variables que ya estén definidas en el entorno.
const fs = require('fs');
const path = require('path');
const util = require('util');

function decode(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xfe && buf[1] === 0xff) return Buffer.from(buf.subarray(2)).swap16().toString('utf16le');
  return buf.toString('utf8').replace(/^﻿/, '');
}

function loadEnv(file = process.env.ENV_FILE || path.join(__dirname, '..', '.env')) {
  const res = { file, loaded: false, count: 0, error: null, hint: null };
  let buf;
  try { buf = fs.readFileSync(file); }
  catch (e) {
    res.error = e.code === 'ENOENT' ? 'no existe' : `no se pudo leer (${e.code || e.message})`;
    // ¿está con otro nombre? (Windows oculta extensiones: .env.txt, .env.env, grupodupla.env…)
    try {
      const dir = path.dirname(file);
      const near = fs.readdirSync(dir).filter((n) => n !== path.basename(file) && /(^\.env|\.env$|\.env\.)/i.test(n) && !/\.example$|\.sample$/i.test(n));
      if (near.length) res.hint = `En esa carpeta hay "${near.join('", "')}": renómbralo exactamente a ".env" (sin .txt).`;
    } catch { /* */ }
    return res;
  }
  let vars;
  try { vars = util.parseEnv(decode(buf)); }
  catch (e) { res.error = `no se pudo interpretar (${e.message})`; return res; }
  for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
  res.loaded = true; res.count = Object.keys(vars).length;
  if (!res.count) res.hint = 'El archivo está vacío o sin líneas CLAVE=valor.';
  return res;
}

const describe = (r) => (r.loaded
  ? `Configuración (.env): ${r.count} variable(s) leídas de ${r.file}${r.hint ? ' — ' + r.hint : ''}`
  : `AVISO: no se pudo usar el archivo .env (${r.error}). Se buscó en: ${r.file}${r.hint ? ' — ' + r.hint : ''}`);

module.exports = { loadEnv, describe };
