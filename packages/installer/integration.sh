#!/bin/sh
set -eu
[ $# = 2 ] || exit 2
root=$1
action=$2
"$root/runtime/bin/node" "$root/app/packages/installer/integration-linux.mjs" "$root" "$action"
