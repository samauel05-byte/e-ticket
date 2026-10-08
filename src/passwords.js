// Política de contraseñas para cuentas propias del sistema (con el login por correo, la clave la maneja el servidor de correo).
const bcrypt = require('bcryptjs');

const MIN = Math.max(8, Number(process.env.PASSWORD_MIN) || 10);
const COST = Math.min(14, Math.max(4, Number(process.env.BCRYPT_COST) || 12));
const COMMON = new Set(['password', 'password1', 'password123', 'passw0rd', '123456789', '1234567890', '12345678', '1234567890', 'qwertyuiop', 'qwerty123', 'qwerty12345',
  'contraseña', 'contrasena', 'contraseña1', 'contrasena123', 'admin1234', 'administrador', 'bienvenido', 'bienvenido1', 'letmein123', 'iloveyou1', 'abc123456', 'abcd1234',
  'grupodupla', 'grupodupla1', 'grupodupla123', 'etique123', 'soporte123', 'cambiame123', 'prueba1234', 'welcome123', 'changeme123']);

// Devuelve un mensaje de error en español, o null si la contraseña es aceptable.
function check(password, email = '') {
  const p = String(password || '');
  if (p.length < MIN) return `La contraseña debe tener al menos ${MIN} caracteres`;
  if (p.length > 200) return 'La contraseña es demasiado larga';
  const low = p.toLowerCase();
  if (COMMON.has(low) || /^(.)\1+$/.test(p) || /^(0123456789|1234567890|abcdefghij)/.test(low)) return 'Esa contraseña es muy común: elige otra más difícil de adivinar';
  const local = String(email).split('@')[0].toLowerCase();
  if (local.length >= 4 && low.includes(local)) return 'La contraseña no debe contener tu nombre de usuario';
  return null;
}
const hash = (p) => bcrypt.hashSync(p, COST);

module.exports = { check, hash, MIN, COST };
