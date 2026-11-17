#!/usr/bin/env bash
# Run after installing the session-auth-capable app and password helper.
# Keep the existing Caddy auth configuration until this entire preparation succeeds.
set -Eeuo pipefail
[[ $(id -u) == 0 ]]
DOMAIN=${DOMAIN:-learning.dmxo.dev}
[[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]] || exit 1
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -m 0700 -o learnharness -g learnharness /var/lib/learnharness/security
if [[ ! -s /var/lib/learnharness/security/session-secret ]]; then
 umask 077
 python3 - <<'PY'
from pathlib import Path
import secrets
p=Path('/var/lib/learnharness/security/session-secret')
with p.open('x') as out: out.write(secrets.token_hex(32))
PY
fi
chown learnharness:learnharness /var/lib/learnharness/security/session-secret
chmod 0600 /var/lib/learnharness/security/session-secret
install -d /etc/systemd/system/learnharness.service.d
cat > /etc/systemd/system/learnharness.service.d/session-auth.conf <<UNIT
[Service]
Environment=LH_SESSION_AUTH=1
Environment=LH_SESSION_ORIGIN=https://$DOMAIN
Environment=LH_SESSION_SECRET_FILE=/var/lib/learnharness/security/session-secret
UNIT
systemctl daemon-reload
systemctl restart learnharness
ready=0
for attempt in {1..30}; do
 if curl -fsS -H "Host: $DOMAIN" http://127.0.0.1:3000/login > /dev/null; then ready=1; break; fi
 sleep 2
done
test "$ready" = 1
# Forward-auth must fail closed for a request without a session.
status=$(curl -s -o /dev/null -w '%{http_code}' -H "Host: $DOMAIN" http://127.0.0.1:3000/api/auth/verify)
test "$status" = 401
install -m 0644 "$SOURCE/Caddyfile" /etc/caddy/Caddyfile.session-next
/usr/bin/caddy validate --config /etc/caddy/Caddyfile.session-next --adapter caddyfile
cp -a /etc/caddy/Caddyfile /etc/caddy/Caddyfile.before-session
mv /etc/caddy/Caddyfile.session-next /etc/caddy/Caddyfile
if ! systemctl reload caddy; then
 cp -a /etc/caddy/Caddyfile.before-session /etc/caddy/Caddyfile
 systemctl reload caddy
 exit 1
fi
