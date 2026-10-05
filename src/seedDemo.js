// Datos de ejemplo SOLO para el ambiente de prueba (docker-compose.test.yml).
// Crea usuarios con una clave conocida, así que se niega a correr sin DEMO_SEED=true.
if (process.env.DEMO_SEED !== 'true') {
  console.error('Se niega a sembrar datos de ejemplo: DEMO_SEED no es "true" (esto es solo para el ambiente de prueba).');
  process.exit(1);
}
const bcrypt = require('bcryptjs');
const db = require('./db');

if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
  console.log('Ya hay usuarios: no se siembra nada (usa "scripts/test-env.sh reset" para empezar de cero).');
  process.exit(0);
}

const PASS = 'prueba1234';
const hash = bcrypt.hashSync(PASS, 10);
const dep = (name) => db.prepare('SELECT id FROM departments WHERE name = ?').get(name).id;
const addUser = db.prepare('INSERT INTO users (email, name, password_hash, department_id, role, lunch_shift) VALUES (?,?,?,?,?,?)');
const U = {};
for (const [key, email, name, d, role, lunch] of [
  ['admin', 'admin@empresa.com', 'Admin Prueba', 'Tecnología', 'admin', 'A'],
  ['tec', 'tecnico@empresa.com', 'Carlos Técnico', 'Tecnología', 'agent', 'B'],
  ['ana', 'ana@empresa.com', 'Ana Ruiz', 'Finanzas', 'user', null],
  ['luis', 'luis@empresa.com', 'Luis Pérez', 'Ventas', 'user', null],
  ['marta', 'marta@empresa.com', 'Marta Gil', 'Recursos Humanos', 'user', null],
]) U[key] = addUser.run(email, name, hash, dep(d), role, lunch).lastInsertRowid;

// [solicitante, depto, titulo, descripcion, categoria, prioridad, estado, responsable, horas desde creación, horas hasta 1ª respuesta, horas hasta resolver]
const rows = [
  ['ana', 'Finanzas', 'No puedo conectarme a la VPN', 'Desde casa me da error de autenticación.', 'Red / Internet', 'alta', 'en_progreso', 'tec', 30, 2, null],
  ['luis', 'Ventas', 'Solicitud de laptop nueva', 'Ingresa un vendedor nuevo el lunes.', 'Hardware', 'media', 'abierto', null, 50, null, null],
  ['marta', 'Recursos Humanos', 'Impresora del piso 2 sin tóner', 'Necesitamos reposición del tóner.', 'Impresoras', 'baja', 'abierto', null, 6, null, null],
  ['ana', 'Finanzas', 'Restablecer contraseña de correo', 'Olvidé mi contraseña.', 'Accesos / Contraseñas', 'urgente', 'resuelto', 'tec', 72, 1, 3],
  ['luis', 'Ventas', 'Instalar Excel en equipo nuevo', 'Falta la licencia de Office.', 'Software', 'media', 'en_espera', 'tec', 20, 3, null],
  ['marta', 'Recursos Humanos', 'Correo no sincroniza en el celular', 'Dejó de llegar el correo.', 'Correo', 'alta', 'abierto', null, 2, null, null],
  ['ana', 'Finanzas', 'Acceso al sistema contable', 'Necesito permisos de lectura.', 'Accesos / Contraseñas', 'media', 'cerrado', 'admin', 120, 4, 20],
  ['luis', 'Ventas', 'Internet lento en la sala de reuniones', 'Se corta en videollamadas.', 'Red / Internet', 'alta', 'en_progreso', 'admin', 10, 1, null],
];
const ago = (h) => `datetime('now','-${h} hours')`;
for (const [who, d, title, desc, cat, pri, status, asg, hAgo, hResp, hRes] of rows) {
  const id = db.prepare(`INSERT INTO tickets (title, description, category, priority, status, requester_id, department_id, assignee_id,
      created_at, updated_at, first_response_at, resolved_at)
    VALUES (?,?,?,?,?,?,?,?, ${ago(hAgo)}, ${ago(Math.max(hAgo - (hRes ?? hResp ?? 0), 0))},
      ${hResp == null ? 'NULL' : ago(hAgo - hResp)}, ${hRes == null ? 'NULL' : ago(hAgo - hRes)})`)
    .run(title, desc, cat, pri, status, U[who], dep(d), asg ? U[asg] : null).lastInsertRowid;
  db.prepare(`INSERT INTO ticket_events (ticket_id, at, status, assignee_id) VALUES (?, ${ago(hAgo)}, 'abierto', NULL)`).run(id);
  if (status !== 'abierto') {
    db.prepare(`INSERT INTO ticket_events (ticket_id, at, status, assignee_id) VALUES (?, ${ago(hAgo - (hResp ?? 0))}, ?, ?)`)
      .run(id, status === 'resuelto' || status === 'cerrado' ? 'en_progreso' : status, asg ? U[asg] : null);
    if (status === 'resuelto' || status === 'cerrado')
      db.prepare(`INSERT INTO ticket_events (ticket_id, at, status, assignee_id) VALUES (?, ${ago(hAgo - hRes)}, ?, ?)`).run(id, status, asg ? U[asg] : null);
  }
  if (hResp != null)
    db.prepare(`INSERT INTO comments (ticket_id, user_id, body, created_at) VALUES (?,?,?, ${ago(hAgo - hResp)})`)
      .run(id, asg ? U[asg] : U.admin, 'Hola, ya estoy revisando tu solicitud.');
}
console.log(`Datos de ejemplo creados. Usuarios (clave: ${PASS}): admin@, tecnico@, ana@, luis@, marta@ (@empresa.com)`);
