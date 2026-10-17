#!/usr/bin/env bash
set -euo pipefail
repository="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
scratch="$(mktemp -d)"
trap 'if [[ "${stage:-}" =~ ^/tmp/tijoratmarkazi\.[a-zA-Z0-9]+$ ]]; then rm -rf "$stage"; fi; rm -rf "$scratch"' EXIT
export TM_ROOT="$scratch/root with spaces"
export TM_LOCK_HELD=1 TM_TIMEOUT_HELD=1
export TEST_LOG="$scratch/docker.log" TEST_CURL_LOG="$scratch/curl.log" TEST_COMMAND_LOG="$scratch/commands.log"
mkdir -p "$scratch/bin" "$TM_ROOT/apps/backend" "$TM_ROOT/apps/frontend"
mkdir -p "$TM_ROOT/runtime"
printf 'DOMAIN=example.test\n' > "$TM_ROOT/runtime/caddy.env"
cat > "$scratch/bin/docker" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$TEST_LOG"
printf '%q ' "$@" >> "$TEST_COMMAND_LOG"
printf '\n' >> "$TEST_COMMAND_LOG"
if [[ "${TEST_FAIL_SHARED:-}" == 1 && "$*" == *'postgres'* ]]; then exit 13; fi
if [[ "${TEST_FAIL_PULL:-}" == 1 && "$*" == *'pull backend'* ]]; then exit 12; fi
MOCK
cat > "$scratch/bin/curl" <<'MOCK'
#!/usr/bin/env bash
printf '%s\n' "$@" >> "$TEST_CURL_LOG"
if [[ "$*" == *https://* ]]; then
  printf '%s' "${TEST_HTTPS_STATUS:-${TEST_HTTP_STATUS:-200}}"
else
  printf '%s' "${TEST_HTTP_STATUS:-200}"
fi
MOCK
chmod +x "$scratch/bin/docker" "$scratch/bin/curl"
export PATH="$scratch/bin:$PATH"
printf 'BACKEND_IMAGE=ghcr.io/tijorat-markazi/backend:backend-%040d-r1-123-a1@sha256:%064d\n' 0 0 > "$scratch/backend.env"
bash "$repository/scripts/deploy.sh" backend "$scratch/backend.env"
grep -q '^backend$' "$TEST_LOG"
if grep -q '^frontend$' "$TEST_LOG"; then exit 1; fi
grep -q 'up .*postgres' "$TEST_COMMAND_LOG"
grep -Fq "$TM_ROOT/compose.yaml" "$TEST_LOG"
grep -q '^--no-deps$' "$TEST_LOG"
if grep -q '^--remove-orphans$' "$TEST_LOG"; then exit 1; fi
grep -q '/api/health/ready$' "$TEST_CURL_LOG"
grep -q '^--resolve$' "$TEST_CURL_LOG"
grep -q '^--noproxy$' "$TEST_CURL_LOG"
grep -q '^example.test:443:127.0.0.1$' "$TEST_CURL_LOG"
test ! -f "$TM_ROOT/apps/frontend/image.env"

: > "$TEST_LOG"
# Deliberately test a literal command substitution rather than executing it.
# shellcheck disable=SC2016
printf 'BACKEND_IMAGE=$(touch %s)\n' "$scratch/injected" > "$scratch/malicious.env"
if bash "$repository/scripts/deploy.sh" backend "$scratch/malicious.env"; then
  echo 'Shell-injected manifest was accepted.' >&2; exit 1
fi
test ! -e "$scratch/injected"
test ! -s "$TEST_LOG"
if bash "$repository/scripts/deploy.sh" unknown; then exit 1; fi

: > "$TEST_COMMAND_LOG"
if TEST_FAIL_PULL=1 bash "$repository/scripts/deploy.sh" backend "$scratch/backend.env"; then
  echo 'Pull failure was reported as deployment success.' >&2; exit 1
fi
if grep -q 'up .* backend ' "$TEST_COMMAND_LOG"; then exit 1; fi

: > "$TEST_LOG"
: > "$TEST_COMMAND_LOG"
if TEST_FAIL_SHARED=1 bash "$repository/scripts/deploy.sh" backend "$scratch/backend.env"; then
  echo 'Unhealthy dependencies were reported as deployment success.' >&2; exit 1
fi
if grep -q '^pull$' "$TEST_LOG"; then exit 1; fi

printf 'FRONTEND_IMAGE=ghcr.io/tijorat-markazi/frontend:frontend-%040d-r2-456-a1@sha256:%064d\n' 0 0 > "$scratch/frontend.env"
bash "$repository/scripts/deploy.sh" frontend "$scratch/frontend.env"
grep -q '/healthz$' "$TEST_CURL_LOG"

for response in 204 302; do
  if TEST_HTTP_STATUS="$response" bash "$repository/scripts/deploy.sh" frontend "$scratch/frontend.env"; then
    echo "HTTP $response was accepted as readiness." >&2; exit 1
  fi
done

if TEST_HTTPS_STATUS=503 bash "$repository/scripts/deploy.sh" frontend "$scratch/frontend.env"; then
  echo 'Healthy container with failing Caddy route was accepted.' >&2; exit 1
fi

# Execute the actual nested SSH command against a disposable local bundle.
# A broken transferred script must stop bootstrap before sudo/registry changes.
stage="$(mktemp -d /tmp/tijoratmarkazi.XXXXXXXX)"
[[ "$stage" =~ ^/tmp/tijoratmarkazi\.[a-zA-Z0-9]+$ ]] || exit 1
export TEST_BOOTSTRAP_STAGE="$stage"
mkdir -p "$stage/scripts"
printf 'if then\n' > "$stage/scripts/bootstrap.sh"
tar -C "$stage" -czf "$stage/bundle.tar.gz" scripts
cat > "$scratch/bin/sudo" <<'MOCK'
#!/usr/bin/env bash
printf 'unexpected sudo\n' >> "$TEST_COMMAND_LOG"
exit 97
MOCK
chmod +x "$scratch/bin/sudo"
command="$(MSYS2_ENV_CONV_EXCL=TEST_BOOTSTRAP_STAGE node --input-type=module -e '
  import { pathToFileURL } from "node:url";
  const { remoteCommand } = await import(pathToFileURL(process.argv[2]));
  console.log(remoteCommand({ mode: "bootstrap", remote: process.env.TEST_BOOTSTRAP_STAGE, port: 22, actor: "fixture" }));
' fixture "$repository/scripts/controller.mjs")"
: > "$TEST_COMMAND_LOG"
if bash -c "$command" <<< 'fixture-registry-token'; then
  echo 'Bootstrap accepted a broken transferred shell script.' >&2; exit 1
fi
test ! -s "$TEST_COMMAND_LOG"
test ! -e "$stage"

# Exercise the real timeout wrapper on a short-lived fixture, not a ten-minute test.
cat > "$scratch/timeout.sh" <<'SCRIPT'
#!/usr/bin/env bash
source "$TEST_REPOSITORY/scripts/lib.sh"
unset TM_TIMEOUT_HELD
if [[ "${1:-}" == child ]]; then sleep 20; exit; fi
tm_bounded 1s child
SCRIPT
export TEST_REPOSITORY="$repository"
set +e
timeout 5s bash "$scratch/timeout.sh"
status=$?
set -e
[[ "$status" == 124 ]]
echo 'Deployment isolation, literal manifests and bounded execution passed.'
