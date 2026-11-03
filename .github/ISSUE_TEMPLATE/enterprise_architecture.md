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

## Acceptance criteria
- [ ] Decision recorded (ADR or governance doc) with trade-offs and gaps addressed
- [ ] Consequences + rollout/rollback stated

## Test plan
How the decision will be validated (review, prototype, metrics — or review-only with reason):

## Dependencies

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

## Agentic design (docs/agents)
Allocation (or none — architecture decisions are human judgment; agents draft, owners decide):

## Completion report (gitops §15 — fill on close)
Follow-ups ledger (G2 rule — each item a linked issue or an explicit owner deferral with date and reason):
- Next-step gate (PASS / BLOCKED + reason):
