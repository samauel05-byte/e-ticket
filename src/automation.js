// Automatización: asignación automática de tickets nuevos y reglas de escalamiento.
const db = require('./db');
const mailer = require('./mailer');
const T = require('./tickets');

const MODES = ['off', 'round_robin', 'least_load'];
const PRIORITY_ORDER = ['baja', 'media', 'alta', 'urgente'];
const OPEN = "('abierto','en_progreso','en_espera')";

const cfgGet = (k, d) => db.prepare('SELECT value FROM automation_config WHERE key = ?').get(k)?.value ?? d;
const cfgSet = (k, v) => db.prepare('INSERT INTO automation_config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, String(v));
const mode = () => (MODES.includes(cfgGet('assign_mode', 'off')) ? cfgGet('assign_mode', 'off') : 'off');

// ── Asignación automática ──────────────────────────────────────────────────
// Quién puede recibir tickets de una categoría: su grupo propio; si no tiene, el grupo general ("*"); si tampoco, todos los técnicos activos.
function candidates(category, excludeIds = []) {
  const ids = (cat) => db.prepare('SELECT user_id FROM assign_pool WHERE category = ?').all(cat).map((r) => r.user_id);
  let pool = ids(category);
  if (!pool.length) pool = ids('*');
  const marks = T.ASSIGNABLE.map(() => '?').join(',');
  let rows = db.prepare(`SELECT id, name, email, role, last_assigned_at FROM users WHERE active = 1 AND role IN (${marks})`).all(...T.ASSIGNABLE);
  if (pool.length) rows = rows.filter((u) => pool.includes(u.id));
  else rows = rows.filter((u) => u.role === 'agent'); // sin grupos: solo técnicos (no administradores)
  return rows.filter((u) => !excludeIds.includes(u.id));
}

function pick(category, excludeIds = []) {
  const m = mode();
  if (m === 'off') return null;
  const list = candidates(category, excludeIds);
  if (!list.length) return null;
  const load = db.prepare(`SELECT COUNT(*) AS n FROM tickets WHERE assignee_id = ? AND status IN ${OPEN}`);
  const oldest = (a, b) => String(a.last_assigned_at || '').localeCompare(String(b.last_assigned_at || '')) || a.id - b.id;
  if (m === 'least_load') list.sort((a, b) => load.get(a.id).n - load.get(b.id).n || oldest(a, b));
  else list.sort(oldest);
  return list[0];
}

function assignTo(ticketId, user, status, note, actorId = null) {
  db.prepare("UPDATE tickets SET assignee_id = ?, updated_at = datetime('now') WHERE id = ?").run(user.id, ticketId);
  db.prepare("UPDATE users SET last_assigned_at = strftime('%Y-%m-%d %H:%M:%f','now') WHERE id = ?").run(user.id);
  T.logEvent.run(ticketId, status, user.id, actorId, note);
}

// Se llama al crear un ticket (web o correo). Devuelve el usuario asignado o null.
function autoAssign(ticketId) {
  const t = db.prepare('SELECT id, category, requester_id, status FROM tickets WHERE id = ?').get(ticketId);
  if (!t) return null;
  const u = pick(t.category, [t.requester_id]);
  if (!u) return null;
  assignTo(t.id, u, t.status, 'Asignado automáticamente');
  return u;
}

// ── Escalamiento ───────────────────────────────────────────────────────────
function escalationRecipients(ticket) {
  const extra = String(process.env.NOTIFY_NEW_TO || '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e));
  let boss = db.prepare("SELECT email FROM users WHERE role = 'coordinator' AND active = 1").all().map((r) => r.email);
  if (!boss.length) boss = db.prepare("SELECT email FROM users WHERE role = 'admin' AND active = 1").all().map((r) => r.email);
  const a = ticket.assignee_id ? T.getUser(ticket.assignee_id) : null;
  return [...new Set([...boss, ...extra, ...(a?.active ? [a.email] : [])])];
}

const CONDITION_TEXT = { no_response: 'sin primera respuesta', unassigned: 'sin responsable', not_resolved: 'sin resolver' };
const fmtMin = (m) => (m >= 60 && m % 60 === 0 ? `${m / 60} h` : `${m} min`);

// withSla: sla.withSla (con opciones). Aplica cada regla una sola vez por ticket, solo a tickets creados después de la regla.
function runEscalations(withSla, { now = Date.now(), notify = mailer.notify } = {}) {
  const rules = db.prepare('SELECT * FROM escalation_rules WHERE enabled = 1').all();
  if (!rules.length) return 0;
  const events = db.prepare('SELECT at, status, assignee_id FROM ticket_events WHERE ticket_id = ? ORDER BY id');
  const lunch = db.prepare('SELECT lunch_shift FROM users WHERE id = ?');
  const done = db.prepare('SELECT 1 FROM escalation_log WHERE ticket_id = ? AND rule_id = ?');
  const mark = db.prepare('INSERT OR IGNORE INTO escalation_log (ticket_id, rule_id) VALUES (?, ?)');
  const open = db.prepare("SELECT * FROM tickets WHERE status IN ('abierto','en_progreso') ORDER BY id").all();
  let n = 0;
  for (const row of open) {
    const t = withSla(row, { now, events: events.all(row.id), lunchFor: (id) => (id ? lunch.get(id)?.lunch_shift : null) });
    for (const r of rules) {
      if (row.created_at < r.created_at) continue;
      if (r.priority !== '*' && r.priority !== row.priority) continue;
      if (done.get(row.id, r.id)) continue;
      const need = r.minutes * 60000;
      const hit = r.condition === 'no_response' ? !row.first_response_at && t.sla_response_used_ms >= need
        : r.condition === 'unassigned' ? !row.assignee_id && t.sla_resolve_used_ms >= need
        : !row.resolved_at && t.sla_resolve_used_ms >= need;
      if (!hit) continue;
      if (mark.run(row.id, r.id).changes === 0) continue;
      n++;
      let what = '';
      if (r.action === 'priority_up') {
        const next = PRIORITY_ORDER[PRIORITY_ORDER.indexOf(row.priority) + 1];
        if (next) {
          db.prepare("UPDATE tickets SET priority = ?, updated_at = datetime('now') WHERE id = ?").run(next, row.id);
          T.logEvent.run(row.id, row.status, row.assignee_id, null, `Prioridad: ${row.priority} → ${next} (regla «${r.name}»)`);
          what = `Se subió la prioridad de ${row.priority} a ${next}.`;
        } else what = 'Ya tenía la prioridad más alta.';
      } else if (r.action === 'reassign') {
        const u = pick(row.category, [row.requester_id, ...(row.assignee_id ? [row.assignee_id] : [])]);
        if (u) {
          assignTo(row.id, u, row.status, `Reasignado a ${u.name} (regla «${r.name}»)`);
          what = `Se reasignó a ${u.name}.`;
          notify(u.email, 'Se te asignó un ticket', T.getTicket(row.id), `Este ticket se reasignó a ti por la regla «${r.name}».`);
        } else what = 'No había otro técnico disponible para reasignarlo.';
      } else {
        T.logEvent.run(row.id, row.status, row.assignee_id, null, `Escalado: regla «${r.name}»`);
      }
      const to = escalationRecipients(db.prepare('SELECT * FROM tickets WHERE id = ?').get(row.id));
      if (to.length) notify(to, `Escalamiento: ${r.name}`, T.getTicket(row.id),
        `El ticket lleva ${fmtMin(r.minutes)} hábiles ${CONDITION_TEXT[r.condition]} (prioridad ${row.priority}).${what ? '\n\n' + what : ''}`);
    }
  }
  return n;
}

let timer = null;
function start(withSla) {
  if (timer) return;
  const every = Math.max(1, Number(process.env.ESCALATION_MINUTES) || 5) * 60000;
  const run = () => { try { runEscalations(withSla); } catch (e) { console.error('escalamiento:', e.message); } };
  setTimeout(run, 20000).unref();
  timer = setInterval(run, every); timer.unref();
}
const stop = () => { if (timer) clearInterval(timer); timer = null; };

module.exports = { MODES, mode, cfgGet, cfgSet, candidates, pick, autoAssign, runEscalations, start, stop };
