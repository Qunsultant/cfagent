/**
 * Issue #4315 — auto-ready draft PRs once the gating workflows are green.
 * Corrected by #4325: the `workflow_run` trigger did fire for a PR branch, but
 * it judged whichever gate finished first (the 19:10:22Z run on 2026-11-13
 * evaluated PR #4442's head while `Policy Gate` was still in progress) and
 * nothing re-evaluated when the last gate passed. The verdict is now a sweep.
 *
 * Pins:
 *  - P01 it sweeps on a 5-minute cadence and takes the gating set from
 *    config/auto-merge.json (no inline list, no inline count).
 *  - P02 only an open DRAFT carrying the configured label is eligible.
 *  - P03 the verdict is the watcher's: latest run per workflow name on the head
 *    SHA, cancelled/skipped never deciding, a missing run pending (never green),
 *    and the whole configured set required before anything is flipped. The run
 *    query is filtered by `head_sha`, so the window is the head's own runs.
 *  - P04 it flips with `ready_for_review`, re-checks the draft flag first, and
 *    tolerates an already-ready 422.
 *  - P05/4498 the flip uses the App token (the workflow token is FORBIDDEN),
 *    and no privileged trigger or PR code checkout is introduced.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const read = (relative: string) =>
  readFileSync(join(here, "..", relative), "utf8").replace(/\r\n/g, "\n");

const workflow = read(".github/workflows/auto-ready-drafts.yml");
const config = JSON.parse(read("config/auto-merge.json")) as {
  label: string;
  gatingWorkflows: string[];
};

const GATING = [
  "Continuous Integration & Test Verification",
  "Policy Gate",
  "CodeQL",
  "Secret Scanning",
  "Auto-merge trusted PRs",
];

describe("4315-P01 gating workflows", () => {
  it("judges on every gate completion, with the sweep as a backstop (#4490)", () => {
    expect(workflow).toContain("workflow_run:");
    expect(workflow).toContain("schedule:");
    expect(workflow).toContain('cron: "*/5 * * * *"');
    // The five gates are the trigger; the workflow never watches itself.
    const watch = workflow.slice(
      workflow.indexOf("  workflow_run:"),
      workflow.indexOf("  schedule:"),
    );
    for (const name of GATING) expect(watch).toContain(`- "${name}"`);
    expect(watch).not.toContain("Auto-ready draft PRs");
    expect(workflow).toContain("github.event.workflow_run.event == 'pull_request'");
    // The set lives in one place, shared with the enrollment half.
    expect(config.gatingWorkflows).toEqual(GATING);
    expect(workflow).toContain("CONFIG_PATH: config/auto-merge.json");
    expect(workflow).toContain("contents/$CONFIG_PATH");
    // The trigger list is a copy of the config (a YAML trigger cannot read it),
    // pinned to the same values; the count is the array's length, never a literal.
    const watched = workflow.slice(
      workflow.indexOf("  workflow_run:"),
      workflow.indexOf("    types: [completed]"),
    );
    const triggered = [...watched.matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
    expect(triggered).toEqual(config.gatingWorkflows);
    expect(workflow).not.toContain("length == 5");
  });
});

describe("4315-P02 eligibility", () => {
  it("requires an open draft carrying the configured label", () => {
    expect(workflow).toContain('--label "$LABEL" --state open');
    expect(workflow).toContain("select(.isDraft == true)");
    expect(workflow).toContain("headRefOid");
  });
});

describe("4315-P03 the verdict", () => {
  it("judges the head SHA with the watcher's rules", () => {
    // The expression lives inside a shell double-quoted heredoc, so assert the
    // tokens, not the exact quoting.
    expect(workflow).toContain("actions/runs?head_sha=$HEAD_SHA");
    expect(workflow).toContain("$HEAD_SHA");
    expect(workflow).toContain('select(.status == "completed")');
    expect(workflow).toContain("cancelled");
    expect(workflow).toContain("skipped");
    expect(workflow).toContain("group_by(.name)");
    expect(workflow).toContain("max_by(.created_at)");
    expect(workflow).toContain('--argjson want "$GATING"');
    expect(workflow).toContain("length == ($want | length)");
    expect(workflow).toContain("all(.conclusion");
  });

  it("does nothing when the set is not green", () => {
    expect(workflow).toContain('if [ "$ALL_GREEN" != "true" ]');
    expect(workflow).toContain("continue");
  });
});

describe("4315-P04 / 4495 the action", () => {
  it("flips via GraphQL and fails loudly when the PR is still a draft", () => {
    // REST `POST /pulls/{n}/ready_for_review` answers 404 on this repository,
    // and the old catch-all hid it behind a green run (#4495).
    expect(workflow).toContain("markPullRequestReadyForReview");
    expect(workflow).not.toContain("pulls/$PR/ready_for_review");
    expect(workflow).not.toContain("probably already ready");
    expect(workflow).toContain("STILL_DRAFT=$(gh api graphql");
    expect(workflow).toContain("::error::Could not mark PR #$PR ready");
    expect(workflow).toContain("FAILED=1");
  });

  it("groups runs per head branch, so a main completion cannot cancel one", () => {
    expect(workflow).toContain(
      "group: auto-ready-${{ github.event.workflow_run.head_branch || 'sweep' }}",
    );
  });
});

describe("4315-P05 / 4498 safety and credentials", () => {
  it("uses the App token for the flip, and never a privileged trigger or checkout", () => {
    // markPullRequestReadyForReview is FORBIDDEN to the workflow token, the
    // same constraint the queue call has (#4320); the App token is scoped to
    // this repository and short-lived (#4498).
    expect(workflow).toContain("create-github-app-token");
    expect(workflow).toContain("permission-pull-requests: write");
    expect(workflow).toContain(
      "GH_TOKEN: ${{ steps.app-token.outputs.token || secrets.GITHUB_TOKEN }}",
    );
    expect(workflow).toContain("APP_TOKEN_READY");
    expect(workflow).toContain("::error::No App token was minted");
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toContain("actions/checkout");
  });
});
