#!/usr/bin/env node
// Respaldo de la base de datos y los adjuntos. Funciona en Windows, Linux y macOS.
//   node scripts/backup.js [--dest ./backups] [--keep 14]            instalación nativa
//   node scripts/backup.js --docker [--keep 14]                       instalación con Docker (copia en ./data/backups)
// La copia de la base es consistente aunque la aplicación esté en marcha.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const n = process.argv[i + 1];
  if (n === undefined || n.startsWith('--')) args[a.slice(2)] = true; else { args[a.slice(2)] = n; i++; }
}
const keepDays = Number(args.keep) || 14;
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

function prune(dir, prefix) {
  if (!fs.existsSync(dir)) return;
  const limit = Date.now() - keepDays * 86400000;
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f.startsWith(prefix) && fs.statSync(p).mtimeMs < limit) fs.rmSync(p, { recursive: true, force: true });
  }
}

if (args.docker) {
  const code = `
const D=require('better-sqlite3');const fs=require('fs');
fs.mkdirSync('/app/data/backups',{recursive:true});
new D('/app/data/eticket.db',{readonly:true}).backup('/app/data/backups/eticket-${stamp}.db')
  .then(()=>console.log('Respaldo: data/backups/eticket-${stamp}.db')).catch(e=>{console.error(e);process.exit(1)})`;
  const r = spawnSync('docker', ['compose', 'exec', '-T', 'eticket', 'node', '-e', code], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status || 1);
  prune(path.join(ROOT, 'data', 'backups'), 'eticket-');
  console.log('Los adjuntos están en data/uploads. Copia data/backups y data/uploads a otro equipo.');
} else {
  try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* sin .env */ }
  const Database = require('better-sqlite3');
  const dbPath = process.env.DB_PATH || path.join(ROOT, 'data', 'eticket.db');
  const upDir = process.env.UPLOAD_DIR || path.join(ROOT, 'data', 'uploads');
  const dest = path.resolve(args.dest || path.join(ROOT, 'backups'));
  if (!fs.existsSync(dbPath)) { console.error(`No se encontró la base de datos: ${dbPath}`); process.exit(1); }
  fs.mkdirSync(dest, { recursive: true });
  const file = path.join(dest, `eticket-${stamp}.db`);
  new Database(dbPath, { readonly: true }).backup(file).then(() => {
    console.log('Base de datos respaldada en ' + file);
    if (fs.existsSync(upDir)) {
      fs.cpSync(upDir, path.join(dest, 'uploads'), { recursive: true, force: false, errorOnExist: false });
      console.log('Adjuntos copiados en ' + path.join(dest, 'uploads'));
    }
    prune(dest, 'eticket-');
  }).catch((e) => { console.error(e); process.exit(1); });
}
