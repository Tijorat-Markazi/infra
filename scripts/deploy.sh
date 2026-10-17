#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
tm_bounded 10m "$@"
tm_lock

app="${1:?Usage: deploy.sh backend|frontend [incoming-image.env]}"
case "$app" in backend|frontend) ;; *) echo 'Unknown application.' >&2; exit 1 ;; esac
incoming="${2:-$TM_ROOT/apps/$app/image.env}"
tm_image "$app" "$incoming" >/dev/null
if [[ "$incoming" != "$TM_ROOT/apps/$app/image.env" ]]; then
  install -m 0644 "$incoming" "$TM_ROOT/apps/$app/image.env"
fi

# Recover stopped dependencies, then replace only this application.
tm_compose "$app" config --quiet
tm_compose "$app" up -d --wait --wait-timeout 120 postgres
tm_compose "$app" pull "$app"
tm_compose "$app" up -d --no-deps --wait --wait-timeout 120 "$app"

if [[ "$app" == backend ]]; then
  status="$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 5 --max-time 10 \
    --output /dev/null --write-out '%{http_code}' \
    http://127.0.0.1:4321/api/health/ready)"
else
  status="$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 5 --max-time 10 \
    --output /dev/null --write-out '%{http_code}' \
    http://127.0.0.1:8080/healthz)"
fi
[[ "$status" == 200 ]] || { echo "$app readiness returned HTTP $status, expected 200." >&2; exit 1; }
domain="$(sed -n 's/^DOMAIN=//p' "$TM_ROOT/runtime/caddy.env")"
[[ "$domain" =~ ^[a-z0-9][a-z0-9.-]*\.[a-z]+$ ]] || { echo 'Invalid installed domain.' >&2; exit 1; }
if [[ "$app" == backend ]]; then ready_path=/api/health/ready; else ready_path=/healthz; fi
# Validate the installed certificate and Caddy routing independently of public DNS.
status="$(curl --noproxy '*' --fail --silent --show-error --connect-timeout 5 --max-time 10 \
  --resolve "$domain:443:127.0.0.1" --output /dev/null --write-out '%{http_code}' \
  "https://$domain$ready_path")"
[[ "$status" == 200 ]] || { echo "$app HTTPS readiness returned HTTP $status, expected 200." >&2; exit 1; }
echo "$app is healthy."
