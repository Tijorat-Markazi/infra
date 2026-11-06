#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
tm_bounded 5m "$@"
tm_lock
bundle="${1:?Usage: bootstrap.sh bundle-directory}"
[[ "$EUID" == 0 ]] || { echo 'Bootstrap needs passwordless sudo.' >&2; exit 1; }
for command in docker python3 flock install systemctl curl timeout tar; do
  command -v "$command" >/dev/null || { echo "Missing prerequisite: $command" >&2; exit 1; }
done
docker info >/dev/null
docker compose version
python3 "$bundle/scripts/preflight.py" "$bundle"

# Only this project's files, permissions and timer are prepared. No containers
# start, no migrations run, and no existing infrastructure is reconfigured.
bash "$bundle/scripts/apply-shared.sh" "$bundle" '' prepare-only
install -d -m 0700 "$TM_ROOT/backups"
cat > /etc/systemd/system/tijoratmarkazi-backup.service <<UNIT
[Unit]
Description=Tijorat Markazi database and media backup
After=docker.service
ConditionPathExists=$TM_ROOT/runtime/backend.env
[Service]
Type=oneshot
ExecStart=$TM_ROOT/scripts/backup.sh
UMask=0077
TimeoutStartSec=15min
UNIT
cat > /etc/systemd/system/tijoratmarkazi-backup.timer <<'UNIT'
[Unit]
Description=Daily Tijorat Markazi backup
[Timer]
OnCalendar=*-*-* 04:15:00 Asia/Tashkent
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
# Persistent timers can immediately run missed backups. Activate after cutover.
systemctl enable tijoratmarkazi-backup.timer
echo 'Project storage and backup timer prepared. Start the timer after approved cutover; no services started.'
