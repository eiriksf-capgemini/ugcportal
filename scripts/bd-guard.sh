#!/bin/sh
# Hook entry point for scripts/bd-guard.mjs (ugcportal-vu49). Finds node, then
# execs the guard with this script's stdin. Looks in: PATH, the nvm default
# alias, the dirs in $BD_GUARD_FALLBACK_DIRS (default /opt/homebrew/bin:
# /usr/local/bin), then any nvm-installed version. If no node is found it exits
# 2 with a message: a hook that exits with any other non-zero code is
# non-blocking, so a missing runtime must block loudly instead of the guard
# silently never running. Uses shell builtins only so it works with an empty PATH.
case $0 in */*) dir=${0%/*} ;; *) dir=. ;; esac
guard="$dir/bd-guard.mjs"
node=$(command -v node)
if [ -z "$node" ] && [ -r "$HOME/.nvm/alias/default" ]; then
  read -r v < "$HOME/.nvm/alias/default"
  v=${v#v}
  for c in "$HOME"/.nvm/versions/node/v"$v"*/bin/node; do
    [ -x "$c" ] && node=$c
  done
fi
if [ -z "$node" ]; then
  oldifs=$IFS
  IFS=:
  for d in ${BD_GUARD_FALLBACK_DIRS:-/opt/homebrew/bin:/usr/local/bin}; do
    [ -z "$node" ] && [ -x "$d/node" ] && node="$d/node"
  done
  IFS=$oldifs
fi
if [ -z "$node" ]; then
  for c in "$HOME"/.nvm/versions/node/*/bin/node; do
    [ -x "$c" ] && node=$c
  done
fi
if [ -z "$node" ]; then
  echo "bd-guard: no node found (PATH, nvm default alias, \$BD_GUARD_FALLBACK_DIRS, any nvm version); refusing so the missing guard is not silent." >&2
  exit 2
fi
exec "$node" "$guard"
