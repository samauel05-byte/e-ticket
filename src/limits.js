// Límites de uso en memoria (ventana deslizante) contra abuso e inundación. Se reinician al reiniciar el servidor,
// a diferencia del límite de intentos de login, que es persistente (rateLimit.js).
const buckets = new Map(); // clave -> [timestamps]

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
const LIMITS = {
  api:      { max: num(process.env.LIMIT_API_PER_MIN, 600), windowMs: 60 * 1000 },          // por IP, todas las peticiones /api
  register: { max: num(process.env.LIMIT_REGISTER_PER_HOUR, 10), windowMs: 3600 * 1000 },   // por IP
  ticket:   { max: num(process.env.LIMIT_TICKETS_PER_HOUR, 30), windowMs: 3600 * 1000 },    // por usuario
  comment:  { max: num(process.env.LIMIT_COMMENTS_PER_HOUR, 120), windowMs: 3600 * 1000 },  // por usuario
  upload:   { max: num(process.env.LIMIT_UPLOADS_PER_HOUR, 60), windowMs: 3600 * 1000 },    // por usuario
};

// Devuelve 0 si se permite (y cuenta la petición) o los segundos que faltan para poder reintentar.
function hit(kind, who, now = Date.now()) {
  const { max, windowMs } = LIMITS[kind];
  const key = kind + ':' + who;
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= max) { buckets.set(key, arr); return Math.max(1, Math.ceil((arr[0] + windowMs - now) / 1000)); }
  arr.push(now); buckets.set(key, arr);
  return 0;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of buckets) if (!v.length || now - v[v.length - 1] > 3600 * 1000) buckets.delete(k); }, 10 * 60 * 1000).unref();

// Middleware: kind = clave de LIMITS; by = 'ip' o 'user'
const middleware = (kind, by = 'ip') => (req, res, next) => {
  const who = by === 'user' ? req.user?.id ?? req.ip : req.ip;
  const wait = hit(kind, who);
  if (!wait) return next();
  res.set('Retry-After', String(wait));
  res.status(429).json({ error: `Demasiadas solicitudes. Intenta de nuevo en ${wait < 90 ? wait + ' s' : Math.ceil(wait / 60) + ' min'}.` });
};

module.exports = { hit, middleware, LIMITS, _reset: () => buckets.clear() };
