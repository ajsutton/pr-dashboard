# dashboard

Real-time PR + CI dashboard. Polls GitHub and CircleCI for PRs you author or review and rolls up their status into a single view.

## Setup

Requires [Bun](https://bun.sh) (1.x).

```bash
bun install
```

## Run

```bash
GH_TOKEN=$(gh auth token) bun src/server.ts
```

Open `http://127.0.0.1:3456`.

## Env vars

| Var | Default | Description |
|---|---|---|
| `DASHBOARD_PORT` | `3456` | listen port |
| `DASHBOARD_HOST` | `0.0.0.0` | listen host |
| `BASE_PATH` | `/` | subpath prefix for reverse-proxy hosting |
| `DASHBOARD_REPOS` | (empty) | comma-separated `owner/repo` list to pin |
| `GH_TOKEN` | (required) | GitHub PAT or `gh auth token` |
| `CITOKEN` | (optional) | CircleCI token for richer CI status |

## Docker

Prerequisite: the workspace-level `.env` and `.secrets/gh_token` must exist (the dashboard image reuses them via `dashboard/compose.yml`'s `../.env` source and `../.secrets/...` mounts). Setup from a fresh workspace clone:

```bash
cp ../.env.example ../.env
$EDITOR ../.env                      # optional: BIND_HOST, DASHBOARD_REPOS
mkdir -p ../.secrets && chmod 700 ../.secrets
printf '%s' "$(gh auth token)" > ../.secrets/gh_token
chmod 600 ../.secrets/*
```

Then:

```bash
./start.sh start
./start.sh logs
./start.sh stop
```

Or pull the published image directly: `ghcr.io/ajsutton/todo-ui-dashboard:latest`.

## Testing

```bash
bun test
```
