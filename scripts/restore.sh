#!/usr/bin/env bash
#
# Restore-Skript für die Checklisten-App.
# Stellt einen Postgres-Dump und ein Anhänge-Tar wieder her.
#
# Aufruf:
#   ./restore.sh <db-backup.sql.gz> [attachments-backup.tgz]
#
# Beide Argumente sind Pfade ZUR Backup-Datei (relativ oder absolut).
# Container muss laufen.
#
set -euo pipefail

if [[ $# -lt 1 ]]; then
    cat <<EOF
Verwendung: $0 <db-backup.sql.gz> [attachments-backup.tgz]

Beispiel:
    $0 /opt/checklisten/backups/db-20260603-023000.sql.gz \\
       /opt/checklisten/backups/attachments-20260603-023000.tgz
EOF
    exit 1
fi

DB_BACKUP="$1"
ATT_BACKUP="${2:-}"

DB_CONTAINER="${DB_CONTAINER:-checklisten-postgres}"
API_CONTAINER="${API_CONTAINER:-checklisten-api}"
ATTACHMENTS_VOLUME="${ATTACHMENTS_VOLUME:-checklisten-tool_checklisten-attachments}"

[[ -f "$DB_BACKUP" ]] || { echo "FEHLER: $DB_BACKUP nicht gefunden" >&2; exit 1; }
if [[ -n "$ATT_BACKUP" && ! -f "$ATT_BACKUP" ]]; then
    echo "FEHLER: $ATT_BACKUP nicht gefunden" >&2; exit 1
fi

echo "⚠️  Achtung: das überschreibt die laufende Datenbank und die Anhänge!"
read -p "Wirklich fortfahren? [yes/N] " confirm
[[ "$confirm" == "yes" ]] || { echo "Abgebrochen."; exit 0; }

echo "==> Stoppe API, damit sie nicht in die DB schreibt"
docker stop "$API_CONTAINER" 2>/dev/null || true

echo "==> DB löschen und neu anlegen"
docker exec -i "$DB_CONTAINER" psql -U checklisten -d postgres -c \
    "DROP DATABASE IF EXISTS checklisten;"
docker exec -i "$DB_CONTAINER" psql -U checklisten -d postgres -c \
    "CREATE DATABASE checklisten OWNER checklisten;"

echo "==> DB-Dump einspielen aus $DB_BACKUP"
gunzip -c "$DB_BACKUP" | docker exec -i "$DB_CONTAINER" psql -U checklisten -d checklisten

if [[ -n "$ATT_BACKUP" ]]; then
    echo "==> Anhänge wiederherstellen aus $ATT_BACKUP"
    # Volume leeren, dann Tar entpacken
    docker run --rm -v "$ATTACHMENTS_VOLUME":/data alpine sh -c 'rm -rf /data/*'
    docker run --rm -v "$ATTACHMENTS_VOLUME":/data -v "$(realpath "$ATT_BACKUP")":/backup.tgz:ro \
        alpine tar -xzf /backup.tgz -C /data
fi

echo "==> API wieder starten"
docker start "$API_CONTAINER" 2>/dev/null || \
    docker compose --profile prod -f /opt/checklisten/docker-compose.yml up -d api

echo "Restore abgeschlossen. Bitte einmal /api/health prüfen."
