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
| `DASHBOARD_PROJECT_WORKFLOWS_MS` | `1800000` | how often (ms) to refresh the expected-workflow set. Separate, slower cadence than the live CI polling. |
| `DASHBOARD_GITHUB_RESERVE` | `1000` | stop using each primary GitHub budget when its remaining quota reaches this floor; resume at reset. Set `0` to disable the reserve (exhaustion still pauses requests). |
| `DASHBOARD_IDLE_REFRESH_MS` | `300000` | GitHub and CircleCI refresh interval with no WebSocket viewers. Opening the dashboard requests a refresh if the last one is over 60 seconds old. |
| `DASHBOARD_PROJECT_REPOS` | `all` | set to `pinned` to poll default-branch Projects only for pinned repositories while keeping PRs and merge queues across all discovered repositories. |

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


## GitHub API usage

PRs, checks and merge queues refresh 60 seconds after the previous refresh
finishes while the dashboard is viewed. Repository activity is batched in
sets of five. Checks remain live even when the commit SHA is unchanged.
Workload searches and repository totals refresh every five minutes. Repository
review rulesets are fetched once per repository every 30 minutes, outside the
PR query. Changed-file lists are fetched only for file-scoped reviewer rules,
paginated, and cached by PR head, base commit and base branch.

Actions history is bootstrapped over the existing 72-hour display window.
Subsequent polls use a stable, overlapping discovery window and stop paging
when they reach previously discovered history. Known active runs outside that
page are refreshed by ID. Full history reconciliation every 30 minutes catches
reruns of older completed runs; those reruns may take up to that interval to
appear. Latest terminal results remain available while newer runs are active.
History scans stop at ten pages because GitHub limits filtered run searches
to 1,000 results, so extremely busy histories may remain incomplete. Restarting the process rebuilds these in-memory caches.

Scheduled/expected-workflow discovery defaults to 30 minutes. Immutable trees
and files are shared between CircleCI and Actions discovery. Workflow lists
are cached for 30 minutes; file reads are pinned to a commit SHA. REST reads
use ETags where provided, with stable history-window URLs so unchanged
responses can return `304` without consuming primary quota. Missing REST
resources have a 30-minute negative cache.

A single request queue limits GitHub concurrency to one, including response
parsing. REST and GraphQL primary budgets are tracked separately. Rate-limit
responses (including GraphQL HTTP-200 errors) pause the relevant budget until
reset, and secondary limits pause both APIs with exponential backoff.
`Retry-After` is respected. The default 1,000-point/request reserve leaves
quota for other tools using the same account; tokens with a smaller total
quota need a smaller configured reserve. Successful responses crossing the
reserve are still used. Failed refreshes preserve previous cards and surface
errors instead of showing empty results.

`GET /api/github-usage` exposes per-operation request, conditional-hit, error,
and point counters plus remaining quota, reset and pause times. GraphQL
points are read from `rateLimit.cost`; REST points count successful non-304
responses and are not an exact accounting of error charges. Counters are
process-local. The server also logs `[github-usage]` summaries every 15 minutes
without enabling verbose response logging. No tokens or response bodies are
included. More browser tabs share the same poller; with no connected viewers,
polling slows to five minutes.

References: [GitHub REST best practices](https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api)
and [GraphQL rate limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api).
