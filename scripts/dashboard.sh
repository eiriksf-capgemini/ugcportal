#!/bin/sh
# Runs bead-dashboard (github.com/eiriksf-capgemini/bead-dashboard) through
# npx, for a consumer repo's npm scripts and cmux layout. Copied from that
# repo's examples/dashboard.sh; see its README, "Adding a consumer repo".
#
# Usage: sh scripts/dashboard.sh <npm spec> [bead-dashboard arguments]
#   e.g. sh scripts/dashboard.sh github:eiriksf-capgemini/bead-dashboard#<40-hex sha> --watch 30
#
# Two failures npx itself does not report, handled here:
#   - node/npx not on PATH (nvm only loads in a login shell; a fresh cmux
#     terminal is not one): put the newest nvm-installed Node first, or say
#     so and exit 127.
#   - the git fetch of the package fails (no network, no ssh-agent, no access
#     to a private repo): npx exits 128 and prints nothing. Then the copy of
#     the same pinned commit already in npm's npx cache is run, if there is
#     one, and otherwise one line names the spec and the exit status.
set -u

if [ $# -lt 1 ]; then
  echo "usage: sh $0 <npm spec> [bead-dashboard arguments]" >&2
  exit 2
fi
spec="$1"
shift

if ! command -v npx >/dev/null; then
  # An unmatched glob stays literal, so test the result rather than trust it.
  newest="$(printf '%s\n' "$HOME"/.nvm/versions/node/*/bin | sort -V | tail -n 1)"
  if [ ! -d "$newest" ]; then
    echo "bead-dashboard: npx is not on PATH and no nvm install was found under $HOME/.nvm/versions/node" >&2
    exit 127
  fi
  PATH="$newest:$PATH"
  export PATH
fi

npx --yes "$spec" "$@"
status=$?
# 128 is git's exit status; bead-dashboard itself never exits with it.
[ "$status" -eq 128 ] || exit "$status"

sha="${spec##*#}"
if printf '%s' "$sha" | grep -Eq '^[0-9a-f]{40}$'; then
  cache="$(npm config get cache)" || cache="$HOME/.npm"
  for lock in "$cache"/_npx/*/node_modules/.package-lock.json; do
    [ -f "$lock" ] || continue
    grep -q "bead-dashboard.git#$sha\"" "$lock" || continue
    bin="$(dirname "$lock")/.bin/bead-dashboard"
    [ -x "$bin" ] || continue
    echo "bead-dashboard: could not fetch $spec (exit 128); running the copy of $sha already in npm's cache" >&2
    exec "$bin" "$@"
  done
fi
echo "bead-dashboard: could not fetch $spec (exit 128); check ssh/gh access or network" >&2
exit 128
