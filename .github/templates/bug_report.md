---
name: Bug report (gitops §5)
about: Defect in shipped behavior — title "[Bug] - <title>", label "bug". Includes ITIL incident triage + problem-management RCA.
title: "[Bug] - "
labels: [bug]
assignees: []
---

## Agent
#<your-agent-hashtag>

## Type
- [x] `[Bug] - <title>` + `bug`

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
Observed behavior (what actually happens):
Expected behavior (what should happen):
Reproduction steps:
Environment (surface: UX / CLI / API / MCP; version/commit if known):

## Impact
Severity (who is affected, how badly, workaround if any):

## Incident triage (ITIL — fill for every bug; most fields are "none" for non-incidents)
Is this bug an incident (unplanned interruption or reduction in service quality)? (yes / no):
Affected service/surfaces:
Detection time + how detected:
Impact (users affected, degradation vs outage):
Priority (P1 service down / P2 major degradation / P3 minor degradation / P4 cosmetic — a FIELD, not a label):
Workaround in place (or none):
Linked incident issue (or none — a bug that IS the incident record carries the `incident` label itself when service impact is confirmed):

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
Linked problem (ITIL — see RCA section):

## Scope
Included (fix scope):
Excluded:

## Acceptance criteria
- [ ] Defect no longer reproduces under the reported steps
- [ ] Regression test covering the defect, in the same PR
- [ ] No regression in adjacent behavior (pins named)
- [ ] RCA closing gate below is satisfied (or the issue stays open)

## Test plan
Levels/types (ISTQB, per G5): unit / integration / system / acceptance; functional / regression / confirmation:

## Dependencies
Cross-lane need: if this requires another lane's capability, link that lane's separately created and assigned issue here — do not fold their work into this issue.

## Root cause analysis (ITIL problem management — required before close)
Timeline (facts only, with times: what happened, when, when detected, when workaround/fix landed):
Root cause (evidenced — link the code/log/record that proves it, not just an assertion):
Contributing causes:
Why it escaped (why it reached production / why it was not caught — test, gate, monitor, or review gap):
Workaround (or none) + known-error status (a problem with diagnosed root cause + documented workaround carries the `known-error` label until its fix merges):
Structural fix (what changes so this class cannot recur — not just the symptom patch):
Recurrence prevention (test / gate / monitor / runbook change that guards the class, or explicit owner deferral with date + reason):
Linked problem issue (or explicit "no problem, one-off" decision with reason — closing an incident without one is a review finding):

## Change management (expected)
Expected impact:
Migration and data impact:
Rollout plan:
Rollback plan:
Communication:

## Conformance (no drift — docs/compliance)
UX surfaces touched + primitives/tokens used (or none):
Architecture surfaces touched + patterns/boundaries/ADRs followed (or none):
Reused surfaces:
Rework justification (or none):
Regression risk + pins:

## Agentic design (docs/agents)
Allocation (agent judgment vs deterministic code, or none — a bug fix is usually deterministic code):

## Completion report (gitops §15 — fill on close)
RCA closing gate (all must hold, or the issue stays open):
- [ ] Root cause evidenced (code/log link in the RCA section)
- [ ] Structural fix merged + verified in production (or known-error recorded with workaround + fix issue linked)
- [ ] Problem linked, or explicit one-off decision recorded in the RCA section
- [ ] §15 report filed below
Follow-ups ledger (G2 rule — each item a linked issue or an explicit owner deferral with date and reason):
- Next-step gate (PASS / BLOCKED + reason):
