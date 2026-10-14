#!/bin/sh
# Runs the dev dashboard (scripts/dev-dashboard.mjs) with Node on PATH.
#
# Node is installed through nvm on this machine, and nvm only loads in a login
# shell. A fresh cmux terminal, `npm run` from such a shell, or any non-login
# shell therefore says "command not found: node" (or "npm"). This wrapper is
# the one place that works around it: if node is not already on PATH, it puts
# the newest nvm-installed Node first. package.json's `dashboard` scripts and
# the cmux layout in .cmux/cmux.json all run through here, so the PATH logic
# lives in exactly one file.
#
# Usage: sh scripts/dashboard.sh [dev-dashboard.mjs arguments]
#   sh scripts/dashboard.sh                         render once
#   sh scripts/dashboard.sh --watch 30 --sidebar    the cmux refresh loop
#   sh scripts/dashboard.sh --watch 30 --open --sidebar   what `npm run dashboard` runs
set -eu

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null; then
  # An unmatched glob stays literal, so test the result rather than trust it.
  newest="$(printf '%s\n' "$HOME"/.nvm/versions/node/*/bin | sort -V | tail -n 1)"
  if [ ! -d "$newest" ]; then
    echo "dashboard: node is not on PATH and no nvm install was found under $HOME/.nvm/versions/node" >&2
    exit 127
  fi
  PATH="$newest:$PATH"
  export PATH
fi

exec node scripts/dev-dashboard.mjs "$@"
