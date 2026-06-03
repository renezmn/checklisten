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
APP_DIR="${APP_DIR:-/opt/checklisten}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.yml}"

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
    # Pfad zum Anhänge-Volume holen – API-Container ist gestoppt, daher zurück über docker inspect
    ATTACH_MOUNT=$(docker inspect "$API_CONTAINER" --format \
        '{{ range .Mounts }}{{ if eq .Destination "/data/attachments" }}{{ .Source }}{{ end }}{{ end }}')
    if [[ -z "$ATTACH_MOUNT" ]]; then
        echo "FEHLER: Konnte Anhänge-Mount nicht ermitteln (API-Container nicht vorhanden?)" >&2
        exit 1
    fi
    rm -rf "$ATTACH_MOUNT"/*
    tar -xzf "$ATT_BACKUP" -C "$ATTACH_MOUNT"
fi

echo "==> API wieder starten"
docker start "$API_CONTAINER" 2>/dev/null || \
    docker compose --profile prod -f "$COMPOSE_FILE" up -d api

echo "Restore abgeschlossen. Bitte einmal /api/health prüfen."
