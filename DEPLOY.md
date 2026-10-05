# Despliegue

## Con Docker (recomendado)
```bash
cp .env.example .env     # edita: ALLOWED_DOMAIN, ADMIN_EMAIL, SESSION_SECRET, IMAP_*, SMTP_*, APP_URL
docker compose up -d --build
```
La base de datos y los adjuntos viven en el volumen `eticket-data`. Salud: `GET /healthz`.

## Sin Docker
`npm ci --omit=dev && npm start` (Node 22+). Usa un gestor como systemd o pm2.

## HTTPS (obligatorio: la contraseña del correo viaja al servidor)
Pon un proxy inverso (nginx, Caddy, Traefik) con certificado delante de la app y define en `.env`:
```
COOKIE_SECURE=true
TRUST_PROXY=true
APP_URL=https://tickets.empresa.com
```
Ejemplo Caddy: `tickets.empresa.com { reverse_proxy localhost:3000 }`

## Variables mínimas
`SESSION_SECRET` (cadena larga aleatoria), `ALLOWED_DOMAIN`, `ADMIN_EMAIL`, `IMAP_HOST`, `SMTP_HOST`.
Las sesiones se guardan en memoria: al reiniciar, los usuarios deben volver a entrar. Una sola instancia.

## Respaldos
`./scripts/backup.sh /ruta/respaldos` (base consistente + adjuntos). Prográmalo con cron, p. ej. diario.
En Docker, respalda el volumen `eticket-data` (p. ej. `docker run --rm -v e-ticket_eticket-data:/d -v $PWD:/b alpine tar czf /b/data.tgz -C /d .`).
