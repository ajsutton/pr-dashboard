#!/bin/sh
set -eu

if [ -f /run/secrets/gh_token ]; then
  GH_TOKEN=$(cat /run/secrets/gh_token); export GH_TOKEN
fi
if [ -f /run/secrets/ci_token ]; then
  CITOKEN=$(cat /run/secrets/ci_token); export CITOKEN
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
else
  exec bun /app/src/server.ts
fi
