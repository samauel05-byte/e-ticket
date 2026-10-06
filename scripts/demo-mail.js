#!/usr/bin/env node
// Envía un correo de prueba a la bandeja simulada de `npm run demo`, para ver cómo se crea un ticket.
//   npm run demo:mail -- --from ana@empresa.com --subject "No tengo internet" --body "Desde las 9 no conecta"
//   npm run demo:mail -- --from ana@empresa.com --ticket 3 --body "Sigue igual"     (responde al ticket #3)
const { buildMail } = require('./fakeMailbox');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i < 0 ? d : (process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d); };

const ticket = arg('ticket');
const raw = buildMail({
  from: arg('from', 'ana@empresa.com'),
  subject: ticket ? `Re: [Ticket #${ticket}] ${arg('subject', 'Recibimos tu solicitud')}` : arg('subject', 'Prueba de correo a soporte'),
  text: arg('body', 'Hola, necesito ayuda de Tecnología.'),
});
const port = Number(arg('port', 3198));
fetch(`http://127.0.0.1:${port}/deliver`, { method: 'POST', body: raw })
  .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); console.log(`Correo enviado a la bandeja de soporte. En unos segundos aparecerá ${ticket ? 'como comentario del ticket #' + ticket : 'como un ticket nuevo'}.`); })
  .catch((e) => { console.error(`No pude entregar el correo (${e.message}). ¿Está corriendo "npm run demo" en otra ventana?`); process.exit(1); });
