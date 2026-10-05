#!/usr/bin/env node
// Asistente de instalación. Funciona igual en Windows, Linux y macOS (solo necesita Node 22+).
//   node scripts/setup.js                  asistente interactivo
//   node scripts/setup.js --yes --mode docker --domain empresa.com --admin ti@empresa.com ...
// Crea el archivo .env (con un SESSION_SECRET aleatorio) y las carpetas de datos.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline/promises');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (!a.startsWith('--')) continue;
  const k = a.slice(2);
  const next = process.argv[i + 1];
  if (next === undefined || next.startsWith('--')) args[k] = true;
  else { args[k] = next; i++; }
}
const yes = Boolean(args.yes);
const envFile = path.resolve(args.out || path.join(ROOT, '.env'));
const tzDefault = Intl.DateTimeFormat().resolvedOptions().timeZone;

async function main() {
  console.log('\nE-Ticket TI · asistente de instalación\n');
  if (fs.existsSync(envFile) && !args.force) {
    if (yes) { console.error(`Ya existe ${envFile}. Usa --force para sobrescribirlo.`); process.exit(1); }
    const rl0 = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ans = (await rl0.question(`Ya existe ${envFile}. ¿Sobrescribirlo? (s/N) `)).trim().toLowerCase();
    rl0.close();
    if (ans !== 's' && ans !== 'si' && ans !== 'sí') { console.log('No se cambió nada.'); return; }
  }

  const rl = yes ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = async (flag, question, def = '') => {
    if (args[flag] !== undefined && args[flag] !== true) return String(args[flag]);
    if (yes) return def;
    const a = (await rl.question(`${question}${def ? ` [${def}]` : ''}: `)).trim();
    return a || def;
  };
  const yesNo = async (flag, question, def) => {
    if (args[flag] !== undefined) return args[flag] === true || /^(1|true|s|si|sí|y|yes)$/i.test(String(args[flag]));
    if (yes) return def;
    const a = (await rl.question(`${question} (${def ? 'S/n' : 's/N'}): `)).trim().toLowerCase();
    return a ? ['s', 'si', 'sí', 'y', 'yes'].includes(a) : def;
  };

  const mode = (await ask('mode', 'Modo de instalación: "docker" (con HTTPS automático) o "native" (solo Node)', 'docker')).toLowerCase();
  if (!['docker', 'native'].includes(mode)) throw new Error('El modo debe ser docker o native');

  const v = {};
  v.ALLOWED_DOMAIN = (await ask('domain', 'Dominio de los correos de la empresa (sin @)', 'empresa.com')).replace(/^@/, '');
  v.ADMIN_EMAIL = await ask('admin', 'Correo del primer administrador', `admin@${v.ALLOWED_DOMAIN}`);
  v.SLA_TZ = await ask('tz', 'Zona horaria de la oficina (para el SLA)', tzDefault);

  console.log('\nInicio de sesión con la clave del correo (IMAP). Déjalo vacío para usar registro local.');
  v.IMAP_HOST = await ask('imap-host', 'Servidor IMAP (host)', '');
  if (v.IMAP_HOST) {
    v.IMAP_PORT = await ask('imap-port', 'Puerto IMAP', '993');
    v.IMAP_SECURE = v.IMAP_PORT === '993' ? 'true' : 'false';
  }
  console.log('\nAvisos por correo (SMTP). Déjalo vacío para no enviar avisos.');
  v.SMTP_HOST = await ask('smtp-host', 'Servidor SMTP (host)', '');
  if (v.SMTP_HOST) {
    v.SMTP_PORT = await ask('smtp-port', 'Puerto SMTP', '587');
    v.SMTP_SECURE = v.SMTP_PORT === '465' ? 'true' : 'false';
    v.SMTP_USER = await ask('smtp-user', 'Usuario SMTP', '');
    if (v.SMTP_USER) v.SMTP_PASS = await ask('smtp-pass', 'Contraseña SMTP', '');
    v.SMTP_FROM = await ask('smtp-from', 'Remitente de los avisos', `E-Ticket TI <${v.SMTP_USER || 'ti@' + v.ALLOWED_DOMAIN}>`);
  }

  console.log('\nTickets por correo: bandeja de soporte (IMAP). Los correos que lleguen ahí se convierten en tickets.');
  console.log('Déjalo vacío para desactivarlo. La contraseña se guarda solo en el archivo .env de este servidor.');
  v.INBOX_HOST = await ask('inbox-host', 'Servidor IMAP de la bandeja de soporte (host)', '');
  if (v.INBOX_HOST) {
    v.INBOX_PORT = await ask('inbox-port', 'Puerto IMAP', '993');
    v.INBOX_SECURE = v.INBOX_PORT === '993' ? 'true' : 'false';
    v.INBOX_USER = await ask('inbox-user', 'Correo de la bandeja de soporte (usuario)', `soporte@${v.ALLOWED_DOMAIN}`);
    v.INBOX_PASS = await ask('inbox-pass', 'Contraseña de esa bandeja', '');
  }

  const lines = [];
  // Valores con caracteres especiales se escriben entre comillas SIMPLES (literales para Node y para Docker Compose).
  // Si el valor trae comilla simple Y otros caracteres especiales no hay forma segura de escribirlo.
  const fmt = (key, val) => {
    if (!/[#"'\\$`]|^\s|\s$/.test(val)) return val;
    if (!val.includes("'")) return `'${val}'`;
    if (!/["\\$`#]|^\s|\s$/.test(val)) return `"${val}"`;
    throw new Error(`El valor de ${key} mezcla comillas y otros símbolos que no se pueden guardar en .env. Cámbialo o edita el archivo a mano.`);
  };
  const out = (k, val) => lines.push(`${k}=${fmt(k, String(val))}`);
  if (mode === 'docker') {
    const site = await ask('site', 'Nombre con el que se abrirá el sistema (p. ej. tickets.empresa.com)', 'localhost');
    const tlsDefault = site === 'localhost' || /\.(local|lan|internal)$/.test(site) ? 'internal' : '';
    const tls = await ask('tls', 'Certificado HTTPS: "internal" (autoridad propia), "/certs/cert.pem /certs/key.pem" o un correo para Let\'s Encrypt', tlsDefault || 'internal');
    v.SITE_ADDRESS = site; v.CADDY_TLS = tls; v.APP_URL = `https://${site}`;
    v.COOKIE_SECURE = 'true'; v.TRUST_PROXY = 'true';
  } else {
    const https = await yesNo('https', '¿Va detrás de un proxy con HTTPS?', false);
    const url = await ask('url', 'Dirección con la que se abrirá el sistema', https ? 'https://tickets.empresa.com' : 'http://localhost:3000');
    v.PORT = await ask('port', 'Puerto', '3000');
    v.APP_URL = url;
    v.COOKIE_SECURE = https ? 'true' : 'false';
    if (https) v.TRUST_PROXY = 'true';
  }
  if (rl) rl.close();

  lines.push('# Generado por scripts/setup.js — edítalo con cuidado; contiene secretos.');
  out('SESSION_SECRET', crypto.randomBytes(32).toString('hex'));
  for (const [k, val] of Object.entries(v)) if (val !== '' && val !== undefined) out(k, val);
  out('NODE_ENV', 'production');

  fs.writeFileSync(envFile, lines.join('\n') + '\n', { mode: 0o600 });
  console.log(`\nCreado ${envFile}`);

  // Carpetas de datos
  const dataDir = path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });
  if (mode === 'docker') {
    fs.mkdirSync(path.join(ROOT, 'certs'), { recursive: true });
    // En Linux el contenedor corre como el usuario "node" (uid 1000) y debe poder escribir en ./data
    if (process.platform === 'linux') {
      try { fs.chownSync(dataDir, 1000, 1000); }
      catch { spawnSync('sudo', ['chown', '-R', '1000:1000', dataDir], { stdio: 'inherit' }); }
    }
  }

  console.log(mode === 'docker'
    ? '\nSiguiente paso:\n  docker compose up -d --build\nLuego abre ' + v.APP_URL
    : '\nSiguiente paso:\n  npm ci --omit=dev   (si aún no lo hiciste)\n  npm start\nLuego abre ' + v.APP_URL);
}

main().catch((e) => { console.error('\nError: ' + e.message); process.exit(1); });
