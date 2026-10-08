# ETIQUE

**ETIQUE** es el sistema de tickets de Tecnología de Grupo Dupla. Su nombre cuenta cómo funciona:

| | |
|---|---|
| **E** | **E**scribes tu solicitud (por la web o por correo) |
| **T** | **T**ecnología la recibe |
| **I** | **I**nterviene un técnico |
| **Q** | **Q**ueda resuelta, con su solución a la vista |
| **U** | **U**suario informado en cada paso |
| **E** | **E**valuamos y mejoramos (reportes y dashboard) |


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
- **Reabrir y confirmar**: al resolverse un ticket, el solicitante puede confirmar que quedó bien (pasa a «cerrado») o reabrirlo explicando qué sigue fallando (hasta `REOPEN_DAYS` días; TI siempre puede).
- **Notas internas**: TI puede dejar notas que ve el equipo y gerencia, pero nunca el solicitante.
- **Historial** de cada ticket: quién cambió estado, responsable, prioridad o categoría, y cuándo.
- **Desactivar usuarios** (Administración → Usuarios → «Activo»): no entran, no reciben tickets ni avisos y se conserva su historial.
- **Avisos de SLA** por correo: al 80 % del tiempo («por vencer») y cuando se vence, una vez por ticket, al responsable (o a todo TI si nadie lo tomó), al encargado y a `NOTIFY_NEW_TO`.
- **Seguridad** (ver [SECURITY.md](SECURITY.md)): verificación en dos pasos (opcional u obligatoria por rol), sesiones con caducidad y revocables, límites de uso, política de contraseñas, revisión del contenido de adjuntos, cabeceras estrictas, contenedor endurecido y **bitácora** de actividad. `npm run security:check` y Administración → Seguridad muestran qué falta ajustar.
- **Automatización** (Administración → Automatización):
  - *Asignación automática* de cada ticket nuevo (web o correo) por turnos o por carga, con grupos de técnicos por categoría. Viene desactivada.
  - *Reglas de escalamiento*: si un ticket cumple una condición (sin primera respuesta, sin responsable o sin resolver) durante N minutos hábiles, el sistema avisa al encargado y puede subir la prioridad o reasignarlo. Una vez por ticket y solo para tickets posteriores a la regla.
  - *Respuestas rápidas*: plantillas con `{{nombre}}`, `{{ticket}}` y `{{tecnico}}` que TI inserta al comentar.
  - *Formularios por categoría*: campos extra al crear el ticket (viene «Alta de usuario» de ejemplo); la categoría con formulario aparece en la lista.
- Roles (`Administración → Usuarios`):
  | Rol | Qué puede hacer |
  |---|---|
  | `user` Usuario | Crea y ve sus tickets y su solución |
  | `leader` Líder de departamento | Lo del usuario + ve (solo lectura) los tickets de su departamento |
  | `agent` Técnico (TI) | Ve y gestiona tickets, escribe la solución; su dashboard solo muestra lo suyo; sin reportes ni administración |
  | `coordinator` Encargado de TI | Ve todo, asigna, dashboard de todo el equipo y reportes; sin administración |
  | `manager` Gerencia | Ve todo, dashboard y reportes; solo lectura |
  | `admin` Administrador | Todo, incluida la administración de usuarios y del correo |

  Los tickets solo se asignan a Técnicos y Administradores.
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
Despliegue en servidor propio (Docker + Caddy, base de datos local en `./data`): ver [DEPLOY.md](DEPLOY.md).

## Reportes y tiempos de respuesta (SLA en horario laboral)
Personal de TI (agent/admin) tiene la pestaña **Reportes**: totales, abiertos, tiempo promedio de primera respuesta y de resolución, cumplimiento de SLA y tickets abiertos vencidos, por prioridad, departamento, categoría, responsable y estado, con filtro por fechas y exportación a CSV.

**Cómo cuenta el tiempo (horas hábiles):**
- Solo corre de lunes a viernes, de 08:00 a 18:00 (`WORK_START`, `WORK_END`, `WORK_DAYS`), sin festivos (`SLA_HOLIDAYS="2026-12-25,2027-01-01"`), en la zona `SLA_TZ` (p. ej. `America/Bogota`). **Define `SLA_TZ`: en Docker el servidor usa UTC por defecto.**
- Se pausa mientras el ticket está **en espera**, **resuelto** o **cerrado**.
- **Almuerzo:** el personal de TI tiene un turno (A: 12:00–13:00, B: 13:00–14:30, configurable con `LUNCH_SHIFTS`), que el admin asigna en *Administración*. Durante el almuerzo de la persona asignada el reloj de ese ticket se pausa; si el ticket no tiene responsable no se pausa (siempre hay alguien de TI disponible por los turnos escalonados).
- *Primera respuesta*: primer comentario de TI, o primer cambio de estado/asignación hecho por alguien distinto del solicitante. *Resolución*: paso a `resuelto`/`cerrado`.
- Objetivos por defecto en horas hábiles (respuesta/resolución): urgente 1/4, alta 2/8, media 4/16, baja 8/32. Cámbialos con `SLA_JSON='{"alta":{"response":2,"resolve":6}}'`. Si cambia la prioridad, se recalcula con el nuevo objetivo.
- Los tickets anteriores a esta función se calculan como si siempre hubieran estado en su estado actual.


## Qué hace
- Los usuarios piden ayuda desde la web (**Nuevo ticket**) o **enviando un correo** a la bandeja de soporte, y ven en **Mis tickets** cómo avanza cada solicitud y **cómo se resolvió**.
- Tecnología atiende, asigna y escribe la solución; **gerencia** (solo lectura) y TI ven un **dashboard** con el avance de cada técnico (% resuelto, SLA, tiempos).
- Todo se guarda en la base de datos del servidor (`data/`): los usuarios solo usan el navegador. Ver [INSTALL.md](INSTALL.md).

## Instalación
Windows, Linux y macOS, con Docker o directo con Node: ver [INSTALL.md](INSTALL.md).

## Ambiente de prueba
Con datos de ejemplo: `npm run demo` (solo Node, sin Docker) o `./scripts/test-env.sh up` (Docker, con bandeja de correos de prueba). Ver [TEST.md](TEST.md).

## Pruebas y CI
`npm test` ejecuta las pruebas automáticas (API, permisos, SLA, adjuntos, reportes, IMAP con servidor simulado, sesiones). GitHub Actions (`.github/workflows/ci.yml`) las corre en cada PR, además de construir la imagen Docker y comprobar que arranca (`/healthz`) y que se niega a iniciar sin `SESSION_SECRET`.

## Seguridad
- Sesiones guardadas en SQLite (sobreviven a reinicios; expiran a las 8 h).
- Cabeceras de seguridad (helmet, CSP) y rechazo de peticiones que modifican datos con `Origin` de otro sitio.
- Límite de intentos de login por IP y por correo guardado en la base, tope de conexiones simultáneas a IMAP y restricción opcional de Administración/Reportes a la red interna (`INTERNAL_CIDRS`). Para publicarlo en internet ver `DEPLOY.md`, sección 7.
- Con `NODE_ENV=production` (como en Docker) `SESSION_SECRET` es obligatorio.
