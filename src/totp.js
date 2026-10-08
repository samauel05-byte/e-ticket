// Verificación en dos pasos (TOTP, RFC 6238) compatible con Google/Microsoft Authenticator, Authy, etc.
const crypto = require('crypto');

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP = 30;

function base32(buf) {
  let bits = 0, value = 0, out = '';
  for (const b of buf) { value = (value << 8) | b; bits += 8; while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
function fromBase32(s) {
  let bits = 0, value = 0; const out = [];
  for (const c of String(s).toUpperCase().replace(/=+$/, '')) {
    const i = B32.indexOf(c); if (i < 0) continue;
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}
const newSecret = () => base32(crypto.randomBytes(20));

function codeAt(secret, counter) {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', fromBase32(secret)).update(c).digest();
  const o = h[h.length - 1] & 15;
  const n = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1000000).padStart(6, '0');
}

// Devuelve el contador (paso de 30 s) que coincide, o null. Acepta ±1 paso por diferencias de reloj.
function verify(secret, code, now = Date.now()) {
  const c = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return null;
  const counter = Math.floor(now / 1000 / STEP);
  for (const d of [0, -1, 1]) {
    const expect = Buffer.from(codeAt(secret, counter + d));
    if (crypto.timingSafeEqual(expect, Buffer.from(c))) return counter + d;
  }
  return null;
}
const uri = (secret, account, issuer = 'ETIQUE') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP}`;

// Códigos de recuperación de un solo uso (por si se pierde el teléfono)
const newRecoveryCodes = (n = 8) => Array.from({ length: n }, () => {
  const h = crypto.randomBytes(5).toString('hex'); return `${h.slice(0, 5)}-${h.slice(5)}`;
});
const hashCode = (c) => crypto.createHash('sha256').update(String(c).toLowerCase().replace(/[^a-z0-9]/g, '')).digest('hex');

module.exports = { newSecret, verify, codeAt, uri, newRecoveryCodes, hashCode, STEP };
