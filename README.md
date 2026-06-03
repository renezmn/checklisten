# dP Checklisten

Web-Tool für strukturierte Service-Checklisten (NovaTime Kick-Off, Rauten-Update,
Vollupdate – plus beliebige eigene Vorlagen). Login, Berechtigungen, geteilte
Vorlagen und Sitzungen.

## Architektur

- **Frontend**: Vanilla HTML/JS/CSS, kein Build-Step. Liegt in `frontend/`.
- **Backend**: .NET 8 minimal API (`backend/Checklisten.Api/`). EF Core,
  Cookie-Auth mit BCrypt, JSON-Spalten in Postgres.
- **DB**: Postgres 16.
- **Anhänge**: Filesystem-Volume, Pfad konfigurierbar via `Attachments:Path`.

Das Frontend wird vom Backend selbst als statische Datei ausgeliefert – ein einziger
Container reicht.

## Rollen

| Rolle | Darf |
|---|---|
| **Admin** | Benutzer verwalten, alle Vorlagen + alle Sitzungen ansehen/bearbeiten/löschen. |
| **Editor** | Vorlagen anlegen/bearbeiten/löschen. Eigene Sitzungen wie Techniker. |
| **Techniker** | Sitzungen anlegen/bearbeiten/löschen (nur eigene). Vorlagen nur lesen. |

## Lokale Entwicklung (Windows)

```bash
# Einmalig: Postgres-Container starten
docker compose up -d postgres

# Backend (serviert auch das Frontend unter http://localhost:5181)
cd backend/Checklisten.Api
dotnet run
```

Standard-Login: `admin` / `admin` – **sofort ändern**.

Frontend-Änderungen werden ohne Cache nachgeladen (Dev-Mode setzt `Cache-Control: no-store`).
Backend-Änderungen brauchen einen Neustart des `dotnet run`-Prozesses.

## Production

`docker-compose.yml` enthält zwei Services:

- `postgres` – startet immer
- `api` – nur unter dem Profil `prod` aktiv (verhindert Konflikte mit lokalem `dotnet run`)

```bash
# Production-Build und Start (Container heißt checklisten-api auf Port 8080)
docker compose --profile prod up -d --build
```

Wichtige Umgebungsvariablen (siehe `docker-compose.yml`):

| Variable | Default | Bedeutung |
|---|---|---|
| `ConnectionStrings__Postgres` | s. compose | Verbindung zur Postgres-DB. |
| `Frontend__PathRelativeToContentRoot` | `./wwwroot` | Im Container liegt das Frontend dort. |
| `Attachments__Path` | `/data/attachments` | Volume für Screenshot-Dateien. |
| `Seed__AdminUsername` | `admin` | Beim ersten Start angelegter Admin. |
| `Seed__AdminPassword` | `admin` | Initial-Passwort des Seed-Admins. |
| `ADMIN_PASSWORD` | – | Wird in `docker-compose.yml` an `Seed__AdminPassword` durchgereicht. |

**Initialer Seed**: Wenn die Datenbank noch leer ist, legt der Backend-Start
automatisch (a) einen Admin-User an und (b) liest `seed-templates.json` ein,
sodass die drei Standard-Vorlagen sofort verfügbar sind.

Nach dem ersten Login: **Passwort des Admins ändern** (oder einen zweiten Admin
anlegen und den Seed-Admin deaktivieren).

## Deployment auf Proxmox

**Komplette Schritt-für-Schritt-Anleitung**: [`docs/proxmox-setup.md`](docs/proxmox-setup.md)
— inkl. GitHub-Deploy-Key, systemd-Auto-Update, Caddy/HTTPS und Backup-Cron.

Kurzfassung folgt unten.

### Variante A – LXC-Container mit Docker (empfohlen, leichtgewichtig)

1. Proxmox VE → „Create CT", Debian 12 Template, mindestens 1 vCPU / 1 GB RAM / 8 GB Disk.
   ⚠️ Im Reiter „Features" **Nesting** und **keyctl** aktivieren – sonst läuft Docker im LXC nicht.
2. Im LXC:
   ```bash
   apt update && apt install -y curl git
   curl -fsSL https://get.docker.com | sh
   git clone <dein-repo> /opt/checklisten
   cd /opt/checklisten
   # Eigenes Admin-Passwort setzen
   echo "ADMIN_PASSWORD=$(openssl rand -base64 18)" > .env
   docker compose --profile prod up -d --build
   ```
3. Reverse Proxy davor (z. B. nginx / Caddy / Traefik), das macht HTTPS und ermöglicht
   Screenshot-Aufnahme via Clipboard/getDisplayMedia (beides braucht `https://`).

### Variante B – VM mit Docker

Identisch zu A, nur dass du eine VM statt eines LXC-Containers anlegst (Debian/Ubuntu,
4 GB RAM oder mehr). Keine Nesting-Caveats, aber etwas mehr Overhead.

### Backup

Zwei Dinge müssen gesichert werden:

1. **Postgres-Daten** (Volume `checklisten-postgres-data`):
   ```bash
   docker exec checklisten-postgres pg_dump -U checklisten checklisten > backup.sql
   ```
2. **Anhänge** (Volume `checklisten-attachments`):
   ```bash
   docker run --rm -v checklisten-tool_checklisten-attachments:/data \
     -v $(pwd):/backup alpine tar -czf /backup/attachments.tgz -C /data .
   ```

Wiederherstellung in umgekehrter Reihenfolge.

## Updates

Die App zeigt im Admin-Bereich (Benutzer-Seite) den aktuellen Versionsstand und
prüft beim Klick auf „Erneut prüfen" gegen eine konfigurierbare Remote-Quelle.
Ist eine neuere Version verfügbar, erscheint **„Update jetzt anfordern"**. Klick
auf den Button schreibt eine Trigger-Datei – die App selbst kann sich nicht neu
deployen, das macht ein **Host-Watcher**.

### Versionsangabe

Die laufende Version ergibt sich aus (in dieser Reihenfolge):
1. ENV-Variable `APP_VERSION` (im Docker-Image über Build-Arg gesetzt).
2. Datei `VERSION` neben der `dotnet`-Anwendung bzw. im Repo-Root.
3. Fallback `dev`.

Vor einem Release also schlicht `VERSION` aktualisieren und `git commit`.

### Remote-Version + Trigger konfigurieren

In `docker-compose.yml` bzw. `.env`:

```env
UPDATE_VERSION_URL=https://raw.githubusercontent.com/<dein-user>/<repo>/main/VERSION
```

Damit fragt das Backend bei jedem Klick im Admin-UI diese URL ab und vergleicht
mit der aktuell laufenden Version.

Die Trigger-Datei wird im Volume `checklisten-state` unter `/data/update-requested.flag`
abgelegt (konfigurierbar über `Update__FlagFile`).

### Host-Watcher (systemd-Timer)

`scripts/update.sh` macht das eigentliche Update:

1. Postgres + Anhänge sichern (in `$APP_DIR/backups/`).
2. `git pull --ff-only`.
3. `docker compose --profile prod up -d --build api` mit dem neuen `APP_VERSION`.
4. Trigger-Datei löschen.

`--force` ignoriert die Trigger-Datei (manueller Aufruf).

Systemd-Timer auf dem Proxmox-Host / LXC:

```ini
# /etc/systemd/system/checklisten-update.service
[Unit]
Description=Checklisten-App: Update ausführen, wenn Trigger gesetzt
After=docker.service

[Service]
Type=oneshot
Environment=APP_DIR=/opt/checklisten
ExecStart=/opt/checklisten/scripts/update.sh
```

```ini
# /etc/systemd/system/checklisten-update.timer
[Unit]
Description=Checklisten-App: alle 5 Minuten auf Trigger prüfen

[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
Unit=checklisten-update.service

[Install]
WantedBy=timers.target
```

```bash
chmod +x /opt/checklisten/scripts/update.sh
systemctl daemon-reload
systemctl enable --now checklisten-update.timer
```

Der Admin im Browser klickt „Update jetzt anfordern" → spätestens 5 min später ist
es deployed. Ohne Watcher sieht der Admin „Update angefordert" und kann manuell
`scripts/update.sh` auf dem Host ausführen.

## Migrationen

Neue EF-Migration anlegen:

```bash
cd backend/Checklisten.Api
dotnet ef migrations add MyChange --output-dir Data/Migrations
```

Beim nächsten Backend-Start läuft `MigrateAsync()` automatisch durch.

## Spätere Integration in COREDESK

Der Stack (.NET 8 / EF Core / Postgres / Cookie-Auth) ist absichtlich identisch zu
COREDESK. Übernahme heißt im Wesentlichen:

1. `backend/Checklisten.Api/Models/`, `Data/`, `Endpoints/` als neues Modul
   `Modules/Checklists/` in das COREDESK-Repo verschieben.
2. Eigenen `AppDbContext` durch den COREDESK-`Identity`-User ersetzen
   (CreatedBy verweist dann auf die COREDESK-User-Tabelle).
3. Frontend in React/Mantine portieren – die Render-Funktionen aus `app.js`
   sind eins-zu-eins in Komponenten übersetzbar; die API-Endpoints bleiben gleich.
