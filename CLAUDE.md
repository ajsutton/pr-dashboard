# pr-dashboard

Real-time PR + CI dashboard: a Bun server plus a vanilla-JS UI that polls GitHub
and CircleCI for PRs you author or review and rolls up their status.

## Non-Negotiables

- **All tests must pass before committing:** `bun test`.

## Running Tests

`bun` is managed by mise and is not on the default PATH:

    eval "$(mise activate zsh)"
    bun install && bun test
