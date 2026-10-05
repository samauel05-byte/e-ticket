#!/bin/sh
# Respaldo consistente de la base de datos y los adjuntos.
# Uso: ./scripts/backup.sh [carpeta_destino]   (por defecto ./backups)
set -e
DEST="${1:-./backups}"; DATA="${DATA_DIR:-./data}"; STAMP=$(date +%Y%m%d-%H%M%S)
mkdir -p "$DEST"
node -e "const D=require('better-sqlite3');new D('$DATA/eticket.db',{readonly:true}).backup('$DEST/eticket-$STAMP.db').then(()=>process.exit(0))"
[ -d "$DATA/uploads" ] && tar -czf "$DEST/uploads-$STAMP.tar.gz" -C "$DATA" uploads
echo "Respaldo en $DEST ($STAMP)"
