#!/usr/bin/env node
/**
 * Issue #4565 — close the issues a merged PR named, accepting EITHER
 * repository slug.
 *
 * GitHub resolves a closing keyword ("Fixes owner/repo#N") only against the
 * repository the PR lives in. This repository was renamed from
 * `OpenAIMP/cfagent` to `Qunsultant/cfagent`; the old slug redirects for
 * reading, and the Policy Gate accepts both forms as a valid linked-issue
 * reference (scripts/ci/policy_gate.py, check (a)) — but GitHub's auto-close
 * does not follow the rename, so a PR that wrote the form the policy shows
 * (`OpenAIMP/cfagent#N`) merged with its issue still open (PR #4560 / #4532,
 * 2026-11-15).
 *
 * This is the auto-close reconciliation gitops §17 describes, implemented at
 * merge time instead of as a scheduled sweep:
 *
 *   - the closing-ref grammar is the SAME one the Policy Gate accepts — one
 *     vocabulary, not a second;
 *   - both accepted slugs (`Qunsultant/cfagent`, `OpenAIMP/cfagent`) and a
 *     bare `#N` count; any other `owner/repo` is ignored (it is not this
 *     repository);
 *   - only an OPEN issue is closed, so a re-run is a no-op and an issue is
 *     never re-closed or re-commented;
 *   - a non-merged PR does nothing at all;
 *   - the closing comment carries the PR number and the merge commit — the
 *     merge is the evidence (§17), never a bare close.
 *
 * Run by `.github/workflows/close-merged-issues.yml`, and by hand for a
 * replay: `node scripts/ci/closeMergedIssueRefs.mjs --pr 4560`.
 */
import { pathToFileURL } from "node:url";

/** The repository slugs accepted in a closing reference, lowercased. */
export const ACCEPTED_REPO_SLUGS = ["qunsultant/cfagent", "openaimp/cfagent"];

/** The closing verbs GitHub honours; the Policy Gate's check (a) uses the same set. */
export const CLOSING_VERBS = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];

/**
 * Matches `<verb> [owner/repo]#N`, `<verb>: [owner/repo]#N`.
 * The verb must stand alone (`not a fix` / `prefix` never match), and the
 * reference must follow it directly — `Fixes the #12` is deliberately not a
 * closing reference, because it names no target the author meant to close.
 */
const CLOSING_REF = new RegExp(
  String.raw`(?<![\w-])(` +
    CLOSING_VERBS.join("|") +
    String.raw`)(?![\w-])\s*:?\s*(?:([A-Za-z0-9][\w.-]*)\/([A-Za-z0-9][\w.-]*))?#(\d+)`,
  "gi",
);

/** Fenced code blocks and inline code spans are prose about a ref, not a closing ref. */
export function stripCode(text) {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`\n]*`/g, " ");
}

/**
 * Every issue a PR body/title asks to close, in first-mention order.
 *
 * `repo` is the current `owner/name` (also accepted, so the rule survives a
 * future rename without an edit). A reference to any other repository is
 * ignored: closing a foreign issue is never what a closing keyword means.
 */
export function parseClosingRefs(text, { repo }) {
  const current = String(repo ?? "").toLowerCase();
  const accepted = new Set([...ACCEPTED_REPO_SLUGS, current].filter(Boolean));
  const out = [];
  const seen = new Set();
  for (const match of stripCode(text).matchAll(CLOSING_REF)) {
    const [, verb, owner, name, digits] = match;
    const issue = Number.parseInt(digits, 10);
    if (!Number.isFinite(issue) || issue <= 0) continue;
    let ref = `#${issue}`;
    if (owner && name) {
      const slug = `${owner.toLowerCase()}/${name.toLowerCase()}`;
      if (!accepted.has(slug)) continue;
      ref = `${owner}/${name}#${issue}`;
    }
    if (seen.has(issue)) continue;
    seen.add(issue);
    out.push({ issue, ref, verb: verb.toLowerCase() });
  }
  return out;
}

/** The comment posted before the issue is closed: the merge is the evidence (§17). */
export function closingComment({ issueRef, prNumber, prTitle, mergeCommit, repo }) {
  return [
    `Closed by the merge of #${prNumber} — \`${prTitle}\` — as \`${mergeCommit}\` on \`${repo}\`.`,
    "",
    `The PR named this issue with the closing reference \`${issueRef}\`. GitHub's own auto-close only`,
    `honours the repository's current slug (\`${repo}\`), so a reference written with the former`,
    "`OpenAIMP/cfagent` slug (or with a bare `#N` in a body that GitHub already closed) is reconciled here.",
    "",
    "Mechanism: `.github/workflows/close-merged-issues.yml` + `scripts/ci/closeMergedIssueRefs.mjs` (#4565).",
  ].join("\n");
}

/**
 * Reconcile one merged PR. `api` is the minimal surface the driver needs, so
 * the decision logic is testable without a network:
 *   getPull(n) -> {merged, merge_commit_sha, title, html_url}
 *   getIssue(n) -> {state, number, pull_request?}
 *   comment(n, body) -> void
 *   close(n) -> void
 */
export async function reconcileClosingRefs({ api, log = () => {} }, { repo, prNumber, dryRun = false }) {
  const pull = await api.getPull(prNumber);
  if (!pull || pull.merged !== true) {
    log(`PR #${prNumber} is not merged; nothing to reconcile.`);
    return { pr: prNumber, merged: false, closed: [], skipped: [] };
  }
  const mergeCommit = pull.merge_commit_sha;
  const refs = parseClosingRefs(`${pull.title ?? ""}\n\n${pull.body ?? ""}`, { repo });
  const closed = [];
  const skipped = [];
  for (const { issue, ref } of refs) {
    if (issue === prNumber) {
      skipped.push({ issue, reason: "the PR references itself" });
      continue;
    }
    const target = await api.getIssue(issue);
    if (!target) {
      skipped.push({ issue, reason: "issue not found" });
      continue;
    }
    if (target.pull_request) {
      skipped.push({ issue, reason: "the reference is a pull request, not an issue" });
      continue;
    }
    if (target.state !== "open") {
      skipped.push({ issue, reason: `already ${target.state}` });
      continue;
    }
    if (dryRun) {
      closed.push({ issue, ref, dryRun: true });
      continue;
    }
    await api.comment(issue, closingComment({ issueRef: ref, prNumber, prTitle: pull.title, mergeCommit, repo }));
    await api.close(issue);
    closed.push({ issue, ref });
    log(`closed #${issue} (closing ref \`${ref}\`) on merge of #${prNumber} as ${mergeCommit}.`);
  }
  return { pr: prNumber, merged: true, closed, skipped };
}

/** The GitHub surface the CLI driver uses. */
export function githubApi({ repo, token, fetchImpl = fetch }) {
  const call = async (path, init = {}) => {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(init.headers ?? {}),
      },
    });
    if (!res.ok && res.status !== 404) {
      const detail = await res.text().catch(() => "");
      throw new Error(`GitHub ${init.method ?? "GET"} ${path} failed: ${res.status} ${detail.slice(0, 200)}`);
    }
    if (res.status === 404) return null;
    return res.status === 204 ? null : res.json();
  };
  return {
    getPull: (n) => call(`/pulls/${n}`),
    getIssue: (n) => call(`/issues/${n}`),
    comment: (n, body) => call(`/issues/${n}/comments`, { method: "POST", body: JSON.stringify({ body }) }),
    close: (n) =>
      call(`/issues/${n}`, { method: "PATCH", body: JSON.stringify({ state: "closed", state_reason: "completed" }) }),
  };
}

function parseArgs(argv) {
  const args = { pr: null, repo: process.env.REPO ?? "", dryRun: false, token: process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN ?? "" };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--pr") args.pr = Number.parseInt(argv[++i], 10);
    else if (value === "--repo") args.repo = argv[++i];
    else if (value === "--dry-run") args.dryRun = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.pr || !args.repo || !args.token) {
    console.error("usage: closeMergedIssueRefs.mjs --pr <number> --repo <owner/name> (GH_TOKEN required)");
    process.exit(2);
  }
  const result = await reconcileClosingRefs(
    { api: githubApi({ repo: args.repo, token: args.token }), log: (line) => console.log(line) },
    { repo: args.repo, prNumber: args.pr, dryRun: args.dryRun },
  );
  console.log(JSON.stringify(result, null, 2));
}

// Importable by the pins; runs only when invoked directly.
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
