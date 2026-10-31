#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
INSTALL=false
if [ "${1:-}" = '--install-prerequisites' ]; then INSTALL=true; shift; fi
STATE=${1:-"$ROOT/private/local-workspace"}
. "$ROOT/scripts/node-path.sh"
if [ "$INSTALL" = true ]; then
  case "$(uname -s)" in
    Linux)
      if ! command -v apt-get >/dev/null 2>&1; then printf '%s\n' 'This installer supports Ubuntu. Install QEMU and OpenSSH with your package manager.'; exit 1; fi
      case "$(uname -m)" in aarch64) PACKAGES='qemu-system-arm qemu-efi-aarch64 qemu-utils openssh-client curl ca-certificates';; *) PACKAGES='qemu-system-x86 qemu-utils openssh-client curl ca-certificates';; esac
      sudo apt-get update
      sudo apt-get install -y $PACKAGES
      ;;
    Darwin)
      BREW=$(command -v brew || true)
      if [ -z "$BREW" ] && [ -x /opt/homebrew/bin/brew ]; then BREW=/opt/homebrew/bin/brew; fi
      if [ -z "$BREW" ]; then printf '%s\n' 'Install Homebrew first: https://brew.sh. Then rerun this script.'; exit 1; fi
      "$BREW" install qemu
      ;;
    *) printf '%s\n' 'Use setup-local.ps1 on Windows.'; exit 1;;
  esac
fi
NODE=$(starport_node "$ROOT" || true)
if [ -z "$NODE" ] && [ "$INSTALL" = true ]; then
  case "$(uname -s)" in Darwin) PLATFORM=darwin;; Linux) PLATFORM=linux;; *) exit 1;; esac
  case "$(uname -m)" in arm64|aarch64) ARCH=arm64;; x86_64) ARCH=x64;; *) printf '%s\n' 'Unsupported processor.'; exit 1;; esac
  RUNTIME="$ROOT/private/runtime"
  mkdir -p "$RUNTIME"; chmod 700 "$ROOT/private" "$RUNTIME"
  NAME="node-v22.23.1-$PLATFORM-$ARCH.tar.gz"
  curl -fSs --retry 2 --max-time 60 https://nodejs.org/dist/v22.23.1/SHASUMS256.txt -o "$RUNTIME/node-sums.txt"
  DIGEST=$(awk -v name="$NAME" '$2==name {print $1}' "$RUNTIME/node-sums.txt")
  test -n "$DIGEST"
  curl -fSs --retry 2 --max-time 300 "https://nodejs.org/dist/v22.23.1/$NAME" -o "$RUNTIME/$NAME.partial"
  if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$RUNTIME/$NAME.partial" | cut -d ' ' -f1); else ACTUAL=$(shasum -a 256 "$RUNTIME/$NAME.partial" | cut -d ' ' -f1); fi
  if [ "$ACTUAL" != "$DIGEST" ]; then printf '%s\n' 'Official Node checksum did not match.'; exit 1; fi
  tar -xzf "$RUNTIME/$NAME.partial" -C "$RUNTIME"
  rm "$RUNTIME/$NAME.partial" "$RUNTIME/node-sums.txt"
  NODE=$(starport_node "$ROOT")
fi
if [ -z "$NODE" ]; then printf '%s\n' 'Node.js 22+ is missing. Rerun with --install-prerequisites or install from nodejs.org.'; exit 1; fi
"$NODE" "$ROOT/bin/starport.mjs" local doctor
printf '\n%s\n' 'Prepare the workspace (reserves at least 10 GiB free disk):'
printf '"%s" "%s/bin/starport.mjs" local prepare --state "%s" --memory-mib 4096\n' "$NODE" "$ROOT" "$STATE"
printf '%s\n' 'Then follow docs/NATIVE-CLIENTS.md to select egress and start. No system PATH was replaced.'
