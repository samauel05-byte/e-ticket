// Objetivos de tiempo (horas corridas, no laborales) por prioridad.
// Se pueden cambiar con SLA_JSON='{"urgente":{"response":1,"resolve":4},...}'
const DEFAULTS = {
  urgente: { response: 1, resolve: 4 },
  alta: { response: 4, resolve: 8 },
  media: { response: 8, resolve: 24 },
  baja: { response: 24, resolve: 72 },
};
let targets = DEFAULTS;
try { if (process.env.SLA_JSON) targets = { ...DEFAULTS, ...JSON.parse(process.env.SLA_JSON) }; }
catch { console.error('SLA_JSON inválido, se usan los valores por defecto'); }

const parse = (s) => (s ? new Date(String(s).replace(' ', 'T') + 'Z').getTime() : null);
const HOUR = 3600 * 1000;

// Agrega al ticket las fechas límite y si están vencidas.
function withSla(t, now = Date.now()) {
  const tg = targets[t.priority] || DEFAULTS.media;
  const created = parse(t.created_at);
  const respDue = created + tg.response * HOUR;
  const resDue = created + tg.resolve * HOUR;
  const resp = parse(t.first_response_at);
  const res = parse(t.resolved_at);
  return {
    ...t,
    sla_response_due: new Date(respDue).toISOString(),
    sla_resolve_due: new Date(resDue).toISOString(),
    sla_response_breached: (resp ?? now) > respDue,
    sla_resolve_breached: (res ?? now) > resDue,
    response_hours: resp ? (resp - created) / HOUR : null,
    resolve_hours: res ? (res - created) / HOUR : null,
  };
}

module.exports = { withSla, targets };
