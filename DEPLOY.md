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

## 7. Publicar en internet (usuarios fuera de la oficina)
Con el login por IMAP la clave real del correo viaja a esta página, así que **solo se publica con HTTPS válido** y con las defensas de abajo.

**Qué necesitas**
1. **Un nombre público**, p. ej. `tickets.tuempresa.com` (registro DNS tipo A hacia la IP pública de la oficina o del servidor).
2. **IP pública fija** (o DNS dinámico) y, en el router/firewall, reenviar los puertos **80 y 443** al servidor. El puerto 80 lo necesita Let's Encrypt para validar y para redirigir a HTTPS.
3. En `.env`:
   ```
   SITE_ADDRESS=tickets.tuempresa.com
   CADDY_TLS=correo-del-admin@tuempresa.com    # Let's Encrypt: Caddy obtiene y renueva el certificado solo
   APP_URL=https://tickets.tuempresa.com
   COOKIE_SECURE=true
   TRUST_PROXY=true
   ```
   Luego `docker compose up -d`. Con un certificado válido los usuarios **no** necesitan instalar nada.
4. **DNS interno (recomendado):** que dentro de la oficina `tickets.tuempresa.com` resuelva a la IP *local* del servidor; muchos routers no soportan acceder a su propia IP pública.
5. **No expongas nada más:** abre solo 80 y 443. Los puertos del servidor IMAP/SMTP **no** deben ser públicos (la app los usa desde dentro).

**Defensas incluidas (ajustables en `.env`)**
| Defensa | Variable (por defecto) |
|---|---|
| Bloqueo por IP tras fallos de login, guardado en la base (sobrevive a reinicios) | `LOGIN_MAX_PER_IP=20` en `LOGIN_WINDOW_MIN=15` |
| Bloqueo por correo tras fallos | `LOGIN_MAX_PER_EMAIL=8` |
| Retraso de ~0,4 s en cada fallo (frena la fuerza bruta) | `LOGIN_FAIL_DELAY_MS=400` |
| Tope de comprobaciones simultáneas contra el servidor IMAP (lo protege de saturación) | `IMAP_MAX_CONCURRENT=5` |
| Administración y Reportes solo desde la red interna | `INTERNAL_CIDRS=192.168.0.0/16,10.0.0.0/8` (vacío = sin restricción) |
| Sin sesión, la API solo muestra lo mínimo para el login | siempre |
| HTTPS obligatorio, cookie `Secure`, HSTS y cabeceras de seguridad | `COOKIE_SECURE=true` |

Notas:
- El bloqueo por correo permite que alguien bloquee a propósito a un compañero durante la ventana (15 min). Es el costo de frenar la fuerza bruta; si ocurre, sube `LOGIN_MAX_PER_EMAIL` o baja `LOGIN_WINDOW_MIN`.
- Los fallos se registran en los logs (`docker compose logs eticket | grep "login fallido"`). Úsalos para detectar ataques.
- Caddy reemplaza la cabecera `X-Forwarded-For` con la IP real del cliente; no pongas otro proxy delante sin ajustar `TRUST_PROXY`.
- **Riesgos que no cubre el sistema:** suplantación (alguien monta una página falsa y pide la clave del correo) y contraseñas filtradas de otros sitios. Avisa a los usuarios la dirección oficial y, si es posible, activa verificación en dos pasos en el correo. La alternativa más segura sería un código por correo en vez de la clave (no implementado).
- Mantén el servidor actualizado (`apt upgrade`, y `git pull && docker compose up -d --build` para el sistema) y revisa los respaldos.

## Sin Docker
`npm ci --omit=dev && npm start` (Node 22+, gestor como systemd o pm2) con un proxy HTTPS propio delante.
