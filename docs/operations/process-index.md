# Operational process index

The single entry point for operational process guides. Future answers
link here instead of re-explaining a process in chat. Each row gives
the process, its category under the
[taxonomy](process-taxonomy.md), its owner, and its guide — or, where
no guide exists yet, the sub-issue that owns writing it. A process
with no guide is a named gap, never a process forced into a wrong
category.

Also linked from the Workflows Hub (`?tab=workflows`, Platform
Workflows panel). Owner of this index: COO-spr9. Last verified:
2026-11-07.

## How to read it

| Column | Meaning |
| --- | --- |
| Process | The process, as named in the #3463 seed inventory. |
| Category | Its taxonomy category. |
| Owner | Who is accountable for it. |
| Guide | Link to the guide, or the sub-issue that owns writing it. |
| Status | `Current` — the guide exists and its links were verified at the date shown. `Partial` — a governing document exists but the operational guide is still pending. `Not yet documented` — no guide exists; the gap is named, not hidden. |
| Last verified | The date the guide (or the gap) was last confirmed. A date, never "recently". |

Guide entries carry the full nine fields from the taxonomy
(purpose, why, trigger, inputs, steps, exit evidence, owner,
failure/rollback, last-verified). This index carries the purpose
summary, category, owner, and link; the full entry lives in the
guide.

## Deterministic — autonomous

| Process | Category | Owner | Guide | Status | Last verified |
| --- | --- | --- | --- | --- | --- |
| Slice delivery via the gitops gate | Autonomous | COO-spr9 | [gitops.md](../agents/gitops.md) §§5–11, 17 | Current | 2026-11-07 |
| Merge-queue landing (replayed tip / tag / post-merge CI) | Autonomous | COO-spr9 | [gitops.md](../agents/gitops.md) §11, §19.5 | Current | 2026-11-07 |
| Close-out tail (§15 + close + tick) | Autonomous | COO-spr9 | [gitops.md](../agents/gitops.md) §15 | Current | 2026-11-07 |
| Verification routines (live re-checks, latest-per-check-name) | Autonomous | COO-spr9 | Not yet documented — #3465 | Not yet documented | — |

## Deterministic — HITL

| Process | Category | Owner | Guide | Status | Last verified |
| --- | --- | --- | --- | --- | --- |
| Approval-card flow | HITL | COO-spr9 (operates the flow); user owns the tap | Not yet documented — #3465 | Not yet documented | — |
| Operator approvals and attestations | HITL | User (store operator) | Not yet documented — #3467 | Not yet documented | — |

## Deterministic — manual / owner-only

| Process | Category | Owner | Guide | Status | Last verified |
| --- | --- | --- | --- | --- | --- |
| Line-6 evidence flow (Billing UI) | Manual / owner-only | User (operator) | Not yet documented — #3467 | Not yet documented | — |
| 1257 retry + signed-in live-hit flow | Manual / owner-only | User (operator) + COO-spr9 | Not yet documented — #3467 | Not yet documented | — |
| Live smoke checks | Manual / owner-only | User | Not yet documented — #3467 | Not yet documented | — |
| Live testnet transfer (owner-HITL) | Manual / owner-only | User | Not yet documented — #3467 | Not yet documented | — |

## Non-deterministic — agentic

| Process | Category | Owner | Guide | Status | Last verified |
| --- | --- | --- | --- | --- | --- |
| Coordinator dispatch + boundary reporting | Agentic | COO-spr9 | Not yet documented — #3466 | Not yet documented | — |
| Proactivity handling (select / skip / send rules) | Agentic | COO-spr9 | Not yet documented — #3466 | Not yet documented | — |
| Handover between agents (lanes) | Agentic | COO-spr9 | [handover-playbook.md](handover-playbook.md) | Current | 2026-11-11 |

## Non-deterministic — copilot

| Process | Category | Owner | Guide | Status | Last verified |
| --- | --- | --- | --- | --- | --- |
| Discussion / decision process (post-2.11 gate) | Copilot | COO-spr9 + user | Not yet documented — #3466 | Not yet documented | — |

## Non-deterministic — RSI

| Process | Category | Owner | Guide | Status | Last verified |
| --- | --- | --- | --- | --- | --- |
| RSI improvement loop | RSI | COO-spr9 | Governing doc: [platforms.md](../agentic-org/platforms.md) §5, §7. Operational guide: not yet documented — #3466 | Partial | 2026-11-07 (governing doc only) |

## Non-deterministic — autopilot

No process in the seed inventory is classified autopilot. The
category is defined in the [taxonomy](process-taxonomy.md) so it
exists before it is needed; the first autopilot process will be
classified here when one is filed, not before.

## Gaps (named, not hidden)

Every process above with status `Not yet documented` is a gap, with
its owning sub-issue:

- #3465 (deterministic processes): verification routines; approval-card flow.
- #3466 (non-deterministic processes): coordinator dispatch +
  boundary reporting; proactivity handling; discussion / decision
  process; RSI improvement loop (operational guide — the governing
  doc exists).
- #3467 (owner-side / HITL processes): line-6 evidence flow; 1257
  retry + signed-in live-hit flow; operator approvals and
  attestations; live smoke checks; live testnet transfer.

Two things the guides must verify when they are written, because the
live record already contradicts the program record:

- **Approval-card lifetime.** The program record states a 1-hour
  expiry. A live card on 2026-11-06 (branch creation for the #3309
  fix) expired after 30 minutes, untapped. The #3465 guide must
  verify the live lifetime before it states one.
- **Autopilot has no process yet.** Do not invent one to fill the
  category.

## Keep-refresh

This index records `last-verified` per entry. The rule that keeps
these guides fresh — and the wiring of the guides into the Hub
surface — is owned by #3468, not restated here. Every process change
must update its guide at the same time as the process changes; the
issue-template enforcement for that rule is #3469.

## Guides home

- Workflows Hub (`?tab=workflows`, Platform Workflows panel) — links
  to this index and to the [taxonomy](process-taxonomy.md).
- Repo docs home: [gitops.md](../agents/gitops.md),
  [coo.md](../agentic-org/coo.md), `docs/operations/`.
