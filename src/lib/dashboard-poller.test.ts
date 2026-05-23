import { describe, expect, test } from "bun:test";
import { dedupReposByCanonical } from "./dashboard-poller.ts";

describe("dedupReposByCanonical", () => {
  test("collapses pinned and PR entries that share a canonical name", () => {
    // After a repo transfer, GitHub redirects API queries for the old name to
    // the new one — so the pinned alias and the canonical name returned for
    // open PRs both point at the same repo.
    const out = dedupReposByCanonical(
      ["ajsutton/moolah-native"],
      ["moolah-rocks/moolah-native"],
      new Map([
        ["ajsutton/moolah-native", "moolah-rocks/moolah-native"],
        ["moolah-rocks/moolah-native", "moolah-rocks/moolah-native"],
      ]),
    );
    expect(out).toEqual(["moolah-rocks/moolah-native"]);
  });

  test("preserves pinned order ahead of PR-discovered repos", () => {
    const out = dedupReposByCanonical(
      ["a/one", "a/two"],
      ["b/three", "a/one"],
      new Map([
        ["a/one", "a/one"],
        ["a/two", "a/two"],
        ["b/three", "b/three"],
      ]),
    );
    expect(out).toEqual(["a/one", "a/two", "b/three"]);
  });

  test("falls back to the input name when the canonical map has no entry", () => {
    const out = dedupReposByCanonical(["a/x"], ["b/y"], new Map());
    expect(out).toEqual(["a/x", "b/y"]);
  });
});
