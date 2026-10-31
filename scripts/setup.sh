#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")/.."
command -v node >/dev/null 2>&1 || { echo '请先安装 Node.js 22 或更高版本。'; exit 1; }
node -e 'if(Number(process.versions.node.split(".")[0])<22)process.exit(1)' || { echo '需要 Node.js 22 或更高版本。'; exit 1; }
mkdir -p profiles
node bin/starport.mjs init --preset desktop-dsw --out profiles/default
node bin/starport.mjs plan --profile profiles/default
