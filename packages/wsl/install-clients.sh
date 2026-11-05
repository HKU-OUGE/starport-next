#!/bin/bash
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin HOME=/root LANG=C.UTF-8 TZ=Asia/Taipei DEBIAN_FRONTEND=noninteractive
export HTTPS_PROXY="${STARPORT_INSTALL_PROXY:?controlled installer proxy required}" HTTP_PROXY="$STARPORT_INSTALL_PROXY"
export https_proxy="$HTTPS_PROXY" http_proxy="$HTTP_PROXY" NO_PROXY=localhost,127.0.0.1
apt_options=(-o "Acquire::https::Proxy=$HTTPS_PROXY" -o "Acquire::http::Proxy=$HTTP_PROXY" -o Acquire::Retries=2 -o Acquire::https::Timeout=45)
python3 - <<'PY'
from pathlib import Path
p=Path('/etc/apt/sources.list.d/ubuntu.sources')
p.write_text(p.read_text().replace('http://archive.ubuntu.com/','https://archive.ubuntu.com/').replace('http://security.ubuntu.com/','https://security.ubuntu.com/').replace('http://ports.ubuntu.com/','https://ports.ubuntu.com/'))
PY
apt-get "${apt_options[@]}" update -qq
apt-get "${apt_options[@]}" install -y --no-install-recommends ca-certificates curl gnupg dbus-x11 xterm xdg-utils gnome-keyring fonts-noto-cjk libsecret-1-0 tigervnc-standalone-server openbox thunar
install -d -m 0755 /etc/apt/keyrings
curl -fSs --retry-all-errors --retry-delay 2 --retry 2 --max-time 60 https://downloads.claude.ai/keys/claude-code.asc -o /etc/apt/keyrings/claude-code.asc
fingerprint=$(gpg --batch --with-colons --show-keys /etc/apt/keyrings/claude-code.asc | awk -F: '$1=="fpr" {print $10; exit}')
test "$fingerprint" = 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/stable stable main' > /etc/apt/sources.list.d/claude-code.list
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-desktop/apt/stable stable main' > /etc/apt/sources.list.d/claude-desktop.list
apt-get "${apt_options[@]}" update -qq
apt-get "${apt_options[@]}" install -y --no-install-recommends claude-code claude-desktop
case "$(dpkg --print-architecture)" in
 amd64)
  node_arch=x64
  if ! command -v google-chrome-stable >/dev/null; then
   curl -fSs --retry-all-errors --retry-delay 2 --retry 2 --max-time 600 https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /var/cache/starport-browser.deb
   apt-get "${apt_options[@]}" install -y --no-install-recommends /var/cache/starport-browser.deb
   rm /var/cache/starport-browser.deb
  fi
  ;;
 arm64)
  node_arch=arm64
  curl -fSs --retry-all-errors --retry-delay 2 --retry 2 --max-time 60 https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/starport-mozilla.asc
  fingerprint=$(gpg --batch --with-colons --show-keys /etc/apt/keyrings/starport-mozilla.asc | awk -F: '$1=="fpr" {print $10; exit}')
  test "$fingerprint" = 35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3
  printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/starport-mozilla.asc] https://packages.mozilla.org/apt mozilla main' > /etc/apt/sources.list.d/starport-mozilla.list
  printf '%s\n' 'Package: firefox*' 'Pin: origin packages.mozilla.org' 'Pin-Priority: 1000' > /etc/apt/preferences.d/starport-firefox
  apt-get "${apt_options[@]}" update -qq
  apt-get "${apt_options[@]}" install -y --no-install-recommends firefox
  ;;
 *) exit 12;;
esac
install -d -m 0755 /usr/local/lib/starport/node
if [ ! -x /usr/local/lib/starport/node/bin/node ]; then
 name="node-v22.23.1-linux-$node_arch.tar.xz"
 curl -fSs --retry-all-errors --retry-delay 2 --retry 3 --max-time 600 "https://nodejs.org/dist/v22.23.1/$name" -o /var/cache/starport-node.tar.xz
 curl -fSs --retry-all-errors --retry-delay 2 --retry 2 --max-time 60 https://nodejs.org/dist/v22.23.1/SHASUMS256.txt -o /var/cache/starport-node-sums.txt
 digest=$(awk -v name="$name" '$2==name {print $1}' /var/cache/starport-node-sums.txt)
 test -n "$digest"
 printf '%s  /var/cache/starport-node.tar.xz\n' "$digest" | sha256sum --check --status
 tar -xJf /var/cache/starport-node.tar.xz --strip-components=1 -C /usr/local/lib/starport/node
 rm /var/cache/starport-node.tar.xz /var/cache/starport-node-sums.txt
fi
ln -sfn /usr/local/lib/starport/node/bin/node /usr/local/bin/node
ln -sfn /usr/local/lib/starport/node/bin/npm /usr/local/bin/npm
cd /usr/local/lib/starport/agent
npm ci --maxsockets=4 --fetch-timeout=60000 --fetch-retries=3 --omit=optional --ignore-scripts --no-audit --no-fund --cache /var/cache/starport-npm
chown -R root:root /usr/local/lib/starport
chmod -R go-w /usr/local/lib/starport
node --input-type=module -e 'import {query} from "@anthropic-ai/claude-agent-sdk"; console.log(JSON.stringify({sdkReady:typeof query==="function",node:process.version}))'
claude --version
dpkg-query -W claude-code claude-desktop
if command -v google-chrome-stable >/dev/null; then google-chrome-stable --version; else firefox --version; fi
