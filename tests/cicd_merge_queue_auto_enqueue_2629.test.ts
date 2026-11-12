/**
 * CI/CD Merge Queue Auto-Enqueue & Auto-Merge Velocity Guard (#2629).
 *
 * Verifies:
 * 1. auto-update-prs-app.yml runs proactively on:
 *    - workflow_run (upon completion of Continuous Integration & Test Verification)
 *    - push to main
 *    - recurring schedule (cron: '* / 5 * * * *')
 *    - workflow_dispatch
 *    so green PRs are enqueued immediately without manual intervention or push storms.
 * 2. auto-update-prs-app.yml inspects autoMergeRequest.mergeMethod and resets non-REBASE
 *    methods (e.g. SQUASH) to REBASE before calling enqueuePullRequest.
 * 3. auto-update-prs-app.yml actively enqueues CLEAN and MERGEABLE unqueued PRs into the Merge Queue.
 * 4. auto-merge-trusted.yml reads REST .auto_merge.merge_method, uppercase-normalizes it,
 *    and removes strategy flags from gh pr merge --auto per gitops §11 merge-queue rules.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const autoUpdateYml = readFileSync(
  new URL("../.github/workflows/auto-update-prs-app.yml", import.meta.url),
  "utf-8"
);
const autoMergeTrustedYml = readFileSync(
  new URL("../.github/workflows/auto-merge-trusted.yml", import.meta.url),
  "utf-8"
);

describe("CI/CD Merge Queue Auto-Enqueue & Auto-Merge Velocity (#2629)", () => {
  it("leaves the merge queue as the sole PR rebuilder — auto-update is manual-only (#4264)", () => {
    // #4264 retired the push / workflow_run / schedule triggers: the queue
    // builds each entry on the latest base and runs merge_group checks there,
    // and the bot updated branches by merge commit, which §6/#1853 forbids.
    expect(autoUpdateYml).toContain("workflow_dispatch:");
    expect(autoUpdateYml).not.toMatch(/^\s*schedule:\s*$/m);
    expect(autoUpdateYml).not.toMatch(/^\s*workflow_run:\s*$/m);
    expect(autoUpdateYml).not.toMatch(/^\s*push:\s*$/m);
  });

  it("queries id and autoMergeRequest { mergeMethod } in auto-update-prs-app queueQuery (#2629)", () => {
    expect(autoUpdateYml).toContain("autoMergeRequest {");
    expect(autoUpdateYml).toContain("mergeMethod");
    expect(autoUpdateYml).toMatch(/pullRequest\([^)]+\)\s*\{[\s\S]*?\bid\b/);
  });

  it("actively resets non-REBASE auto-merge and calls enqueuePullRequest on CLEAN & MERGEABLE PRs (#2629)", () => {
    expect(autoUpdateYml).toContain("enqueuePullRequest(input: { pullRequestId: $id })");
    expect(autoUpdateYml).toContain("disablePullRequestAutoMerge");
    expect(autoUpdateYml).toContain("enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: REBASE })");
    expect(autoUpdateYml).toContain("!prDetails.isInMergeQueue");
  });

  it("reads the enrollment back in auto-merge-trusted.yml (#2629, #4305)", () => {
    // The read-back names the queue state and the recorded method, so a dead
    // auto-merge request is visible in the run log instead of silent.
    expect(autoMergeTrustedYml).toContain("isInMergeQueue");
    expect(autoMergeTrustedYml).toContain("autoMergeRequest { mergeMethod }");
  });

  it("enrolls by queue entry and never relies on an auto-merge method (#4305/#4313)", () => {
    // Verified 2026-11-12 on #4298: GitHub records an auto-merge request as the
    // repository default (SQUASH here) even when REBASE is requested, so such a
    // request can never merge under a rebase-only ruleset (#4267/#4219/#4244/
    // #4283/#4285/#4297/#4303). The entry is the enrollment.
    expect(autoMergeTrustedYml).toContain("enqueuePullRequest(input: { pullRequestId: $id })");
    // No auto-merge mutation and no flagless `gh pr merge` may remain.
    expect(autoMergeTrustedYml).not.toContain("enablePullRequestAutoMerge");
    expect(autoMergeTrustedYml).not.toMatch(/^\s+gh pr merge\b[^\n]*--auto/m);
    // The enqueue runs on CI completion (workflow_run has no pull_request
    // payload), so the PR is resolved by head branch and only when it carries
    // the auto-merge label.
    expect(autoMergeTrustedYml).toContain(
      'gh pr list --repo "$GITHUB_REPOSITORY" --head "$HEAD_BRANCH"',
    );
    expect(autoMergeTrustedYml).toContain('select(any(.labels[]?; .name == "auto-merge"))');
  });

  it("no longer depends on pull_request_target (#4313)", () => {
    // GitHub restricts `pull_request_target` on public repositories from
    // 2026-12-02; this job never executes PR code, so `pull_request` with a
    // same-repo guard is the safe equivalent.
    expect(autoMergeTrustedYml).not.toContain("pull_request_target");
    expect(autoMergeTrustedYml).toContain(
      "head.repo.full_name == github.repository",
    );
  });
});
