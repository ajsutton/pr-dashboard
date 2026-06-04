#!/bin/sh
set -eu

if [ -f /run/secrets/gh_token ]; then
  GH_TOKEN=$(cat /run/secrets/gh_token); export GH_TOKEN
fi
if [ -f /run/secrets/ci_token ]; then
  CITOKEN=$(cat /run/secrets/ci_token); export CITOKEN
fi

# Args (e.g. --debug) are passed straight to the server. Use `docker run
# --entrypoint …` if you need to run something other than the dashboard.
# DASHBOARD_WATCH=1 (compose dev mode sets it) restarts on source changes.
exec bun ${DASHBOARD_WATCH:+--watch} /app/src/server.ts "$@"
