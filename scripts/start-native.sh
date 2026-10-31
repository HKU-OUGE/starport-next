#!/bin/bash
set -euo pipefail
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
STATE=private/native-workspace
PROFILE=profiles/imported
PASSWORD_FILE=
INSTALL=false
LOGIN=false
OPEN=true
while [ $# -gt 0 ]; do
 case "$1" in
  --state) STATE=$2; shift 2;;
  --profile) PROFILE=$2; shift 2;;
  --password-file) PASSWORD_FILE=$2; shift 2;;
  --install-clients) INSTALL=true; shift;;
  --login) LOGIN=true; shift;;
  --no-open) OPEN=false; shift;;
  *) printf 'Unknown option: %s\n' "$1"; exit 2;;
 esac
done
. "$ROOT/scripts/node-path.sh"
NODE=$(starport_node "$ROOT") || { printf '%s\n' 'Run setup-local.sh first.'; exit 1; }
CLI="$ROOT/bin/starport.mjs"
cd "$ROOT"
if [ ! -f "$STATE/machine.json" ]; then "$NODE" "$CLI" local prepare --state "$STATE" --memory-mib 4096; fi
ARGS=(local start --state "$STATE" --profile "$PROFILE" --client native)
if [ -n "$PASSWORD_FILE" ]; then ARGS+=(--password-file "$PASSWORD_FILE"); fi
STARTED=$("$NODE" "$CLI" "${ARGS[@]}")
printf '%s\n' "$STARTED"
REUSED=$(printf '%s' "$STARTED" | "$NODE" -e 'let s="";for await(const c of process.stdin)s+=c;console.log(Boolean(JSON.parse(s).reused))' --input-type=module)
if [ "$REUSED" != true ]; then "$NODE" "$CLI" local verify --state "$STATE"; fi
if [ "$INSTALL" = true ]; then "$NODE" "$CLI" local native-install --state "$STATE"; fi
VIEW=$("$NODE" "$CLI" local native-ui --state "$STATE")
URL=$(printf '%s' "$VIEW" | "$NODE" --input-type=module -e 'let s="";for await(const c of process.stdin)s+=c;const u=new URL(JSON.parse(s).url);if(u.protocol!=="http:"||u.hostname!=="127.0.0.1")throw Error("non_loopback_viewer");console.log(u.href)')
if [ "$OPEN" = true ]; then
 case "$(uname -s)" in Darwin) open "$URL";; Linux) xdg-open "$URL";; esac
else printf '%s\n' "$URL"; fi
"$NODE" "$CLI" local native-desktop --state "$STATE"
if [ "$LOGIN" = true ]; then "$NODE" "$CLI" local native-login --state "$STATE"; fi
