// @vitest-environment node
/**
 * Issues #4444 / #4325 / #4346 — the publish-early chain has triggers that
 * actually fire.
 *
 * Root cause, verified live: `workflow_run` is never delivered for PR-branch
 * runs in this repository, so the enrollment job (which only ran on
 * `workflow_run`) never ran for a PR, and a ready flip only ran the label job.
 *
 * Pins:
 *  - 4444-P01 enrollment runs on `pull_request`, a 5-minute `schedule`, and
 *    `workflow_dispatch`; no `workflow_run` remains (the trigger that never
 *    fired for PRs).
 *  - 4444-P02 the sweep enumerates labeled open PRs and enrolls the green,
 *    non-draft ones, keeping the #4317 read-back (fail loudly when the queue
 *    entry did not land).
 *  - 4444-P03 the event path resolves the PR from the payload, skips a draft,
 *    and uses the same enrollment function.
 *  - 4325-P01 the ready half is a sweep too (no `workflow_run`), same cadence,
 *    and still only touches labeled drafts whose full gating set is green.
 *  - 4346-P01 both files describe the chain as implemented (the flip and the
 *    enrollment are two halves of one cadence).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const enrollWorkflow = readFileSync(join(root, ".github/workflows/auto-merge-trusted.yml"), "utf8");
const readyWorkflow = readFileSync(join(root, ".github/workflows/auto-ready-drafts.yml"), "utf8");

describe("4444-P01 the enrollment triggers that actually fire", () => {
  it("runs on pull_request, a 5-minute schedule and dispatch — never workflow_run", () => {
    expect(enrollWorkflow).toContain("pull_request:");
    expect(enrollWorkflow).toContain("ready_for_review");
    expect(enrollWorkflow).toContain("schedule:");
    expect(enrollWorkflow).toContain('cron: "*/5 * * * *"');
    expect(enrollWorkflow).toContain("workflow_dispatch:");
    // The trigger that never fired for PR branches is gone, not left running.
    expect(enrollWorkflow).not.toMatch(/^\s*workflow_run:\s*$/m);
    // The header states why (#4444/#4325), so the next reader is not misled.
    expect(enrollWorkflow).toContain("#4444");
    expect(enrollWorkflow).toContain("does\n# not reach `pull_request`-event runs");
  });
});

describe("4444-P02 the sweep enrolls green, ready, labeled PRs", () => {
  it("lists by label, skips drafts, and keeps the read-back", () => {
    expect(enrollWorkflow).toContain("--label auto-merge --state open");
    expect(enrollWorkflow).toContain("isDraft");
    expect(enrollWorkflow).toContain("isInMergeQueue");
    expect(enrollWorkflow).toContain("statusCheckRollup");
    expect(enrollWorkflow).toContain('if [ "$rollup" != "SUCCESS" ]');
    expect(enrollWorkflow).toContain("::error::PR #$pr_number is not in the merge queue");
    // A pipe would run the loop in a subshell and swallow FAILED.
    expect(enrollWorkflow).toContain("done < <(jq -c '.[]' prs.json)");
  });
});

describe("4444-P03 the event path uses the payload, not a branch lookup", () => {
  it("resolves the PR by number, skips drafts, and reuses enroll()", () => {
    expect(enrollWorkflow).toContain("gh pr view \"$PR_NUMBER\"");
    expect(enrollWorkflow).toContain('if [ "$(echo "$PR_JSON" | jq -r \'.isDraft\')" = "true" ]');
    expect(enrollWorkflow).toContain('enroll "$(echo "$PR_JSON" | jq -r \'.id\')" "$PR_NUMBER"');
    // The old head-branch resolution only worked for workflow_run payloads.
    expect(enrollWorkflow).not.toContain("--head \"$HEAD_BRANCH\"");
  });
});

describe("4325-P01 the ready half is a sweep on the same cadence", () => {
  it("schedules instead of waiting for workflow_run, and keeps the eligibility rules", () => {
    expect(readyWorkflow).toContain("schedule:");
    expect(readyWorkflow).toContain('cron: "*/5 * * * *"');
    expect(readyWorkflow).not.toMatch(/^\s*workflow_run:\s*$/m);
    // Eligibility and verdict are unchanged: labeled drafts only, full gating
    // set green on the head SHA.
    expect(readyWorkflow).toContain("state=open");
    expect(readyWorkflow).toContain("select(.draft == true)");
    expect(readyWorkflow).toContain('index("auto-merge")');
    expect(readyWorkflow).toContain("head_sha ==");
    expect(readyWorkflow).toContain("select(length == 5)");
    expect(readyWorkflow).toContain("ready_for_review");
  });
});

describe("4346-P01 the chain is described as implemented", () => {
  it("names the cadence in both headers and keeps the enrollment invariants", () => {
    for (const workflow of [enrollWorkflow, readyWorkflow]) {
      expect(workflow).toContain("5-minute");
    }
    expect(enrollWorkflow).toContain("create-github-app-token");
    expect(enrollWorkflow).toContain(
      "GH_TOKEN: ${{ steps.app-token.outputs.token || secrets.GITHUB_TOKEN }}",
    );
    expect(enrollWorkflow).not.toContain("pull_request_target");
    expect(enrollWorkflow).toContain("head.repo.full_name == github.repository");
  });
});
