#!/usr/bin/env bash
#
# Update-Skript für die Checklisten-App auf einem Proxmox-Host / LXC.
# Wird per Cron oder systemd-Timer regelmäßig aufgerufen ODER manuell als root.
#
# Verhalten:
#   1. Sucht eine Trigger-Datei (im Volume `checklisten-state` unter
#      /update-requested.flag). Existiert sie, wird das Update ausgeführt.
#   2. Optional: `--force` ignoriert die Flag-Datei und aktualisiert immer.
#   3. Sichert vor dem Update Postgres + Attachments.
#   4. `git pull` im Repo, dann `docker compose --profile prod up -d --build`.
#   5. Entfernt die Flag-Datei.
#
# Konfiguration über Umgebungsvariablen oder Defaults unten:
#   APP_DIR        = Pfad zum Checklisten-Tool-Repo (Default: /opt/checklisten)
#   BACKUP_DIR     = Wohin werden Backups geschrieben (Default: /opt/checklisten/backups)
#   COMPOSE_FILE   = Pfad zur compose-Datei (Default: $APP_DIR/docker-compose.yml)
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/checklisten}"
BACKUP_DIR="${BACKUP_DIR:-$APP_DIR/backups}"
COMPOSE_FILE="${COMPOSE_FILE:-$APP_DIR/docker-compose.yml}"

FORCE=0
if [[ "${1:-}" == "--force" ]]; then FORCE=1; fi

cd "$APP_DIR"

# Resolve flag file path inside the host – it's mounted to the container's /data
FLAG_FILE=$(docker volume inspect checklisten-tool_checklisten-state 2>/dev/null \
  | grep -oE '"Mountpoint": "[^"]+"' \
  | head -1 | cut -d'"' -f4 | sed 's|$|/update-requested.flag|')

if [[ $FORCE -eq 0 ]]; then
  if [[ -z "$FLAG_FILE" || ! -f "$FLAG_FILE" ]]; then
    echo "Keine Update-Anforderung gefunden – nichts zu tun."
    exit 0
  fi
  echo "Update-Anforderung gefunden ($(cat "$FLAG_FILE")) – starte Update."
fi

mkdir -p "$BACKUP_DIR"
TS=$(date +%Y%m%d-%H%M%S)

echo "==> Backup Postgres"
docker exec checklisten-postgres pg_dump -U checklisten checklisten \
  > "$BACKUP_DIR/db-$TS.sql"

echo "==> Backup Anhänge"
docker run --rm \
  -v checklisten-tool_checklisten-attachments:/data:ro \
  -v "$BACKUP_DIR":/backup \
  alpine tar -czf "/backup/attachments-$TS.tgz" -C /data . 2>/dev/null || true

echo "==> Git pull"
git pull --ff-only

VERSION=$(cat VERSION 2>/dev/null || echo "dev")
echo "==> Build + Restart (Version $VERSION)"
APP_VERSION="$VERSION" docker compose -f "$COMPOSE_FILE" --profile prod up -d --build api

# Remove the flag after a successful run
if [[ -n "$FLAG_FILE" && -f "$FLAG_FILE" ]]; then
  rm -f "$FLAG_FILE"
fi

# Keep the last 14 backups
ls -1t "$BACKUP_DIR"/db-*.sql 2>/dev/null         | tail -n +15 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/attachments-*.tgz 2>/dev/null | tail -n +15 | xargs -r rm -f

echo "Update abgeschlossen."
