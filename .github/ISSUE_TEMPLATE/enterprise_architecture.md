---
name: Enterprise Architecture (gitops §5)
about: Cross-cutting architecture decision, standard, pattern, or governance item — title "[Enterprise Architecture] - <title>", labels "ent-arch" + "architecture"
title: "[Enterprise Architecture] - "
labels: [architecture]
assignees: []
---

## Agent
#<your-agent-hashtag>

## Type
- [x] `[Enterprise Architecture] - <title>` + `ent-arch` (+ `architecture`)
- NOTE: add the `ent-arch` label at creation once it exists (owner web-UI step, issue #1873); `architecture` is applied by this template.

## Size
<!-- Estimate the work, not the importance. Pick one. -->
- [ ] Small — one focused change, one PR, no migration, no cross-surface coordination
- [ ] Medium — several files or one migration, one PR, coordination with one other surface or lane
- [ ] Large — multi-PR or multi-slice work, migrations, or cross-lane coordination; split into smaller issues when possible

## Priority
<!-- How urgent this is, not how big it is. Pick one. -->
- [ ] Low — nice to have; no deadline, deferrable without user impact
- [ ] Medium — needed for a planned milestone; short deferral acceptable
- [ ] High — blocks users, a release, or another lane's work; needs prompt attention

## Problem
What architectural problem or decision is this about, and why now?

## Outcome
What observable architectural result is required (decision, standard, pattern, governance rule)?

## Architecture (G4 refines this section; starter form)
Context:
Views touched (logical / process / deployment / data — as applicable, others not-applicable):
Quality attributes + scenarios:
Constraints:
Alternatives considered + trade-off matrix (options × latency, throughput, cost, complexity, operability, reversibility):
Decision + ADR link (`docs/architecture/adr/`):
Gap checklist (each: applicable + analysis, or not-applicable + reason): batch vs realtime; sync vs async; parallel vs linear; distributed vs monolithic; WebSocket vs HTTP/polling; stateful vs stateless; push vs pull; strong vs eventual consistency.
Enterprise layers touched (business / data / application / technology — or not-applicable):
Patterns used (GoF / GRASP / architecture / analysis) and anti-patterns avoided:

## User journey
Journey:
User:
How value surfaces in UX:

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
- [ ] Decision recorded (ADR or governance doc) with trade-offs and gaps addressed
- [ ] Consequences + rollout/rollback stated

## Test plan
How the decision will be validated (review, prototype, metrics — or review-only with reason):

## Dependencies
Cross-lane need: if this requires another lane's capability, link that lane's separately created and assigned issue here — do not fold their work into this issue.

## Change management (expected)
Expected impact:
Migration and data impact:
Rollout plan:
Rollback plan:
Communication:

## Conformance (no drift — docs/compliance)
Architecture boundaries followed:
Reused surfaces:
Rework justification (or none):

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
Allocation (or none — architecture decisions are human judgment; agents draft, owners decide):

## Completion report (gitops §15 — fill on close)
Follow-ups ledger (G2 rule — every follow-up IS a sub-issue under this issue; list its sub-issue number here, or an explicit owner deferral with date and reason):
- Next-step gate (PASS / BLOCKED + reason):
