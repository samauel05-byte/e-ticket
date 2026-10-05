#!/bin/sh
# Prepara las carpetas locales para Docker. Ejecutar una vez, desde la raíz del proyecto.
set -e
mkdir -p data certs
# El contenedor corre como el usuario "node" (uid 1000) y debe poder escribir en ./data
chown -R 1000:1000 data 2>/dev/null || sudo chown -R 1000:1000 data
[ -f .env ] || { cp .env.example .env; echo "Creado .env: edítalo antes de continuar."; }
echo "Listo. Siguiente: editar .env y ejecutar  docker compose up -d --build"
