#!/usr/bin/env bash
set -Eeuo pipefail
[[ $(id -u) == 0 ]]
SOURCE=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
apt-get install -y --no-install-recommends python3-bcrypt
install -d -m 0755 /opt/learnharness/helpers
install -m 0644 "$SOURCE/password-helper.py" /opt/learnharness/helpers/password-helper.py
install -m 0644 "$SOURCE/learnharness-password.service" /etc/systemd/system/
install -d -m 0755 /etc/systemd/system/learnharness.service.d
cat > /etc/systemd/system/learnharness.service.d/password.conf <<'UNIT'
[Service]
Environment=LH_PASSWORD_SOCKET=/run/learnharness-password/helper.sock
UNIT
systemctl daemon-reload
systemctl enable --now learnharness-password.service
systemctl restart learnharness-password.service
# Restart the application with the new environment during the coordinated app release.
