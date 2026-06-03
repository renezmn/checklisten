#!/usr/bin/env bash
#
# Update-Skript für die Checklisten-App auf einem Proxmox-Host / LXC.
# Wird per systemd-Timer regelmäßig aufgerufen ODER manuell als root.
#
# Verhalten:
#   - Ohne Argument: prüft, ob die Trigger-Datei existiert. Wenn ja → Update.
#   - --force: ignoriert die Trigger-Datei und aktualisiert immer.
#              Geeignet auch für den allerersten Bootstrap.
#
# Konfiguration über Umgebungsvariablen oder Defaults unten.
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/checklisten}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.yml}"
API_CONTAINER="${API_CONTAINER:-checklisten-api}"
DB_CONTAINER="${DB_CONTAINER:-checklisten-postgres}"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then FORCE=1; fi

log()  { echo "[$(date +%H:%M:%S)] $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

have docker         || { echo "FEHLER: docker nicht installiert"; exit 1; }
have docker-compose || have_compose_plugin=1
[[ -d "$APP_DIR/.git" ]] || { echo "FEHLER: $APP_DIR ist kein Git-Repo"; exit 1; }

cd "$APP_DIR"

# ---- Flag-Datei auflösen: aus den /data-Mount des laufenden API-Containers --
# Das funktioniert egal wie das Volume in compose heißt.
FLAG_FILE=""
if docker ps --format '{{.Names}}' | grep -q "^${API_CONTAINER}$"; then
    STATE_MOUNT=$(docker inspect "$API_CONTAINER" --format \
        '{{ range .Mounts }}{{ if eq .Destination "/data" }}{{ .Source }}{{ end }}{{ end }}')
    if [[ -n "$STATE_MOUNT" && -d "$STATE_MOUNT" ]]; then
        FLAG_FILE="$STATE_MOUNT/update-requested.flag"
    fi
fi

if [[ $FORCE -eq 0 ]]; then
    if [[ -z "$FLAG_FILE" ]]; then
        log "API-Container nicht gefunden oder /data-Mount fehlt – App vermutlich nie gestartet."
        log "Erst-Setup: $0 --force"
        exit 0
    fi
    if [[ ! -f "$FLAG_FILE" ]]; then
        log "Keine Update-Anforderung gefunden – nichts zu tun."
        exit 0
    fi
    log "Update-Anforderung gefunden ($(cat "$FLAG_FILE")) – starte Update."
fi

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)

# ---- Backups nur, wenn Container/Volumes existieren -------------------------
if docker ps --format '{{.Names}}' | grep -q "^${DB_CONTAINER}$"; then
    log "Backup Postgres → $BACKUP_DIR/db-$TS.sql.gz"
    docker exec "$DB_CONTAINER" pg_dump -U checklisten checklisten | gzip > "$BACKUP_DIR/db-$TS.sql.gz"
else
    log "Kein laufender ${DB_CONTAINER} – überspringe DB-Backup"
fi

ATTACH_MOUNT=""
if docker ps --format '{{.Names}}' | grep -q "^${API_CONTAINER}$"; then
    ATTACH_MOUNT=$(docker inspect "$API_CONTAINER" --format \
        '{{ range .Mounts }}{{ if eq .Destination "/data/attachments" }}{{ .Source }}{{ end }}{{ end }}')
fi
if [[ -n "$ATTACH_MOUNT" && -d "$ATTACH_MOUNT" ]]; then
    log "Backup Anhänge → $BACKUP_DIR/attachments-$TS.tgz"
    tar -czf "$BACKUP_DIR/attachments-$TS.tgz" -C "$ATTACH_MOUNT" . 2>/dev/null \
        || log "Anhänge-Backup übersprungen (Verzeichnis leer?)"
else
    log "Kein Anhänge-Mount gefunden – überspringe Anhänge-Backup"
fi

# ---- Quellen aktualisieren --------------------------------------------------
log "git pull"
git pull --ff-only

VERSION=$(cat VERSION 2>/dev/null || echo "dev")
log "Build + Restart der API mit APP_VERSION=$VERSION"

# .env wird von docker compose automatisch geladen; APP_VERSION überschreiben wir hier
APP_VERSION="$VERSION" docker compose -f "$COMPOSE_FILE" --profile prod up -d --build

# ---- Aufräumen --------------------------------------------------------------
if [[ -n "$FLAG_FILE" && -f "$FLAG_FILE" ]]; then
    rm -f "$FLAG_FILE"
    log "Trigger-Flag entfernt"
fi

# Letzte 14 Backups behalten
ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null      | tail -n +15 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/attachments-*.tgz 2>/dev/null | tail -n +15 | xargs -r rm -f

log "Update abgeschlossen."
