# Default-branch project workflow scope

**Date:** 2026-07-21  
**Status:** Approved for implementation

## Problem

The Projects board combines recent default-branch runs with an expected workflow set. The expected GitHub Actions set currently includes every committed workflow file, including workflows that can run only for pull requests or merge queue entries. Its long-lookback status lookup also requests the latest run without a branch filter, so a pull-request result can color a Projects card even when the workflow has never run on the repository's default branch.

## Goals

- Exclude GitHub Actions workflows that run only for pull requests or merge queue entries from the expected Projects workflow set.
- Use only runs whose head branch is the repository's default branch for Projects status.
- Preserve mixed-trigger workflows and expected workflows that have never run on the default branch.
- Preserve existing CircleCI behavior.

## Non-goals

- Predict whether a scheduled workflow is overdue.
- Change pull request or merge queue CI cards.
- Restrict expected workflows to an allowlist of default-branch event types.
- Change the 72-hour window for recent default-branch runs.

## Design

### Workflow eligibility

Parse each committed GitHub Actions workflow file's `on` declaration using `Bun.YAML.parse`. Normalize the supported declaration forms into an event-name set:

- Scalar: `on: pull_request`
- Sequence: `on: [pull_request, push]`
- Mapping: `on: { pull_request: {}, push: {} }`

A workflow is excluded when its non-empty event set is a subset of:

- `pull_request`
- `pull_request_target`
- `merge_group`

A workflow with any other event remains eligible. For example, `[pull_request, push]` remains in Projects. Missing files, invalid YAML, missing `on`, and unsupported `on` shapes remain eligible so an incomplete classification cannot silently hide a workflow.

Eligibility is evaluated before requesting the workflow's latest run. Excluded workflows therefore consume no per-workflow run API request.

### Default-branch status

Extend the per-workflow latest-run client method to require a branch and request:

`GET /repos/{owner}/{repo}/actions/workflows/{workflow_id}/runs?branch={default_branch}&per_page=1`

The poller passes the default branch obtained from its existing default-branch seed. A workflow with no matching run receives `lastRun: { found: false }`, even if it has newer pull-request or merge-queue runs.

The recent-run path already requests `/actions/runs?branch={default_branch}` and remains unchanged. After this change, both recent and long-lookback Projects statuses are scoped to the default branch.

### Data flow

1. Fetch committed GitHub Actions workflow definitions and their file contents.
2. Classify each workflow's trigger set.
3. Drop pull-request and merge-queue-only workflows.
4. Fetch each remaining workflow's latest run filtered to the repository default branch.
5. Build expected workflow records and merge them with recent default-branch jobs as before.

### Error handling

Existing best-effort poller behavior remains unchanged. A missing or invalid workflow file does not exclude the workflow. GitHub API failures continue to be recorded by the project-workflows refresh boundary and leave the prior successful snapshot in place.

## Testing

Unit tests will cover:

- Scalar, sequence, and mapping `on` declarations.
- `pull_request`, `pull_request_target`, and `merge_group` combinations being excluded.
- Mixed PR/default-branch triggers being retained.
- Missing, malformed, or unsupported workflow content being retained.
- Excluded workflows skipping latest-run requests.
- Default branch propagation into the latest-run request.
- Branch query encoding.
- A PR-only latest run no longer supplying Projects status when no default-branch run exists.

## Acceptance criteria

- `pr-title` from `ethereum-optimism/optimism` is absent from the expected Projects workflow set because it declares only `pull_request`.
- A workflow declaring both `pull_request` and `push` remains present.
- Every GitHub Actions run used for a Projects card matches the repository's default branch.
- A workflow with PR runs but no default-branch run renders as `last run not found` if it remains eligible through another trigger.
- Relevant server tests pass.
