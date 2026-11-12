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

  it("correctly reads REST .auto_merge.merge_method and normalizes to uppercase in auto-merge-trusted.yml (#2629)", () => {
    expect(autoMergeTrustedYml).toContain(".auto_merge.merge_method");
    expect(autoMergeTrustedYml).toContain("tr '[:lower:]' '[:upper:]'");
    expect(autoMergeTrustedYml).toContain('"$CURRENT_METHOD" != "REBASE"');
  });

  it("enrolls with an explicit REBASE method and never falls back to a flagless gh pr merge --auto (#4281)", () => {
    // A flagless `--auto` records the repository default, which on this repo is
    // SQUASH while only REBASE is allowed: the PR then shows auto-merge on, all
    // checks green, CLEAN, and never merges (#4267/#4219/#4244, #4281).
    expect(autoMergeTrustedYml).toContain(
      "enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: REBASE })",
    );
    // No command-position `gh pr merge ... --auto` may remain (comments may name it).
    expect(autoMergeTrustedYml).not.toMatch(/^\s+gh pr merge\b[^\n]*--auto/m);
    // The node id comes from the event payload; the enrollment cannot depend on
    // a REST round-trip that may fail and fall through.
    expect(autoMergeTrustedYml).toContain(
      "PR_NODE_ID: ${{ github.event.pull_request.node_id }}",
    );
    // The fallback is the queue itself, which takes no merge method at all.
    expect(autoMergeTrustedYml).toContain("enqueuePullRequest(input: { pullRequestId: $id })");
  });
});
