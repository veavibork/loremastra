# GCP deployment runbook

Fast-path steps for standing up Loremaster on a GCP e2-micro (free tier). Written after the first live deploy (2026-07-03) — treat as the reference for redeploying or provisioning a second instance, not as marketing copy.

## Prerequisites

- VM created (e2-micro, free-tier region: `us-west1`, `us-central1`, or `us-east1`)
- A DNS hostname pointed at the VM's external IP (we used DuckDNS)
- `gcloud` CLI configured locally against the right project

## 0. Known app-level gotcha (fix before deploying)

`web/src/api.ts` must NOT hardcode an absolute `API_BASE` (e.g. `http://localhost:4114`) — it breaks the moment the built frontend is served from anywhere but the dev machine. Keep `API_BASE = ""` (relative) and rely on the reverse proxy to route `/api/*` to the backend. Vite's dev proxy (`web/vite.config.ts`) forwards `/api` to `localhost:4113` locally so this doesn't break `npm run dev`.

## 1. Networking

```
gcloud compute firewall-rules list        # confirm 80/443 open (untargeted rule, applies to all instances)
gcloud compute addresses create <name> --addresses=<current-external-ip> --region=<region>   # promote ephemeral IP to static (free while attached to a running instance)
```

Point your domain/DuckDNS record at the reserved IP. Verify with `nslookup`.

## 2. VM baseline

`gcloud compute ssh` provisions a non-root sudo user automatically via OS Login — no separate user-creation step needed.

```
sudo apt-get update -qq
sudo apt-get install -y unattended-upgrades apt-listchanges
sudo dpkg-reconfigure -f noninteractive unattended-upgrades
```

## 3. Swap file (essential on 1GB-RAM e2-micro)

```
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
sudo sysctl vm.swappiness=10
echo 'vm.swappiness=10' | sudo tee -a /etc/sysctl.conf
```

Without this, `npm install` / `tsc` can OOM on a 964Mi VM (in practice `better-sqlite3` pulled a prebuilt binary and didn't need to compile, but don't count on that holding for every dependency change).

## 4. Runtime + reverse proxy

```
# Node 22 via NodeSource
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git build-essential

# Caddy (automatic HTTPS)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

## 5. Deploy the app

```
sudo mkdir -p /opt/loremaster && sudo chown $USER:$USER /opt/loremaster
git clone --branch main https://github.com/veavibork/loremastra.git /opt/loremaster
# scp your .env up separately — never paste secrets through a shell command
cd /opt/loremaster && npm install && npm run build
cd web && npm install && npm run build
cd .. && npm run db:init
npm run user:create -- <name> <password>   # run this one yourself, interactively — keeps the password out of shell history/logs
```

**Gotcha:** `tsconfig.json` has `rootDir: "."`, so the compiled entry point is `dist/src/index.js`, not `dist/index.js`. `npm run start` (added to `package.json`) runs the correct path.

## 6. systemd service (crash + reboot recovery)

`/etc/systemd/system/loremaster.service`:

```ini
[Unit]
Description=Loremaster backend
After=network.target

[Service]
Type=simple
User=hoborg
WorkingDirectory=/opt/loremaster
EnvironmentFile=/opt/loremaster/.env
ExecStart=/usr/bin/node dist/src/index.js
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/opt/loremaster/data
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now loremaster.service
```

Verify recovery actually works: `sudo kill -9 $(systemctl show -p MainPID loremaster.service --value)` then confirm it comes back within `RestartSec`.

## 7. Caddy config

`/etc/caddy/Caddyfile`:

```
your-domain.example.com {
	handle /api/* {
		reverse_proxy localhost:4113
	}
	handle {
		root * /opt/loremaster/web/dist
		try_files {path} /index.html
		file_server
	}
}
```

```
sudo systemctl reload caddy
```

Caddy handles the ACME/Let's Encrypt cert automatically — no certbot needed.

## 8. Automated backups to GCS

```
gcloud storage buckets create gs://<bucket> --location=<region> --uniform-bucket-level-access
gcloud storage buckets update gs://<bucket> --lifecycle-file=lifecycle.json   # 30-day auto-delete
```

The VM's default service account needs **two** separate things to write to GCS — easy to miss the second one:

1. OAuth scope on the instance: `storage-rw` (not the full URL string — `gcloud compute instances set-service-account` wants the short alias). Changing this requires a VM stop/start.
2. An actual IAM role granted on the bucket: `roles/storage.objectAdmin` bound to the VM's service account, scoped to just this bucket (not project-wide).

```
gcloud compute instances stop <instance> --zone=<zone>
gcloud compute instances set-service-account <instance> --zone=<zone> --scopes=storage-rw,logging-write,monitoring-write,service-management,service-control,trace
gcloud compute instances start <instance> --zone=<zone>
gcloud storage buckets add-iam-policy-binding gs://<bucket> --member="serviceAccount:<sa-email>" --role="roles/storage.objectAdmin"
```

Backup script: `scripts/backup-to-gcs.mjs` (not checked in — deploy-specific, lives at `/opt/loremaster/scripts/` on the VM). Uses `better-sqlite3`'s `.backup()` API for a WAL-safe consistent snapshot of every `*.sqlite` under `data/`, gzips, uploads via the VM's own service account credentials (no static key file on disk).

Cron (`/etc/cron.d/loremaster-backup`), daily 3am UTC:

```
0 3 * * * hoborg cd /opt/loremaster && /usr/bin/node scripts/backup-to-gcs.mjs >> /var/log/loremaster/backup.log 2>&1
```

## Redeploying after a code change

```
cd /opt/loremaster
git pull
npm install && npm run build           # if backend deps/code changed
cd web && npm install && npm run build # if frontend deps/code changed
sudo systemctl restart loremaster
```

Caddy doesn't need a restart for frontend changes — it serves `web/dist` directly off disk.

**Docs-only or backend-only changes** skip the `web/` build. After `git pull`, if `package.json` /
`package-lock.json` changed, run `npm install` before `npm run build`.

### Verify memory pipeline after deploy

From your laptop (replace host, story id, session header):

```
curl -s https://your-domain.example.com/api/stories/<id>/memory/summary \
  -H "X-Loremaster-Session: <session>"
curl -s https://your-domain.example.com/api/stories/<id>/memory/tag-activation \
  -H "X-Loremaster-Session: <session>"
```

On the VM, run smoke tests against the checkout (uses ephemeral server — does not need the live service):

```
cd /opt/loremaster && npx tsx scripts/test-memory-pipeline-smoke.ts
```

Existing stories opened after deploy get `memory_content_stamp` backfilled automatically on first
`getStoryDb()` open (posts that already had `gen_extract` adopt stamps without mass recompress).
