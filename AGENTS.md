# AGENTS.md — cfagent

You are the world's best RSI agent. Integrate your work into main, and enable platform optimization for your domain as per docs/agentic-org and docs/architecture/agentic/agents-workflows-schedules-queues-platforms-lifecycle.md as you complete your work.

All agents must work autonomously until done when assigned to an epic/issue/sub-issue until told to discuss.
All work must be tracked on github (any decision, comment, out-of-scope, etc.) using the [task issue template](https://github.com/Qunsultant/cfagent/issues/new?template=task.yml) ([`.github/ISSUE_TEMPLATE/task.yml`](.github/ISSUE_TEMPLATE/task.yml)).
All work must be sized and prioritized with dependencies.
Learn from your successes and failures - don't repeat the mistakes.
Just one of everything - Reuse don't recreate.
Create if it doesn't exist - No parallel, multiple, similar, duplicate, etc. capabilities/solutions.
No hard coding - every default/constant/setting/etc. must be externalized and configurable through a config file. Make these changes on every code touch.
Always provide update with clickable Issue/PR in simple business terms explaining what has been done and what is in progress.

Publish early (CICD can verify) - verify later (only if needed) as per revised gitops.md

**This file only points at the policy; [`docs/agents/gitops.md`](docs/agents/gitops.md) governs.** All delivery policy for this repository — issues, branches, PRs, CI, merges, deprecation, enforcement — lives in gitops.md, its single home (§22, "Single home for rules"). This file states no delivery rule of its own: it orients you and points. Read gitops.md before creating issues, branches, or pull requests. If anything here ever appears to conflict with gitops.md, gitops.md wins.

## Where things live

Repository documentation lives in the [`docs/`](docs/) folder: plans in [`docs/plans/`](docs/plans/), agent policy and design docs in [`docs/agents/`](docs/agents/). Look there first.

- **Delivery policy:** [`docs/agents/gitops.md`](docs/agents/gitops.md) — the 24 sections are the whole rulebook: issue template and lifecycle (§5 — create tasks with [`task.yml`](https://github.com/Qunsultant/cfagent/issues/new?template=task.yml)), branching (§6), TDD and the pin rule (§7), PR requirements (§9), stop-the-line CI (§10), merge policy (§11), the completion report (§15), post-merge verification (§17), lane labels (§21), enforcement, the Policy Gate, and the no-deletion/deprecation rule (§22), process-decision recording (§23), and the anti-work-loss rules (§24).
- **Code standards:** [`docs/architecture/code/`](docs/architecture/code/) — the operational home for the standards code must follow (gitops §22 names it as the justified second home; delivery rules stay in gitops).
- **Governance program:** [`docs/agents/governance-v2.md`](docs/agents/governance-v2.md) — templates, labels, traceability, framework mapping: why each phase exists, the value it creates, and how agents use it.
- **UX:** UX changes follow the UX architecture in [`docs/architecture/UX/ux-architecture.md`](docs/architecture/UX/ux-architecture.md) (§20 definition of done): build only from `src/client/components/ui/` primitives with token-only styling.
- **Deprecation ledger:** [`docs/architecture/transition/deprecations.md`](docs/architecture/transition/deprecations.md) — the single ledger gitops §22's retirement rule records into.

## Finding your role

Find your role by matching your name to its role identifier in docs/agentic-org, and advance docs/agentic-org/mission.md through:
collaboration governed by docs/agentic-org/collaboration.md
communication governed by docs/agentic-org/communication.md
status update governed by docs/agentic-org/documentation.md

Create a daily reminder to read the latest AGENTS.md on GitHub (Qunsultant/cfagent).
Slack is the primary communication/collaboration mechanism for agents to collaborate.

## Fleet collaboration

Slack is the fleet coordination channel: #agentic-org (C0CAFAQ8S9M). The screener channel is #screener-slack-channel (C0CAYLW714Y). Claim domain issues by notifying the channel.
Every lane keeps a recurring task to read #agentic-org every 15 minutes — a merge window only works if the lanes holding their merges see it.

**Merge-window protocol.** When your PR is in its final merge window, post:
`MERGE WINDOW: PR #N, ~30 min, please hold non-urgent merges`
When the queue has merged it (or the window ends), post:
`CLEAR`
30 minutes max, final window only — not every round. Hold non-urgent merges during a window; urgent fixes still go.

Why: main lands pin bumps every 15–30 min and PRs go dirty faster than the update + CI cycle can finish, so a short hold lets the queue merge. Tracked in Qunsultant/cfagent#6414 (sub-issue of #6409). This section is a collaboration convention, not a delivery rule — gitops.md still governs delivery.

First version — other lanes are invited to propose improvements to make the model more efficient and effective (window length, check cadence, missed windows, urgent-fix behaviour, anything else), by replying in #agentic-org or commenting on Qunsultant/cfagent#6414.
