#!/bin/sh
# Instalador de E-Ticket TI para un servidor LINUX (Ubuntu, Debian, RHEL/Rocky/Alma...).
# Instala Docker si hace falta, descarga el sistema, crea la configuración, lo arranca con HTTPS y programa el respaldo diario.
#
#   Desde una copia ya descargada:   sudo ./scripts/install-server.sh
#   Sin descargar nada antes:        curl -fsSL https://raw.githubusercontent.com/samauel05-byte/e-ticket/main/scripts/install-server.sh | sudo sh
#
# Variables opcionales: INSTALL_DIR (por defecto /opt/e-ticket), ETICKET_BRANCH (main), ETICKET_REPO,
#   SETUP_ARGS (respuestas del asistente sin preguntar, p. ej. "--yes --domain grupodupla.com --site tickets.grupodupla.com ...")
set -eu

REPO="${ETICKET_REPO:-https://github.com/samauel05-byte/e-ticket}"
BRANCH="${ETICKET_BRANCH:-main}"

say() { printf '\n==> %s\n' "$*"; }
warn() { printf '\n[aviso] %s\n' "$*" >&2; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = "Linux" ] || die "Este instalador es para servidores Linux. En Windows o macOS mira INSTALL.md."

if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1 && [ -f "$0" ]; then exec sudo -E sh "$0" "$@"; fi
  die "Ejecútalo como administrador:  sudo ./scripts/install-server.sh"
fi

# ¿Se ejecuta desde una copia descargada? Entonces se instala ahí mismo.
SCRIPT_DIR=""
if [ -f "$0" ]; then SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd); fi
if [ -n "$SCRIPT_DIR" ] && [ -f "$SCRIPT_DIR/../docker-compose.yml" ]; then
  DIR=$(cd "$SCRIPT_DIR/.." && pwd)
else
  DIR="${INSTALL_DIR:-/opt/e-ticket}"
fi

install_pkg() {
  if command -v apt-get >/dev/null 2>&1; then apt-get update -y && apt-get install -y "$@"
  elif command -v dnf >/dev/null 2>&1; then dnf install -y "$@"
  elif command -v yum >/dev/null 2>&1; then yum install -y "$@"
  else die "No sé instalar '$*' en este sistema. Instálalo a mano y vuelve a ejecutar el instalador."; fi
}

# 1. Docker
if ! command -v docker >/dev/null 2>&1; then
  say "Instalando Docker"
  command -v curl >/dev/null 2>&1 || install_pkg curl ca-certificates
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker >/dev/null 2>&1 || true
docker compose version >/dev/null 2>&1 || die "Falta el complemento 'docker compose'. Instala docker-compose-plugin y vuelve a ejecutar."

# 2. El sistema
if [ ! -f "$DIR/docker-compose.yml" ]; then
  say "Descargando E-Ticket TI en $DIR"
  command -v git >/dev/null 2>&1 || install_pkg git
  git clone --branch "$BRANCH" "$REPO" "$DIR"
elif [ -z "$SCRIPT_DIR" ] && [ -d "$DIR/.git" ]; then
  say "Actualizando $DIR"
  git -C "$DIR" pull --ff-only
fi
cd "$DIR"

# 3. Configuración (.env). El asistente corre dentro de Docker: no hace falta instalar Node.
if [ ! -f .env ]; then
  say "Configuración inicial"
  if [ -n "${SETUP_ARGS:-}" ]; then
    # shellcheck disable=SC2086
    docker run --rm -v "$DIR":/app -w /app node:22-slim node scripts/setup.js --mode docker $SETUP_ARGS </dev/null
  elif [ -r /dev/tty ]; then
    echo "Responde las preguntas (Enter acepta el valor entre corchetes). Las contraseñas solo se guardan en $DIR/.env"
    docker run --rm -it -v "$DIR":/app -w /app node:22-slim node scripts/setup.js --mode docker </dev/tty
  else
    die "No hay terminal para las preguntas. Copia .env.example a .env, edítalo y vuelve a ejecutar."
  fi
  chmod 600 .env
else
  say "Ya existe $DIR/.env: se conserva tal cual"
fi
mkdir -p data certs
chown -R 1000:1000 data

# 4. Arranque
say "Construyendo y arrancando (la primera vez tarda unos minutos)"
docker compose up -d --build

printf 'Esperando a que responda'
n=0
until docker compose exec -T eticket node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" >/dev/null 2>&1; do
  n=$((n + 1))
  [ "$n" -gt 90 ] && { echo; docker compose logs --tail 40 eticket; die "El sistema no arrancó. Revisa el mensaje de arriba."; }
  printf '.'; sleep 1
done
echo " listo"

# 5. Correo: comprobar lo configurado
if grep -Eq '^(INBOX_HOST|SMTP_HOST)=' .env; then
  say "Comprobando el correo"
  docker compose exec -T eticket node scripts/check-mail.js || warn "El correo tiene problemas (arriba se explica cuál). Corrige el archivo $DIR/.env y ejecuta:  cd $DIR && docker compose up -d && docker compose exec eticket node scripts/check-mail.js"
fi

# 6. Respaldo diario a las 2:00 (base de datos y adjuntos, quedan en data/backups)
if [ -d /etc/cron.d ]; then
  cat > /etc/cron.d/eticket-backup <<CRON
0 2 * * * root cd $DIR && docker compose exec -T eticket node scripts/backup.js --dest /app/data/backups >> /var/log/eticket-backup.log 2>&1
CRON
  chmod 644 /etc/cron.d/eticket-backup
  say "Respaldo diario programado (copias en $DIR/data/backups; copia esa carpeta y data/uploads a otro equipo)"
fi

APP_URL=$(sed -n 's/^APP_URL=//p' .env | head -n 1)
say "Instalación terminada"
docker compose ps
cat <<MSG

  Abre:  ${APP_URL:-https://localhost}
  Entra con tu correo de la empresa y la contraseña de tu correo. Quien tenga el correo de ADMIN_EMAIL queda como administrador.
  Luego, en Administración, asigna el rol "Técnico (TI)" a tu equipo y "Gerencia" a quien corresponda.
  Si el certificado es "internal", instala el certificado raíz en los equipos (ver DEPLOY.md).

  Actualizar:        cd $DIR && git pull && docker compose up -d --build
  Ver registros:     cd $DIR && docker compose logs -f eticket
  Probar el correo:  cd $DIR && docker compose exec eticket node scripts/check-mail.js
MSG
