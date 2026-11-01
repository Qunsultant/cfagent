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
 *    and removes strategy flags from gh pr merge --auto per AGENTS.md merge queue rules.
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
  it("triggers auto-update-prs-app.yml proactively on CI completion, push, schedule, and workflow_dispatch (#2629)", () => {
    expect(autoUpdateYml).toMatch(/schedule:\s*[\r\n]+\s*-\s*cron:\s*['"]\*\s*\/\s*5/);
    expect(autoUpdateYml).toContain("workflow_dispatch:");
    expect(autoUpdateYml).toContain("workflow_run:");
    expect(autoUpdateYml).toContain("Continuous Integration & Test Verification");
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

  it("omits strategy flags from gh pr merge --auto to comply with Merge Queue rules (#2629)", () => {
    expect(autoMergeTrustedYml).not.toContain("gh pr merge --auto --rebase");
    expect(autoMergeTrustedYml).not.toContain("gh pr merge --auto --squash");
    expect(autoMergeTrustedYml).toMatch(/gh pr merge ["']?\$PR_NUMBER["']? --auto/);
  });
});
