// Datos de ejemplo SOLO para el ambiente de prueba (docker-compose.test.yml y `npm run demo`).
// Crea usuarios con una clave conocida, así que se niega a correr sin DEMO_SEED=true.
function assertDemo() {
  if (process.env.DEMO_SEED !== 'true') {
    console.error('Se niega a sembrar datos de ejemplo: DEMO_SEED no es "true" (esto es solo para el ambiente de prueba).');
    process.exit(1);
  }
}
// Si se ejecuta directamente, negarse ANTES de abrir la base de datos
if (require.main === module) assertDemo();
const bcrypt = require('bcryptjs');
const db = require('./db');

function seed() {
  assertDemo();
  if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0) {
    console.log('Ya hay usuarios: no se siembra nada (borra la base de demostración para empezar de cero).');
    return false;
  }


  const PASS = 'prueba1234';
  const hash = bcrypt.hashSync(PASS, 10);
  const dep = (name) => db.prepare('SELECT id FROM departments WHERE name = ?').get(name).id;
  const addUser = db.prepare('INSERT INTO users (email, name, password_hash, department_id, role, lunch_shift) VALUES (?,?,?,?,?,?)');
  const U = {};
  for (const [key, email, name, d, role, lunch] of [
    ['admin', 'admin@empresa.com', 'Admin Prueba', 'Tecnología', 'admin', 'A'],
    ['tec', 'tecnico@empresa.com', 'Carlos Técnico', 'Tecnología', 'agent', 'B'],
    ['samuel', 'samuel@empresa.com', 'Samuel Soporte', 'Tecnología', 'agent', 'A'],
    ['laura', 'laura@empresa.com', 'Laura Redes', 'Tecnología', 'agent', 'B'],
    ['encargado', 'encargado@empresa.com', 'Elena Encargada', 'Tecnología', 'coordinator', null],
    ['lider', 'lider@empresa.com', 'Lucía Líder (Finanzas)', 'Finanzas', 'leader', null],
    ['gerencia', 'gerencia@empresa.com', 'Gerencia Prueba', 'Administración', 'manager', null],
    ['ana', 'ana@empresa.com', 'Ana Ruiz', 'Finanzas', 'user', null],
    ['luis', 'luis@empresa.com', 'Luis Pérez', 'Ventas', 'user', null],
    ['marta', 'marta@empresa.com', 'Marta Gil', 'Recursos Humanos', 'user', null],
  ]) U[key] = addUser.run(email, name, hash, dep(d), role, lunch).lastInsertRowid;

  // [solicitante, depto, titulo, descripcion, categoria, prioridad, estado, responsable, horas desde creación, horas hasta 1ª respuesta, horas hasta resolver, solución]
  const rows = [
    ['ana', 'Finanzas', 'No puedo conectarme a la VPN', 'Desde casa me da error de autenticación.', 'Red / Internet', 'alta', 'en_progreso', 'laura', 30, 2, null, null],
    ['luis', 'Ventas', 'Solicitud de laptop nueva', 'Ingresa un vendedor nuevo el lunes.', 'Hardware', 'media', 'abierto', null, 50, null, null, null],
    ['marta', 'Recursos Humanos', 'Impresora del piso 2 sin tóner', 'Necesitamos reposición del tóner.', 'Impresoras', 'baja', 'abierto', null, 6, null, null, null],
    ['ana', 'Finanzas', 'Restablecer contraseña de correo', 'Olvidé mi contraseña.', 'Accesos / Contraseñas', 'urgente', 'resuelto', 'samuel', 72, 1, 3, 'Se restableció la contraseña y se activó la verificación en dos pasos. Ya puedes entrar.'],
    ['luis', 'Ventas', 'Instalar Excel en equipo nuevo', 'Falta la licencia de Office.', 'Software', 'media', 'en_espera', 'tec', 20, 3, null, null],
    ['marta', 'Recursos Humanos', 'Correo no sincroniza en el celular', 'Dejó de llegar el correo.', 'Correo', 'alta', 'abierto', null, 2, null, null, null],
    ['ana', 'Finanzas', 'Acceso al sistema contable', 'Necesito permisos de lectura.', 'Accesos / Contraseñas', 'media', 'cerrado', 'admin', 120, 4, 20, 'Se otorgó el rol de lectura en el sistema contable por solicitud de la jefatura.'],
    ['luis', 'Ventas', 'Internet lento en la sala de reuniones', 'Se corta en videollamadas.', 'Red / Internet', 'alta', 'en_progreso', 'laura', 10, 1, null, null],
    ['marta', 'Recursos Humanos', 'Proyector no enciende', 'Sala 2, reunión de las 3.', 'Hardware', 'alta', 'resuelto', 'samuel', 96, 1, 2, 'Estaba desconectado el cable HDMI de la pared; se reemplazó por uno nuevo.'],
    ['ana', 'Finanzas', 'Instalar impresora de red', 'Quiero imprimir desde mi equipo.', 'Impresoras', 'baja', 'resuelto', 'samuel', 140, 5, 8, 'Se instaló el controlador y se agregó la impresora del piso 1.'],
    ['luis', 'Ventas', 'Actualizar Windows', 'Me pide reiniciar a cada rato.', 'Software', 'baja', 'resuelto', 'tec', 160, 6, 12, 'Se aplicaron las actualizaciones pendientes y se programó el reinicio fuera de horario.'],
    ['marta', 'Recursos Humanos', 'Cuenta de nuevo ingreso', 'Crear correo y accesos para Pedro.', 'Accesos / Contraseñas', 'media', 'resuelto', 'tec', 200, 2, 9, 'Se creó el correo, el acceso al sistema de nómina y el usuario de red.'],
    ['ana', 'Finanzas', 'Teclado con teclas pegadas', 'Se pegan la E y la R.', 'Hardware', 'baja', 'en_progreso', 'samuel', 8, 1, null, null],
    ['luis', 'Ventas', 'Wi-Fi no conecta en el piso 3', 'Desde el lunes no hay señal.', 'Red / Internet', 'urgente', 'resuelto', 'laura', 180, 1, 4, 'El punto de acceso del piso 3 estaba sin energía; se restableció el switch PoE.'],
    ['marta', 'Recursos Humanos', 'Licencia de Adobe', 'Necesito Acrobat para firmar PDFs.', 'Software', 'media', 'resuelto', 'laura', 110, 3, 14, 'Se asignó la licencia de Acrobat y se instaló en tu equipo.'],
  ];
  // Calificaciones de ejemplo: [estrellas, comentario]
  const RATE = {
    'Restablecer contraseña de correo': [5, 'Muy rápido, gracias'], 'Acceso al sistema contable': [4, null], 'Proyector no enciende': [5, null],
    'Instalar impresora de red': [3, 'Tardó un poco en responder'], 'Actualizar Windows': [4, null], 'Cuenta de nuevo ingreso': [5, 'Todo listo antes de que llegara'],
    'Wi-Fi no conecta en el piso 3': [2, 'Volvió a fallar al día siguiente'], 'Licencia de Adobe': [4, null],
  };
  const ago = (h) => `datetime('now','-${h} hours')`;
  for (const [who, d, title, desc, cat, pri, status, asg, hAgo, hResp, hRes, solucion] of rows) {
    const id = db.prepare(`INSERT INTO tickets (title, description, category, priority, status, requester_id, department_id, assignee_id,
        created_at, updated_at, first_response_at, resolved_at, resolution)
      VALUES (?,?,?,?,?,?,?,?, ${ago(hAgo)}, ${ago(Math.max(hAgo - (hRes ?? hResp ?? 0), 0))},
        ${hResp == null ? 'NULL' : ago(hAgo - hResp)}, ${hRes == null ? 'NULL' : ago(hAgo - hRes)}, ?)`)
      .run(title, desc, cat, pri, status, U[who], dep(d), asg ? U[asg] : null, solucion || null).lastInsertRowid;
    db.prepare(`INSERT INTO ticket_events (ticket_id, at, status, assignee_id) VALUES (?, ${ago(hAgo)}, 'abierto', NULL)`).run(id);
    if (RATE[title] && (status === 'resuelto' || status === 'cerrado')) db.prepare('INSERT INTO ticket_ratings (ticket_id, rating, comment, user_id) VALUES (?,?,?,?)').run(id, RATE[title][0], RATE[title][1], U[who]);
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
  console.log(`Datos de ejemplo creados. Usuarios (clave: ${PASS}): admin@, tecnico@, samuel@, laura@, encargado@, lider@, gerencia@, ana@, luis@, marta@ (@empresa.com)`);
  return true;
}

if (require.main === module) seed();
module.exports = { seed };
