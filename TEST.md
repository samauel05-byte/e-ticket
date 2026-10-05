# Ambiente de prueba

Levanta el sistema completo en tu computadora o en un servidor de pruebas, con datos de ejemplo y sin tocar el correo real. **No es para producción** (usa claves conocidas y HTTP sin cifrar).

## Requisitos
Docker y Docker Compose. En Windows y Mac: **Docker Desktop** (en Windows usa WSL 2; si usas VirtualBox a la vez, revisa que no choquen: Docker Desktop activa funciones de virtualización de Windows).

## Arrancar

**Linux / Mac / WSL / servidor:**
```bash
git clone https://github.com/samauel05-byte/e-ticket && cd e-ticket
./scripts/test-env.sh up
```

**Windows (símbolo del sistema o PowerShell):**
```bat
git clone https://github.com/samauel05-byte/e-ticket
cd e-ticket
scripts\test-env.cmd up
```
Si prefieres no usar el script, son estos dos comandos (sirven en cualquier sistema):
```
docker compose -f docker-compose.test.yml up -d --build
docker compose -f docker-compose.test.yml exec eticket node src/seedDemo.js
```

- Sistema: http://localhost:3000
- Bandeja de correos de prueba (aquí llegan los avisos): http://localhost:8025

Usuarios de ejemplo (clave **prueba1234**, dominio `@empresa.com`):
| Usuario | Rol |
|---|---|
| `admin@` | administrador |
| `tecnico@` | personal de TI |
| `ana@`, `luis@`, `marta@` | usuarios que piden tickets |

## Qué probar
1. Entra como `ana@` y crea un ticket con un archivo adjunto. Mira la lista, el detalle y que solo ves tus tickets.
2. Entra como `tecnico@`: ve todos los tickets, cámbiale el estado, asígnalo y comenta. Revisa en http://localhost:8025 los correos que recibió Ana.
3. Entra como `admin@`: Administración (roles, departamentos, turnos de almuerzo) y Reportes (gráficos, CSV).
4. Prueba en el celular: abre `http://IP-DE-TU-PC:3000` desde la misma red.
5. Equivócate 20 veces en el login para ver el bloqueo (15 min); `./scripts/test-env.sh reset` lo limpia todo.
6. Mira el SLA: los tickets de ejemplo se crean con horas relativas a "ahora", así que los tiempos y los "vencidos" dependen del día y la hora en que lo levantes (el SLA solo cuenta lunes a viernes de 8 a 18).

## Probar con tu correo real (IMAP/SMTP)
En `docker-compose.test.yml`, sección `environment`, agrega `IMAP_HOST`, `IMAP_PORT` (y `IMAP_SECURE`/`IMAP_USER_FORMAT` si hace falta); para correos reales reemplaza `SMTP_HOST: mailpit` por tu servidor y agrega `SMTP_USER`/`SMTP_PASS`. Luego `./scripts/test-env.sh reset`. Con IMAP activo el registro local se desactiva y se entra con la clave del correo; los usuarios sembrados dejan de poder entrar con `prueba1234`, pero los nuevos se crean al primer acceso.

## Comandos
`./scripts/test-env.sh up | down | reset | logs` (en Windows `scripts\test-env.cmd ...`). `reset` borra todos los datos de prueba.
