#!/usr/bin/env bash
set -euo pipefail
# shellcheck source=scripts/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
tm_bounded 25m "$@"
tm_lock
bundle="${1:?Usage: bootstrap.sh bundle-directory SSH-port}"
ssh_port="${2:-22}"
[[ "$ssh_port" =~ ^[0-9]+$ ]] && (( ssh_port >= 1 && ssh_port <= 65535 )) || exit 1
[[ "$EUID" == 0 ]] || { echo 'Bootstrap needs root or passwordless sudo.' >&2; exit 1; }
# shellcheck source=/dev/null
source /etc/os-release
[[ "$ID" == ubuntu ]] && [[ "$VERSION_ID" =~ ^(22\.04|24\.04|26\.04)$ ]] || {
  echo 'Use supported Ubuntu 22.04, 24.04 or 26.04 LTS.' >&2; exit 1;
}
[[ "$(dpkg --print-architecture)" == amd64 ]] || { echo 'This stack builds linux/amd64 images.' >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get -o DPkg::Lock::Timeout=120 update
apt-get -o DPkg::Lock::Timeout=120 install -y ca-certificates curl gnupg ufw dnsutils python3
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \
  https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod 0644 /etc/apt/keyrings/docker.asc
printf 'Types: deb\nURIs: https://download.docker.com/linux/ubuntu\nSuites: %s\nComponents: stable\nSigned-By: /etc/apt/keyrings/docker.asc\n' \
  "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.sources
curl --fail --silent --show-error --connect-timeout 10 --max-time 60 \
  https://dl.cloudsmith.io/public/caddy/stable/gpg.key | \
  gpg --batch --yes --dearmor -o /etc/apt/keyrings/caddy.gpg
printf 'deb [signed-by=/etc/apt/keyrings/caddy.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main\n' \
  > /etc/apt/sources.list.d/caddy.list
apt-get -o DPkg::Lock::Timeout=120 update
apt-get -o DPkg::Lock::Timeout=120 install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin caddy
systemctl enable --now docker caddy

# Preserve the actual SSH port before enabling host firewall rules.
sed -i 's/^IPV6=.*/IPV6=yes/' /etc/default/ufw
ufw allow "$ssh_port/tcp"
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable
printf 'net.core.rmem_max=7500000\nnet.core.wmem_max=7500000\n' > /etc/sysctl.d/90-tijoratmarkazi-quic.conf
sysctl -p /etc/sysctl.d/90-tijoratmarkazi-quic.conf >/dev/null

# Preserve provider/cloud-init networking; verify the assigned IPv6 instead.
if ! ip -6 address show scope global | grep -q 'inet6 ' || ! ip -6 route show default | grep -q default; then
  echo 'IPv6 address/default route missing. Assign public IPv6 and follow your provider network configuration before bootstrap.' >&2
  exit 1
fi
domain="$(sed -n 's/^DOMAIN=//p' "$bundle/runtime/caddy.env")"
# Proxied DNS returns CDN addresses; origin TLS is verified separately below.
python3 - "$domain" <<'PY'
import ipaddress
import subprocess
import sys

for record_type, family in (('A', 4), ('AAAA', 6)):
    records = []
    for line in subprocess.check_output(['dig', '+time=3', '+tries=1', '+short', record_type, sys.argv[1]], text=True, timeout=15).splitlines():
        try:
            address = ipaddress.ip_address(line)
            if address.version == family:
                records.append(address)
        except ValueError:  # Ignore CNAME labels; require final addresses.
            pass
    if not records:
        sys.exit(f'No {record_type} addresses resolved for DOMAIN. Check DNS records and propagation; Cloudflare proxying is supported.')
PY
bash "$bundle/scripts/apply-shared.sh" "$bundle"
# A CDN's edge certificate does not prove the origin has a valid certificate.
# Preserve Host/SNI and certificate verification. A fresh site's 502 is expected.
for attempt in {1..18}; do
  if curl --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 10 \
      --resolve "$domain:443:127.0.0.1" "https://$domain/" -o /dev/null; then
    break
  fi
  if [[ "$attempt" == 18 ]]; then
    echo 'Origin certificate is not ready. Check journalctl -u caddy, TCP 80/443 and DNS origin addresses. Allow /.well-known/acme-challenge/* through CDN redirects/WAF; use Full (strict) TLS.' >&2
    exit 1
  fi
  sleep 5
done
curl -6 --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 10 \
  --resolve "$domain:443:[::1]" "https://$domain/" -o /dev/null || {
  echo 'Origin IPv6 HTTPS failed on loopback; check Caddy IPv6 listening.' >&2; exit 1;
}
curl -6 --noproxy '*' --silent --show-error --connect-timeout 5 --max-time 15 "https://$domain/" -o /dev/null || {
  echo 'Public IPv6 HTTPS failed; check DNS, CDN certificate status and provider connectivity.' >&2; exit 1;
}
ss -lun '( sport = :443 )' | grep -q ':443' || { echo 'Caddy is not listening on UDP 443 for HTTP/3.' >&2; exit 1; }
echo 'Bootstrap complete. Publish/deploy each application independently.'
