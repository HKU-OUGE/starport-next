#!/bin/sh
# Ubuntu host: private, independent installation. No global PATH replacement.
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
[ "$(uname -s)" = Linux ] || { echo 'Use setup-control.ps1 on Windows; see LOCAL-RUNTIME.md for macOS.'; exit 1; }
INSTALL=false
if [ "${1:-}" = --install-prerequisites ]; then INSTALL=true; shift; fi
[ $# -eq 0 ] || { echo 'Usage: setup-control.sh [--install-prerequisites]'; exit 1; }
if [ "$INSTALL" = true ]; then
  "$ROOT/scripts/setup-local.sh" --install-prerequisites "$ROOT/private/qemu"
  sudo apt-get install -y --no-install-recommends bubblewrap sshfs zenity xdg-utils
fi
. "$ROOT/scripts/node-path.sh"
NODE=$(starport_node "$ROOT" || true)
[ -n "$NODE" ] || { echo 'Node.js 22+ required. Rerun with --install-prerequisites.'; exit 1; }
cd "$ROOT"
# npm is invoked with this Node; the caller's PATH remains unchanged.
NPM=$(dirname "$NODE")/../lib/node_modules/npm/bin/npm-cli.js
if [ ! -f "$NPM" ]; then NPM=/usr/share/nodejs/npm/bin/npm-cli.js; fi
[ -f "$NPM" ] || { echo 'npm is missing from this Node installation.'; exit 1; }
PATH="$(dirname "$NODE"):$PATH" "$NODE" "$NPM" ci --ignore-scripts
if [ ! -f private/host-control.json ]; then "$NODE" bin/starport.mjs control init --out private/host-control.json; fi
printf '%s\n' '1. Configure private/host-control.json with the controlled subscription (docs/LINUX-HOST.md).' \
  '2. node bin/starport.mjs linux install --config private/host-control.json' \
  '3. scripts/start-control.sh' \
  'Optional seamless windows: install xpra xvfb xauth python3-pil; set seamless: true before step 2.' \
  'Login startup is optional; no service was enabled.'
