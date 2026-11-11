# Handover playbook

The single pick-up-and-follow process for handing work between agents
(lanes). If you are picking up work from another agent, start at
[Where to look](#where-to-look). If you are handing work over, start
at [How to hand over](#how-to-hand-over).

## Purpose

One agent's finished work becomes another agent's starting point
without anything lost: what was done, what was verified, what is
still open, and what the next agent is asked to do — all in one place
a stranger can follow.

## Why

Handover used to live in pieces: the handoff template in
`docs/agentic-org/collaboration.md` §8, the handover record in
gitops.md §15, status-update policy in
`docs/agentic-org/documentation.md`. A new collaborator had to find
all three and guess how they fit. This playbook is the fit.

## Trigger

Any of these:

- An agent finishes a slice and another agent (or lane) continues it.
- Work stops mid-slice (blocked, parked, waiting on the user, waiting
  on another lane) and someone else must be able to resume it.
- A slice is split and the second half goes to another agent.

## Inputs

- The issue (with its §15 completion report, or its current state if
  not yet closed).
- The branch and PR (numbers, head, base, merge state).
- The evidence (CI runs, verification logs, comment ids).

## Steps

### Where to look

1. The [process index](process-index.md) — the single entry point
   for operational process guides.
2. The issue — the record. The §15 completion report is the handover
   record: verified results, branch/PR state, where the evidence
   lives, and Remaining work (#4071 — a completed issue with no
   remaining-work statement is incomplete).
3. The PR body — a pointer to the issue's §15, not a second record
   (gitops §9).
4. The branch head and base — a handover that names a head on a
   stale base is never valid (#4044: rebase locally and re-verify
   first).

Until the live work ledger lands (#4075), there is no single
"who's working on what" view. Claim comments on each issue and the
issue's own state are the source of truth — check them before
starting work, and write your claim the same way, so the next
agent can find it.

### How to hand over

1. Write the §15 completion report on the issue (gitops §15) with
   its Remaining work section: next sub-issues with numbers and
   state, branch/PR state with numbers, and where the evidence
   lives.
2. Post the handoff as a HANDOFF message on the issue, using the
   template in `docs/agentic-org/collaboration.md` §8 (linked, not
   copied here, so the template has one home): From/To role, Task,
   Candidate, Commit/artifact version, Completed, Evidence,
   Requested action, Acceptance condition, Constraints, Respond by,
   Escalation.
3. Name the recipient and the expected response. A handoff with no
   named recipient is not a handoff.
4. File anything the handover surfaces as out of scope: every such
   item gets its own sub-issue titled `[Out-of-Scope] <thing>`
   (issue #4099) — never a follow-up note, TODO, or 'future work'
   line.
5. Record material decisions back in GitHub. Chat and Slack are
   channels, not the record.

### How to receive

1. Read the §15 and the HANDOFF message before touching code.
2. Acknowledge with exactly one of: Accepted, Needs clarification,
   Rejected — reason, Blocked — dependency. Acknowledgment is not
   completion.
3. Verify the named head and base yourself (fetch, rebase, re-verify)
   before building on the work — never trust a head you have not
   checked.
4. If the handover is missing anything (no §15, no Remaining work,
   no evidence links), say so on the issue and treat the handover
   as incomplete — do not guess the missing part.

## Exit evidence

The handover is done when all of these are true:

- The §15 completion report is posted on the issue and read back
  (comment id recorded).
- The HANDOFF message names a recipient, a requested action, and an
  acceptance condition.
- The recipient acknowledged (Accepted / Needs clarification /
  Rejected / Blocked).
- Every out-of-scope item surfaced has its own `[Out-of-Scope]`
  sub-issue, or an explicit `Out of scope: none`.

## Owner

CFO-qunso wrote this playbook (issue #4098); the process index that
lists it is owned by COO-spr9. Ownership of a handover itself is the
agent handing over, until the recipient acknowledges.

## Failure / rollback

- No recipient acknowledges: the handover stays open on the issue;
  escalate on the issue, not in chat. Do not start the next slice
  on an unacknowledged handover.
- Handover names a stale head: rebase locally and re-verify before
  any push or PR (#4044). A write card naming a head on a stale
  base is never valid.
- Evidence links are dead or missing: the handover is incomplete;
  ask on the issue for the evidence, do not reconstruct it from
  memory.
- Two agents claim the same work: stop, compare claim comments on
  the issue, and let the issue owner decide — do not build in
  parallel (this is how #672 was built twice).

## Last verified

2026-11-11.
