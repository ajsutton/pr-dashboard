#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
export UID
export GID="${GID:-$(id -g)}"
if [ -f ../.env ]; then set -a; . ../.env; set +a; fi
case "${1:-start}" in
  start)   docker compose up -d ;;
  stop)    docker compose down ;;
  restart) docker compose down && docker compose up -d ;;
  logs)    docker compose logs -f ;;
  *) echo "Usage: $0 [start|stop|restart|logs]"; exit 2 ;;
esac
