#!/bin/sh
# Ambiente de prueba con Docker. Uso: ./scripts/test-env.sh up | down | reset | logs
set -e
F="-f docker-compose.test.yml"
case "$1" in
  up)
    docker compose $F up -d --build
    printf "Esperando a que arranque"
    i=0
    until docker compose $F exec -T eticket node -e "fetch('http://localhost:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))" 2>/dev/null; do
      i=$((i+1)); [ "$i" -gt 60 ] && { echo; echo "No arrancó; revisa: ./scripts/test-env.sh logs"; exit 1; }
      printf "."; sleep 1
    done
    echo
    docker compose $F exec -T eticket node src/seedDemo.js
    cat <<MSG

  Sistema:           http://localhost:3000
  Bandeja de correo: http://localhost:8025   (aquí llegan los avisos)

  Usuarios (clave: prueba1234)
    admin@empresa.com    administrador
    tecnico@, samuel@ y laura@empresa.com  personal de TI
    ana@ / luis@ / marta@empresa.com   usuarios que piden tickets
MSG
    ;;
  down) docker compose $F down ;;
  reset) docker compose $F down -v; "$0" up ;;
  logs) docker compose $F logs -f eticket ;;
  *) echo "Uso: $0 up | down | reset | logs"; exit 1 ;;
esac
