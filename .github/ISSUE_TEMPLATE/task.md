---
name: Task (gitops §5)
about: One unit of work — issue first, per docs/agents/gitops.md
title: ""
labels: []
assignees: []
---

## Agent
#<your-agent-hashtag>

## Type
Title convention + label (check one; title prefix and label must match):
- [ ] `[Enterprise Architecture] - <title>` + `ent-arch` (+ `architecture`): cross-cutting architecture decision, standard, pattern, or governance item (usually epic or ADR-linked)
- [ ] `[Bug] - <title>` + `bug`: defect in shipped behavior
- [ ] `[Enhancement] - <title>` + `enhancement`: new or improved capability
- [ ] `[Fix] - <title>` + `fix`: planned correction (non-urgent)
- [ ] `[Hotfix] - <title>` + `hotfix`: urgent production fix (emergency rules, gitops §18.2, still apply)
- [ ] Task (no type prefix; `lane:<lane>` label still required)

## Size
<!-- Estimate the work, not the importance. Pick one. -->
- [ ] Small — one focused change, one PR, no migration, no cross-surface coordination
- [ ] Medium — several files or one migration, one PR, coordination with one other surface or lane
- [ ] Large — multi-slice work, migrations, or cross-lane coordination; split into smaller issues (each one-PR-sized) — a sub-issue's work never spans multiple PRs (gitops §5, issue #4072)

## Priority
<!-- How urgent this is, not how big it is. Pick one. -->
- [ ] Low — nice to have; no deadline, deferrable without user impact
- [ ] Medium — needed for a planned milestone; short deferral acceptable
- [ ] High — blocks users, a release, or another lane's work; needs prompt attention

## Problem

## Outcome

## User journey
Journey (which user journey this change serves):
User (who the user is):
How value surfaces in UX (what the user sees/does differently):

Journey impact — REQUIRED before/after statement (an issue without it is incomplete):
- Journey today (how it works now, before this change):
- Journey after this change (how it works once this lands):
- What the user sees/does differently (be specific; where the change touches navigation, name the nav/preset states — which items appear/disappear, which preset is active, what an empty selection shows):

## Existing / similar issues (required — search BEFORE creating)
- [ ] I searched existing issues (open and closed) for the same or similar work before creating this issue.
- Same or similar issues found (reference each by number; state whether it already covers this work, only overlaps it, or is distinct):
  - #NNNN — <title> — <covers / overlaps / distinct because …>
  - (If none found, write "None found" and give the search terms used below.)
- Search terms used:
- If an existing issue already covers this work, do NOT create a duplicate — comment on that issue instead. A new issue is justified only when no existing issue covers it, or when the difference is stated above. (Record confirmed relationships under Related issues below.)

## Related issues
Parent epic:
Blocks / Blocked by:
Related:
Supersedes:

## Scope
Included:
Excluded:
Scope discipline: every item excluded from this issue gets its own sub-issue under this issue, created at the time it is identified and linked under Related issues — never left as a follow-up note, TODO, or 'future work' line. An excluded item with no sub-issue is a review finding.

## Acceptance criteria
- [ ]

## Test plan

## Dependencies
Cross-lane need: if this requires another lane's capability, link that lane's separately created and assigned issue here — do not fold their work into this issue.

## Parallelism (gitops §5, issue #4070)
Parallel or Serial:
Depends on (issue numbers, or none):
Conflicts with (shared files/surfaces, or none):

## Change management (expected)
Expected impact:
Migration and data impact:
Rollout plan:
Rollback plan:
Communication:

## Conformance (no drift — docs/compliance)
No UX drift, no architecture drift, no rework, no regression — reuse is mandatory.
UX surfaces touched + primitives/tokens used (or none):
Architecture surfaces touched + patterns/boundaries/ADRs followed (or none):
Reused surfaces (existing implementations reused):
Rework justification (if rebuilding an existing capability, why — otherwise none):
Regression risk + pins preserving existing behavior:

### Per-doc conformance checklist (REQUIRED — answer every line; an unanswered line makes the issue incomplete)
For each doc, write `applies (evidence: …)` or `N/A (reason: …)`:
- [ ] `docs/agentic-org/platforms.md` — applies (evidence: ) / N/A (reason: )
- [ ] `docs/architecture/ADD.md` — applies (evidence: ) / N/A (reason: )
- [ ] `docs/architecture/standards/standards.md` — applies (evidence: ) / N/A (reason: )
- [ ] `docs/agents/gitops.md` — applies (evidence: ) / N/A (reason: )
- [ ] `docs/agents/tech-standards.md` — applies (evidence: ) / N/A (reason: )
- [ ] `docs/compliance/anti-drift.md` — applies (evidence: ) / N/A (reason: )
- [ ] `docs/agents/ux-architecture.md` — applies (evidence: ) / N/A (reason: )

## Agentic design (docs/agents)
Allocation is a decision, not a default — do NOT turn every service into an agent.
Capability allocation (agent judgment vs deterministic service/tool, and why the agent earns its cost):
Coordinator / delegation path + evaluator (independent criteria):
Task state + records (durable task ledger, execution path recorded):
Adaptive policies + budgets (explicit, recorded; never-list compliance):
Deterministic rules kept in code (calculations, risk limits, authorization, accounting, schema validation — never in a model loop):

## Engineering standards
All development on this issue must follow:
- SOLID principles
- GoF design patterns
- GRASP patterns
- 15-factor app methodology
- Design thinking — start from the user journey and UX: name the journey this change serves and how its value surfaces in UX

## Standing guardrails
- TDD (gitops §7): every behavior change updates its pin tests in the same PR
- No silent nulls, no lazy fallbacks — fix root causes
- User-facing messages carry business errors, not technical errors; technical detail stays in logs
- Everything user-scoped, session-scoped, run-scoped — no shared mutable client state
- Incremental changes only — never silently remove a capability
- Verify against live production before calling it done — merged is not working
- Pre-merge: rebase onto fresh main, run scripts/verify-before-merge.sh, green gate expires when main advances; post-merge CI is mandatory
- Branch-as-lock when collaborating: check live fix/<issue>-* branches and open PRs before claiming
- Never place or cancel a trade/order without explicit confirmation

## Completion report (gitops §15 — fill on close; the single document for this issue)
- Issue / Pull request / Integration (merged, target, resulting commit):
- Implementation (key decisions, alternatives, scope exclusions):
- Test evidence (red, green, regression, integration/evaluation; CI runs; post-merge checks):
- Change management (actual: change type, impacted surfaces, migration and data impact, rollout plan, rollback plan, communication, changelog entry):
- Conformance (actual: UX primitives/tokens used, architecture boundaries followed, reused surfaces, rework justification, regression pins):
- Agentic design (actual: allocation as built, delegation path, evaluator, task records, policies/budgets, never-list compliance):
- Value and impact (value created, capabilities enabled, competencies improved, value proposition, delivery channels, user journey):
- Risk and limitations (security, tenant isolation, compatibility, performance/cost; known test-coverage gaps stated explicitly):
- Delivery and release (migration, feature flag, deployment impact, rollback; release state, version, environment):
- Workflows operationalized:
- How to harness this value from UX:
- Follow-ups ledger (G2 rule — every follow-up IS a sub-issue under this issue; list its sub-issue number here, or an explicit owner deferral with date and reason):
- Remaining work (gitops §15 — handoff-ready completion): next sub-issues with numbers and state (open / in progress / blocked + reason); branch/PR state (merged / closed / open, with numbers); where the evidence lives (logs, comments, files). A completed issue with no remaining-work statement is incomplete.
- Next-step gate (PASS / BLOCKED + reason):
