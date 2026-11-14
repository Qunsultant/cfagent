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
    // Issue #4444: enrollment runs on `pull_request` (payload resolution) plus
    // a 5-minute sweep of labeled open PRs — the retry that carries a PR past a
    // required check which finishes after the CI workflow. The label and the
    // limit come from config/auto-merge.json. `gh pr list --json` exposes `id`
    // (the node id) and has no `nodeId` field — asking for one fails the job
    // (observed on #4316).
    expect(autoMergeTrustedYml).toContain(
      '--label "$LABEL" --state open --limit "$SWEEP_LIMIT"',
    );
    expect(autoMergeTrustedYml).toContain("--json number,id,isDraft");
    expect(autoMergeTrustedYml).not.toContain("nodeId");
    expect(autoMergeTrustedYml).toContain('gh pr view "$PR_NUMBER"');
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

  it("enqueues with the App token — the workflow token is FORBIDDEN there (#4305)", () => {
    // Observed on #4320: enqueuePullRequest answered FORBIDDEN, "Resource not
    // accessible by integration", with the workflow token. The App token is
    // scoped to this repository and used only for that call.
    expect(autoMergeTrustedYml).toContain("create-github-app-token");
    expect(autoMergeTrustedYml).toContain(
      "GH_TOKEN: ${{ steps.app-token.outputs.token || secrets.GITHUB_TOKEN }}",
    );
  });

  it("verifies the enrollment and fails loudly when it did not land (#4317)", () => {
    // A green job used to prove nothing; the read-back is the verdict.
    expect(autoMergeTrustedYml).toContain("isInMergeQueue");
    expect(autoMergeTrustedYml).toContain('if [ "$IN_QUEUE" != "true" ]');
    expect(autoMergeTrustedYml).toContain("::error::");
    expect(autoMergeTrustedYml).toContain("exit 1");
  });

  it("skips a draft instead of failing it — auto-ready flips drafts (#4317)", () => {
    expect(autoMergeTrustedYml).toContain("isDraft");
    expect(autoMergeTrustedYml).toContain("is a draft; auto-ready-drafts will flip it");
  });
});
