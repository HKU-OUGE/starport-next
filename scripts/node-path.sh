#!/bin/sh
starport_node() {
  task_root=$1
  for task_candidate in "$(command -v node 2>/dev/null || true)" \
    /opt/homebrew/opt/node@22/bin/node /usr/local/opt/node@22/bin/node \
    "$task_root"/private/runtime/node-v22.23.1-*/bin/node; do
    if [ -n "$task_candidate" ] && [ -x "$task_candidate" ] && "$task_candidate" -e 'process.exit(Number(process.versions.node.split(".")[0])>=22?0:1)'; then
      printf '%s\n' "$task_candidate"; return 0
    fi
  done
  return 1
}
