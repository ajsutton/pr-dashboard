#!/bin/sh
set -eu

if [ -f /run/secrets/gh_token ]; then
  GH_TOKEN=$(cat /run/secrets/gh_token); export GH_TOKEN
fi
if [ -f /run/secrets/ci_token ]; then
  CITOKEN=$(cat /run/secrets/ci_token); export CITOKEN
fi

# A leading-flag arg (e.g. --debug) is meant for the server, not a command to
# run instead of it. Anything else (a bare program name) replaces the command.
if [ "$#" -eq 0 ]; then
  exec bun /app/src/server.ts
elif [ "${1#-}" != "$1" ]; then
  exec bun /app/src/server.ts "$@"
else
  exec "$@"
fi
