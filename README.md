# E-Ticket TI

Sistema de tickets de solicitud para el área de Tecnología. Node + Express + SQLite.

## Uso
```bash
npm install
cp .env.example .env   # luego exporta las variables (o defínelas al ejecutar)
ALLOWED_DOMAIN=tuempresa.com ADMIN_EMAIL=ti@tuempresa.com SESSION_SECRET=algo-largo npm start
```
Abre http://localhost:3000.

## Funcionamiento
- Solo se pueden registrar correos del dominio `ALLOWED_DOMAIN`; cada usuario elige su departamento.
- El correo `ADMIN_EMAIL` queda como **admin** al registrarse.
- Roles: `user` (crea y ve sus tickets), `agent` (personal de TI: ve todos, cambia estado/prioridad, asigna), `admin` (además gestiona usuarios, roles y departamentos).
- Los departamentos iniciales están en `src/db.js`; el admin puede agregar más desde la UI.
- Producción: define `SESSION_SECRET`, usa HTTPS con `COOKIE_SECURE=true`.

## Inicio de sesión con IMAP
Define `IMAP_HOST` (y opcionalmente `IMAP_PORT`, `IMAP_SECURE`, `IMAP_USER_FORMAT`) para que los usuarios entren con la contraseña de su correo corporativo; el servidor solo comprueba que el IMAP la acepte y **no la guarda**. En el primer acceso el usuario elige su nombre y departamento. Con IMAP activo el registro local queda deshabilitado. Hay un bloqueo temporal tras 8 intentos fallidos por correo/IP (en memoria).

## Avisos por correo (SMTP)
Define `SMTP_HOST` (+ `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `APP_URL`). Se envía correo cuando:
- se crea un ticket: confirmación al solicitante y aviso al personal de TI (agent/admin);
- cambia el estado: al solicitante;
- se asigna un ticket: al responsable asignado;
- hay un comentario: al solicitante si comenta TI; al responsable (o a todo TI si no hay) si comenta el solicitante.

El envío no bloquea la aplicación: si el SMTP falla, solo se registra el error en la consola.

## Adjuntos
Se pueden adjuntar archivos al crear un ticket o después desde su detalle (hasta 5 por subida, `MAX_UPLOAD_MB` MB cada uno, 10 por defecto). Tipos permitidos: png, jpg, gif, pdf, txt, log, csv, doc(x), xls(x), ppt(x), zip. Se guardan en `UPLOAD_DIR` (por defecto `data/uploads`, incluido en `.gitignore`) con nombre aleatorio, y solo se descargan a través de la API con sesión: el solicitante y el personal de TI pueden verlos; solo quien lo subió o un admin puede eliminarlo. Incluye `data/` en tus respaldos.
