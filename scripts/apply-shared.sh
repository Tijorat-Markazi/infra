#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
tm_bounded 10m "$@"
tm_lock
bundle="${1:?Usage: apply-shared.sh bundle-directory}"
skip_app="${2:-}"

# Validate before replacing the live Caddy configuration.
domain="$(sed -n 's/^DOMAIN=//p' "$bundle/runtime/caddy.env")"
email="$(sed -n 's/^ACME_EMAIL=//p' "$bundle/runtime/caddy.env")"
DOMAIN="$domain" ACME_EMAIL="$email" caddy validate --config "$bundle/Caddyfile" --adapter caddyfile

install -d -m 0755 "$TM_ROOT" "$TM_ROOT/scripts" "$TM_ROOT/apps/backend" "$TM_ROOT/apps/frontend"
install -d -m 0700 "$TM_ROOT/runtime"
install -m 0644 "$bundle/compose.yaml" "$TM_ROOT/compose.yaml"
for app in backend frontend; do
  install -m 0644 "$bundle/apps/$app/compose.yaml" "$TM_ROOT/apps/$app/compose.yaml"
done
for script in lib.sh deploy.sh apply-shared.sh bootstrap.sh; do
  install -m 0755 "$bundle/scripts/$script" "$TM_ROOT/scripts/$script"
done
for runtime in postgres backend caddy; do
  install -m 0600 "$bundle/runtime/$runtime.env" "$TM_ROOT/runtime/$runtime.env"
done
install -d -m 0755 "$TM_ROOT/data"
install -d -m 0700 "$TM_ROOT/data/backend" "$TM_ROOT/data/uploads"
# Container IDs need not exist in the host's passwd/group databases.
chown 10001:10001 "$TM_ROOT/data/backend" "$TM_ROOT/data/uploads"

install -d -m 0755 /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironmentFile=%s/runtime/caddy.env\n' "$TM_ROOT" > /etc/systemd/system/caddy.service.d/tijoratmarkazi.conf
install -m 0644 "$bundle/Caddyfile" /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl reload-or-restart caddy
tm_compose shared config --quiet
tm_compose shared up -d --wait --wait-timeout 120 postgres

# Configuration applies never copy either release file from an older snapshot.
for app in backend frontend; do
  [[ "$app" != "$skip_app" ]] || continue
  if [[ -f "$TM_ROOT/apps/$app/image.env" ]]; then
    tm_image "$app" "$TM_ROOT/apps/$app/image.env" >/dev/null
    bash "$TM_ROOT/scripts/deploy.sh" "$app"
  fi
done
echo 'Shared configuration applied; initialized applications are healthy.'
