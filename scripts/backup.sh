#!/usr/bin/env bash
#
# Backup-Skript für die Checklisten-App.
# Sichert Postgres-Datenbank und Anhänge-Volume in $BACKUP_DIR.
# Hält automatisch die letzten N Backups vor und löscht ältere.
#
# Aufruf:
#   ./backup.sh           # Standard-Backup, Logs nach stdout
#   ./backup.sh --quiet   # Nur Fehler ausgeben (für Cron)
#
# Empfohlener Cron (siehe docs/proxmox-setup.md):
#   30 2 * * * root /opt/checklisten/scripts/backup.sh --quiet >> /var/log/checklisten-backup.log 2>&1
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/checklisten}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
KEEP="${BACKUP_KEEP:-30}"          # Anzahl Backups, die behalten werden
DB_CONTAINER="${DB_CONTAINER:-checklisten-postgres}"
ATTACHMENTS_VOLUME="${ATTACHMENTS_VOLUME:-checklisten-tool_checklisten-attachments}"

QUIET=0
if [[ "${1:-}" == "--quiet" ]]; then QUIET=1; fi
log() { [[ $QUIET -eq 1 ]] || echo "[$(date +%H:%M:%S)] $*"; }

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)
DB_FILE="$BACKUP_DIR/db-$TS.sql.gz"
ATT_FILE="$BACKUP_DIR/attachments-$TS.tgz"

# ---- Postgres ----------------------------------------------------------------
log "Sichere Postgres → $DB_FILE"
if ! docker exec "$DB_CONTAINER" pg_dump -U checklisten checklisten | gzip > "$DB_FILE"; then
    echo "FEHLER: pg_dump fehlgeschlagen" >&2
    rm -f "$DB_FILE"
    exit 1
fi
# Sanity check – ein leeres Backup wäre verdächtig
if [[ $(stat -c%s "$DB_FILE" 2>/dev/null || stat -f%z "$DB_FILE") -lt 200 ]]; then
    echo "FEHLER: DB-Backup ist verdächtig klein (<200 B): $DB_FILE" >&2
    exit 1
fi

# ---- Anhänge -----------------------------------------------------------------
log "Sichere Anhänge → $ATT_FILE"
if ! docker run --rm \
        -v "$ATTACHMENTS_VOLUME":/data:ro \
        -v "$BACKUP_DIR":/backup \
        alpine tar -czf "/backup/attachments-$TS.tgz" -C /data . 2>/dev/null; then
    echo "WARNUNG: Anhänge-Backup fehlgeschlagen (Volume leer?)" >&2
    # Kein hartes Exit – ohne hochgeladene Bilder ist das Volume manchmal leer
fi

# ---- Rotation ----------------------------------------------------------------
log "Behalte die letzten $KEEP Backups, lösche ältere"
# shellcheck disable=SC2012
ls -1t "$BACKUP_DIR"/db-*.sql.gz 2>/dev/null    | tail -n +$((KEEP + 1)) | xargs -r rm -f
ls -1t "$BACKUP_DIR"/attachments-*.tgz 2>/dev/null | tail -n +$((KEEP + 1)) | xargs -r rm -f

# Übersicht
DB_COUNT=$(ls -1 "$BACKUP_DIR"/db-*.sql.gz       2>/dev/null | wc -l)
AT_COUNT=$(ls -1 "$BACKUP_DIR"/attachments-*.tgz 2>/dev/null | wc -l)
log "Fertig: $DB_COUNT DB-Backups, $AT_COUNT Anhänge-Backups in $BACKUP_DIR"

# ---- Optional: Offsite-Kopie -------------------------------------------------
# Auf NAS oder zweiten Server kopieren. Empfohlen!
# Beispiel rsync (passe Pfad/Host an):
#
# RSYNC_TARGET="${RSYNC_TARGET:-backup@nas.dp-elektronik.de:/srv/backups/checklisten/}"
# if [[ -n "$RSYNC_TARGET" ]]; then
#     log "Kopiere nach $RSYNC_TARGET"
#     rsync -az --delete-after \
#         --include 'db-*.sql.gz' --include 'attachments-*.tgz' --exclude '*' \
#         "$BACKUP_DIR/" "$RSYNC_TARGET"
# fi
