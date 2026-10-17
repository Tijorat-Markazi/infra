# First production deployment

This project uses Node for both applications. Follow these steps for a fresh Ubuntu VPS. Commands marked PowerShell run on your Windows laptop; bash commands run through your trusted server console/admin account. Replace placeholders before running a block.

## 1. Prepare GitHub, DNS and the VPS

Review source **and Git history** before making repositories public. The backend's historical `data/orgs.json` was removed from all commits in the approved 17 October 2026 cleanup, and full-history Gitleaks passes. Rotate any previously exposed passwords still in use. Preserve local work and realign or reclone old backend checkouts; do not merge the removed history back. Keep the full-history security gate enabled.

Create `prod` environments in `Tijorat-Markazi/backend`, `frontend` and `infra`, with deployment branches restricted to `main`. Private repositories need an eligible plan for environment secrets. Push the reviewed infra implementation before application releases.

Use an amd64 Ubuntu 22.04/24.04/26.04 VPS with public IPv4 and IPv6. Configure domain A/AAAA origin records for those VPS addresses. Permit the actual SSH TCP port, TCP 80/443, UDP 443 and ICMP/ICMPv6 in the provider firewall. GitHub-hosted runners must be able to reach SSH.

Cloudflare proxying may stay enabled. Set **Full (strict)** TLS, keep origin TCP 80 reachable, and allow `/.well-known/acme-challenge/*` through redirect/WAF rules. Leave Always Use HTTPS off during first certificate issuance. Public DNS can return Cloudflare addresses; bootstrap checks the origin certificate separately. Browser HTTP/3 through the proxy tests Cloudflare's edge; enable its HTTP/3 setting separately.

## 2. Create and install the deployment key

PowerShell:

```powershell
$TmDeployKey = Join-Path $env:USERPROFILE '.ssh\tijoratmarkazi-deploy'
New-Item -ItemType Directory -Force (Split-Path $TmDeployKey) | Out-Null
if (Test-Path -LiteralPath $TmDeployKey) { throw 'Key already exists; reuse it or choose another filename.' }
ssh-keygen -t ed25519 -f $TmDeployKey -C 'tijoratmarkazi-production'
Get-Content -Raw "$TmDeployKey.pub" | Set-Clipboard
```

Use an empty passphrase for this dedicated automation key. Install only its `.pub` contents on the VPS. Keep the private file on your laptop for the GitHub secret.

From a trusted **root console** on the VPS:

```bash
TM_PUBLIC_KEY='REPLACE_WITH_COMPLETE_SSH_ED25519_PUBLIC_KEY'
id deploy >/dev/null 2>&1 || adduser --disabled-password --gecos '' deploy
install -d -o deploy -g deploy -m 0700 /home/deploy/.ssh
touch /home/deploy/.ssh/authorized_keys
grep -qF -- "$TM_PUBLIC_KEY" /home/deploy/.ssh/authorized_keys || printf 'restrict %s\n' "$TM_PUBLIC_KEY" >> /home/deploy/.ssh/authorized_keys
chown deploy:deploy /home/deploy/.ssh/authorized_keys
chmod 0600 /home/deploy/.ssh/authorized_keys
printf 'deploy ALL=(ALL) NOPASSWD: ALL\n' > /etc/sudoers.d/tijoratmarkazi-deploy
chmod 0440 /etc/sudoers.d/tijoratmarkazi-deploy
visudo -cf /etc/sudoers.d/tijoratmarkazi-deploy
```

Restrict that account to noninteractive key authentication:

```bash
cat > /etc/ssh/sshd_config.d/60-tijoratmarkazi-deploy.conf <<'SSH'
Match User deploy
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    AllowTcpForwarding no
    X11Forwarding no
Match all
SSH
/usr/sbin/sshd -t && systemctl reload ssh
sudo -n -u deploy sudo -n id -u
```

The final command must print `0`. Keep your console open while testing another SSH connection. This automation account has root-equivalent sudo privilege; the application containers use non-root users. Bootstrap connects as `deploy`, never root.

## 3. Verify server host trust

In the trusted VPS console:

```bash
ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
TM_VPS_ADDRESS='REPLACE_WITH_VPS_IPV4'
printf '%s ' "$TM_VPS_ADDRESS"
cat /etc/ssh/ssh_host_ed25519_key.pub
```

Save the complete final line as `VPS_KNOWN_HOSTS`, for example `203.0.113.10 ssh-ed25519 AAAA...`. The fingerprint alone is insufficient. The initial address must exactly match `VPS_HOST`. For a custom SSH port, use `[address]:port`. Read the **public** host key, never the private host key, and do not trust an unverified `ssh-keyscan` result.

PowerShell, using your real values:

```powershell
$TmVpsAddress = 'REPLACE_WITH_VPS_IPV4'
$TmKnownHosts = Join-Path $env:USERPROFILE '.ssh\tijoratmarkazi_known_hosts'
Set-Content -LiteralPath $TmKnownHosts -Encoding ascii -Value 'REPLACE_WITH_COMPLETE_VERIFIED_KNOWN_HOSTS_LINE'
ssh -i $TmDeployKey -p 22 -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o "UserKnownHostsFile=$TmKnownHosts" "deploy@$TmVpsAddress" 'whoami; sudo -n id -u'
```

Expected output is `deploy`, then `0`, without a password prompt. Change port 22 consistently if using another SSH port. Do not bypass host-key checking after replacing a server; verify the new public host key through its trusted console.

## 4. Configure infra/prod

Add these **environment secrets** in [infra/prod](https://github.com/Tijorat-Markazi/infra/settings/environments):

| Secret | Value |
| --- | --- |
| `VPS_HOST` | Real IP/hostname only. Move any existing `VPS_HOST` variable here and delete the old variable. |
| `VPS_SSH_KEY` | Complete laptop private deployment key, including BEGIN/END lines. |
| `VPS_KNOWN_HOSTS` | Complete trusted host-key line from step 3. |
| `POSTGRES_PASSWORD` | Independent random password, at least 24 characters. |
| `ADMIN_PASSWORD`, `RAIS_PASSWORD` | Independent random passwords, each at least 16 characters. |
| `ANTHROPIC_API_KEY`, `TELEGRAM_BOT_TOKEN` | Optional existing integrations. |

To copy the private client key on your laptop: `Get-Content -Raw $TmDeployKey | Set-Clipboard`. Paste it directly into GitHub's secret field.

Add **environment variables** `VPS_USERNAME=deploy`, `VPS_PORT=22`, your lowercase `DOMAIN`, and your `ACME_EMAIL`. Set `POSTGRES_DB=tijoratmarkazi`, `POSTGRES_USER=tijoratmarkazi`, `WEB_CONCURRENCY=1`, `STARTUP_TIMEOUT=120`, `DOC_TTL_DAYS=14`. `ANTHROPIC_MODEL` is required only when its API key is configured; `RAIS_TG_CHAT` is optional. All runtime values must be single-line. See [production.env.example](production.env.example).

Do not put GitHub App credentials in infra or VPS credentials in either app repo. GitHub automatically supplies `GITHUB_TOKEN`; do not create that secret yourself.

## 5. Bootstrap and release

Dispatch **infra → Actions → server bootstrap → Run workflow → main**. The single run shows **Validate infra → Bootstrap Ubuntu server**. Validation runs without production secrets; failure skips bootstrap. The bootstrap job uses only the exact validated commit, repeats script syntax checks, connects with your pinned SSH trust, then checks transferred shell scripts before installation.

On a fresh VPS it installs Docker/Compose/Caddy, prepares private runtime/data directories, configures the firewall/QUIC buffers and starts PostgreSQL 18. No application image is required; missing application routes can return 502 until first release.

Create a GitHub App installed on **Tijorat-Markazi/infra only**, with **Contents read/write**, **Actions read/write**, and **Deployments read** permissions. Generate its private key. In **each application's prod environment**, add secret `INFRA_APP_PRIVATE_KEY` and variables `INFRA_APP_ID` (App ID, not Client ID) and `INFRA_REPO=Tijorat-Markazi/infra`. Permit the App's automated image commits through any branch rules requiring PRs. It does not need Workflows or Deployments-write permission.

For each application:

1. Dispatch **CI and release** on `main` with `publish_only=true`. Wait for source scans, tests, image publishing and the image scan to pass.
2. Open that GHCR package's **Manage Actions access**. Give **Tijorat-Markazi/infra Read** and verify its publishing repository has Admin.
3. Dispatch a normal release with `publish_only=false`. It updates only its infra image file and waits for the matching infra deployment.
4. Open the infra run: **Validate infra → Deploy backend/frontend** are jobs in that same run. A validation failure skips deploy and prevents app cleanup.

Initial pushes containing empty image files can trigger rejected deploy runs; they make no VPS changes. Bootstrap and real application releases initialize the server independently.

## Routine updates and recovery

Normal app releases replace only their own container. For config or runtime-secret changes, dispatch an infra app workflow with `apply_shared=true` (default), leaving `expected_image` empty. For routine image recovery, use `apply_shared=false`. A failed app deploy-job retry reuses its existing candidate and dispatches recovery once; old runs cannot rewind a newer desired image.

Failed, pending or unknown deployment outcomes prevent registry pruning. Current and previous distinct healthy images stay protected; use retained images for rollbacks. Under future storage limits, prepublish maintenance removes only unprotected versions when deployment state is confirmed healthy.

Changing `POSTGRES_PASSWORD` in GitHub does not rotate an existing database role. Rotate it interactively with PostgreSQL's `\password`, then update the GitHub secret and apply shared config. Rotate an existing Rais account through an authenticated administrator action. Updating `ADMIN_PASSWORD` and applying shared config rotates administrator access.

For a replacement server, prepare its account/key trust and DNS, update infra/prod's VPS settings, run bootstrap, then dispatch each app with `apply_shared=false` to pull retained releases. Moving existing database/uploads is a separate operator task.

After deployment, check public IPv6 and HTTP/3 with `curl -6 -I https://<DOMAIN>` and an HTTP/3-capable `curl --http3-only -I https://<DOMAIN>`. Through Cloudflare these probe the edge. To probe origin QUIC directly, use `curl --http3-only --noproxy '*' --resolve '<DOMAIN>:443:<VPS_IPV4>' -I https://<DOMAIN>` with the real domain/IP. Keep backend, frontend and database ports private.
