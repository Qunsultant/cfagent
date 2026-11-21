/**
 * Issue #5930 — an enrollment check that passes must mean the PR is queued.
 *
 * The 2026-11-20 stall: `auto-merge: enroll` reported pass while
 * `isInMergeQueue` was false on three green PRs. Cause: the "not green yet"
 * branch returned success, so "checks still running" and "enrolled" were
 * indistinguishable; and an entry the queue accepted and then dropped was
 * never noticed at all.
 *
 * These pins hold the two behaviours that make the verdict honest:
 *  - 5930-P01 a pending head fails the check with its reason (no silent pass);
 *  - 5930-P02 an accepted-then-dropped entry is detected and reported as an
 *    eviction, not counted as enrolled.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  new URL("../.github/workflows/auto-merge-trusted.yml", import.meta.url),
  "utf8",
);

describe("5930-P01 a pending head is not an enrollment", () => {
  it("computes pending from the same rollup, excluding its own checks", () => {
    expect(workflow).toContain("pending=$(echo \"$state\" | jq -r --arg p \"$OWN_CHECK_PREFIX\"");
    expect(workflow).toContain('any(. == "IN_PROGRESS" or . == "QUEUED"');
  });

  it("fails the check with the reason instead of returning success", () => {
    expect(workflow).toContain('if [ "$verdict" != "SUCCESS" ] && [ "$pending" = "true" ]');
    expect(workflow).toContain("is not enrollable yet: checks are still running");
    // The loud failure stays (#4317): own checks are excluded from the
    // verdict, so a red enrollment run cannot block its own retry.
    const pendingBranch = workflow.slice(
      workflow.indexOf('if [ "$verdict" != "SUCCESS" ] && [ "$pending" = "true" ]'),
    );
    expect(pendingBranch.slice(0, 800)).toContain("FAILED=1");
  });
});

describe("5930-P02 an accepted-then-dropped entry is an eviction", () => {
  it("re-reads after a settle and reports the drop", () => {
    expect(workflow).toContain("sleep 8");
    expect(workflow).toContain(
      "was enqueued and is no longer in the merge queue (evicted without a merge-group build",
    );
  });

  it("never counts a dropped entry as enrolled", () => {
    const settle = workflow.slice(workflow.indexOf("sleep 8"));
    // the drop path sets FAILED before the success log line
    expect(settle.indexOf("FAILED=1")).toBeGreaterThan(-1);
    expect(settle.indexOf("FAILED=1")).toBeLessThan(
      settle.indexOf("is enrolled in the merge queue."),
    );
  });
});
