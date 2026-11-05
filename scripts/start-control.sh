#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/scripts/node-path.sh"
NODE=$(starport_node "$ROOT")
STATE=${1:-"$ROOT/private/control"}
CONFIG=${2:-"$ROOT/private/host-control.json"}
exec "$NODE" "$ROOT/scripts/service-entry.mjs" --kind control --state "$STATE" --config "$CONFIG"
