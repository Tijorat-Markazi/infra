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

Working-tree Gitleaks checks exclude only the ignored local verification-tool cache; CI retains the default full Git-history scan. Frontend history is clean. Backend history contains **29 password findings** in `data/orgs.json`, commit `20cf52b0bb08f77bdce05d123132ed58d4247aff`. The release gate remains intentionally blocked until credentials are rotated and public history is reviewed/remediated. No blanket ignore or history rewrite was introduced.

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
