# Despliegue en servidor propio

Arquitectura: **Caddy** (HTTPS, puertos 80/443) → **e-ticket** (Node, solo accesible por Caddy).
La base de datos (SQLite) y los adjuntos viven en la carpeta local **`./data`** del servidor.

## 1. Requisitos
- Linux (p. ej. Ubuntu Server 24.04 LTS), Docker y Docker Compose.
- Un nombre interno (p. ej. `tickets.empresa.local`) que el DNS apunte al servidor.
- Puertos 80 y 443 abiertos hacia la red interna; salida hacia los servidores IMAP y SMTP.

## 2. Instalar
```bash
git clone https://github.com/samauel05-byte/e-ticket && cd e-ticket
./scripts/setup.sh          # crea ./data (permisos), ./certs y .env
nano .env                   # ver "Variables" abajo
docker compose up -d --build
```
Abre `https://<SITE_ADDRESS>`. Entra con `ADMIN_EMAIL`: queda como administrador.

## 3. Variables (`.env`)
| Variable | Valor |
|---|---|
| `ALLOWED_DOMAIN`, `ADMIN_EMAIL` | dominio de correo y primer administrador |
| `SESSION_SECRET` | cadena aleatoria: `openssl rand -hex 32` (obligatoria) |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_SECURE` | login con la contraseña del correo |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | avisos por correo |
| `SLA_TZ` | zona horaria de la oficina, p. ej. `America/Bogota` (obligatoria: el contenedor usa UTC) |
| `SITE_ADDRESS` | nombre de acceso, p. ej. `tickets.empresa.local` |
| `CADDY_TLS` | `internal`, `/certs/cert.pem /certs/key.pem` o un correo (Let's Encrypt) |
| `APP_URL` | `https://tickets.empresa.local` (enlaces dentro de los correos) |
| `COOKIE_SECURE`, `TRUST_PROXY` | `true` y `true` |

## 4. Certificado HTTPS
La contraseña del correo viaja al servidor: HTTPS es obligatorio.
- **`CADDY_TLS=internal`** (por defecto): Caddy crea su propia autoridad. Los equipos deben confiar en ella una sola vez (p. ej. por política de dominio). Exporta el certificado raíz:
  ```bash
  docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./root.crt
  ```
- **Certificado de la empresa:** copia `cert.pem` y `key.pem` a `./certs` y usa `CADDY_TLS=/certs/cert.pem /certs/key.pem`.
- **Nombre público:** `CADDY_TLS=correo@empresa.com` (Let's Encrypt; requiere que el servidor sea alcanzable desde internet).

## 5. Respaldos
Todo lo importante está en `./data` (`eticket.db` y `uploads/`).
```bash
./scripts/backup-docker.sh        # copia consistente de la BD en ./data/backups (con la app en marcha)
```
Prográmalo a diario con cron y copia `./data/backups` y `./data/uploads` a otro equipo:
```
0 2 * * * cd /ruta/e-ticket && ./scripts/backup-docker.sh >> backup.log 2>&1
```
**Restaurar:** `docker compose down`, copia el `.db` elegido a `data/eticket.db` (borra `eticket.db-wal` y `-shm` si existen), `docker compose up -d`.

## 6. Operación
- Actualizar: `git pull && docker compose up -d --build`
- Logs: `docker compose logs -f eticket`
- Estado: `docker compose ps` · salud de la app: `GET /healthz`
- Reiniciar no cierra las sesiones (se guardan en la base). Es una sola instancia.

## Sin Docker
`npm ci --omit=dev && npm start` (Node 22+, gestor como systemd o pm2) con un proxy HTTPS propio delante.
