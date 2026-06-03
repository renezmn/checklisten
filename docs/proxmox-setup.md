# Proxmox-Setup: Checklisten-App mit GitHub-basiertem Update

Schritt-für-Schritt-Anleitung für einen Production-Aufbau auf Proxmox VE mit:

- LXC-Container, Debian 12
- Docker + Docker-Compose
- GitHub-Repo (privat) als Code-Quelle
- systemd-Timer für Auto-Update über den Admin-Button
- Caddy als Reverse-Proxy mit automatischem HTTPS (Let's Encrypt)
- Tägliches Backup-Cron

Wenn du noch nie einen LXC erstellt hast: das Proxmox-Web-UI führt dich da durch.
Diese Doku zeigt nur die App-spezifischen Schritte.

---

## 1. GitHub-Repo anlegen (einmalig, auf deinem PC)

```bash
cd C:\Users\zachmann\Checklisten-Tool
git init -b main
git add .
git commit -m "Initial: Checklisten-App"

# Auf github.com ein privates Repo anlegen (z. B. dp-elektronik/checklisten),
# DANN das Remote hinzufügen:
git remote add origin git@github.com:dp-elektronik/checklisten.git
git push -u origin main
```

Wenn du noch keinen SSH-Key für GitHub hast: `ssh-keygen -t ed25519` und den
Public-Key bei github.com → Settings → SSH-Keys hinterlegen.

---

## 2. Proxmox-LXC anlegen

Im Proxmox-Web-UI „Create CT":

- **Hostname**: `checklisten`
- **Template**: `debian-12-standard`
- **Disk**: 16 GB (8 reicht, mehr ist nett wegen Backups)
- **CPU**: 2 cores
- **RAM**: 1024 MB (Postgres + .NET passt)
- **Netzwerk**: feste IP empfohlen, oder DHCP mit Reservation
- **Features-Tab** (wichtig!):
  - ☑ **Nesting**
  - ☑ **keyctl**

Ohne Nesting/keyctl bricht Docker beim Start mit Pivot-Root-Fehlern.

Container starten und einloggen:

```bash
pct enter <vmid>     # vom Proxmox-Host aus
# oder per SSH wenn root@<ip> erlaubt ist
```

---

## 3. Docker + Git + grundlegende Tools installieren

```bash
apt update
apt install -y curl git ca-certificates openssh-client
# Docker (offizielles convenience-script):
curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

# Test
docker run --rm hello-world
```

---

## 4. SSH-Deploy-Key für das GitHub-Repo

Damit der LXC `git pull` machen darf:

```bash
mkdir -p /root/.ssh && chmod 700 /root/.ssh
ssh-keygen -t ed25519 -f /root/.ssh/checklisten_deploy -N ''
cat /root/.ssh/checklisten_deploy.pub
```

Den Public-Key kopieren → in GitHub im Repo unter
**Settings → Deploy keys → Add deploy key**, Write-Access *nicht* nötig (nur read).

`/root/.ssh/config` anlegen:

```
Host github.com
  HostName github.com
  User git
  IdentityFile /root/.ssh/checklisten_deploy
  IdentitiesOnly yes
```

Test:

```bash
ssh -T git@github.com
# Erwartete Antwort: "Hi <user>/checklisten! You've successfully authenticated, but GitHub does not provide shell access."
```

---

## 5. Repo klonen + ENV setzen

```bash
git clone git@github.com:dp-elektronik/checklisten.git /opt/checklisten
cd /opt/checklisten

# .env aus Vorlage erstellen
cp .env.example .env
nano .env
```

In der `.env` mindestens setzen:

```env
ADMIN_PASSWORD=einZufaelligesPasswort     # openssl rand -base64 18
APP_VERSION=0.1.0                          # was VERSION-Datei sagt
UPDATE_VERSION_URL=https://raw.githubusercontent.com/dp-elektronik/checklisten/main/VERSION
```

⚠️ Privates Repo? Dann braucht die Raw-URL einen Token (GitHub →
Settings → Personal Access Tokens, nur `repo:read`):

```env
UPDATE_VERSION_URL=https://ghp_xxxxxxxxxxxxxxxxxxxx@raw.githubusercontent.com/dp-elektronik/checklisten/main/VERSION
```

---

## 6. Erster Start

```bash
cd /opt/checklisten
docker compose --profile prod up -d --build
docker compose logs -f api    # Strg+C zum Beenden, läuft im Hintergrund weiter
```

Im Browser: `http://<lxc-ip>:8080` → Login `admin` / `<ADMIN_PASSWORD>` →
**sofort eigenes Admin-Konto anlegen und Seed-Admin deaktivieren oder
Passwort ändern**.

---

## 7. systemd-Timer für Auto-Updates

`/etc/systemd/system/checklisten-update.service`:

```ini
[Unit]
Description=Checklisten-App: Update ausführen, wenn Trigger gesetzt
After=docker.service
Wants=docker.service

[Service]
Type=oneshot
Environment=APP_DIR=/opt/checklisten
ExecStart=/opt/checklisten/scripts/update.sh
StandardOutput=journal
StandardError=journal
```

`/etc/systemd/system/checklisten-update.timer`:

```ini
[Unit]
Description=Checklisten-App: alle 5 Minuten auf Trigger prüfen

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=checklisten-update.service
Persistent=true

[Install]
WantedBy=timers.target
```

Aktivieren:

```bash
chmod +x /opt/checklisten/scripts/update.sh
systemctl daemon-reload
systemctl enable --now checklisten-update.timer
systemctl list-timers checklisten-update.timer
# Logs nach einem Lauf:
journalctl -u checklisten-update.service -n 50
```

Manueller Aufruf (testen):

```bash
/opt/checklisten/scripts/update.sh --force
```

---

## 8. HTTPS via Caddy (Reverse-Proxy)

Ohne HTTPS funktionieren die Browser-Features „Bildschirm aufnehmen" und
„Aus Zwischenablage einfügen" nicht. Caddy macht Let's Encrypt automatisch.

```bash
apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt update && apt install -y caddy
```

`/etc/caddy/Caddyfile`:

```caddy
checklisten.dp-elektronik.de {
    reverse_proxy localhost:8080
    encode gzip zstd
}
```

DNS für `checklisten.dp-elektronik.de` auf die öffentliche IP des Proxmox-Hosts
zeigen (oder per Reverse-Proxy weiter intern). Port 80 und 443 müssen vom
Internet zu Caddy durchreichen für die Let's-Encrypt-Validierung.

```bash
systemctl reload caddy
journalctl -u caddy -n 30   # auf "certificate obtained" prüfen
```

---

## 9. Backup-Cron

Das `update.sh` macht vor jedem Update ein Backup. Zusätzlich ein nächtliches
Backup auch ohne Update – das ist Pflicht für ein Produktionssystem:

`/etc/cron.d/checklisten-backup`:

```cron
# Jede Nacht um 02:30 ein Backup
30 2 * * * root /opt/checklisten/scripts/backup.sh >> /var/log/checklisten-backup.log 2>&1
```

`scripts/backup.sh` (existiert noch nicht – bitte anlegen):

```bash
#!/usr/bin/env bash
set -euo pipefail
APP_DIR=/opt/checklisten
BACKUP_DIR=$APP_DIR/backups
TS=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"
docker exec checklisten-postgres pg_dump -U checklisten checklisten > "$BACKUP_DIR/db-$TS.sql"
docker run --rm -v checklisten-tool_checklisten-attachments:/data:ro \
  -v "$BACKUP_DIR":/backup alpine tar -czf "/backup/attachments-$TS.tgz" -C /data .
ls -1t "$BACKUP_DIR"/db-*.sql 2>/dev/null         | tail -n +30 | xargs -r rm -f
ls -1t "$BACKUP_DIR"/attachments-*.tgz 2>/dev/null | tail -n +30 | xargs -r rm -f
```

`chmod +x scripts/backup.sh`.

Bonus: Backups regelmäßig **vom Host wegkopieren** (rsync auf NAS oder
ähnliches). Local-Backup hilft nicht, wenn die VM kaputt geht.

---

## 10. Update-Loop ausprobieren

Jetzt sollte der Loop laufen:

1. Lokal: in `VERSION` `0.1.1` schreiben, committen, pushen
2. Im Browser auf der Proxmox-Instanz: Benutzer-Seite → **„Erneut prüfen"**
3. Banner zeigt „Neue Version 0.1.1 verfügbar"
4. Klick **„Update jetzt anfordern"**
5. Bis zu 5 Minuten warten
6. Reload → `Aktuell: 0.1.1`

Funktioniert das nicht? Diagnose:

```bash
# Wurde die Flag geschrieben?
docker volume inspect checklisten-tool_checklisten-state \
  | grep Mountpoint   # → in den Pfad gucken, ob update-requested.flag da ist

# Lief der Timer?
journalctl -u checklisten-update.service -n 50

# Manuell forcieren:
/opt/checklisten/scripts/update.sh --force
```

---

## Was später noch sinnvoll ist

- **Data-Protection-Keys persistieren** — sonst müssen sich nach jedem Update
  alle einmal neu einloggen, weil die Cookie-Signaturschlüssel im Container-FS
  liegen und beim Rebuild verschwinden. Lösung: zusätzliches Volume
  `checklisten-keys:/root/.aspnet/DataProtection-Keys` in `docker-compose.yml`.
- **fail2ban** für Login-Bruteforce-Schutz auf den Caddy-Logs.
- **Monitoring**: `docker stats` reicht für 5 User; bei mehr → Uptime-Kuma als
  separater LXC.
