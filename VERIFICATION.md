# Implementation verification

Validated locally on 16 October 2026 using checksum-verified Node 24.21.0 and an isolated PostgreSQL 18.6 cluster. No production data or existing database service was used.

| Check | Result |
| --- | --- |
| Backend unit and live PostgreSQL HTTP/WebSocket integration | 13 passed, none skipped |
| Frontend session, static assets and hostile-markup regressions | 15 passed |
| Backend/frontend release retry and registry-retention tests | 54 passed |
| Infra runtime, acknowledgements, SSH transport and independent Compose models | 10 passed |
| Deployment shell isolation, timeout and failure cases | Passed |
| Actions syntax | Passed; actionlint 1.7.12 ignores only its unsupported `concurrency.queue` keyword, which GitHub supports |
| Live browser login against the real API | All six roles passed; no credential-bearing API envelopes outside sign-in |
| Guest inquiry browser regression | Threads survive reloads; two browsers using the same contact email cannot see each other's inquiries |
| Caddy configuration | Validated with checksum-verified Caddy 2.11.7 |
| Semgrep source rules | No blocking findings in either application |
| Trivy source vulnerabilities/misconfiguration/secrets | No high/critical findings in either application |
| npm dependency audit | No reported vulnerabilities |

Working-tree Gitleaks checks exclude only the ignored local verification-tool cache; CI retains the default full Git-history scan. Frontend history is clean. At this initial validation, backend history contained **29 password findings** in `data/orgs.json` and the release gate was blocked. The approved cleanup below subsequently resolved the full-history scan; no blanket ignore was introduced.

The workflow uses GitHub's documented [`queue: max` concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency) and the [2026-03-10 workflow dispatch response](https://docs.github.com/en/rest/actions/workflows?apiVersion=2026-03-10#create-a-workflow-dispatch-event), which includes the exact run ID for recovery. These were checked against the official documentation during final review.

Docker Desktop's local API hangs during startup, so production image builds, image-level Trivy scans and running-container checks could not be completed locally. The workflows contain those required gates. Successful native application/configuration tests are not a substitute for that first container validation.

GitHub environment settings, repository visibility, private-package access and the real VPS were not changed. Follow [README.md](README.md) for the GitHub App, `prod` environments, SSH trust, bootstrap, publish-only package setup and initial releases. Public IPv6/QUIC connectivity still requires checking against the configured VPS/domain after bootstrap.

## YouthCapital adaptation — 17 October 2026

Compared the local YouthCapital checkout and verified the GitHub heads: [infra `f7bd72c`](https://github.com/Youth-Capital/infra/commit/f7bd72c00b943839598cbe9bd2be2360d5204749), backend `5580642`, frontend `340a6c5`. The app pipeline files match the previously reviewed release implementations; newer application feature changes do not alter the pipeline contract. Infra improvements include validation gating, Cloudflare support, secret placement, numeric data ownership and the setup runbook.

Adapted here with additional guarantees: validation and deploy/bootstrap are jobs in one workflow run, the actual deployment uses the exact validated commit, and bootstrap checks transferred shell scripts before privileged operations. Existing deployment-history-based retention is preserved; failed/unknown deployments still prevent registry deletion.

| Follow-up check | Result |
| --- | --- |
| Infra runtime, Compose, acknowledgements, exact validation SHA and DNS fixtures | 18 passed |
| Real Caddy trusted/untrusted peers, both IP headers, routes and access/error-log redaction | 3 passed with native Caddy 2.11.7 |
| Backend/frontend release recovery and failed/unknown-deployment retention | 54 passed |
| Deployment Bash regressions | Passed, including a malformed transferred bootstrap script rejected before sudo/registry operations |
| Actions and all Node/Bash deployment-script syntax | Passed; only the old actionlint `queue` compatibility exception remains |

Docker's server API is currently unavailable locally; no image rebuild or real Ubuntu/VPS bootstrap was performed. Compose configuration and native Caddy checks passed without the Docker daemon. See [SETUP.md](SETUP.md) for the required migration of `VPS_HOST` from a variable to an infra/prod secret and exact first-release instructions. GitHub settings and YouthCapital were not modified.

## Approved backend history cleanup — 17 October 2026

Removed only historical `data/orgs.json` with checksum-verified git-filter-repo 2.47.0 in an isolated clone, then replaced backend/main using an exact force-with-lease after owner approval. All three backend commit IDs changed; old HEAD `78dc940` became `948f2b2ef0d75f155067c1ee9097eb08cb30d20a`. HEAD tree hashes match, so current application files are identical. The original local backend checkout was synchronized to the clean history.

The cleaned history passes Gitleaks 8.30.1 locally with **zero findings**, and the [new GitHub Gitleaks job passed](https://github.com/Tijorat-Markazi/backend/actions/runs/39050600778/job/117448218876). Semgrep also passed in that run; subsequent pipeline stages were still running at this check. Password revocation/rotation and removal of cached old commit views or old copies are separate tasks; this cleanup does not prove either is complete.


## Dedicated Docker server migration preparation — 26 October 2026

All production interactions were read-only. Compared the AgroZanjir infrastructure reference and inspected the target host using the supplied deployment key. Confirmed database `tijorat_markazi_db` and owner/login `tijorat_markazi_user`: no superuser, CREATEDB, CREATEROLE, replication, RLS bypass or role memberships; public schema USAGE/CREATE available; initially zero application tables. Confirmed existing shared PostgreSQL container/network, occupied public edge ports and free project loopback ports. The running edge serves a different domain and has no certificate for this project's hostname yet. No production migrations, restarts, deployments, volume deletion, GitHub setting changes or pushes occurred.

Final architecture keeps two project containers: backend joins the shared database network, frontend Nginx proxies same-origin backend routes and joins the existing edge network with a unique service name. Existing public Caddy remains the TLS/HTTP2/HTTP3 endpoint. Project bootstrap only prepares project storage, private runtime files, scripts and its backup timer. It does not configure host packages, Docker, PostgreSQL, firewall, networking or SSH. Both applications have a prod/AUTO_DEPLOY interlock, default false, so pushes still run CI but cannot promote until enabled; manual non-publish-only dispatch is explicit promotion. Cleanup is skipped when promotion is paused.

| Check executed locally | Result |
| --- | --- |
| Backend tests with real disposable PostgreSQL and non-superuser application role | 16 passed, none skipped |
| Frontend auth/render/static regressions | 15 passed |
| Infra runtime, Compose, SHA gating, shared-host bootstrap/workflows and actual edge routing/TLS-template/log-redaction tests | 16 passed |
| Python project-only archive/restore/preflight guards | 7 passed |
| Backend/frontend release retry and failed/unknown-deploy retention regressions | 54 passed |
| Both app workflow promotion scripts: paused/default push, enabled push, manual dispatch; cleanup gating | Passed |
| Real two-image frontend -> backend -> shared-network PostgreSQL readiness and secure session cookie | Passed |
| Database/media dump and restore round trip with application credentials | Passed; Windows ownership syscall mocked, container UID verified independently |
| Linux Bash deployment tests and actual bootstrap prepare-only installation path with infrastructure commands mocked | Passed |
| Backend and refreshed frontend Docker image builds; frontend nginx -t | Passed |
| Published-image frontend smoke script: backend absent at startup, paths, cookies, forwarded headers, real WebSocket upgrade, error-log token privacy | Passed against final local image |
| ShellCheck 0.11.0 and Bash/Node/Python syntax | Passed for affected scripts |
| actionlint 1.7.12, all affected workflows | Passed, ignoring only the already-established unsupported concurrency.queue syntax |
| Full Git-history and worktree Gitleaks 8.30.1, all three repos | Zero source/history findings; local downloaded verification caches excluded using existing local-only configuration, CI rules unchanged |
| Semgrep 1.180.0 project source rules, backend/frontend | Zero findings |
| Trivy 0.75.0 source vulnerability/misconfiguration/secret scans, all three repos | Zero HIGH/CRITICAL findings |
| Trivy final backend/frontend runtime images | Zero HIGH/CRITICAL findings |
| Proposed combined edge configuration, exact running Caddy image | Valid; no reload or certificate issuance performed |
| Initial-cutover edge patch against the reference repository | git apply --check passes; patch not applied |

A cache-only JWT finding was confirmed to be the public PyJWT documentation example, outside versioned/deployed source; no credential suppression was added to CI.

**Outstanding shared infrastructure finding:** running Caddy 2.11.6 image digest `881bbc60f9986d5ab8e7cfd6cf7e4ef3c9c0439fef2429d035d065577882f028` has 8 HIGH vulnerability instances in a local scan of the exact image. The current official 2-alpine tag also showed those findings. No shared proxy image was updated. Record this with the edge owner and review a patched/rebuilt edge before public cutover. This is separate from the clean project runtime images.

Local reports and integration logs are in the workspace's ignored `.verification/security/`; the prepared full edge candidate is `.verification/migration-edge-candidate.caddy`. These artifacts contain no production credentials. GitHub API authentication for environment settings was unavailable (401), so settings still require secure configuration. Old-server access was not supplied; source DB identity/data export, actual target password authentication, production bootstrap/restore/startup, domain DNS changes and certificate issuance remain approval-gated rollout checks. Cloudflare account proxy/TLS settings were not authenticated or changed. Daily backup/media capture is not atomic; local retention is not off-host disaster recovery. See SETUP.md for the exact ordered maintenance-window procedure and rollback limits.


## Migration revalidation — 6 November 2026

Preserved the pre-existing uncommitted changes across all three repositories and completed the migration review. No applicable AGENTS.md was found in the project or ancestor directories. The supplied WomanUp path does not exist; inspected the corresponding reference at `C:/Users/vbaho/Documents/WomenUp-D/infra`, alongside AgroZanjir and YouthCapital. No reference repository was modified.

Read-only SSH/catalog checks reconfirmed `tijorat_markazi_db`, owner/login `tijorat_markazi_user`, schema USAGE/CREATE, zero application tables, no elevated role attributes and no role memberships. The owner confirms no source data exists, so rollout skips export/restore. The shared PostgreSQL image now includes pgvector; it remains external and untouched. Password authentication with the real application credential remains an operator check because the credential was not supplied.

The live server now has YouthCapital on 127.0.0.1:8080. Changed this project's frontend host binding/readiness to 127.0.0.1:8081; container/upstream port stays 8080. Backend host port 4321 and frontend host port 8081 were free; no installed Tijorat Markazi project or containers were present. Added Compose and deployment-shell regression assertions for 8081. Bootstrap now enables its project timer without starting it, avoiding immediate catch-up backups from Persistent=true; rollout starts it after acceptance. Rebuilt the append-only edge patch against the current AgroZanjir reference and checked it without applying. The live edge additionally includes WomanUP; the candidate retains WomanUP and the YouthCapital include, plus the existing global log filter.

| Check executed for this review | Result |
| --- | --- |
| Infra Node tests, including actual Compose models and Caddy routing/TLS-template checks | 16 passed |
| Python archive, restore and preflight guards | 7 passed |
| Backend tests with disposable PostgreSQL and a non-superuser application role | 16 passed; none skipped |
| Frontend unit/static tests and asset validation | 15 passed; 55 scripts and 43 pages validated |
| Backend/frontend release safety regressions | 27 passed per repository |
| Linux deployment regressions, including 8081 readiness | Passed |
| ShellCheck 0.11.0 and Bash syntax | Passed |
| actionlint 1.7.12 across all three repositories | Passed with only its known unsupported concurrency.queue keyword excluded |
| Both current local application image builds, frontend nginx -t | Passed |
| Real local frontend/backend/shared-network PostgreSQL readiness and session cookie | Passed |
| Project database/media backup and restore round trip | Passed; Windows chown mocked, container UID checked independently |
| Refreshed frontend image smoke: lazy DNS/startup, paths, cookies, headers, WebSocket, log privacy | Passed |
| Complete proposed edge candidate with exact running Caddy image | Valid; no production reload or issuance |
| Append-only edge patch | git apply --check passed against reference; not applied |
| Gitleaks 8.30.1 histories and source trees, all three repositories | Zero findings; output redacted |
| Pinned Semgrep 1.180.0, configured application ERROR rules | Zero findings in both applications |
| Trivy 0.75.0 source vulnerability/misconfiguration/secret scans | Zero HIGH/CRITICAL findings in all three repositories |
| Trivy current local backend/frontend images | Zero HIGH/CRITICAL findings after frontend runtime refresh |

The initial Trivy source attempt timed out after downloading its vulnerability database; the complete rerun used snapshots of all current tracked/untracked non-ignored source files and a longer timeout. The initial cached frontend image had four HIGH libexpat findings; rebuilding with `--no-cache-filter runtime` (already configured in release CI) upgraded libexpat to 2.10.0-r0 and cleared them. Semgrep was rerun on the same source snapshots with its pinned image and OSS engine after the first bind-mounted scan stalled. No CI rules or severity thresholds were weakened.

The refreshed exact shared-edge image scan reports **1 CRITICAL and 10 HIGH instances**. This supersedes the 26 October count. Shared infrastructure was not changed; remediation or explicit owner risk acceptance remains a cutover prerequisite. Reports/build/integration logs are local under ignored `.verification/security/*2026-11-06*`.

Public A/AAAA answers resolve to Cloudflare. The new origin still has no certificate/site for tijoratmarkazi.uz, and a direct SNI TLS handshake fails. Full (strict) settings and underlying origin DNS records cannot be authenticated from public DNS; verify them in Cloudflare before cutover. The runbook retains HTTP-01, disables TLS-ALPN-01 and requires direct certificate verification before deployment. GitHub CLI authentication still returns HTTP 401, so no prod settings were changed. No push, production bootstrap, migration, deployment, restart, timer activation, DNS change, certificate issuance or volume deletion occurred. Shared PostgreSQL and edge start timestamps remained unchanged throughout inspection.
