// Avisos por correo cuando un ticket está por incumplir el SLA (80 % del tiempo) y cuando ya lo incumplió.
// Un aviso por ticket y tipo. Va al responsable (o a todo TI si nadie lo tomó), al encargado y a NOTIFY_NEW_TO.
const db = require('./db');
const mailer = require('./mailer');
const T = require('./tickets');

const WARN_PCT = Number(process.env.SLA_WARN_PCT) || 80;
const kinds = [
  ['response', 'sla_response_used_pct', 'primera respuesta'],
  ['resolve', 'sla_resolve_used_pct', 'resolución'],
];

function recipients(ticket) {
  const extra = String(process.env.NOTIFY_NEW_TO || '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e));
  const coord = db.prepare("SELECT email FROM users WHERE role = 'coordinator' AND active = 1").all().map((r) => r.email);
  const a = ticket.assignee_id ? T.getUser(ticket.assignee_id) : null;
  const main = a?.active ? [a.email] : T.staffEmails(0);
  return [...new Set([...main, ...coord, ...extra])];
}

// withSla: función que agrega las métricas de SLA a un ticket. Devuelve cuántos avisos envió.
function check(withSla, { now = Date.now(), notify = mailer.notify, force = false } = {}) {
  if (!force && !mailer.enabled()) return 0; // sin SMTP no se marca nada: al activarlo se avisará lo que siga pendiente
  const silent = !db.prepare("SELECT 1 FROM sla_alerts WHERE ticket_id = 0 AND kind = 'init'").get(); // primera vez: solo se registra lo que ya estaba vencido
  const has = db.prepare('SELECT 1 FROM sla_alerts WHERE ticket_id = ? AND kind = ?');
  const put = db.prepare('INSERT OR IGNORE INTO sla_alerts (ticket_id, kind) VALUES (?, ?)');
  const events = db.prepare('SELECT at, status, assignee_id FROM ticket_events WHERE ticket_id = ? ORDER BY id');
  const lunch = db.prepare('SELECT lunch_shift FROM users WHERE id = ?');
  const open = db.prepare("SELECT * FROM tickets WHERE status IN ('abierto','en_progreso')").all();
  let sent = 0;
  for (const row of open) {
    const t = withSla(row, { now, events: events.all(row.id), lunchFor: (id) => (id ? lunch.get(id)?.lunch_shift : null) });
    const full = T.getTicket(row.id);
    for (const [key, field, label] of kinds) {
      const pct = t[field];
      if (pct == null) continue;
      const level = pct >= 100 ? 'breach' : pct >= WARN_PCT ? 'warn' : null;
      if (!level) continue;
      const kind = `${key}_${level}`;
      if (has.get(row.id, kind)) continue;
      put.run(row.id, kind);
      if (level === 'breach') put.run(row.id, `${key}_warn`); // si ya venció, no tiene sentido avisar "por vencer" después
      if (silent) continue;
      const who = recipients(row);
      if (!who.length) continue;
      notify(who, level === 'breach' ? 'SLA vencido' : 'SLA por vencer', full,
        level === 'breach'
          ? `Este ticket ya superó el tiempo objetivo de ${label} (prioridad ${row.priority}).`
          : `Este ticket ya consumió el ${pct} % del tiempo objetivo de ${label} (prioridad ${row.priority}). Atiéndelo pronto para cumplir el SLA.`);
      sent++;
    }
  }
  if (silent) db.prepare("INSERT OR IGNORE INTO sla_alerts (ticket_id, kind) VALUES (0, 'init')").run();
  return sent;
}

let timer = null;
function start(withSla) {
  const every = Math.max(1, Number(process.env.SLA_ALERT_MINUTES) || 10) * 60000;
  if (timer) return;
  const run = () => { try { check(withSla); } catch (e) { console.error('avisos de SLA:', e.message); } };
  setTimeout(run, 15000).unref();
  timer = setInterval(run, every); timer.unref();
}
const stop = () => { if (timer) clearInterval(timer); timer = null; };

module.exports = { check, start, stop };
