#!/usr/bin/env bash
# Run as root on Ubuntu 24.04 amd64. No model/provider credentials are configured.
set -Eeuo pipefail
umask 022
export DEBIAN_FRONTEND=noninteractive
COMMIT=${LH_BUILD_COMMIT:?Set LH_BUILD_COMMIT to the full source commit}
REPOSITORY=${LH_REPOSITORY:?Set LH_REPOSITORY to your Git clone URL}
DOMAIN=${DOMAIN:?Set DOMAIN to the public hostname}
[[ "$DOMAIN" =~ ^[a-zA-Z0-9.-]+$ ]] || { echo "Invalid DOMAIN" >&2; exit 1; }
[[ "$COMMIT" =~ ^[a-f0-9]{40}$ ]] || { echo "Use a full commit SHA" >&2; exit 1; }
NODE_VERSION=${NODE_VERSION:-26.13.1}
BASE=/opt/learnharness
RELEASE="$BASE/releases/$COMMIT"
NODE_HOME="/opt/node-v${NODE_VERSION}-linux-x64"
export PATH="$NODE_HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
[[ $(id -u) == 0 ]] || { echo 'Run as root' >&2; exit 1; }
. /etc/os-release
[[ "$ID" == ubuntu && "$VERSION_ID" == 24.04 && $(dpkg --print-architecture) == amd64 ]] || { echo 'Requires Ubuntu 24.04 amd64' >&2; exit 1; }
apt-get update
apt-get install -y --no-install-recommends ca-certificates curl xz-utils git build-essential python3 fontconfig fonts-liberation
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  node_stage=$(mktemp -d)
  (
    cd "$node_stage"
    curl --fail --show-error --silent --location --retry 3 -O "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz"
    curl --fail --show-error --silent --location --retry 3 -O "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
    awk -v name="node-v$NODE_VERSION-linux-x64.tar.xz" '$2 == name {print}' SHASUMS256.txt > selected.sha256
    test -s selected.sha256
    sha256sum --check selected.sha256
    tar -xJf "node-v$NODE_VERSION-linux-x64.tar.xz" -C /opt
  )
  rm -rf "$node_stage"
fi
[[ $(node --version) == "v$NODE_VERSION" ]]
# Ubuntu's chromium package is a snap shim; use Chrome's native deb instead.
if [[ ! -x /usr/bin/google-chrome ]]; then
  chrome_stage=$(mktemp -d)
  curl -fsSL --retry 3 https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o "$chrome_stage/chrome.deb"
  chmod 755 "$chrome_stage"
  chmod 644 "$chrome_stage/chrome.deb"
  apt-get install -y "$chrome_stage/chrome.deb"
  rm -rf "$chrome_stage"
fi
getent passwd learnharness >/dev/null || useradd --system --user-group --home-dir /var/lib/learnharness --shell /usr/sbin/nologin learnharness
install -d -m 0755 "$BASE" "$BASE/releases"
install -d -m 0700 -o learnharness -g learnharness /var/lib/learnharness /var/lib/learnharness/data /var/lib/learnharness/auth
if [[ ! -e /var/lib/learnharness/auth/auth.json ]]; then
  install -m 0600 -o learnharness -g learnharness /dev/null /var/lib/learnharness/auth/auth.json
  printf '{}\n' > /var/lib/learnharness/auth/auth.json
fi
if [[ ! -f "$RELEASE/.deployment-complete" ]]; then
  build_stage=$(mktemp -d "$BASE/.build-XXXXXXXX")
  chown learnharness:learnharness "$build_stage"
  runuser -u learnharness -- env PATH="$PATH" HOME=/var/lib/learnharness BUILD_STAGE="$build_stage" APP_COMMIT="$COMMIT" APP_REPOSITORY="$REPOSITORY" bash <<'BUILD'
set -Eeuo pipefail
git clone "$APP_REPOSITORY" "$BUILD_STAGE/source"
cd "$BUILD_STAGE/source"
git checkout --detach "$APP_COMMIT"
test "$(git rev-parse HEAD)" = "$APP_COMMIT"
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 NEXT_TELEMETRY_DISABLED=1
npm ci --no-audit --no-fund
npm run plugins:setup
export LH_BUILD_COMMIT="$APP_COMMIT"
export LH_VERSION=$(node -p "require('./package.json').version")
npm run build
node scripts/build-server.mjs
# Includes isolated native provider/demo/compression and core-plugin runtime gates.
node scripts/smoke-server.mjs
BUILD
  # The final runtime contains only the curated standalone payload.
  install -d "$RELEASE"
  cp -a "$build_stage/source/.next/standalone/." "$RELEASE/"
  chown -R root:root "$RELEASE"
  chmod -R a+rX "$RELEASE"
  install -d -o learnharness -g learnharness "$RELEASE/.next/cache"
  printf '%s\n' "$COMMIT" > "$RELEASE/.deployment-complete"
  rm -rf "$build_stage"
fi
APP_VERSION=$(node -p "require('$RELEASE/package.json').version")
ln -sfn "$RELEASE" "$BASE/current.next"
mv -Tf "$BASE/current.next" "$BASE/current"
install -d -m 0755 /etc/learnharness
# An optional separately managed env file can supply additional non-model settings.
cat > /etc/systemd/system/learnharness.service <<UNIT
[Unit]
Description=LearnHarness personal learning application
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=learnharness
Group=learnharness
WorkingDirectory=$BASE/current
Environment=NODE_ENV=production
Environment=NEXT_TELEMETRY_DISABLED=1
Environment=HOSTNAME=127.0.0.1
Environment=PORT=3000
Environment=HOME=/var/lib/learnharness
Environment=PATH=$PATH
Environment=LH_DATA_DIR=/var/lib/learnharness/data
Environment=LH_AUTH_FILE=/var/lib/learnharness/auth/auth.json
Environment=LH_ALLOWED_HOSTS=$DOMAIN
Environment=LH_BUILD_COMMIT=$COMMIT
Environment=LH_VERSION=$APP_VERSION
Environment=CHROME_PATH=/usr/bin/google-chrome
EnvironmentFile=-/etc/learnharness/runtime.env
ExecStart=$NODE_HOME/bin/node $BASE/current/server.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=30
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectHome=true
ProtectSystem=strict
ReadWritePaths=/var/lib/learnharness $BASE/releases

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable learnharness.service
systemctl restart learnharness.service
ready=0
for attempt in {1..60}; do
  if curl --fail --silent http://127.0.0.1:3000/ >/dev/null; then ready=1; break; fi
  sleep 2
done
if [[ "$ready" != 1 ]]; then
  systemctl status learnharness.service --no-pager || true
  journalctl -u learnharness.service -n 80 --no-pager
  exit 1
fi
echo "LearnHarness $COMMIT is listening on 127.0.0.1:3000"
