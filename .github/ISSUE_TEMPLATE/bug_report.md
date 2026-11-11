---
name: Bug report (gitops §5)
about: Defect, incident, or problem record — pick Classification below; title prefix + label follow the choice. Includes ITIL incident triage + problem-management RCA.
title: "[Bug] - "
labels: [bug]
assignees: []
---

## Agent
#<agent-hashtag>

## Type
- [x] `[Bug] - <title>` + `bug`

## Classification
<!-- Pick exactly one. The title prefix + label follow the choice — edit the issue title and labels to match (the template default is Development/Bug). -->
- [ ] Incident management — an unplanned interruption or reduction in service quality. Title prefix `[Incident] - `, label `incident`. This issue IS the incident record.
- [ ] Problem management — the root-cause record behind one or more incidents. Title prefix `[Problem] - `, label `problem`. Linked incident issue(s) required.
- [ ] Development — a defect fix or enhancement with no current service impact. Title prefix `[Bug] - ` + label `bug` (or the enhancement equivalent) stays.

How the sections below bind to the choice:
- Incident → the Incident triage section is REQUIRED (affected service/surfaces, detection time + how detected, impact, P1–P4 priority field, workaround or none, linked problem via Related issues + the RCA section). Incident lifecycle: detect → triage → workaround → restore → communicate. An incident closes only when service restoration is proven live AND its problem record is linked (or an explicit one-off decision with reason is recorded in the RCA section).
- Problem → the Root cause analysis section is REQUIRED (evidenced root cause with code/log link, contributing causes, why it escaped, structural fix, recurrence prevention). Known-error rule: a problem with diagnosed root cause + documented workaround carries the `known-error` label until its fix merges.
- Development → Incident triage and RCA stay as they are (most triage fields "none" for non-incidents; RCA required before close per the existing gate).
- The §15 Completion report + RCA closing gate applies to Incident and Problem closes, not just bugs.

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

## User journey
Journey (which user journey this change serves):
User (who the user is):
How value surfaces in UX (what the user sees/does differently):

Journey impact — REQUIRED before/after statement (an issue without it is incomplete):
- Journey today (how it works now, before this change):
- Journey after this change (how it works once this lands):
- What the user sees/does differently (be specific; where the change touches navigation, name the nav/preset states — which items appear/disappear, which preset is active, what an empty selection shows):

## Incident triage (ITIL — REQUIRED when Classification is Incident; for Development, most fields are "none")
Is this bug an incident (unplanned interruption or reduction in service quality)? (yes / no):
Affected service/surfaces:
Detection time + how detected:
Impact (users affected, degradation vs outage):
Priority (P1 service down / P2 major degradation / P3 minor degradation / P4 cosmetic — a FIELD, not a label):
Workaround in place (or none):
Linked incident issue (or none — an issue classified Incident IS the incident record and carries the `incident` label itself when service impact is confirmed):

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
Scope discipline: every item excluded from this issue gets its own sub-issue under this issue, created at the time it is identified and linked under Related issues — never left as a follow-up note, TODO, or 'future work' line. An excluded item with no sub-issue is a review finding. Title it `[Out-of-Scope] <thing>` (issue #4099): anything this work identifies as out of scope, or as not considered, gets its own sub-issue under the relevant parent with that title, a one-line reason it is out of scope, and a link to the work that surfaced it.

## Acceptance criteria
- [ ] Defect no longer reproduces under the reported steps
- [ ] Regression test covering the defect, in the same PR
- [ ] No regression in adjacent behavior (pins named)
- [ ] RCA closing gate below is satisfied (or the issue stays open)

## Test plan
Levels/types (ISTQB, per G5): unit / integration / system / acceptance; functional / regression / confirmation:

## Dependencies
Cross-lane need: if this requires another lane's capability, link that lane's separately created and assigned issue here — do not fold their work into this issue.

## Parallelism (gitops §5, issue #4070)
Parallel or Serial:
Depends on (issue numbers, or none):
Conflicts with (shared files/surfaces, or none):

## Root cause analysis (ITIL problem management — REQUIRED when Classification is Problem; required before close for all classifications)
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
Allocation (agent judgment vs deterministic code, or none — a bug fix is usually deterministic code):

## Completion report (gitops §15 — fill on close; applies to Incident and Problem closes, not just bugs)
An incident closes only when service restoration is proven live AND its problem record is linked (or an explicit one-off decision with reason is recorded in the RCA section).
RCA closing gate (all must hold, or the issue stays open):
- [ ] Root cause evidenced (code/log link in the RCA section)
- [ ] Structural fix merged + verified in production (or known-error recorded with workaround + fix issue linked)
- [ ] Problem linked, or explicit one-off decision recorded in the RCA section
- [ ] §15 report filed below
- Process docs updated (file + commit, or none with reason):
- Follow-ups ledger (G2 rule — every follow-up IS a sub-issue under this issue; list its sub-issue number here, or an explicit owner deferral with date and reason):
- Remaining work (gitops §15 — handoff-ready completion): next sub-issues with numbers and state (open / in progress / blocked + reason); branch/PR state (merged / closed / open, with numbers); where the evidence lives (logs, comments, files). A completed issue with no remaining-work statement is incomplete.
- Next-step gate (PASS / BLOCKED + reason):
