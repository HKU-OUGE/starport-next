#!/bin/bash
set -euo pipefail
export PATH=/usr/local/bin:/usr/bin:/bin HOME=/root LANG=C.UTF-8 TZ=Asia/Taipei DEBIAN_FRONTEND=noninteractive
export HTTPS_PROXY=http://127.0.0.1:13128 HTTP_PROXY=http://127.0.0.1:13128
export https_proxy=$HTTPS_PROXY http_proxy=$HTTP_PROXY NO_PROXY=localhost,127.0.0.1
# The VM has no direct egress; apt also uses the same controlled CONNECT proxy.
python3 - <<'PY'
from pathlib import Path
p=Path('/etc/apt/sources.list.d/ubuntu.sources')
s=p.read_text().replace('http://archive.ubuntu.com/','https://archive.ubuntu.com/').replace('http://security.ubuntu.com/','https://security.ubuntu.com/').replace('http://ports.ubuntu.com/','https://ports.ubuntu.com/')
p.write_text(s)
Path('/etc/apt/apt.conf.d/80-starport-proxy').write_text('Acquire::https::Proxy "http://127.0.0.1:13128";\nAcquire::http::Proxy "http://127.0.0.1:13128";\nAcquire::Retries "3";\nAcquire::https::Timeout "45";\n')
PY
apt-get update -qq
apt-get install -y --no-install-recommends ca-certificates curl gnupg dbus-x11 openbox xterm xclip tigervnc-standalone-server tigervnc-tools xauth novnc websockify xdg-utils fonts-noto-cjk locales git
install -d -m 0755 /etc/apt/keyrings
curl -fSs --retry 3 --max-time 60 https://downloads.claude.ai/keys/claude-code.asc -o /etc/apt/keyrings/claude-code.asc
fingerprint=$(gpg --batch --with-colons --show-keys /etc/apt/keyrings/claude-code.asc | awk -F: '$1=="fpr" {print $10; exit}')
test "$fingerprint" = 31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-code/apt/stable stable main' > /etc/apt/sources.list.d/claude-code.list
printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/claude-code.asc] https://downloads.claude.ai/claude-desktop/apt/stable stable main' > /etc/apt/sources.list.d/claude-desktop.list
apt-get update -qq
apt-get install -y --no-install-recommends claude-code claude-desktop
# The login browser is installed inside the guest on both supported architectures.
case "$(dpkg --print-architecture)" in
 amd64)
  if ! command -v google-chrome-stable >/dev/null; then
   curl -fSs --retry 3 --max-time 300 https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb -o /tmp/starport-browser.deb
   apt-get install -y --no-install-recommends /tmp/starport-browser.deb
   rm /tmp/starport-browser.deb
  fi
  ;;
 arm64)
  curl -fSs --retry 3 --max-time 60 https://packages.mozilla.org/apt/repo-signing-key.gpg -o /etc/apt/keyrings/packages.mozilla.org.asc
  fingerprint=$(gpg --batch --with-colons --show-keys /etc/apt/keyrings/packages.mozilla.org.asc | awk -F: '$1=="fpr" {print $10; exit}')
  test "$fingerprint" = 35BAA0B33E9EB396F59CA838C0BA5CE6DC6315A3
  printf '%s\n' 'deb [signed-by=/etc/apt/keyrings/packages.mozilla.org.asc] https://packages.mozilla.org/apt mozilla main' > /etc/apt/sources.list.d/mozilla.list
  printf '%s\n' 'Package: firefox*' 'Pin: origin packages.mozilla.org' 'Pin-Priority: 1000' '' 'Package: firefox' 'Pin: release o=Ubuntu' 'Pin-Priority: -1' > /etc/apt/preferences.d/starport-firefox
  apt-get update -qq
  apt-get install -y --no-install-recommends firefox
  ;;
 *) printf '%s\n' 'unsupported_guest_architecture'; exit 12;;
esac
# Disable vendor auto-updaters here; updates run explicitly through this installer.
rm -f /etc/apt/sources.list.d/google-chrome.list
/usr/sbin/locale-gen en_US.UTF-8 zh_TW.UTF-8
apt-get clean
printf '%s\n' 'Native packages installed.'
claude --version
dpkg-query -W claude-code claude-desktop
if command -v google-chrome-stable >/dev/null; then google-chrome-stable --version; else firefox --version; fi
