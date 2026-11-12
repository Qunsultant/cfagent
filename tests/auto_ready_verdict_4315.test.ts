/**
 * Issue #4315 — auto-ready draft PRs once the gating workflows are green.
 *
 * The workflow ships with its verdict inline (the shape the issue specifies), so
 * these pins read the file and assert the parts that matter:
 *  - P01 it watches exactly the five gating workflows, on completion.
 *  - P02 only an open DRAFT that carries the `auto-merge` label is eligible.
 *  - P03 the verdict is the watcher's: latest run per workflow name on the head
 *    SHA, cancelled/skipped never deciding, a missing run pending (never green),
 *    and all five required before anything is flipped.
 *  - P04 it flips with `ready_for_review`, re-checks the draft flag first, and
 *    tolerates an already-ready 422.
 *  - P05 no privileged trigger, no App credentials, no PR code checkout.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const workflow = readFileSync(
  join(here, "..", ".github/workflows/auto-ready-drafts.yml"),
  "utf8",
);

const GATING = [
  "Continuous Integration & Test Verification",
  "Policy Gate",
  "CodeQL",
  "Secret Scanning",
  "Auto-merge trusted PRs",
];

describe("4315-P01 gating workflows", () => {
  it("triggers on the five gating workflows completing", () => {
    expect(workflow).toContain("workflow_run:");
    for (const name of GATING) expect(workflow).toContain(`- "${name}"`);
    expect(workflow).toContain("types: [completed]");
  });
});

describe("4315-P02 eligibility", () => {
  it("requires an open draft carrying the auto-merge label", () => {
    expect(workflow).toContain("state=open");
    expect(workflow).toContain("select(.draft == true)");
    expect(workflow).toContain('index("auto-merge")');
  });
});

describe("4315-P03 the verdict", () => {
  it("judges the head SHA with the watcher's rules", () => {
    // The expression lives inside a shell double-quoted string, so quotes
    // are escaped in the file: assert the tokens, not the exact quoting.
    expect(workflow).toContain("head_sha ==");
    expect(workflow).toContain("$HEAD_SHA");
    expect(workflow).toContain("status ==");
    expect(workflow).toContain("cancelled");
    expect(workflow).toContain("skipped");
    expect(workflow).toContain("group_by(.name)");
    expect(workflow).toContain("max_by(.created_at)");
    expect(workflow).toContain("length == 5");
    expect(workflow).toContain("all(.conclusion");
  });

  it("does nothing when the set is not green", () => {
    expect(workflow).toContain('if [ "$ALL_GREEN" != "true" ]');
    expect(workflow).toContain("exit 0");
  });
});

describe("4315-P04 the action", () => {
  it("flips with ready_for_review and tolerates already-ready", () => {
    expect(workflow).toContain("/ready_for_review");
    expect(workflow).toContain('STILL_DRAFT=$(gh api');
    expect(workflow).toContain("probably already ready");
  });
});

describe("4315-P05 safety", () => {
  it("uses no privileged trigger, no App credentials and no PR checkout", () => {
    expect(workflow).not.toContain("pull_request_target");
    expect(workflow).not.toContain("create-github-app-token");
    expect(workflow).not.toContain("AUTO_UPDATE_APP");
    expect(workflow).not.toContain("actions/checkout");
    expect(workflow).toContain("GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}");
  });
});
