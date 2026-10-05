process.env.SLA_TZ = 'America/Bogota'; // UTC-5 sin horario de verano
process.env.SLA_HOLIDAYS = '2026-10-12';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withSla, workMs, addWorkMs, localToMs } = require('../src/sla');

const H = 3600 * 1000;
// Hora local de Bogotá -> ms UTC. 2026-10-05 es lunes.
const at = (d, h, m = 0) => localToMs(2026, 10, d, h, m);
const iso = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 19);

test('horas hábiles: dentro de un mismo día y recorte al horario 8–18', () => {
  assert.equal(workMs(at(5, 9), at(5, 11), null) / H, 2);
  assert.equal(workMs(at(5, 6), at(5, 9), null) / H, 1); // antes de las 8 no cuenta
  assert.equal(workMs(at(5, 17), at(5, 20), null) / H, 1); // después de las 18 no cuenta
});

test('horas hábiles: viernes tarde a lunes por la mañana omite el fin de semana', () => {
  assert.equal(workMs(at(2, 17), at(5, 9), null) / H, 2); // vie 2 oct 17:00 → lun 5 oct 9:00 = 1 h + 1 h
});

test('festivo: el lunes 12 de oct no cuenta', () => {
  // vie 9 17:00 → mar 13 09:00 = 1 h (vie) + 1 h (mar); el lunes 12 es festivo
  assert.equal(workMs(at(9, 17), at(13, 9), null) / H, 2);
  assert.equal(workMs(at(12, 8), at(12, 18), null), 0);
});

test('almuerzo: turno A (12–13) y turno B (13–14:30) descuentan solo su ventana', () => {
  assert.equal(workMs(at(5, 11), at(5, 14), null) / H, 3);
  assert.equal(workMs(at(5, 11), at(5, 14), ['12:00', '13:00']) / H, 2);
  assert.equal(workMs(at(5, 11), at(5, 15), ['13:00', '14:30']) / H, 2.5);
});

test('addWorkMs: salta almuerzo, noche y fin de semana', () => {
  assert.equal(iso(addWorkMs(at(5, 11), 2 * H, ['12:00', '13:00'])), iso(at(5, 14)));
  assert.equal(iso(addWorkMs(at(9, 17), 2 * H, null)), iso(at(13, 9))); // vie 17:00 + 2 h hábiles (lun 12 festivo)
  assert.equal(iso(addWorkMs(at(5, 19), 1 * H, null)), iso(at(6, 9))); // fuera de horario: arranca mañana a las 8
});

const ticket = (extra) => ({
  created_at: iso(at(9, 16)), priority: 'alta', status: 'abierto', assignee_id: null,
  first_response_at: null, resolved_at: null, ...extra,
});
// created_at se guarda en UTC con formato "YYYY-MM-DD HH:MM:SS"
const utc = (ms) => iso(ms);

test('SLA de respuesta (alta = 2 h hábiles): vence según horas hábiles, no corridas', () => {
  const t = ticket({ created_at: utc(at(9, 16)) }); // viernes 16:00
  // sábado y domingo no cuentan: lunes festivo; martes 8:00 → 2 h hábiles consumidas (vie 16–18) → justo en el límite
  assert.equal(withSla(t, { now: at(13, 8) }).sla_response_breached, false);
  assert.equal(withSla(t, { now: at(13, 8, 1) }).sla_response_breached, true);
  assert.equal(withSla(t, { now: at(10, 12) }).sla_response_breached, false); // sábado: el reloj no corrió
});

test('SLA: la fecha límite proyectada cae en horario laboral', () => {
  const t = ticket({ created_at: utc(at(9, 17)) }); // vie 17:00: queda 1 h hoy y 1 h el martes
  const r = withSla(t, { now: at(9, 17) });
  assert.equal(iso(Date.parse(r.sla_response_due)), iso(at(13, 9)));
});

test('SLA: "en espera" pausa el reloj', () => {
  const t = ticket({ created_at: utc(at(5, 8)), status: 'en_espera', priority: 'urgente' }); // objetivo 1 h
  const events = [
    { at: utc(at(5, 8)), status: 'abierto', assignee_id: null },
    { at: utc(at(5, 8, 30)), status: 'en_espera', assignee_id: null },
  ];
  const r = withSla(t, { events, now: at(5, 17) });
  assert.equal(r.sla_response_breached, false); // solo corrieron 30 min
  assert.equal(r.sla_paused, true);
  assert.equal(r.sla_response_due, null);
});

test('SLA: el almuerzo del responsable pausa el reloj; sin responsable no', () => {
  const base = { created_at: utc(at(5, 11)), priority: 'urgente' }; // respuesta: 1 h
  const conTurnoA = withSla(ticket({ ...base, assignee_id: 7, status: 'en_progreso' }),
    { events: [{ at: base.created_at, status: 'en_progreso', assignee_id: 7 }], lunchFor: () => 'A', now: at(5, 13) });
  const sinResp = withSla(ticket(base), { now: at(5, 13) });
  assert.equal(conTurnoA.sla_response_breached, false); // 11–12 cuenta 1 h; 12–13 almuerzo
  assert.equal(sinResp.sla_response_breached, true); // 2 h corridas hábiles
});

test('SLA: tiempos de respuesta y resolución medidos en horas hábiles', () => {
  const t = ticket({ created_at: utc(at(9, 16)), first_response_at: utc(at(13, 9)), resolved_at: utc(at(13, 11)) });
  const r = withSla(t, { now: at(14, 12) });
  assert.equal(r.response_hours, 3); // vie 16–18 (2 h) + mar 8–9 (1 h)
  assert.equal(r.resolve_hours, 5);
  assert.equal(r.sla_response_breached, true); // 3 h > 2 h
});
