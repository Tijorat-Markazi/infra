# Tijorat Markazi production

Three repositories, one Ubuntu VPS, Docker Compose and host-installed Caddy. Applications publish scanned private GHCR images and update their own `apps/<app>/image.env` here. Only infra accesses the server. This follows the YouthCapital deployment layout with the publication-based retention bug corrected through GitHub deployment acknowledgements.

For the exact first-deployment steps, follow [SETUP.md](SETUP.md). `VPS_HOST` is an **infra/prod environment secret**. GitHub App credentials stay in the two application repos; all server/runtime credentials stay here.

```text
backend CI  -> private GHCR -> apps/backend/image.env  -> deploy-backend -> backend
frontend CI -> private GHCR -> apps/frontend/image.env -> deploy-frontend -> frontend
                                      infra/prod owns SSH and runtime secrets
```

Review the public application source **and Git history** before first publication, including previously committed credentials, personal data, development accounts and database artifacts. Rotate exposed credentials; deleting a current file does not remove it from history. This implementation does not change repository visibility. Production runtime files, data and keys are never committed.

The initial security review found **29 historical password findings** in backend `data/orgs.json`. On 17 October 2026, an approved history cleanup removed that file from all backend commits without changing current application files. [GitHub's full-history Gitleaks job passed](https://github.com/Tijorat-Markazi/backend/actions/runs/39050600778/job/117448218876) at cleaned commit `948f2b2ef0d75f155067c1ee9097eb08cb30d20a`, without suppressions or weaker scan settings. Rotate any exposed passwords still in use. Existing backend clones must be realigned or recloned after preserving local work; do not merge the removed history back.

## Layout and operation

| File | Purpose |
| --- | --- |
| `compose.yaml` | PostgreSQL 18 only, private network and durable named volume. |
| `apps/<app>/compose.yaml` | One unprivileged application, independently merged with the base. |
| `apps/<app>/image.env` | Desired release, including its readable tag and immutable digest. |
| `Caddyfile` | HTTPS, IPv4/IPv6 and HTTP/3; `/api`, `/ws`, `/uploads` go to backend with paths preserved. |
| `scripts/bootstrap.sh` | Idempotent Ubuntu packages, firewall, Caddy, QUIC settings and initial database. |
| `scripts/apply-shared.sh`, `deploy.sh` | Apply shared/runtime settings or replace one application. |
| `scripts/controller.mjs`, `runtime.mjs`, `deployments.mjs` | Strict input validation, SSH transport, private runtime files and deployment acknowledgements. |

Everything is installed under `/opt/tijoratmarkazi`; the Compose project is always `tijoratmarkazi`. PostgreSQL has no public port. Backend and frontend publish only `127.0.0.1:4321` and `127.0.0.1:8080`. Separate frontend/backend Docker networks prevent frontend from connecting to PostgreSQL. Caddy runs as a systemd service and reaches the loopback ports.

Initial image files are intentionally empty. Bootstrap starts PostgreSQL only. Each real application release includes only its own Compose fragment; no sibling image or placeholder is required. Before both applications exist, the missing routes can return 502. Never use `docker compose down`, `down -v` or `--remove-orphans` for deployment: the omitted sibling is intentional and must keep running.

Normal application promotion copies only that application's image file, starts/checks PostgreSQL and replaces that application. It does not copy shared config, runtime secrets or the sibling's image. Manual `deploy-backend` / `deploy-frontend` dispatch defaults `apply_shared=true`, applying current shared/runtime configuration and rechecking initialized apps. Set `apply_shared=false` for a routine image recovery. Shared configuration changes and GitHub variable changes require this manual apply; they do not silently deploy another application's desired image.

Each **deploy-backend**, **deploy-frontend** and **server bootstrap** run contains **Validate infra → Deploy/Bootstrap** jobs in the same pipeline. `needs: validate` prevents server access if any validation fails. The reusable checks workflow executes inside that run; it does not trigger or wait on a separate pipeline. Standalone checks remain available for PRs and config pushes, excluding image-only pushes.

After queue admission, validation resolves current `main` once, runs every check, and returns its full commit SHA. The deployment job checks out exactly that validated SHA; the controller rejects missing or mismatched validation output before SSH. App workflows capture the expected image from their triggering commit and verify it still matches current desired state. Old retries cannot rewind an application over a newer pointer. Server scripts also share one bounded `flock`; the same lock covers a shared apply and its target deployment.

## GitHub setup

Create `prod` environments in all three repositories, restrict deployment branches to `main`, protect `main`, and review workflow/deploy-script changes. Environment secrets for private repositories require an eligible GitHub plan. Use GitHub-hosted runners, not the VPS as a runner.

Install a GitHub App on **Tijorat-Markazi/infra only**, with Contents read/write, Actions read/write and Deployments read. Store its private key as `INFRA_APP_PRIVATE_KEY`, and variables `INFRA_APP_ID` and `INFRA_REPO=Tijorat-Markazi/infra`, in each application repository's `prod` environment. The App requires no Workflows permission. Permit its automatic image commits through any branch rule requiring PRs; no PR promotion flow is installed.

App Contents access is repository-wide: those app workflows are trusted deployment code. An optional eligible push ruleset can restrict paths with exact image-file exceptions and no App bypass, but a workflow validator alone is not folder authorization. Do not give application credentials Deployments write or allow them to forge acknowledgement files.

Infra/prod settings are listed in [production.env.example](production.env.example). Configure the real values in GitHub, never in that example:

| Secrets | Purpose |
| --- | --- |
| `VPS_HOST` | VPS IP/hostname, without a scheme, username or port. Move an existing variable to this environment secret. |
| `VPS_SSH_KEY`, `VPS_KNOWN_HOSTS` | Complete private key and independently verified OpenSSH host trust. |
| `POSTGRES_PASSWORD` | At least 24 random characters. |
| `ADMIN_PASSWORD`, `RAIS_PASSWORD` | At least 16 random characters each; secure initial application accounts. |
| `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN` | Optional existing application integrations. |

| Variables | Default / purpose |
| --- | --- |
| `DOMAIN`, `ACME_EMAIL` | Required lowercase domain and certificate contact. |
| `VPS_USERNAME`, `VPS_PORT` | `deploy`, `22`; must match the server. IPv6 literals are supported. |
| `POSTGRES_DB`, `POSTGRES_USER` | `tijoratmarkazi`; choose before first database initialization. |
| `WEB_CONCURRENCY`, `STARTUP_TIMEOUT` | `1`, `120` seconds. Multiple workers are rejected by this backend. |
| `DOC_TTL_DAYS`, `ANTHROPIC_MODEL`, `RAIS_TG_CHAT` | `14`, empty, empty. An explicit provider model ID is required if the Anthropic key is configured. Scheduled news fetching is off. |

All runtime values must be single-line. Password punctuation is preserved with Compose `env_file: format: raw`; files are never sourced/evaluated. Temporary runner files are private, transferred over SSH and installed root-readable with mode `0600`. Use `compose config --quiet` on production; expanded output contains secrets. Browser build variables are public and belong in the frontend repo only when needed. Production requests use relative `/api` URLs.

Each app publishes/cleans its own private GHCR package using its job token. First run app CI with `publish_only=true`, then under each new package's **Manage Actions access**, give **Tijorat-Markazi/infra Read** and verify its publishing repo has Admin. Then run a normal release. Infra authenticates pulls with its short-lived job token through encrypted stdin and removes its temporary Docker login afterward. No persistent GHCR PAT is required.

## Prepare SSH and bootstrap

Use Ubuntu 22.04/24.04/26.04 LTS on amd64, with working global IPv4 **and** IPv6. Configure DNS A/AAAA origin records for the VPS. Cloudflare orange-cloud proxying is supported; public DNS then returns Cloudflare addresses. Bootstrap checks address families without requiring DNS answers to match a host interface, validates the origin certificate using IPv4/IPv6 loopback with the correct SNI, then checks public IPv6 HTTPS and the UDP 443 listener. Provider firewall rules must allow your SSH TCP port, TCP 80/443, UDP 443 and ICMP/ICMPv6. Bootstrap preserves provider/cloud-init networking.

For Cloudflare, use **Full (strict)** TLS. Keep TCP 80 reachable and `/.well-known/acme-challenge/*` free of redirects/WAF challenges while Caddy obtains its certificate; leave Always Use HTTPS off during initial issuance. A valid CDN edge certificate does not prove the origin certificate is ready. Caddy accepts `CF-Connecting-IP` only from [Cloudflare's published IPv4](https://www.cloudflare.com/ips-v4) and [IPv6](https://www.cloudflare.com/ips-v6) ranges, and overwrites both `X-Real-IP` and `X-Forwarded-For`. Review those ranges when maintaining infra. This follows [Caddy's trusted-proxy model](https://caddyserver.com/docs/caddyfile/options#trusted-proxies). Browser HTTP/3 through orange-cloud DNS terminates at Cloudflare; enable edge HTTP/3 separately. Test origin QUIC directly when verifying the VPS.

Create a dedicated key locally (`ssh-keygen -t ed25519 -f tijoratmarkazi-deploy`). Through a trusted console/admin session, create `deploy`, install **only its public key** in `/home/deploy/.ssh/authorized_keys` with the `restrict` option, owner deploy and permissions directory `0700` / file `0600`. Add `/etc/sudoers.d/tijoratmarkazi-deploy` containing `deploy ALL=(ALL) NOPASSWD: ALL`, mode `0440`, and validate with `visudo -cf`. This account has root-equivalent deployment privilege, although application containers are unprivileged.

Configure an SSH `Match User deploy` block disabling password/keyboard-interactive authentication, PTY, TCP forwarding and X11 forwarding. Run `sshd -t` and reload SSH. Keep the original console session open while verifying a second key-authenticated session can run `sudo -n true`. Disable root SSH only after that succeeds. Read the host's public Ed25519 key/fingerprint through the trusted console and place the matching known-hosts entry in `VPS_KNOWN_HOSTS`; custom ports use `[host]:port`. Do not trust unverified `ssh-keyscan` output.

Dispatch **server bootstrap** on main after infra settings are ready. It installs Docker/Compose/Caddy from signed apt repositories, preserves SSH when enabling UFW, allows HTTP/HTTPS/QUIC and persists UDP buffer settings. It is safe to rerun; PostgreSQL data is retained. For replacing a populated VPS, moving database/uploads/application data is a separate operator task. No backup system or automatic database rollback is installed.

Bootstrap validation covers all Bash/Node scripts, executable DNS fixtures, runtime/Compose models, deployment failure cases and real Caddy trust/routing/log-redaction tests. The bootstrap job repeats syntax checks on the validated checkout. The remote controller then checks every transferred shell script before registry login or installation. Container-owned data directories use numeric `chown 10001:10001`; matching host accounts are not required.

## Retries, acknowledgements and retention

Readable tags include app prefix, source SHA, run number/id and build attempt; infra additionally pins `@sha256:...`. App deploy retries reuse the built reference, avoid empty commits and dispatch recovery once if needed. Whole-pipeline retries publish a new attempt tag, so frozen older attempts cannot overwrite it.

Before changing an application on the server, infra creates an explicit GitHub Deployment with environment `prod`, task `deploy-backend` or `deploy-frontend`, and payload `{app,image,previous_image,source_sha,config_sha}`. It marks in-progress, and marks success only after Compose plus HTTP readiness checks pass. Shared applies and bootstrap reruns also record each initialized app they reapply. Failure/timeout/unknown outcomes never count as healthy; `auto_inactive=false` preserves both applications' independent records.

App pipelines wait for the exact infra run and successful **Deploy application** step. Cleanup uses deployment history to retain current healthy, previous distinct healthy and the candidate when different. A newer failed/in-progress/unknown attempt skips deletion altogether, including pre-publish and manual maintenance. The VPS `image.env` is an attempted pointer and is not proof of health. Repeated failures can temporarily retain more images; retry the existing candidate rather than deleting a possibly running release. GHCR storage/bandwidth are currently free; protected images cannot safely be deleted to promise space under any future quota.

Jobs, API/SSH operations, lock waits, pulls/startup and readiness checks have finite deadlines. Readiness checks cover both direct app HTTP and certificate-verified HTTPS through Caddy using loopback resolution. Container replacement can briefly interrupt that app. No zero-downtime layer is implied. Migrations run in the backend startup path; failed upgrades do not automatically revert database schema.

Manual image rollbacks must use retained images. GitHub's deployment-history checks and registry deletion are separate API calls: manually pointing infra at an arbitrary older, unprotected digest concurrently with cleanup is outside this protocol and can race deletion. Ordinary application releases are serialized and publish unique attempt tags.

PostgreSQL 18 persists in `tijoratmarkazi_postgres_data` mounted at `/var/lib/postgresql`. Backend writable paths `/app/data` and `/app/uploads` map to `/opt/tijoratmarkazi/data/backend` and `data/uploads`. Initialization variables only affect an empty PostgreSQL data directory: changing `POSTGRES_PASSWORD` in GitHub does not rotate an existing role; change it with interactive `psql` `\password`, then update the GitHub secret and apply shared config. `RAIS_PASSWORD` provisions the initial Rais account; rotate an existing Rais password through an authenticated administrator action. `ADMIN_PASSWORD` remains runtime configuration: changing it and applying shared config rotates administrator access and invalidates its existing sessions.

## Checks and inspection

See [VERIFICATION.md](VERIFICATION.md) for completed local checks and the remaining first-release prerequisites.

Run `node --test tests/*.test.mjs` and `bash tests/deploy.test.sh`. Syntax-check each shell script with `for script in scripts/*.sh; do bash -n "$script"; done`. Node tests need Docker Compose's CLI, Python 3 (`PYTHON_BIN` optionally selects its executable) and Caddy (`CADDY_BIN` optionally selects its executable). CI extracts Caddy's static binary from the pinned image and exercises it on temporary loopback ports. Tests require no production secrets, TLS issuance or public DNS.

For logs, use `sudo docker compose -p tijoratmarkazi -f compose.yaml -f apps/backend/compose.yaml --env-file apps/backend/image.env logs backend` from `/opt/tijoratmarkazi`, or `sudo journalctl -u caddy`. Verify the public endpoints with `curl -6 -I https://<DOMAIN>` and an HTTP/3-capable client's `curl --http3-only -I https://<DOMAIN>`. Caddy filters token query parameters and Referer headers from logs.
