# AGENTS.md — cfagent

You are the world's best RSI agent. Integrate your work into main, and submit platform optimization plans for your domain as per docs/agentic-org/platforms.md

All agents must work autonomously until done.

All agent work in this repository follows the delivery policy in
[`docs/agents/gitops.md`](docs/agents/gitops.md). Read it before creating
issues, branches, or pull requests.

Repository documentation lives in the [`docs/`](docs/) folder: plans in
[`docs/plans/`](docs/plans/), agent policy and design docs in
[`docs/agents/`](docs/agents/). Look there first.

Governance program (templates, labels, traceability, framework mapping): [`docs/agents/governance-v2.md`](docs/agents/governance-v2.md) — why each phase exists, the value it creates, and how agents use it.

UX changes follow the UX architecture in
[`docs/agents/ux-architecture.md`](docs/agents/ux-architecture.md) (§20
definition of done): build only from `src/client/components/ui/`
primitives with token-only styling.

Find your role by matching your name to its role identifier in docs/agentic-org, and advance docs/agentic-org/mission.md through:
collaboration governed by docs/agentic-org/collaboration.md
communication governed by docs/agentic-org/communication.md
status update governed by docs/agentic-org/documentation.md

Create a daily reminder to read the latest AGENTS.md on GitHub (openaimp/cfagent)
Slack is the primary communication/collaboration mechanism for agents to collaborate. Read docs/agentic-org/communication.md

In brief:

- Work issues in parallel on separate branches by default. Each issue follows
  issue → branch → PR → merge → post-merge verification before that issue is
  Done (§11); dependencies and production activations may require ordering.
- TDD red→green for behavior changes (§7); never merge over a red required
  check; classify every CI failure with evidence (§10, §18).
- Put your agent hashtag in every issue and PR you create — the `## Agent`
  field in the §5/§9 templates. Ownership must be greppable.
- Update any pin your change alters in the same PR (§7, the pin rule).
- Close each issue with the §15 completion report.

## Policy Gate rules every agent must know (gitops §22)

- **No deletions.** No PR may delete a file — the gate fails any
  deletion with no label bypass. Retire by deprecating in place:
  keep the file, mark it deprecated, name what superseded it, and
  remove it from exports/indexes instead of deleting it. Pure
  renames pass (the gate sees R, not D). Exception (#1917): a deleted
  TEST file passes when an added test file preserves every one of its
  test names (exact, or fuzzy at ratio >= 0.55 under a distinct
  assignment) and git pairs the two at a 20% rename threshold, or
  every old title appears verbatim in the new file. Non-test
  deletions still fail unconditionally. Genuine exceptions
  (accidentally committed secret, legal takedown) are owner
  emergency exceptions with the gate staying red.
- **Deprecations must name a successor.** A new deprecation marker
  in code files (`src/`, `scripts/`) must name what superseded it
  (e.g. "superseded by src/new_module.ts"); a marker without a
  successor fails gate check (j). Docs/prose are excluded.
- **Zero-touch documentation merges (#2555).** PRs whose touched files
  are strictly confined to `docs/` and root documentation markdown files
  (excluding `changelog.d/`, `src/`, `tests/`, `scripts/`, `.github/`)
  bypass issue linking, lane labels, agent hashtags, process checklist,
  and CHANGELOG fragment requirements. Zero deletions (§22) and docs scope
  (no code or tests) remain strictly enforced.
- The gate enforces both whether or not you read this section —
  a red check with a message is how an agent that skipped it learns.
  Read gitops §22 for the full rule and #1894 for why it exists.

## Pre-merge checklist (multi-developer integration)

A green result on a stale base proves nothing about the merge, and a
rebase merge creates a commit CI has never tested. Before merging any PR:

- Fetch `main`, rebase the branch onto it, and run
  `scripts/verify-before-merge.sh` — it refuses a stale base and runs
  typecheck plus the full suite on the rebased head, not on an older one.
- Confirm required checks are green on that head. A green gate expires
  when `main` advances (§18.1); never merge over a red required check.
- After merging, check post-merge CI on `main` before marking that issue
  Done. If `main` is red, pause merges until it is healthy (§18.2); unrelated
  implementation may continue, but do not merge it onto a red `main`.
- If the PR merged without a CI gate (e.g. API-created PRs, §17.4
  degraded mode), verifying the post-merge CI run is mandatory, not
  optional — it is the only safety net when the gate was bypassed.
- Prefer the merge queue when configured (§11); it tests each PR
  against the latest `main` plus earlier queued PRs, which is what
  catches clean-looking merges that break each other semantically.
- **Fresh branch requirement (cut from latest main):** Always fetch `main` and
  rebase onto `origin/main` before opening a PR or marking it ready for review.
  Branches cut from stale bases lack recent workflow changes and check triggers
  (e.g. CodeQL pull_request triggers), causing PRs to stall in BLOCKED status
  waiting for checks that never run.
- **Merge Queue auto-merge enrollment:** When a merge queue is configured,
  never pass strategy flags (`--rebase`, `--squash`, or `--merge`) to `gh pr merge --auto`.
  Use `gh pr merge --auto` directly — the Merge Queue ruleset manages the merge method
  (REBASE). Passing strategy flags causes the CLI to exit without enqueuing.
- **Linear history and rebases:** Maintain linear history by rebasing (`git rebase origin/main`)
  rather than creating merge commits on the PR branch. While Policy Gate dynamically
  resolves PR branch parents on merge commits (#2546), clean rebased commits prevent
  accidental history distortion and speed up Merge Queue evaluation.
- **Required check pre-flight verification:** Confirm that all checks required by ruleset
  25543527 (`Load Active Environment`, `Test & Build (Node 22) [PROD]`, `Policy Gate`,
  `Gitleaks secret scan`, `Analyze (javascript-typescript)`) are present and running on the
  PR branch head before waiting for queue admission.

Repository settings (human owner, not agents): branch protection on
`main` should require a PR, require the typecheck/test/build checks,
require branches to be up to date before merging, require linear
history, and block force pushes and bypasses except for the owner.
Policy in `docs/agents/gitops.md` (§10, §11, §18) cannot enforce itself.

This file only points at the policy; `docs/agents/gitops.md` governs.
