#!/usr/bin/env bash
# Root, after install-app.sh. TLS must terminate at the upstream load balancer.
set -Eeuo pipefail
DOMAIN=${DOMAIN:?Set DOMAIN to the HTTPS public hostname}
[[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]] || exit 1
HERE=$(cd -- "$(dirname -- "$0")" && pwd)
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get -o DPkg::Lock::Timeout=300 install -y --no-install-recommends caddy
install -d -m 0755 /etc/learnharness
# Create /etc/learnharness/proxy.env privately before running (see README).
test -s /etc/learnharness/proxy.env
chmod 600 /etc/learnharness/proxy.env
install -m 0644 "$HERE/oauth-helper.py" /opt/learnharness/oauth-helper.py
install -m 0644 "$HERE/learnharness-oauth.service" /etc/systemd/system/learnharness-oauth.service
printf 'LH_PUBLIC_ORIGIN=https://%s\n' "$DOMAIN" > /etc/learnharness/oauth.env
chmod 600 /etc/learnharness/oauth.env
install -m 0640 -o root -g caddy "$HERE/Caddyfile" /etc/caddy/Caddyfile
# Load the same systemd-compatible key=value file for validation, never echo it.
set -a
. /etc/learnharness/proxy.env
set +a
: "${LH_BASIC_USER:=learning}" "${LH_BASIC_PASSWORD_HASH:?}"
[[ "$LH_BASIC_USER" =~ ^[a-zA-Z0-9_]+$ ]] || exit 1
[[ "$LH_BASIC_PASSWORD_HASH" =~ ^\$2[aby]\$[0-9]{2}\$[./a-zA-Z0-9]{53}$ ]] || { echo "Expected bcrypt hash" >&2; exit 1; }
# Preserve a password changed through Settings when reinstalling.
if [[ ! -e /etc/caddy/learnharness-users.caddy ]]; then
  install -m 0640 -o root -g caddy /dev/null /etc/caddy/learnharness-users.caddy
  printf "%s %s\n" "$LH_BASIC_USER" "$LH_BASIC_PASSWORD_HASH" > /etc/caddy/learnharness-users.caddy
fi
caddy validate --config /etc/caddy/Caddyfile
systemctl daemon-reload
systemctl enable --now learnharness-oauth.service
systemctl restart learnharness-oauth.service
systemctl enable caddy
systemctl restart caddy
