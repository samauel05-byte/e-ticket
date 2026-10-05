// Restricción opcional por red: INTERNAL_CIDRS="192.168.0.0/16,10.0.0.0/8,203.0.113.7"
// Solo IPv4 (también reconoce direcciones IPv4 mapeadas ::ffff:a.b.c.d).
const toInt = (ip) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m || m.slice(1).some((x) => Number(x) > 255)) return null;
  return ((Number(m[1]) << 24) | (Number(m[2]) << 16) | (Number(m[3]) << 8) | Number(m[4])) >>> 0;
};
function parse(list) {
  return String(list || '').split(',').map((s) => s.trim()).filter(Boolean).map((c) => {
    const [ip, bits = '32'] = c.split('/');
    const base = toInt(ip), b = Number(bits);
    if (base == null || !(b >= 0 && b <= 32)) throw new Error(`INTERNAL_CIDRS inválido: ${c}`);
    const mask = b === 0 ? 0 : (0xffffffff << (32 - b)) >>> 0;
    return { net: (base & mask) >>> 0, mask };
  });
}
function allowed(rules, rawIp) {
  const ip = toInt(String(rawIp || '').replace(/^::ffff:/, ''));
  return ip != null && rules.some((r) => ((ip & r.mask) >>> 0) === r.net);
}
module.exports = { parse, allowed };
