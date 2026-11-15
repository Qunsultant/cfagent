// @vitest-environment node
/**
 * Issue #4565 — a merged PR closes its issue whichever repository slug it names.
 *
 * GitHub's auto-close resolves a closing keyword only against the repository
 * the PR lives in, so `Fixes OpenAIMP/cfagent#N` (the repo's former name, and
 * the form the Policy Gate accepts and the templates show) merged with the
 * issue still open — PR #4560 / #4532 on 2026-11-15. This pin holds the
 * reconciler's grammar and its decisions:
 *
 *  - 4565-P01 both slugs (any case) and a bare `#N` are closing references;
 *    another repository never is.
 *  - 4565-P02 the grammar is the same one the Policy Gate accepts (same verbs,
 *    same slug set), and prose/code about a ref is not a closing reference.
 *  - 4565-P03 an open issue is commented (with the merge commit) then closed;
 *    a closed issue, a PR reference, and a missing issue are skipped.
 *  - 4565-P04 a non-merged PR does nothing, and a re-run is a no-op.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import {
  ACCEPTED_REPO_SLUGS,
  CLOSING_VERBS,
  closingComment,
  parseClosingRefs,
  reconcileClosingRefs,
} from "../scripts/ci/closeMergedIssueRefs.mjs";

const REPO = "Qunsultant/cfagent";

describe("4565-P01 both slugs and a bare ref are closing references", () => {
  it("accepts the current slug", () => {
    expect(parseClosingRefs("Fixes Qunsultant/cfagent#12", { repo: REPO })).toEqual([
      { issue: 12, ref: "Qunsultant/cfagent#12", verb: "fixes" },
    ]);
  });

  it("accepts the former slug, in any case", () => {
    expect(parseClosingRefs("closes openaimp/CFAGENT#7", { repo: REPO })).toEqual([
      { issue: 7, ref: "openaimp/CFAGENT#7", verb: "closes" },
    ]);
  });

  it("accepts a bare #N (GitHub's own rule)", () => {
    expect(parseClosingRefs("Resolved: #99", { repo: REPO })).toEqual([
      { issue: 99, ref: "#99", verb: "resolved" },
    ]);
  });

  it("ignores another repository, however the verb is spelled", () => {
    expect(parseClosingRefs("Fixes someorg/other#12", { repo: REPO })).toEqual([]);
    expect(parseClosingRefs("Closes Qunsultant/another#12", { repo: REPO })).toEqual([]);
  });

  it("dedupes a ref named twice and keeps first-mention order", () => {
    const refs = parseClosingRefs(
      "Closes #5 and Fixes OpenAIMP/cfagent#9\nFixes #5 again",
      { repo: REPO },
    );
    expect(refs.map((r) => r.issue)).toEqual([5, 9]);
  });
});

describe("4565-P02 the grammar is the Policy Gate's, and prose is not a reference", () => {
  const gate = readFileSync("scripts/ci/policy_gate.py", "utf8");

  it("uses the same three verbs and both slugs the gate accepts", () => {
    for (const verb of ["close", "fix", "resolve"]) {
      expect(CLOSING_VERBS.some((v) => v.startsWith(verb))).toBe(true);
      expect(gate).toContain(verb);
    }
    expect(gate).toMatch(/\(OpenAIMP\|Qunsultant\)\/cfagent/);
    expect(ACCEPTED_REPO_SLUGS).toEqual(["qunsultant/cfagent", "openaimp/cfagent"]);
  });

  it("never treats a code span, a fenced block, or a bare mention as a closing ref", () => {
    expect(parseClosingRefs("`Fixes #12`", { repo: REPO })).toEqual([]);
    expect(parseClosingRefs("```\nFixes #12\n```", { repo: REPO })).toEqual([]);
    expect(parseClosingRefs("This fixes things; see #12 for context.", { repo: REPO })).toEqual([]);
    expect(parseClosingRefs("A prefix mention: #12", { repo: REPO })).toEqual([]);
  });
});

describe("4565-P03 the decisions: close open, skip the rest", () => {
  function api({ pull, issues }) {
    const calls = [];
    return {
      calls,
      getPull: async () => pull,
      getIssue: async (n) => issues[n] ?? null,
      comment: async (n, body) => calls.push(["comment", n, body]),
      close: async (n) => calls.push(["close", n]),
    };
  }

  it("comments with the merge commit, then closes", async () => {
    const fake = api({
      pull: { merged: true, merge_commit_sha: "abc123", title: "feat: thing", body: "Fixes OpenAIMP/cfagent#4532" },
      issues: { 4532: { state: "open", number: 4532 } },
    });
    const result = await reconcileClosingRefs({ api: fake }, { repo: REPO, prNumber: 4560 });
    expect(result.closed).toEqual([{ issue: 4532, ref: "OpenAIMP/cfagent#4532" }]);
    expect(fake.calls.map((c) => c[0])).toEqual(["comment", "close"]);
    expect(fake.calls[0][2]).toContain("abc123");
    expect(fake.calls[0][2]).toContain("#4560");
  });

  it("skips an already-closed issue, a PR reference, and a missing issue", async () => {
    const fake = api({
      pull: {
        merged: true,
        merge_commit_sha: "abc123",
        title: "t",
        body: "Closes #1\nCloses #2\nCloses #3",
      },
      issues: { 1: { state: "closed", number: 1 }, 2: { state: "open", number: 2, pull_request: {} } },
    });
    const result = await reconcileClosingRefs({ api: fake }, { repo: REPO, prNumber: 10 });
    expect(result.closed).toEqual([]);
    expect(result.skipped.map((s) => s.issue)).toEqual([1, 2, 3]);
    expect(fake.calls).toEqual([]);
  });

  it("does nothing for a non-merged PR", async () => {
    const fake = api({ pull: { merged: false, body: "Fixes #1" }, issues: { 1: { state: "open" } } });
    const result = await reconcileClosingRefs({ api: fake }, { repo: REPO, prNumber: 10 });
    expect(result).toMatchObject({ merged: false, closed: [] });
    expect(fake.calls).toEqual([]);
  });
});

describe("4565-P05 the mechanism is wired, and the rule is documented", () => {
  const workflow = readFileSync(".github/workflows/close-merged-issues.yml", "utf8");
  const gitops = readFileSync("docs/agents/gitops.md", "utf8");

  it("runs on a merged PR and on a replay, and never on an unmerged close", () => {
    expect(workflow).toContain("pull_request_target:");
    expect(workflow).toContain("types: [closed]");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).toContain("github.event.pull_request.merged == true");
  });

  it("calls the one script with the PR number and the repository", () => {
    expect(workflow).toContain("node scripts/ci/closeMergedIssueRefs.mjs --pr \"$PR_NUMBER\" --repo \"$REPO\"");
    expect(workflow).toContain("issues: write");
  });

  it("gitops §17 states both accepted slugs and points at this mechanism", () => {
    expect(gitops).toContain("**Accepted closing forms.**");
    expect(gitops).toContain("`Qunsultant/cfagent#N`");
    expect(gitops).toContain("`OpenAIMP/cfagent#N`");
    expect(gitops).toContain("close-merged-issues.yml");
  });
});

describe("4565-P04 a re-run is a no-op", () => {
  it("second run finds nothing open and posts no second comment", async () => {
    const state = { 1: { state: "open", number: 1 } };
    const calls = [];
    const api = {
      getPull: async () => ({ merged: true, merge_commit_sha: "abc", title: "t", body: "Fixes #1" }),
      getIssue: async (n) => state[n] ?? null,
      comment: async (n, body) => calls.push(["comment", n, body]),
      close: async (n) => {
        calls.push(["close", n]);
        state[n] = { ...state[n], state: "closed" };
      },
    };
    await reconcileClosingRefs({ api }, { repo: REPO, prNumber: 5 });
    const second = await reconcileClosingRefs({ api }, { repo: REPO, prNumber: 5 });
    expect(second.closed).toEqual([]);
    expect(second.skipped).toEqual([{ issue: 1, reason: "already closed" }]);
    expect(calls.filter((c) => c[0] === "comment")).toHaveLength(1);
  });

  it("the closing comment names the merge, the PR, and the mechanism", () => {
    const comment = closingComment({
      issueRef: "OpenAIMP/cfagent#9",
      prNumber: 77,
      prTitle: "feat: x",
      mergeCommit: "deadbeef",
      repo: REPO,
    });
    expect(comment).toContain("#77");
    expect(comment).toContain("deadbeef");
    expect(comment).toContain("OpenAIMP/cfagent#9");
    expect(comment).toContain("closeMergedIssueRefs.mjs");
  });
});
