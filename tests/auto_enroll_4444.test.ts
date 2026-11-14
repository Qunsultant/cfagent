// @vitest-environment node
/**
 * Issues #4444 / #4325 / #4346 — the publish-early chain's triggers and its
 * retry.
 *
 * Root cause, corrected from the 19:10:24Z step logs (2026-11-13): the
 * `workflow_run` trigger DID reach the PR branch — the enqueue job's log shows
 * `HEAD_BRANCH: fix/4441-autopilot-capabilities-doc` — and the enqueue was
 * rejected (UNPROCESSABLE: required status check "Policy Gate" is in progress)
 * because the compliance gate finishes after the CI workflow. The failed
 * attempt had no retry, so a green PR sat unenrolled. The auto-ready sibling
 * judged the same head two seconds later, reached "not all gating workflows are
 * green", and never re-evaluated — which is why a draft never flipped. A ready
 * flip fires no CI completion at all (#4346).
 *
 * Pins:
 *  - 4444-P01 enrollment runs on `pull_request`, a 5-minute `schedule` and
 *    `workflow_dispatch`; no `workflow_run` remains (the event that fires too
 *    early to be the only trigger).
 *  - 4444-P02 the sweep enumerates labeled open PRs, skips drafts, and keeps the
 *    #4317 read-back (fail loudly when the queue entry did not land).
 *  - 4444-P03 the event path resolves the PR from the payload and reuses
 *    enroll().
 *  - 4444-P04 retry safety: the green verdict ignores this workflow's own check
 *    runs, so a failed attempt stays visible without making the head red and
 *    blocking its own retry.
 *  - 4325-P01 / 4346-P01 both halves are sweeps on one cadence, and both files
 *    describe the chain as implemented.
 *  - CFG-P01 config/auto-merge.json is the single source for the label, the
 *    gating workflow set and the sweep limit — neither workflow repeats them.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
// Normalise line endings: the checkout is CRLF on Windows and LF in CI, and a
// pin must not depend on which side read it.
const read = (relative: string) =>
  readFileSync(join(root, relative), "utf8").replace(/\r\n/g, "\n");

const enrollWorkflow = read(".github/workflows/auto-merge-trusted.yml");
const readyWorkflow = read(".github/workflows/auto-ready-drafts.yml");
const config = JSON.parse(read("config/auto-merge.json")) as {
  label: string;
  sweepLimit: number;
  gatingWorkflows: string[];
};

const GATING = [
  "Continuous Integration & Test Verification",
  "Policy Gate",
  "CodeQL",
  "Secret Scanning",
  "Auto-merge trusted PRs",
];

describe("4444-P01 the enrollment triggers that actually fire", () => {
  it("runs on pull_request, a 5-minute schedule and dispatch — never workflow_run", () => {
    expect(enrollWorkflow).toContain("pull_request:");
    expect(enrollWorkflow).toContain("ready_for_review");
    expect(enrollWorkflow).toContain("schedule:");
    expect(enrollWorkflow).toContain('cron: "*/5 * * * *"');
    expect(enrollWorkflow).toContain("workflow_dispatch:");
    // The trigger that fires before the last required check is gone as the
    // only path; nothing reads its payload any more.
    expect(enrollWorkflow).not.toMatch(/^\s*workflow_run:\s*$/m);
    expect(enrollWorkflow).not.toMatch(/github\.event_name == 'workflow_run'/);
  });

  it("states the corrected cause, with the evidence that corrected it", () => {
    expect(enrollWorkflow).toContain("#4444");
    expect(enrollWorkflow).toContain("WHY THE SWEEP — order, not delivery");
    expect(enrollWorkflow).toContain("DID reach a PR");
    // The event is not the problem; the order of required checks is.
    expect(enrollWorkflow).toContain('"Policy Gate" is in progress');
  });
});

describe("4444-P02 the sweep enrolls green, ready, labeled PRs", () => {
  it("lists by the configured label, skips drafts, and keeps the read-back", () => {
    expect(enrollWorkflow).toContain(
      '--label "$LABEL" --state open --limit "$SWEEP_LIMIT"',
    );
    expect(enrollWorkflow).toContain("isDraft");
    expect(enrollWorkflow).toContain("isInMergeQueue");
    expect(enrollWorkflow).toContain("statusCheckRollup");
    expect(enrollWorkflow).toContain('if [ "$verdict" != "SUCCESS" ]');
    expect(enrollWorkflow).toContain(
      "::error::PR #$pr_number is not in the merge queue",
    );
    // A pipe would run the loop in a subshell and swallow FAILED.
    expect(enrollWorkflow).toContain("done < <(jq -c '.[]' prs.json)");
  });
});

describe("4444-P03 the event path uses the payload, not a branch lookup", () => {
  it("resolves the PR by number, skips drafts, and reuses enroll()", () => {
    expect(enrollWorkflow).toContain('gh pr view "$PR_NUMBER"');
    // Label-gated on the event path too, not only in the sweep.
    expect(enrollWorkflow).toContain('index($l) != null');
    expect(enrollWorkflow).toContain(
      'if [ "$(echo "$PR_JSON" | jq -r \'.isDraft\')" = "true" ]',
    );
    expect(enrollWorkflow).toContain(
      'enroll "$(echo "$PR_JSON" | jq -r \'.id\')" "$PR_NUMBER"',
    );
    // The old head-branch resolution only worked for workflow_run payloads.
    expect(enrollWorkflow).not.toContain('--head "$HEAD_BRANCH"');
  });
});

describe("4444-P04 retry safety: a failed attempt cannot block the next one", () => {
  it("excludes this workflow's own check runs from the green verdict", () => {
    // GitHub attaches this workflow's check runs to the PR head. If a failed
    // enqueue made the head red, every later sweep would read "not green" and
    // never retry — the stall this issue is about, with a different cause.
    expect(enrollWorkflow).toContain('OWN_CHECK_PREFIX: "auto-merge:"');
    expect(enrollWorkflow).toContain('name: "auto-merge: label"');
    expect(enrollWorkflow).toContain('name: "auto-merge: enroll"');
    expect(enrollWorkflow).toContain("contexts(first: 100)");
    expect(enrollWorkflow).toContain("startswith($p)");
    expect(enrollWorkflow).toContain('.conclusion // .state // "UNKNOWN"');
    // The loud failure stays (#4317).
    expect(enrollWorkflow).toContain("FAILED=1");
  });
});

describe("4325-P01 the ready half is a sweep on the same cadence", () => {
  it("schedules instead of waiting for the first gate, and judges per head", () => {
    expect(readyWorkflow).toContain("schedule:");
    expect(readyWorkflow).toContain('cron: "*/5 * * * *"');
    expect(readyWorkflow).not.toMatch(/^\s*workflow_run:\s*$/m);
    expect(readyWorkflow).toContain("--label \"$LABEL\" --state open");
    expect(readyWorkflow).toContain("select(.isDraft == true)");
    // The run window is the head's own runs — a repo-wide window is pushed
    // out by the sweeps themselves.
    expect(readyWorkflow).toContain("actions/runs?head_sha=$HEAD_SHA");
    expect(readyWorkflow).toContain('--argjson want "$GATING"');
    expect(readyWorkflow).toContain("length == ($want | length)");
    expect(readyWorkflow).toContain("ready_for_review");
  });
});

describe("4346-P01 the chain is described as implemented", () => {
  it("names the cadence in both headers and keeps the enrollment invariants", () => {
    for (const workflow of [enrollWorkflow, readyWorkflow]) {
      expect(workflow).toContain("5-minute");
      expect(workflow).toContain("config/auto-merge.json");
    }
    expect(enrollWorkflow).toContain("create-github-app-token");
    expect(enrollWorkflow).toContain(
      "GH_TOKEN: ${{ steps.app-token.outputs.token || secrets.GITHUB_TOKEN }}",
    );
    expect(enrollWorkflow).not.toContain("pull_request_target");
    expect(enrollWorkflow).toContain("head.repo.full_name == github.repository");
  });
});

describe("CFG-P01 one source for the label, the gating set and the limit", () => {
  it("is a valid config both workflows read", () => {
    expect(config.label).toBe("auto-merge");
    expect(Number.isInteger(config.sweepLimit)).toBe(true);
    expect(config.sweepLimit).toBeGreaterThan(0);
    expect(config.gatingWorkflows).toEqual(GATING);
    for (const workflow of [enrollWorkflow, readyWorkflow]) {
      expect(workflow).toContain("CONFIG_PATH: config/auto-merge.json");
      expect(workflow).toContain("contents/$CONFIG_PATH");
    }
  });

  it("is not repeated as a literal in either workflow", () => {
    for (const workflow of [enrollWorkflow, readyWorkflow]) {
      expect(workflow).not.toContain("Continuous Integration & Test Verification");
      expect(workflow).not.toContain("--label auto-merge");
    }
  });
});
