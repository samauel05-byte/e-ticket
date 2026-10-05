#!/bin/sh
# Respaldo consistente de la base de datos (con la app en marcha) dentro de ./data/backups.
# Los adjuntos ya están en ./data/uploads. Copia luego ./data/backups y ./data/uploads fuera del servidor.
# Uso: ./scripts/backup-docker.sh [dias_a_conservar]   (por defecto 14)
set -e
KEEP="${1:-14}"
STAMP=$(date +%Y%m%d-%H%M%S)
docker compose exec -T eticket node -e "
const D=require('better-sqlite3');
const fs=require('fs');fs.mkdirSync('/app/data/backups',{recursive:true});
new D('/app/data/eticket.db',{readonly:true}).backup('/app/data/backups/eticket-$STAMP.db')
  .then(()=>console.log('Respaldo: data/backups/eticket-$STAMP.db')).catch(e=>{console.error(e);process.exit(1)})"
find ./data/backups -name 'eticket-*.db' -mtime +"$KEEP" -delete
