---
name: Task (gitops §5)
about: One unit of work — issue first, per docs/agents/gitops.md
title: ""
labels: []
assignees: []
---

## Agent
#<agent-hashtag>

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
What is wrong or missing?

## Outcome
What observable result is required?

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

## Reuse class (required — pick one; definitions: gitops §7 "Reuse before you build")
- [ ] Reuse — this issue delivers its outcome using an existing mechanism as it stands (call it, route to it, expose its existing read path, remove a fallback branch). No behaviour change.
- [ ] Enhancement — this issue delivers its outcome by extending or changing an existing mechanism's behaviour (new fields, branches, parameters, or a surface on something that already exists). State the §7 sub-kind: enhance / optimize / consolidate.
- [ ] New — this issue builds a mechanism or behaviour with no existing counterpart (new store, workflow, endpoint, surface, or mode). Last option.
- Reused mechanism (name + file:line, or "none — new"):
- Enhancement sub-kind and what changes (enhance / optimize / consolidate; or "n/a"):
- Search confirming nothing exists (for New: terms + what was checked; or "n/a"):

## Related issues
Parent epic:
Blocks / Blocked by:
Related:
Supersedes:

## Scope
Included:
Excluded:
Scope discipline: every item excluded from this issue gets its own sub-issue under this issue, created at the time it is identified and linked under Related issues — never left as a follow-up note, TODO, or 'future work' line. An excluded item with no sub-issue is a review finding. Title it `[Out-of-Scope] <thing>` (issue #4099): anything this work identifies as out of scope, or as not considered, gets its own sub-issue under the relevant parent with that title, a one-line reason it is out of scope, and a link to the work that surfaced it.

## Full-stack coverage (architecture-first — REQUIRED)

Architecture first: one row per architecture layer, then the 15-factors mapped to that layer, then the full-stack areas mapped to that layer, then the platforms that layer enables. Layer rows, factor mappings, and full-stack mappings are fixed — do not edit them. Fill the Platforms column from the Domain table below, starting from the owning platform shown, and fill Status per row. A trailing `+` means: add the domain platform(s) this change affects. An unanswered row makes the issue incomplete. Factor numbers follow `docs/agentic-org/architecture.md` §6 (IBM 15-factor formulation): 1 One codebase, 2 API first, 3 Dependency management, 4 Design/build/release/run, 5 Configuration/credentials/code, 6 Logs, 7 Disposability, 8 Backing services, 9 Environment parity, 10 Administrative processes, 11 Port binding, 12 Stateless processes, 13 Concurrency, 14 Telemetry, 15 Authentication/authorization.

| Row | Architecture layer | 15-factor(s) | Full-stack area(s) | Platform(s) enabled (fill from the Domain table; owning platform shown) | Status / evidence (Done + evidence, or N/A + reason) |
|---|---|---|---|---|---|
| L-1 | UX | 2, 9 | FS-1 | D-6 CPO Product and experience (owning) + | |
| L-2 | Product architecture | 1, 2, 3, 7, 9, 12, 13 | FS-1, FS-3 | D-6 CPO Product and experience; D-8 + | |
| L-3 | Application | 1, 2, 3, 5, 6, 7, 10, 11, 12, 13, 14, 15 | FS-2, FS-3, FS-4, FS-7 | D-8 CTO Technology and engineering (owning); D-10, D-16, D-18 + | |
| L-4 | Data/storage | 5, 8, 12 | FS-6 | D-9 CDO Data and knowledge (owning) + | |
| L-5 | Infrastructure | 4, 5, 8, 9, 12, 14 | FS-6, FS-8 | D-9 CDO Data and knowledge; D-7, D-8 + | |
| L-6 | Network | 2, 11, 15 | FS-4 | D-8 CTO Technology and engineering (owning) + | |
| L-7 | Integration | 2, 7, 8, 10, 11, 13, 14, 15 | FS-4, FS-5, FS-7 | D-8 CTO Technology and engineering; D-10 + | |
| L-8 | Security | 5, 6, 14, 15 | FS-2 | D-16 CISO Security and trust; D-18, D-8 | |
| L-9 | Observability | 4, 5, 6, 9, 14, 15 | FS-2, FS-8 | D-16 CISO Security and trust; D-18, D-8, D-7 | |
| L-10 | Error-reporting | 5, 6, 14, 15 | FS-2 | D-16 CISO Security and trust; D-18, D-8 | |
| L-11 | Agentic | 2, 7, 8, 10, 13, 14, 15 | FS-5, FS-7 | D-10 CAIO AI, agent, and improvement (owning); D-8 + | |

### Full-stack area sub-issues (one per area — REQUIRED)

Title each sub-issue `[Full-stack] <area>`. The parent closes only when every area sub-issue is closed. FS-2's scope is the ADD.md AOP definition (Exception Handling, Coded Messages, Logging, Externalized Configuration, Security, Transaction Management).

| Area | Sub-issue | Status | Evidence |
|---|---|---|---|
| FS-1 UX-URL (deployed page/route, UX-architecture conformance) | | | |
| FS-2 AOP compliance (transactions, security, exceptions, coded messages, logging, error reporting, externalized config) | | | |
| FS-3 Services (reused/created) | | | |
| FS-4 API endpoints | | | |
| FS-5 MCP endpoints | | | |
| FS-6 Data layer (D1/DO, Vectorize, R2, AI search) | | | |
| FS-7 Agentic capabilities (channels, tools, schedules, workflows, copilots/autopilot) | | | |
| FS-8 Release & operations (build/release/run, rollout/rollback) | | | |

### Domain declaration (REQUIRED — name every domain the change touches; platform names verbatim from `docs/agentic-org/platforms.md` §1–§2)

| ID | Domain / platform | Applies to this change? (yes + note / no) |
|---|---|---|
| D-1 | Research | |
| D-2 | Trading | |
| D-3 | Payment | |
| D-4 | CEO — Organization and strategy platform | |
| D-5 | CBO — Business architecture and commercial platform | |
| D-6 | CPO — Product and experience platform | |
| D-7 | COO — Operations and service-delivery platform | |
| D-8 | CTO — Technology and engineering platform | |
| D-9 | CDO — Data and knowledge platform | |
| D-10 | CAIO — AI, agent, and improvement platform | |
| D-11 | CFO — Finance and capital platform | |
| D-12 | CLO — Legal and obligation platform | |
| D-13 | CIO — Investment and portfolio platform | |
| D-14 | Chief Research Officer — Research platform | |
| D-15 | CRO — Enterprise, investment, and model-risk platform | |
| D-16 | CISO — Security and trust platform | |
| D-17 | CCO — Compliance and market-integrity platform | |
| D-18 | CQO — Independent assurance platform | |
| D-19 | Workforce — Human–agent workforce platform | |
| D-20 | Channels (name the channel) | |
| D-21 | Other platform capability (name it) | |

### Multi-dimensional enablement (REQUIRED — answer every line)

For each dimension state Enabled (this change adds it), Preserved (the change keeps it working, with evidence), or N/A (reason). A change must not silently narrow the platform to one provider, one broker, one user, one tenant, or one transaction at a time — any narrowing is a stated, reviewed decision recorded on the dimension's line, never an accident of implementation.

| ID | Dimension | Answer |
|---|---|---|
| M-1 | Multi-data-provider | |
| M-2 | Multi-broker | |
| M-3 | Multi-user | |
| M-4 | Multi-tenant | |
| M-5 | Multi-transaction | |
| M-6 | Concurrency | |
| M-7 | Parallelism | |
| M-8 | Multi-asset-class | |
| M-9 | Multi-channel | |
| M-10 | Multi-environment (paper/live) | |

### Coverage rules (fixed — do not edit)

| ID | Rule |
|---|---|
| R-1 | Full coverage is the default: every layer row is implemented, evidenced through its full-stack areas' sub-issues, or recorded N/A with a reason; every full-stack area is Done with evidence or N/A with a reason. Unanswered = incomplete. |
| R-2 | One sub-issue per full-stack area (see the ledger above). An N/A area's sub-issue closes with the N/A reason recorded. |
| R-3 | Platforms column: fill per layer row from the Domain table. Implemented rows name at least one platform; an empty cell on an implemented row is incomplete. |
| R-4 | Consistency: every platform named in the Domain declaration appears in at least one Platforms cell, and every platform in a Platforms cell is named in the Domain declaration or justified on the row. |
| R-5 | No forced mappings: a layer row maps only to factors, areas, and platforms that genuinely apply. |
| R-6 | Scope discipline (#4099): every excluded item gets its own sub-issue, created when identified — never a follow-up note, TODO, or 'future work' line. |
| R-7 | Scoped issues: an issue may be scoped to specific layer(s)/area(s) — state the scope in the Domain declaration and the table — but every out-of-scope full-stack area then gets its own `[Full-stack] <area>` sub-issue. N/A is reserved for areas that genuinely do not apply at all; scoped-out is not N/A. |

## Acceptance criteria
- [ ] Observable, testable criterion
- [ ] Failure/recovery criterion
- [ ] Relevant regression criterion

## Test plan

## Dependencies (for prioritization — the ordering record; Parallelism states whether this issue can start)
Blocking — this issue cannot start (or cannot merge) until these land. Each entry states the dependency's state and what it unblocks. A blocked slice names its unblocker here and states what is blocked; never work around a dependency (no parallel re-implementation, no silent fallback). If a dependency's state changes, update this section in the same PR that discovers it. A cross-lane need is a blocking dependency on that lane's separately created and assigned issue — link it here, do not fold their work into this issue.
- [ ] #NNNN — <title> — state: open / merged / blocked — unblocks: <what this issue needs from it>
- (None — write "None" if there are no blocking dependencies.)
Related — linked work that is not blocking (parent, sub-issue, adjacent):
- #NNNN — <title> — <role>
Blocked by this issue — work waiting on this issue (reverse dependencies, if any):
- #NNNN — <title>
- (None — write "None" if nothing waits on this issue.)

## Parallelism (gitops §5, issue #4070)
Parallel or Serial:
Depends on: see ## Dependencies (Blocking) — the list lives there, not here; do not duplicate it.
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
Reused surfaces (existing implementations reused — must match the ## Reuse class above):
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
- [ ] `docs/architecture/UX/ux-architecture.md` — applies (evidence: ) / N/A (reason: )

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
- Reuse class (as filed, or as changed with reason — reuse / enhancement / new + evidence):
- Test evidence (red, green, regression, integration/evaluation; CI runs; post-merge checks):
- Change management (actual: change type, impacted surfaces, migration and data impact, rollout plan, rollback plan, communication, changelog entry):
- Conformance (actual: UX primitives/tokens used, architecture boundaries followed, reused surfaces, rework justification, regression pins):
- Agentic design (actual: allocation as built, delegation path, evaluator, task records, policies/budgets, never-list compliance):
- Full-stack coverage (actual, keyed by L/FS/D/M IDs):
- Value and impact (value created, capabilities enhanced, competencies improved, value proposition, delivery channels, user journey):
- Risk and limitations (security, tenant isolation, compatibility, performance/cost; known test-coverage gaps stated explicitly):
- Delivery and release (migration, feature flag, deployment impact, rollback; release state, version, environment):
- Workflows operationalized:
- How to harness this value from UX:
- Process docs updated (file + commit, or none with reason):
- Follow-ups ledger (G2 rule — every follow-up IS a sub-issue under this issue; list its sub-issue number here, or an explicit owner deferral with date and reason):
- Out-of-scope items filed (issue #4099): `[Out-of-Scope]` sub-issue numbers for anything this issue surfaced as out of scope or not considered, or none.
- Remaining work (gitops §15 — handoff-ready completion): next sub-issues with numbers and state (open / in progress / blocked + reason); branch/PR state (merged / closed / open, with numbers); where the evidence lives (logs, comments, files). A completed issue with no remaining-work statement is incomplete.
- Next-step gate (PASS / BLOCKED + reason):
