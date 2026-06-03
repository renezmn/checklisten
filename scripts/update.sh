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
STATE_VOLUME="${STATE_VOLUME:-checklisten-tool_checklisten-state}"
ATTACHMENTS_VOLUME="${ATTACHMENTS_VOLUME:-checklisten-tool_checklisten-attachments}"
DB_CONTAINER="${DB_CONTAINER:-checklisten-postgres}"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then FORCE=1; fi

log()  { echo "[$(date +%H:%M:%S)] $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

have docker         || { echo "FEHLER: docker nicht installiert"; exit 1; }
have docker-compose || have_compose_plugin=1
[[ -d "$APP_DIR/.git" ]] || { echo "FEHLER: $APP_DIR ist kein Git-Repo"; exit 1; }

cd "$APP_DIR"

# ---- Flag-Datei auflösen (Volume muss noch nicht existieren) ----------------
FLAG_FILE=""
if docker volume inspect "$STATE_VOLUME" >/dev/null 2>&1; then
    MOUNT=$(docker volume inspect "$STATE_VOLUME" --format '{{.Mountpoint}}')
    FLAG_FILE="$MOUNT/update-requested.flag"
fi

if [[ $FORCE -eq 0 ]]; then
    if [[ -z "$FLAG_FILE" ]]; then
        log "Volume $STATE_VOLUME existiert noch nicht – App vermutlich nie gestartet."
        log "Erst-Setup: ./scripts/update.sh --force"
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

if docker volume inspect "$ATTACHMENTS_VOLUME" >/dev/null 2>&1; then
    log "Backup Anhänge → $BACKUP_DIR/attachments-$TS.tgz"
    docker run --rm \
        -v "$ATTACHMENTS_VOLUME":/data:ro \
        -v "$BACKUP_DIR":/backup \
        alpine tar -czf "/backup/attachments-$TS.tgz" -C /data . 2>/dev/null || \
        log "Anhänge-Backup übersprungen (Volume leer?)"
else
    log "Kein Anhänge-Volume vorhanden – überspringe"
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
