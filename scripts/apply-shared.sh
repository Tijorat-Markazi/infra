#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
tm_bounded 10m "$@"
tm_lock
bundle="${1:?Usage: apply-shared.sh bundle-directory [skip-app] [prepare-only]}"
skip_app="${2:-}"
mode="${3:-apply}"
[[ "$mode" == apply || "$mode" == prepare-only ]] || exit 1

python3 "$bundle/scripts/preflight.py" "$bundle"

install -d -m 0755 "$TM_ROOT" "$TM_ROOT/scripts" "$TM_ROOT/apps/backend" "$TM_ROOT/apps/frontend"
install -d -m 0700 "$TM_ROOT/runtime" "$TM_ROOT/backups"
install -m 0644 "$bundle/compose.yaml" "$TM_ROOT/compose.yaml"
for app in backend frontend; do
  install -m 0644 "$bundle/apps/$app/compose.yaml" "$TM_ROOT/apps/$app/compose.yaml"
done
for script in lib.sh deploy.sh apply-shared.sh bootstrap.sh preflight.py backup.py backup.sh restore.sh; do
  install -m 0755 "$bundle/scripts/$script" "$TM_ROOT/scripts/$script"
done
for runtime in compose.env caddy.env edge-site.caddy edge-log-filter.caddy backend.env; do
  if [[ -f "$bundle/runtime/$runtime" ]]; then
    install -m 0600 "$bundle/runtime/$runtime" "$TM_ROOT/runtime/$runtime"
  fi
done
install -d -m 0755 "$TM_ROOT/data"
install -d -m 0700 "$TM_ROOT/data/backend" "$TM_ROOT/data/uploads"
chown 10001:10001 "$TM_ROOT/data/backend" "$TM_ROOT/data/uploads"
tm_compose shared config --quiet
if [[ "$mode" == prepare-only ]]; then exit 0; fi

# Only initialized project applications are rechecked. The shared database and
# edge proxy are never managed here; Nginx configuration travels in the image.
for app in backend frontend; do
  [[ "$app" != "$skip_app" ]] || continue
  if [[ -f "$TM_ROOT/apps/$app/image.env" ]]; then
    tm_image "$app" "$TM_ROOT/apps/$app/image.env" >/dev/null
    bash "$TM_ROOT/scripts/deploy.sh" "$app"
  fi
done
echo 'Project configuration applied; shared infrastructure unchanged.'
