// Lógica de tickets compartida por la web y por la recepción de correos
const db = require('./db');
const forms = require('./forms');
const mailer = require('./mailer');

const STATUSES = ['abierto', 'en_progreso', 'en_espera', 'resuelto', 'cerrado'];
const PRIORITIES = ['baja', 'media', 'alta', 'urgente'];
const CATEGORIES = ['Hardware', 'Software', 'Red / Internet', 'Correo', 'Accesos / Contraseñas', 'Impresoras', 'Otro'];

// Lista que se ofrece al crear tickets: las del sistema (sin "Otro") + las que tienen formulario propio
const categoryList = () => [...CATEGORIES.filter((c) => c !== 'Otro'), ...forms.names().filter((n) => !CATEGORIES.includes(n))];
const knownCategories = () => [...CATEGORIES, ...forms.names()];

// Categoría: una de la lista, o escrita a mano (valor "__otra__" + texto). Devuelve null si no es válida.
function resolveCategory(selected, other) {
  const known = knownCategories();
  if (known.includes(selected)) return selected;
  if (selected !== '__otra__') return null;
  const t = String(other || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (t.length < 2) return null;
  const hit = known.find((c) => c.toLowerCase() === t.toLowerCase()); // "hardware" -> "Hardware"
  return hit || t.charAt(0).toUpperCase() + t.slice(1);
}
// Categorías escritas a mano que ya se usaron (para sugerirlas)
const extraCategories = () => {
  const known = knownCategories();
  return db.prepare(`SELECT category FROM tickets WHERE category NOT IN (${known.map(() => '?').join(',')})
    GROUP BY category ORDER BY COUNT(*) DESC LIMIT 20`).all(...known).map((r) => r.category);
};

const USER_SELECT = `SELECT u.id, u.email, u.name, u.role, u.lunch_shift, u.active, u.department_id, d.name AS department
  FROM users u JOIN departments d ON d.id = u.department_id`;
const getUser = (id) => db.prepare(`${USER_SELECT} WHERE u.id = ?`).get(id);
const getUserByEmail = (email) => db.prepare(`${USER_SELECT} WHERE u.email = ?`).get(String(email).toLowerCase());

const TICKET_SELECT = `SELECT t.*, r.name AS requester_name, r.email AS requester_email,
  d.name AS department, a.name AS assignee_name
  FROM tickets t JOIN users r ON r.id = t.requester_id
  JOIN departments d ON d.id = t.department_id
  LEFT JOIN users a ON a.id = t.assignee_id`;

const eventStmt = db.prepare('INSERT INTO ticket_events (ticket_id, status, assignee_id, actor_id, note) VALUES (?,?,?,?,?)');
const logEvent = { run: (ticketId, status, assignee, actor = null, note = null) => eventStmt.run(ticketId, status, assignee, actor, note) };
// Correos de TI (técnicos y administradores) + los de NOTIFY_NEW_TO (p. ej. el jefe de Tecnología, separados por coma)
const staffEmails = (exceptId) => {
  const extra = String(process.env.NOTIFY_NEW_TO || '').split(',').map((e) => e.trim().toLowerCase()).filter((e) => /^[^\s@]+@[^\s@]+$/.test(e));
  const staff = db.prepare("SELECT email FROM users WHERE role IN ('agent','coordinator','admin') AND active = 1 AND id != ?").all(exceptId || 0).map((r) => r.email);
  return [...new Set([...staff, ...extra])];
};
const ASSIGNABLE = ['agent', 'admin']; // a quienes se les asignan tickets: Tecnología y Administración
const STAFF_ROLES = ['agent', 'coordinator', 'admin']; // gestionan tickets: técnico, encargado y administrador
const isStaff = (u) => STAFF_ROLES.includes(u.role);
const getTicket = (id) => db.prepare(`${TICKET_SELECT} WHERE t.id = ?`).get(id);

// Crea un ticket (lo asigna solo si la asignación automática está activa) y avisa al solicitante y a TI. requester: fila de getUser().
function createTicket({ requester, title, description, category, priority = 'media', source = 'web', formData = null }) {
  const info = db.prepare(`INSERT INTO tickets (title, description, category, priority, requester_id, department_id, source, form_data)
    VALUES (?,?,?,?,?,?,?,?)`).run(title, description, category, priority, requester.id, requester.department_id, source,
    formData && formData.length ? JSON.stringify(formData) : null);
  logEvent.run(info.lastInsertRowid, 'abierto', null, requester.id);
  const assignee = require('./automation').autoAssign(info.lastInsertRowid);
  const created = getTicket(info.lastInsertRowid);
  mailer.notify(requester.email, 'Recibimos tu solicitud', created,
    `Hola ${requester.name}, registramos tu ticket${source === 'email' ? ' a partir de tu correo' : ''}. Te avisaremos cuando haya novedades.` +
    (source === 'email' ? '\n\nPuedes responder a este mensaje para agregar información al ticket.' : ''));
  const others = staffEmails(requester.id).filter((e) => !assignee || e !== assignee.email);
  mailer.notify(others, `Nuevo ticket (${priority}) de ${requester.department}`, created,
    `${requester.name} (${requester.email}) creó un ticket de ${category}, prioridad ${priority}${source === 'email' ? ', por correo' : ''}.\n\n` +
    (assignee ? `Se asignó automáticamente a ${assignee.name}.` : 'Está SIN ASIGNAR: entra al sistema para asignarlo a un técnico.'));
  if (assignee) mailer.notify(assignee.email, 'Se te asignó un ticket', created, `El sistema te asignó este ticket automáticamente (prioridad ${priority}).`);
  return created;
}

// Agrega un comentario y avisa a la otra parte. ticket: fila de la tabla tickets. user: fila de getUser().
function addComment({ ticket, user, body, internal = false }) {
  internal = Boolean(internal) && isStaff(user); // solo TI puede dejar notas internas
  db.prepare('INSERT INTO comments (ticket_id, user_id, body, internal) VALUES (?,?,?,?)').run(ticket.id, user.id, body, internal ? 1 : 0);
  db.prepare(`UPDATE tickets SET updated_at = datetime('now'),
      first_response_at = CASE WHEN first_response_at IS NULL AND ? THEN datetime('now') ELSE first_response_at END
      WHERE id = ?`).run(!internal && isStaff(user) && user.id !== ticket.requester_id ? 1 : 0, ticket.id);
  const full = getTicket(ticket.id);
  if (internal) { // la nota interna nunca llega al solicitante
    const a = ticket.assignee_id && ticket.assignee_id !== user.id ? getUser(ticket.assignee_id) : null;
    if (a?.active) mailer.notify(a.email, 'Nota interna', full, `${user.name} dejó una nota interna:\n\n${body}`);
    return full;
  }
  let to;
  if (user.id === ticket.requester_id) to = ticket.assignee_id ? getUser(ticket.assignee_id)?.email : staffEmails(user.id);
  else to = full.requester_email;
  mailer.notify(to, 'Nuevo comentario', full, `${user.name} comentó:\n\n${body}`);
  return full;
}

module.exports = { STATUSES, PRIORITIES, CATEGORIES, ASSIGNABLE, categoryList, resolveCategory, extraCategories, USER_SELECT, getUser, getUserByEmail, TICKET_SELECT, getTicket, logEvent, staffEmails, isStaff, createTicket, addComment };
