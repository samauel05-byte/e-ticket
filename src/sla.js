// SLA en horario laboral. Los objetivos son horas HÁBILES, no corridas.
//
// Configuración (variables de entorno):
//   SLA_TZ          zona horaria del horario laboral, p. ej. America/Bogota (por defecto la del servidor)
//   WORK_START/END  "08:00" / "18:00"
//   WORK_DAYS       días laborales, 0=domingo … 6=sábado (por defecto "1,2,3,4,5")
//   SLA_HOLIDAYS    fechas no laborales "2026-12-25,2027-01-01"
//   LUNCH_SHIFTS    '{"A":["12:00","13:00"],"B":["13:00","14:30"]}'
//   SLA_JSON        objetivos por prioridad (horas hábiles) '{"alta":{"response":2,"resolve":6}}'
//
// El reloj NO corre: fuera del horario, fines de semana y festivos; mientras el ticket está
// "en espera", "resuelto" o "cerrado"; ni durante el almuerzo de la persona asignada.

const DEFAULTS = {
  urgente: { response: 1, resolve: 4 },
  alta: { response: 2, resolve: 8 },
  media: { response: 4, resolve: 16 },
  baja: { response: 8, resolve: 32 },
};
const json = (name, fallback) => {
  if (!process.env[name]) return fallback;
  try { return JSON.parse(process.env[name]); } catch { console.error(`${name} inválido, se usa el valor por defecto`); return fallback; }
};
const targets = { ...DEFAULTS, ...json('SLA_JSON', {}) };

const TZ = process.env.SLA_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
const hm = (s, d) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || d)); return m ? [Number(m[1]), Number(m[2])] : hm(d, d); };
const START = hm(process.env.WORK_START, '08:00');
const END = hm(process.env.WORK_END, '18:00');
const WORK_DAYS = new Set(String(process.env.WORK_DAYS || '1,2,3,4,5').split(',').map(Number));
const HOLIDAYS = new Set(String(process.env.SLA_HOLIDAYS || '').split(',').map((s) => s.trim()).filter(Boolean));
const LUNCH_SHIFTS = json('LUNCH_SHIFTS', { A: ['12:00', '13:00'], B: ['13:00', '14:30'] });

const PAUSED = new Set(['en_espera', 'resuelto', 'cerrado']);
const HOUR = 3600 * 1000;
const MIN = 60 * 1000;

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});
function parts(ms) {
  const o = {};
  for (const p of fmt.formatToParts(ms)) o[p.type] = p.value;
  return { y: +o.year, m: +o.month, d: +o.day, H: +o.hour, M: +o.minute, S: +o.second };
}
// Instante UTC (ms) que corresponde a una hora local de la zona SLA_TZ.
function localToMs(y, m, d, H, M) {
  const want = Date.UTC(y, m - 1, d, H, M);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = parts(guess);
    guess += want - Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S);
  }
  return guess;
}
const parse = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z').getTime() : null);

// Ventanas laborales [ini, fin) de un día local, descontando el almuerzo si se indica.
function windows(y, m, d, lunch) {
  const cal = new Date(Date.UTC(y, m - 1, d));
  const key = cal.toISOString().slice(0, 10);
  if (!WORK_DAYS.has(cal.getUTCDay()) || HOLIDAYS.has(key)) return [];
  const ws = localToMs(y, m, d, ...START);
  const we = localToMs(y, m, d, ...END);
  if (!lunch) return [[ws, we]];
  const ls = Math.max(ws, localToMs(y, m, d, ...hm(lunch[0], '12:00')));
  const le = Math.min(we, localToMs(y, m, d, ...hm(lunch[1], '13:00')));
  return le > ls ? [[ws, ls], [le, we]] : [[ws, we]];
}
function* days(fromMs) {
  const p = parts(fromMs);
  for (let i = 0; i < 4000; i++) {
    const c = new Date(Date.UTC(p.y, p.m - 1, p.d + i));
    yield [c.getUTCFullYear(), c.getUTCMonth() + 1, c.getUTCDate()];
  }
}
const lunchOf = (shift) => (shift && LUNCH_SHIFTS[shift]) || null;

// Milisegundos laborales entre a y b.
function workMs(a, b, lunch) {
  if (!(b > a)) return 0;
  let total = 0;
  for (const [y, m, d] of days(a)) {
    const ws = windows(y, m, d, lunch);
    if (ws.length && ws[0][0] >= b) break;
    if (!ws.length && localToMs(y, m, d, 0, 0) >= b) break;
    for (const [s, e] of ws) {
      const lo = Math.max(s, a), hi = Math.min(e, b);
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}
// Instante en que se habrán acumulado `ms` milisegundos laborales a partir de `from`.
function addWorkMs(from, ms, lunch) {
  let left = ms;
  for (const [y, m, d] of days(from)) {
    for (const [s, e] of windows(y, m, d, lunch)) {
      const lo = Math.max(s, from);
      if (lo >= e) continue;
      if (left <= e - lo) return lo + left;
      left -= e - lo;
    }
  }
  return null;
}

// Tiempo laboral consumido por el ticket hasta endMs, según su historial de estado/responsable.
function usedMs(t, events, lunchFor, endMs) {
  const created = parse(t.created_at);
  const ev = (events && events.length ? events : [{ at: t.created_at, status: t.status, assignee_id: t.assignee_id }])
    .map((e) => ({ ...e, ms: Math.max(parse(e.at), created) }));
  let total = 0;
  for (let i = 0; i < ev.length; i++) {
    const s = ev[i].ms;
    const e = Math.min(i + 1 < ev.length ? ev[i + 1].ms : endMs, endMs);
    if (e <= s || PAUSED.has(ev[i].status)) continue;
    total += workMs(s, e, lunchOf(lunchFor(ev[i].assignee_id)));
  }
  return total;
}

// Agrega al ticket métricas de SLA. opts: { events, lunchFor(userId)->turno, now }
function withSla(t, opts = {}) {
  const now = opts.now ?? Date.now();
  const events = opts.events || [];
  const lunchFor = opts.lunchFor || (() => null);
  const tg = targets[t.priority] || DEFAULTS.media;
  const resp = parse(t.first_response_at);
  const res = parse(t.resolved_at);
  const respUsed = usedMs(t, events, lunchFor, resp ?? now);
  const resUsed = usedMs(t, events, lunchFor, res ?? now);

  const lunch = lunchOf(lunchFor(t.assignee_id));
  const due = (done, used, target) => {
    if (done || PAUSED.has(t.status)) return null;
    const left = target * HOUR - used;
    if (left <= 0) return null;
    const at = addWorkMs(now, left, lunch);
    return at == null ? null : new Date(at).toISOString();
  };
  return {
    ...t,
    sla_response_target_h: tg.response,
    sla_resolve_target_h: tg.resolve,
    sla_response_due: due(resp, respUsed, tg.response),
    sla_resolve_due: due(res, resUsed, tg.resolve),
    sla_paused: !res && PAUSED.has(t.status),
    sla_response_breached: respUsed > tg.response * HOUR,
    sla_resolve_breached: resUsed > tg.resolve * HOUR,
    response_hours: resp ? respUsed / HOUR : null,
    resolve_hours: res ? resUsed / HOUR : null,
  };
}

module.exports = { withSla, targets, workMs, addWorkMs, localToMs, config: { TZ, START, END, WORK_DAYS: [...WORK_DAYS], LUNCH_SHIFTS } };
