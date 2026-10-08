// Lista de comprobaciones de seguridad de la configuración. La usan el arranque, `npm run security:check` y Administración → Seguridad.
const fs = require('fs');

const weakSecret = (s) => !s || String(s).length < 16 || /cambia|ejemplo|secret|changeme|password|12345/i.test(String(s));
const isOff = (v) => String(v).toLowerCase() === 'false';

// env: process.env (o equivalente). opts.envFile: ruta del .env para revisar permisos.
function run(env = process.env, opts = {}) {
  const out = [];
  const add = (level, id, msg, fix) => out.push({ level, id, msg, fix: fix || null });
  const prod = env.NODE_ENV === 'production';

  if (weakSecret(env.SESSION_SECRET)) add('bad', 'secret', 'SESSION_SECRET es débil, está vacío o es el valor de ejemplo.', 'Genera uno nuevo: openssl rand -hex 32 (y ponlo en .env).');
  else add('ok', 'secret', 'SESSION_SECRET es largo y no es el de ejemplo.');

  if (env.COOKIE_SECURE === 'true') add('ok', 'https', 'Cookie segura y HSTS activos (HTTPS).');
  else add(prod ? 'bad' : 'warn', 'https', 'Sin COOKIE_SECURE=true: la sesión viaja sin la marca Secure y no se activa HSTS.', 'Usa HTTPS (Caddy) y pon COOKIE_SECURE=true y TRUST_PROXY=true.');

  if (!env.ADMIN_EMAIL) add('warn', 'admin', 'ADMIN_EMAIL no está definido: nadie queda como administrador al registrarse.', 'Pon el correo del administrador en ADMIN_EMAIL.');
  else add('ok', 'admin', 'Hay un administrador definido (ADMIN_EMAIL).');

  if (!env.ALLOWED_DOMAIN || /empresa\.com/i.test(env.ALLOWED_DOMAIN)) add('warn', 'domain', 'ALLOWED_DOMAIN no está configurado con el dominio de la empresa.', 'Pon ALLOWED_DOMAIN=grupodupla.com.');
  else add('ok', 'domain', `Solo se aceptan correos @${String(env.ALLOWED_DOMAIN).replace(/^@/, '')}.`);

  const tlsOff = ['IMAP_TLS_REJECT_UNAUTHORIZED', 'INBOX_TLS_REJECT_UNAUTHORIZED', 'SMTP_TLS_REJECT_UNAUTHORIZED'].filter((k) => isOff(env[k]));
  if (tlsOff.length) add('warn', 'tls', `Se desactivó la validación del certificado del correo (${tlsOff.join(', ')}).`, 'Úsalo solo en red interna; lo correcto es un certificado válido.');
  else add('ok', 'tls', 'Se valida el certificado de los servidores de correo.');
  if (isOff(env.IMAP_SECURE) || isOff(env.INBOX_SECURE)) add('warn', 'imap-plain', 'El IMAP se conecta sin cifrado directo (SECURE=false): las contraseñas viajarían sin proteger si el servidor no ofrece STARTTLS.', 'Usa el puerto 993 con SSL.');

  if (!env.IMAP_HOST) add('warn', 'login', 'El inicio de sesión usa contraseñas propias del sistema (no la del correo).', 'Configura IMAP_HOST para validar contra el correo de la empresa.');
  else add('ok', 'login', 'El inicio de sesión se valida contra el servidor de correo.');

  if (String(env.REQUIRE_2FA_ROLES || '').trim()) add('ok', '2fa', `Verificación en dos pasos obligatoria para: ${env.REQUIRE_2FA_ROLES}.`);
  else add('warn', '2fa', 'La verificación en dos pasos es opcional para todos.', 'Pon REQUIRE_2FA_ROLES=admin,coordinator para exigirla a administradores y encargados.');

  if (!String(env.INTERNAL_CIDRS || '').trim()) add('warn', 'internal', 'Administración, Reportes y Dashboard se pueden abrir desde cualquier red (si el sistema está en Internet).', 'Si lo publicas en Internet, pon INTERNAL_CIDRS="192.168.0.0/16,10.0.0.0/8" (tu red interna).');
  else add('ok', 'internal', 'Administración, Reportes y Dashboard solo desde la red interna.');

  if (opts.envFile && process.platform !== 'win32') {
    try {
      const mode = fs.statSync(opts.envFile).mode & 0o077;
      if (mode) add('bad', 'envperm', 'El archivo .env se puede leer por otros usuarios del equipo.', `chmod 600 ${opts.envFile}`);
      else add('ok', 'envperm', 'El archivo .env solo lo lee su dueño.');
    } catch { /* sin .env */ }
  }
  return out;
}

const summary = (list) => ({ bad: list.filter((c) => c.level === 'bad').length, warn: list.filter((c) => c.level === 'warn').length, ok: list.filter((c) => c.level === 'ok').length });
module.exports = { run, summary, weakSecret };
