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
  excludedAuthors: string[];
};

const GATING = [
  "Continuous Integration & Test Verification",
  "Policy Gate",
  "CodeQL",
  "Secret Scanning",
  "Auto-merge trusted PRs",
];

describe("4444-P01 / 4490-P01 the enrollment triggers", () => {
  it("runs on every gate completion, on pull_request, a backstop schedule and dispatch", () => {
    expect(enrollWorkflow).toContain("pull_request:");
    expect(enrollWorkflow).toContain("ready_for_review");
    expect(enrollWorkflow).toContain("workflow_run:");
    expect(enrollWorkflow).toContain("schedule:");
    expect(enrollWorkflow).toContain('cron: "*/5 * * * *"');
    expect(enrollWorkflow).toContain("workflow_dispatch:");
    // The old design hung everything on one event and had no retry; the job is
    // no longer gated on the event name.
    expect(enrollWorkflow).not.toMatch(/github\.event_name == 'workflow_run'/);
  });

  it("watches the gates it does not own, and never itself", () => {
    const watch = enrollWorkflow.slice(
      enrollWorkflow.indexOf("  workflow_run:"),
      enrollWorkflow.indexOf("  pull_request:"),
    );
    for (const gate of [
      "Continuous Integration & Test Verification",
      "Policy Gate",
      "CodeQL",
      "Secret Scanning",
    ]) {
      expect(watch).toContain(`- "${gate}"`);
    }
    // Watching its own completion would recurse: this workflow is one of the
    // five gates in the ready verdict, not one of its own triggers.
    expect(watch).not.toContain("Auto-merge trusted PRs");
    expect(enrollWorkflow).toContain(
      "github.event.workflow_run.event == 'pull_request'",
    );
  });

  it("states the corrected cause, with the evidence that corrected it twice", () => {
    expect(enrollWorkflow).toContain("#4444");
    expect(enrollWorkflow).toContain("WHY THE TRIGGERS CHANGED TWICE (#4444 then #4490)");
    // The event fired; the order of required checks was the problem.
    expect(enrollWorkflow).toContain('"Policy Gate" is in progress');
    // And the retry's clock: schedules on this repo run hours apart.
    expect(enrollWorkflow).toContain("throttles schedules on this repository");
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

describe("4444-P03 / 4490-P02 one decision path for every event", () => {
  it("resolves pull_request from the payload and workflow_run by head branch", () => {
    expect(enrollWorkflow).toContain('try_pr "$(gh pr view "$PR_NUMBER"');
    expect(enrollWorkflow).toContain(
      'gh pr list --repo "$GITHUB_REPOSITORY" --head "$HEAD_BRANCH"',
    );
    // One try_pr(): the guards and the enrollment are not duplicated per trigger.
    expect(enrollWorkflow).toContain("try_pr() {");
    expect(enrollWorkflow).toContain(
      'enroll "$(echo "$pr_json" | jq -r \'.id\')" "$number"',
    );
    expect(enrollWorkflow).toContain('index($l) != null');
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
    // Gate completions are the trigger (#4490); the schedule is the backstop.
    expect(readyWorkflow).toContain("workflow_run:");
    expect(readyWorkflow).toContain("github.event.workflow_run.event == 'pull_request'");
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

describe("EXCL-P01 excluded authors (Dependabot) are never automated", () => {
  it("skips the excluded accounts on every path, including the label job", () => {
    // Owner rule, 2026-11-14: Dependabot PRs need a human decision. They are
    // not labelled for automation, not flipped ready, and not enrolled.
    expect(config.excludedAuthors).toContain("app/dependabot");
    for (const workflow of [enrollWorkflow, readyWorkflow]) {
      expect(workflow).toContain("excludedAuthors");
      expect(workflow).toContain("EXCLUDED: ${{ steps.config.outputs.excluded }}");
      expect(workflow).toContain('--argjson ex "$EXCLUDED"');
    }
    expect(enrollWorkflow).toContain("AUTHOR_LOGIN");
    expect(enrollWorkflow).toContain("(excluded by config) — never enrolled.");
    expect(enrollWorkflow).toContain("--json number,id,isDraft,author,labels");
    expect(readyWorkflow).toContain("--json number,isDraft,headRefOid,author");
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
      // Default branch first, with one loud bootstrap path for the run that
      // introduces the file (#4444 landed before the file existed on main).
      expect(workflow).toContain("FALLBACK_REF");
      expect(workflow).toContain("::warning::$CONFIG_PATH is not on the default branch yet");
    }
  });

  it("keeps the YAML trigger lists in step with the config (pinned copies)", () => {
    // A YAML trigger cannot read the config file, so the gate names appear in
    // both. Pin the copies together: a new gate in the config that is not
    // watched (or a stale name in the trigger) fails here instead of drifting.
    const triggerList = (source: string) => {
      const start = source.indexOf("  workflow_run:");
      const end = source.indexOf("    types: [completed]", start);
      return [...source.slice(start, end).matchAll(/- "([^"]+)"/g)].map((m) => m[1]);
    };
    // The ready half watches the whole set; the enrollment half watches the set
    // minus itself, because watching its own completion would recurse.
    expect(triggerList(readyWorkflow)).toEqual(config.gatingWorkflows);
    expect(triggerList(enrollWorkflow)).toEqual(
      config.gatingWorkflows.filter((name) => name !== "Auto-merge trusted PRs"),
    );
    for (const workflow of [enrollWorkflow, readyWorkflow]) {
      expect(workflow).not.toContain("--label auto-merge");
    }
  });
});
