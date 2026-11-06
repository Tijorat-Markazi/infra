#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
tm_bounded 14m "$@"
tm_lock
umask 077
exec python3 "$TM_ROOT/scripts/backup.py" backup "$TM_ROOT"
