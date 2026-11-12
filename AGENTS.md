# AGENTS.md — cfagent

You are the world's best RSI agent. Integrate your work into main, and enable platform optimization for your domain as per docs/agentic-org and docs/architecture/agentic/agents-workflows-schedules-queues-platforms-lifecycle.md as you complete your work.

All agents must work autonomously until done when assigned to an epic/issue/sub-issue until told to discuss.
Learn from your successes and failures - don't repeat the mistakes.

**This file only points at the policy; [`docs/agents/gitops.md`](docs/agents/gitops.md) governs.** All delivery policy for this repository — issues, branches, PRs, CI, merges, deprecation, enforcement — lives in gitops.md, its single home (§22, "Single home for rules"). This file states no delivery rule of its own: it orients you and points. Read gitops.md before creating issues, branches, or pull requests. If anything here ever appears to conflict with gitops.md, gitops.md wins.

## Where things live

Repository documentation lives in the [`docs/`](docs/) folder: plans in [`docs/plans/`](docs/plans/), agent policy and design docs in [`docs/agents/`](docs/agents/). Look there first.

- **Delivery policy:** [`docs/agents/gitops.md`](docs/agents/gitops.md) — the 24 sections are the whole rulebook: issue template and lifecycle (§5), branching (§6), TDD and the pin rule (§7), PR requirements (§9), stop-the-line CI (§10), merge policy (§11), the completion report (§15), post-merge verification (§17), lane labels (§21), enforcement, the Policy Gate, and the no-deletion/deprecation rule (§22), process-decision recording (§23), and the anti-work-loss rules (§24).
- **Code standards:** [`docs/architecture/code/`](docs/architecture/code/) — the operational home for the standards code must follow (gitops §22 names it as the justified second home; delivery rules stay in gitops).
- **Governance program:** [`docs/agents/governance-v2.md`](docs/agents/governance-v2.md) — templates, labels, traceability, framework mapping: why each phase exists, the value it creates, and how agents use it.
- **UX:** UX changes follow the UX architecture in [`docs/agents/ux-architecture.md`](docs/agents/ux-architecture.md) (§20 definition of done): build only from `src/client/components/ui/` primitives with token-only styling.
- **Deprecation ledger:** [`docs/architecture/transition/deprecations.md`](docs/architecture/transition/deprecations.md) — the single ledger gitops §22's retirement rule records into.

## Finding your role

Find your role by matching your name to its role identifier in docs/agentic-org, and advance docs/agentic-org/mission.md through:
collaboration governed by docs/agentic-org/collaboration.md
communication governed by docs/agentic-org/communication.md
status update governed by docs/agentic-org/documentation.md

Create a daily reminder to read the latest AGENTS.md on GitHub (Qunsultant/cfagent).
Slack is the primary communication/collaboration mechanism for agents to collaborate.
