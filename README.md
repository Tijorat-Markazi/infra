# Tijorat Markazi deployment

Independent backend/frontend releases build immutable GHCR images, update their own `apps/<app>/image.env`, and wait for infra deployment. App repositories have no server credentials. Their prod `AUTO_DEPLOY` variable defaults to false: pushes build/scan only until it is explicitly enabled. A manual non-publish-only dispatch promotes after approval; cleanup is skipped when promotion is paused. Validation and deployment remain jobs in the **same workflow run**; only the validated configuration SHA may access the server. Failed or unknown deploys still prevent image cleanup.

## Dedicated host layout

- Server: `deploy@65.108.142.153`; project root `/opt/tijoratmarkazi`; Compose project `tijoratmarkazi`.
- **Existing** PostgreSQL 18 container `infrastructure-postgres-postgres-1`, on external network `infrastructure_database`, hostname `postgres:5432`.
- Reconfirmed on 6 November 2026: database `tijorat_markazi_db`, owner/login `tijorat_markazi_user`; role is not superuser and cannot create roles/databases. Public schema USAGE/CREATE are granted; target currently contains no application tables.
- No PostgreSQL service, volume, initialization SQL, administrator password or cluster-management operation in this deployment.
- Backend joins its private `backendnet` plus the external database network. Frontend joins `backendnet` and the existing edge network; it never joins the database network. Existing app ports remain loopback-only: 4321 and 8081 (frontend container stays on 8080).
- Existing AgroZanjir edge Caddy already publishes TCP 80/443 and UDP 443. It is preserved. The uniquely named `tijoratmarkazi-frontend` service joins existing `agrozanjir_web`; its Nginx serves static files and proxies API requests to the unique `tijoratmarkazi-backend-upstream` alias on `backendnet`. This avoids ambiguous `backend`/`frontend` aliases on AgroZanjir's network. No additional reverse-proxy container is deployed.
- Same origin: `https://tijoratmarkazi.uz/` -> frontend; `/api`, `/ws`, `/uploads` (including subpaths) -> backend, preserving prefixes and WebSocket upgrades. No Redis service exists in this project; AgroZanjir Redis remains untouched.

TLS terminates at the existing edge Caddy, which forwards to `tijoratmarkazi-frontend:8080`. Nginx forwards backend paths without stripping their prefixes and supports WebSocket upgrades. The rendered `runtime/edge-site.caddy` must be merged into **both the edge owner's infrastructure source and its installed Caddyfile**, after approval. This repo never automatically replaces or reloads another project's Caddy. Use the literal rendered hostname, not the edge's existing `{$DOMAIN}` environment variable (currently a different site).

The edge site accepts `CF-Connecting-IP` only from the published Cloudflare address ranges and replaces forwarded IP/protocol headers. Frontend Nginx trusts private Docker peers and remains loopback-only on the host: applications sharing this server are a trust boundary. Keep its host binding on 127.0.0.1. Nginx resolves its backend alias lazily and can start before the backend. Access logs omit query strings; upstream error logging is suppressed on token-bearing API paths because Nginx cannot redact request URLs. The edge site and global log filter redact query tokens and Referer headers. Maintain Cloudflare ranges from https://www.cloudflare.com/ips/.

## Runtime settings and bootstrap

Use **infra/prod** for every server/runtime secret or variable; the exact list is in [production.env.example](production.env.example) and [SETUP.md](SETUP.md). `DB_USER` is a secret. The established `POSTGRES_PASSWORD` secret now means the **existing application role password**, never the shared PostgreSQL administrator password. `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_NETWORK` are variables. Retire old `POSTGRES_DB`/`POSTGRES_USER` variables. Changing GitHub secrets never rotates database roles.

Backend startup reads DB components directly, with single-line passwords preserved in raw env files; partial component settings fail rather than falling back to a different URL. Legacy `DATABASE_URL` remains supported for older local/CI callers. New production runtime files contain no connection URL or postgres initialization credentials. A backend release refreshes its runtime env; frontend-only releases leave backend runtime unchanged unless explicitly applying shared project configuration.

`server bootstrap` is for an **already provisioned Docker host**. It checks existing networks/containers, validates transferred scripts (Caddy templates are exercised in CI), installs only project files, assigns UID/GID 10001 storage and enables its own backup timer without starting it. It never installs packages, changes Docker/APT/firewall/network/SSH settings, creates a database/network, starts app containers, or runs migrations. It prepares the supplied application runtime secrets for the initial empty-database startup, without connecting to PostgreSQL; no PostgreSQL administrator secret is needed. A bootstrap rerun does not redeploy existing apps or acknowledge them as newly healthy.

`apply_shared=true` installs this project's Compose/runtime configuration and rechecks initialized apps. Nginx configuration is built and syntax-checked inside the frontend image. It does not manage shared infrastructure. All deployments retain bounded SSH/API/lock/startup/readiness deadlines and GitHub deployment acknowledgements. Backend startup creates/updates application tables, so deploying it is a database-changing operation requiring migration approval during the initial cutover.

## Backup and restore

`sudo /opt/tijoratmarkazi/scripts/backup.sh` creates a mode-0600 archive under `backups/` containing only a custom-format dump of `tijorat_markazi_db`, `data/backend`, `data/uploads` and a project manifest. It uses the application role through the existing container's PostgreSQL client; password travels through stdin, not process arguments or archive contents. No `pg_dumpall`, roles, shared database files, Redis, Caddy state or other apps are included. Daily timer: 04:15 Asia/Tashkent. Seven completed local archives are retained. Daily database/media capture is not atomic; freeze writes for migration or strict-consistency exports. These local copies do not protect against loss of the server; copy required archives off-host through an operator-managed secure channel.

After explicit approval, stop only this project's backend, take a current backup and restore a **trusted** project archive:

```bash
sudo /opt/tijoratmarkazi/scripts/restore.sh /absolute/path/project.tar.gz --confirm=tijorat_markazi_db
```

Restore refuses a running backend, another project/database/role, unsafe archive paths, links and unrelated files. It restores only this database using `pg_restore --single-transaction --clean --if-exists --no-owner --no-acl`, then copies project media and fixes UID/GID 10001. Existing extra media files are preserved. It leaves the backend stopped and never deletes volumes. Database and filesystem restore are not one atomic transaction: a media-copy failure needs operator recovery before restart. Do not restore untrusted dumps; PostgreSQL archives can contain executable SQL.

## Validation

```bash
node --test tests/*.test.mjs
python3 -m unittest discover -s tests -p '*_test.py'
for file in scripts/*.sh tests/*.sh; do bash -n "$file"; done
shellcheck -x scripts/*.sh tests/*.sh
bash tests/deploy.test.sh
```

Node tests require Docker Compose, Python 3 and Caddy (`CADDY_BIN` may select its path); no production secrets or server access. Caddy tests use temporary local listeners. CI runs Compose/runtime tests, Bash/ShellCheck, Python backup/preflight tests, edge routing/IP-spoofing/log-redaction tests; the frontend image scan job also exercises published-image routing and WebSocket upgrades and exact-SHA deployment gating.

For rollout, DNS/certificate issuance and rollback, use [SETUP.md](SETUP.md). No production migration, service restart, push or deployment was performed while preparing these changes.
