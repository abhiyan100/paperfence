#!/usr/bin/env bash
# Blocks git push --force / -f.
input=$(cat)
cmd=$(printf '%s' "$input" | sed -n 's/.*"command":"\([^"]*\)".*/\1/p')
if printf '%s' "$cmd" | grep -Eq 'git push.*(--force|-f( |$))'; then
  echo "force push is not allowed in this repo" >&2
  exit 2
fi
exit 0
