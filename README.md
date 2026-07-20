# pr-dashboard

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
| `DASHBOARD_REPOS` | (empty) | comma-separated `owner/repo` list. When set, the dashboard scopes everything (your PRs, assigned issues, review requests) to just these repos. When empty, your PRs everywhere are shown. |
| `DASHBOARD_ALL_REPOS` | (off) | set to `1` to keep showing your PRs/issues/reviews across **all** repos even when `DASHBOARD_REPOS` is set — the listed repos are then just pinned, not a filter. |
| `GH_TOKEN` | (required) | GitHub PAT or `gh auth token` |
| `CITOKEN` | (optional) | CircleCI personal API token — needed to read private CircleCI projects and to lift the per-IP rate limit |
| `DASHBOARD_DEBUG` | (off) | set to `1` (or pass `--debug`) to trace every GitHub + CircleCI request/response — incl. partial GraphQL `errors` — to the logs. Use to diagnose an empty/blank board. Verbose. |
| `DASHBOARD_PROJECT_WORKFLOWS` | `1` (on) | set to `0` to disable the expected/scheduled-workflow view in Projects. When on, pinned repos (`DASHBOARD_REPOS`) show workflows defined in their CircleCI config plus GitHub Actions workflows that can run outside pull requests and merge queues. Statuses come only from the default branch, so a scheduled job that has stopped firing or never fired is visible. |
| `DASHBOARD_PROJECT_WORKFLOWS_MS` | `300000` | how often (ms) to refresh the expected-workflow set. Separate, slower cadence than the live CI polling. |

## Docker

Quickest start — pull the published image and run it directly:

```bash
docker run --rm -p 3456:3456 -e GH_TOKEN="$(gh auth token)" ghcr.io/ajsutton/pr-dashboard:latest
```

Open `http://127.0.0.1:3456`. Add `-e CITOKEN=…` for private CircleCI, or
`-e DASHBOARD_REPOS=org/repo-a,org/repo-b` to pin repos. The container runs
under tini, so Ctrl-C stops it cleanly.

For a persistent setup with token files instead of env vars, use compose. Set
up `.env` and the token secrets (both gitignored):

```bash
cp .env.example .env
$EDITOR .env                         # optional: BIND_HOST, DASHBOARD_REPOS, UID/GID
mkdir -p .secrets && chmod 700 .secrets
printf '%s' "$(gh auth token)" > .secrets/gh_token

# CircleCI token (.secrets/ci_token): lets the dashboard read private CircleCI
# projects and lifts the per-IP rate limit. Compose mounts it as a secret, so the
# file must exist — but it may be empty if you don't use CircleCI:
printf '%s' "$YOUR_CIRCLECI_TOKEN" > .secrets/ci_token   # or: : > .secrets/ci_token
chmod 600 .secrets/*
```

Then:

```bash
./start.sh start
./start.sh logs
./start.sh stop
```

Or pull the published image directly: `ghcr.io/ajsutton/pr-dashboard:latest`.

## Testing

```bash
bun test
```
