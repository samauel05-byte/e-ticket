# Instalación (Windows, Linux y macOS)

Hay dos formas. Las dos funcionan igual en los tres sistemas porque los scripts de instalación están hechos en Node.js.

| | **A. Con Docker** (recomendada) | **B. Directa con Node** |
|---|---|---|
| HTTPS automático (Caddy + Let's Encrypt) | Sí | No incluido: pones tu propio proxy |
| Qué instalas | Docker | Node.js 22 |
| Mejor para | Servidor de producción | Pruebas rápidas o equipos sin Docker |

> Para **probar** sin instalar nada en tu PC, usa la máquina virtual con VirtualBox: ver [TEST.md](TEST.md).

## A. Con Docker

1. **Instala Docker**
   - Windows y macOS: [Docker Desktop](https://www.docker.com/products/docker-desktop/) (en Windows necesita WSL 2).
   - Linux: `curl -fsSL https://get.docker.com | sh`
2. **Descarga el sistema** (necesitas [Git](https://git-scm.com/downloads)):
   ```
   git clone https://github.com/samauel05-byte/e-ticket
   cd e-ticket
   ```
3. **Instala [Node.js 22](https://nodejs.org/) solo para el asistente** y ejecútalo (sirve el mismo comando en los tres sistemas):
   ```
   node scripts/setup.js --mode docker
   ```
   Te pregunta el dominio de correo, el administrador, la zona horaria, IMAP, SMTP y el nombre con el que se abrirá, y crea el archivo `.env` con una clave secreta aleatoria. *(Si prefieres no instalar Node: copia `.env.example` a `.env` y edítalo a mano.)*
4. **Arranca**:
   ```
   docker compose up -d --build
   ```
5. Abre la dirección que elegiste (por ejemplo `https://tickets.empresa.local`). Para el certificado, el acceso desde internet y los respaldos ver [DEPLOY.md](DEPLOY.md).

## B. Directa con Node (sin Docker)

1. **Instala Node.js 22 o superior**
   - Windows: `winget install OpenJS.NodeJS.LTS` (o el instalador de nodejs.org).
   - macOS: `brew install node@22` (o el instalador de nodejs.org).
   - Linux: nodejs.org o `nvm install 22`.
2. **Descarga e instala**:
   ```
   git clone https://github.com/samauel05-byte/e-ticket
   cd e-ticket
   npm ci --omit=dev
   node scripts/setup.js --mode native
   ```
3. **Arranca**: `npm start` y abre `http://localhost:3000`.
4. **Que arranque solo con el equipo** (con [pm2](https://pm2.keymetrics.io/), igual en los tres sistemas):
   ```
   npm install -g pm2
   pm2 start src/server.js --name eticket
   pm2 save
   pm2 startup        # sigue la instrucción que imprime (en Windows: usa el programador de tareas o pm2-windows-startup)
   ```
5. **HTTPS:** el sistema habla HTTP. Para usarlo fuera de tu equipo pon delante un proxy con certificado ([Caddy](https://caddyserver.com/download) tiene versión para Windows, Linux y macOS) y vuelve a ejecutar `node scripts/setup.js --mode native --force` indicando que va detrás de HTTPS (o pon `COOKIE_SECURE=true` y `TRUST_PROXY=true` en `.env`).
6. Abre el puerto en el firewall del sistema si otros equipos van a conectarse.

## Respaldos (igual en los tres sistemas)
```
node scripts/backup.js --dest ./backups        # instalación directa
node scripts/backup.js --docker                # instalación con Docker (copia en ./data/backups)
```
Prográmalo cada día: cron (Linux/macOS), `launchd` (macOS) o el Programador de tareas (Windows).

## Actualizar
```
git pull
docker compose up -d --build        # con Docker
npm ci --omit=dev && pm2 restart eticket     # directa
```

## Problemas comunes
- **Windows: "`./scripts/...` no se reconoce"**: en Windows se usa `node scripts/...` o `scripts\...cmd`, no `./`.
- **`npm ci` falla compilando `better-sqlite3`**: normalmente baja un binario ya compilado; si no lo encuentra, instala las herramientas de compilación (Windows: "Build Tools for Visual Studio"; macOS: `xcode-select --install`; Linux: `apt install build-essential python3`).
- **Docker Desktop y VirtualBox a la vez en Windows**: pueden chocar por la virtualización. Para pruebas usa la máquina virtual de [TEST.md](TEST.md) en vez de Docker Desktop.
