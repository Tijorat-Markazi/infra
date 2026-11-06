# Dedicated-server migration runbook

All commands changing GitHub, DNS, services or data below are **after explicit approval**. Preparation only inspected the shared host and changed local files. A short maintenance window is expected; no zero-downtime migration is promised.

## Confirmed target and prerequisites

6 November 2026: `65.108.142.153`, deployment user `deploy`, shared PostgreSQL container `infrastructure-postgres-postgres-1`, network `infrastructure_database`, alias `postgres`, port 5432. Database `tijorat_markazi_db` is owned by `tijorat_markazi_user`, with schema USAGE/CREATE and no administrator privileges. The database is empty. No database/role creation or password rotation is necessary.

AgroZanjir's Caddy owns host TCP 80/443 and UDP 443 on `agrozanjir_web`. Its current site is a different domain. This project has no Redis dependency and must not touch AgroZanjir Redis. YouthCapital owns host port 8080. This project binds only 127.0.0.1:8081 for frontend and 127.0.0.1:4321 for backend; both were free. No Tijorat Markazi Compose project, containers, networks or installed project root were present. WomanUP uses its own internal proxy; preserve all existing routes. The host has global IPv6 `2a01:4f9:1a:9280::2/64` with a default route; the existing edge listens on IPv4/IPv6 TCP 80/443 and UDP 443. The new server currently has **no certificate for tijoratmarkazi.uz**. The existing public site's HTTPS/readiness succeeds, which proves neither new-origin TLS nor the Cloudflare account's encryption setting.

The owner confirmed there is no existing data to migrate. Start with the already-created empty target database; no old-server export, restore or database/role creation is required. Record the current Cloudflare A/AAAA origin values and proxy/TLS settings securely before cutover. Old-host retirement is a separate action after acceptance; do not delete its volumes during this migration.

## GitHub prod settings

Only **Tijorat-Markazi/infra -> prod** stores server/application runtime settings. Backend/frontend retain their existing GitHub App promotion credentials and `INFRA_REPO`, with no SSH/database credentials. In **each app/prod**, set variable `AUTO_DEPLOY=false` during migration; set it to `true` only after acceptance. Without it, pushes still build and scan images but cannot promote or clean up. Manual workflow dispatch with `publish_only=false` remains an explicit promotion action.

| Type | Name | Value/action |
| --- | --- | --- |
| Secret | `VPS_HOST` | `65.108.142.153` |
| Secret | `VPS_SSH_KEY` | Existing `hetzner_ax41_deploy_ed25519` private key, entered securely; do not print it |
| Secret | `VPS_KNOWN_HOSTS` | Verified complete new-host key entry for that IP; verify through a trusted server console |
| Secret | `DB_USER` | `tijorat_markazi_user` |
| Secret | `POSTGRES_PASSWORD` | Already-created **application role** password, at least 24 characters; never the shared administrator password |
| Secret | `ADMIN_PASSWORD`, `RAIS_PASSWORD` | Preserve existing application values, at least 16 characters |
| Secret | `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN` | Preserve configured optional integrations |
| Variable | `VPS_USERNAME`, `VPS_PORT` | `deploy`, `22` |
| Variable | `DOMAIN` | `tijoratmarkazi.uz` |
| Variable | `DB_HOST`, `DB_PORT` | `postgres`, `5432` |
| Variable | `DB_NAME` | `tijorat_markazi_db` |
| Variable | `DB_NETWORK` | `infrastructure_database` |
| Variable | `DB_CONTAINER` | `infrastructure-postgres-postgres-1` |
| Variable | `PROXY_NETWORK` | `agrozanjir_web` |
| Variable | `EDGE_PROXY_CONTAINER` | `agrozanjir-caddy-1` |
| Variable | `WEB_CONCURRENCY`, `STARTUP_TIMEOUT`, `DOC_TTL_DAYS` | `1`, `120`, `14` (preserve intentional overrides) |
| Variable | `ANTHROPIC_MODEL`, `RAIS_TG_CHAT` | Preserve configured values; model required when the API key is present |

Retire `POSTGRES_DB` and `POSTGRES_USER` variables; remove any old database-administrator secret after checking no unrelated workflow needs it. The established `POSTGRES_PASSWORD` name is deliberately preserved with the application-role meaning. `ACME_EMAIL` is no longer required by this project's frontend; certificate management belongs to the existing edge. No settings were changed during preparation: local GitHub CLI API authentication was rechecked on 6 November and is unavailable (HTTP 401).

## Existing shared-edge security finding

The running edge is Caddy 2.11.6 at digest `881bbc60f9986d5ab8e7cfd6cf7e4ef3c9c0439fef2429d035d065577882f028`. A refreshed 6 November scan of its exact image reports **1 CRITICAL and 10 HIGH vulnerability instances**, including Alpine libraries and embedded Go dependencies. This migration does not rebuild or replace shared infrastructure. Review remediation or explicit risk acceptance with the edge owner before public cutover; validate all existing sites if the shared image changes. Both local project runtime images pass the refreshed HIGH/CRITICAL scan after rebuilding the frontend runtime security packages. CI must repeat the scans for the immutable release images. Reports and validation limits are recorded in VERIFICATION.md.

## Exact rollout order

1. **Approve the reviewed changes and maintenance window.** Review remediation or explicit acceptance of the shared-edge image findings with its owner before public cutover. Set `AUTO_DEPLOY=false` in both application prod environments before pushing. Leave CI enabled: source scans, tests and publishing continue, while promotion/cleanup are gated. Manual releases must also wait for approval. Configure infra/prod with the new host and application role credentials. Preserve the old host settings in your secure operator records for rollback.
2. **Push all three repositories after approval.** Infra code changes run validation only. Both backend connection configuration and frontend Nginx routing changed; both images must be rebuilt. Dispatch both application release workflows with `publish_only=true`; all tests/scans and the immutable image scan must pass. Do not promote either image yet. Do not push further application changes or dispatch normal releases until cutover. Confirm infra's GHCR Read access remains granted.
3. **Dispatch infra `server bootstrap` on main.** Validation and bootstrap are in one run. It installs project runtime/scripts/storage and its backup timer, without starting/restarting containers or the backup timer, running migrations, or changing host settings. Its app runtime file is prepared for the initial empty-database startup. The enabled backup timer remains inactive until step 9. Inspect `/opt/tijoratmarkazi/runtime/edge-site.caddy` (contains no secrets).
4. **Prepare the existing edge route for review.** `edge/agrozanjir-Caddyfile.patch` appends only this project site to the reference AgroZanjir infrastructure checkout; it was checked with `git apply --check` but not applied. Rebase it if the edge source changed, and use the freshly rendered site if DOMAIN differs. Append the rendered site's block to a candidate copy of `/opt/agrozanjir/Caddyfile`, preserving its current global block and all sites. Also mirror that addition in AgroZanjir's infrastructure source, otherwise a later AgroZanjir deployment will remove it. The live Caddyfile additionally contains WomanUP's route, which is absent from that local reference; reconcile it in the edge owner's source before any full-file replacement. Preserve the existing global log filter rather than adding a duplicate. Do not use that container's `{$DOMAIN}` for this project. Validate the full candidate using its existing Caddy binary. Its upstream is `tijoratmarkazi-frontend:8080` on the existing network; it will be unavailable until the new frontend starts. No Docker/Compose restart is needed to load a Caddyfile change: after approval, update the existing bind-mounted file **in place** and use `docker exec agrozanjir-caddy-1 caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile`. Preserve a copy of the previous file. If the edge default error logger records requests, retain the project's token/Referer filters there as described below.
5. **Recheck empty target and isolation.** Read-only checks must still confirm database `tijorat_markazi_db`, owner/login `tijorat_markazi_user`, schema USAGE/CREATE, no elevated role privileges or memberships, and zero application tables. Confirm loopback 4321/8081 remain free and the project name is unused. If data appeared, stop for review; do not reset or delete it. Verify application-role password authentication securely before startup; never substitute an administrator password.
6. **Skip data transfer for this fresh installation.** No source export or target restore is required. Keep the approved restore utility for future project-only recovery. Preserve the old host and all volumes until acceptance and a separate retirement decision.
7. **Cut over this domain and obtain origin TLS.** Load the reviewed edge site, point only this domain's Cloudflare A record to `65.108.142.153`, and update/remove any stale origin AAAA record to `2a01:4f9:1a:9280::2` after verifying external reachability. Preserve host networking. Keep proxying enabled and **Full (strict)**. HTTP-01 must reach this edge's TCP 80 through Cloudflare without custom WAF/challenge/cache/redirect rules intercepting `/.well-known/acme-challenge/*`. The site explicitly disables TLS-ALPN-01, which cannot pass through Cloudflare. HTTP-01 issuance requires DNS to reach the new origin, so allow a brief maintenance/TLS-error window until issuance completes; it cannot be pre-issued with local `--resolve`. Do not downgrade TLS verification. If this window is unacceptable, stop and arrange DNS-01 issuance with the edge owner before cutover; the stock image has no Cloudflare DNS module.
8. **Verify the origin certificate, then promote/deploy.** From the new server, `curl --noproxy '*' --connect-timeout 5 --max-time 15 --resolve 'tijoratmarkazi.uz:443:127.0.0.1' https://tijoratmarkazi.uz/ -o /dev/null` must pass certificate verification; an upstream 502 is expected before apps start (do not add `--fail` to this initial certificate-only check). Inspect certificate SAN/expiry and Caddy issuance logs. First dispatch a normal **frontend** release (`publish_only=false`), which promotes the new Nginx-aware frontend and waits for infra deployment. Frontend readiness does not require the backend, so this initializes routing safely. Then dispatch a normal **backend** release; its new DB-aware image starts against the confirmed empty database and waits for origin HTTPS readiness through Nginx. Backend startup creates/checks application tables, so this is the approved migration/startup point. The previous frontend image cannot route this architecture and must not be used for initial cutover. Enable automatic promotion only after both are healthy.
9. **Verify and retain rollback material.** Check direct loopback app readiness, certificate-verified origin `/api/health/ready` and `/healthz`, public HTTPS, login, uploads and WebSockets. Check the other edge domain still works. Confirm the shared PostgreSQL container ID/start time and other projects' containers are unchanged. Run the scoped backup once and verify the archive listing plus off-host copy, then start only `sudo systemctl start tijoratmarkazi-backup.timer`. Verify its next run with `systemctl list-timers tijoratmarkazi-backup.timer`. Set both applications' prod/AUTO_DEPLOY variables to `true` only after acceptance. Cleanup remains conservative on failed/unknown deploys. Never remove the old database/volumes as part of this migration.

Cloudflare [Full (strict)](https://developers.cloudflare.com/ssl/origin-configuration/ssl-modes/full-strict/) requires an unexpired, trusted certificate for the requested hostname. Caddy documents [HTTP-01 prerequisites](https://caddyserver.com/docs/automatic-https#acme-challenges) and [disabling TLS-ALPN-01](https://caddyserver.com/docs/caddyfile/directives/tls). Cloudflare's [Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/) currently documents HTTP DCV support; do not blanket-disable unrelated zone protections. Check custom redirects/WAF separately.

### Edge log redaction

Frontend access logs omit query strings; API upstream-error logs are suppressed to avoid unredactable tokens. Preserve the equivalent filter in the existing edge's global block to prevent an edge upstream failure logging download/reset tokens:

```caddyfile
log default {
    format filter {
        request>uri query {
            delete t
            delete token
        }
        request>headers>Referer delete
    }
}
```

This is part of the reviewed edge change, not an automatic bootstrap action. Do not add a second global block or overwrite other logging configuration.

## Rollback

Before accepting writes on the new app, stop only the new backend and restore this domain's previous DNS origin values/edge configuration; return to the old service only if it was healthy and only after approval. There is no source data to restore for this fresh installation. Keep the shared PostgreSQL service and all volumes untouched. After new writes have been accepted, freeze both sides and migrate this project's latest database/media back before redirecting traffic; pointing DNS back at a stale database loses writes. An image rollback does not undo database changes. Never run Compose `down -v`, PostgreSQL cluster restores, or host-wide pruning as recovery.
