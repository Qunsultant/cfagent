# Operational process taxonomy

The shared vocabulary for every operational process guide in this
program (#3463). A process is classified once, by how its path is
decided — not by who runs it, and not by how important it is. Future
answers link to the process index
([process-index.md](process-index.md)) instead of re-explaining a
process; the index links back here for what each category means.

Owner: COO-spr9. Last verified: 2026-11-07.

## The two families

### Deterministic

The steps are fixed. Given the same inputs, the same steps run, in the
same order, and the outcome is determined by the steps — not by
judgment made while the work runs. What varies is the data, never the
procedure. When a deterministic process fails, the failure is a
deviation from a known step, and the fix is a correction to that step.

### Non-deterministic

The path is decided as the work runs, by an agent — or by a human
paired with an agent — working within bounds. The same trigger can
take different paths on different runs, and the same outcome can be
reached by different routes. What is fixed is the envelope (bounds,
gates, audit), never the route. When a non-deterministic process
fails, the failure is a judgment or a bound, and the fix is a better
bound, a better gate, or better evidence — not a new fixed step.

## Categories

### Deterministic — autonomous

Runs without human input. The agent (or the system) executes the
fixed steps end to end; no human confirms, approves, or intervenes
while it runs.

- Example: merge-queue landing — once a PR is armed, the queue
  replays, tests, and merges it with no human action.
- Owner pattern: the lane agent that operates the flow.
- Exit evidence: the recorded outcome of the run (merge commit, tag,
  CI result), never an assertion that it ran.

### Deterministic — HITL (human-in-the-loop)

A human confirm or approve gate sits inside an otherwise fixed flow.
The steps before and after the gate are deterministic; the gate itself
is a human decision, and the flow does not advance past it without
one.

- Example: the approval-card flow — a GitHub write needs the user's
  tap on an approval card before it executes.
- Owner pattern: the lane agent operates the flow; the user (or
  operator) owns the gate decision.
- Exit evidence: the gate decision record (who tapped, when, what was
  approved) plus the outcome that followed it.

### Deterministic — manual / owner-only

The human is the process. No agent runs it; the agent at most records
it, verifies it, or reports on it. The steps are fixed, but only the
owner can perform them.

- Example: the live testnet transfer — only the owner can fund the
  wallet and confirm the transfer.
- Owner pattern: the user (or store operator).
- Exit evidence: the owner's own report of the result (transaction,
  response body, screenshot), recorded verbatim — never paraphrased
  into a claim the evidence does not support.

### Non-deterministic — agentic

An agent decides within bounds. The agent chooses the route, the
order, and the tools; the bounds (scope, approvals, audit) are what
keep it from going outside the envelope.

- Example: coordinator dispatch — the parent agent chooses which
  coordinator runs, in what order, and how to verify the boundary.
- Owner pattern: the agent that holds the mandate.
- Exit evidence: the boundary report (what was done, the gate
  evidence, what remains) — a report is not done until its evidence
  is independently verified.

### Non-deterministic — RSI (recursive self-improvement)

An improvement loop that changes the system that runs it: governed
research → independent evaluation → portfolio simulation → paper /
shadow → limited live → cross-platform improvement, per
[platforms.md](../agentic-org/platforms.md) §5 (a governed RSI model)
and §7 (implementation order). The loop itself is the process; each
pass through it is judged on evidence, never on assertion.

- Example: the RSI improvement loop that produced this taxonomy
  program — a filed program, executed only on direction, with its own
  close-out evidence.
- Owner pattern: the RSI-COO, under the platform governance in
  `platforms.md` §5/§7.
- Exit evidence: the evaluated outcome per loop stage, with the
  governing decision recorded in the repository (gitops.md §23).

### Non-deterministic — copilot

A human and an agent paired. Neither runs it alone: the agent does
the work, the human steers, and the decision is made together, in
the conversation.

- Example: the discussion / decision process after slice 2.11 — the
  agent brings evidence and a recommendation, the user decides the
  order and scope.
- Owner pattern: the pair — the agent runs the work, the user owns the
  decision.
- Exit evidence: the decision as recorded (issue comment, decision
  surface), with the evidence it rested on.

### Non-deterministic — autopilot

The agent runs; the human supervises and intervenes. The agent
proceeds without asking at each step, and the human watches for
drift, steps in when the envelope is breached, and can stop the run.

- Example: none in the seed inventory — autopilot is defined so the
  category exists before it is needed, and no process is forced into
  it. The first autopilot process will be classified here when one
  is filed.
- Owner pattern: the agent that runs, with a named human supervisor.
- Exit evidence: the supervision record (what ran, what the supervisor
  observed, every intervention and its reason).

## The entry schema

Every process guide carries the same nine fields. A guide that omits
one is incomplete, and the omission must be named in the guide rather
than left silent. This schema implements the role requirement in
[coo.md](../agentic-org/coo.md) §3.3 ("Own operational process
integrity"), which requires each material workflow to define its
trigger, inputs, owner, participants, permissions, state transitions,
dependencies, service expectations, completion criteria, failure
handling, recovery, and audit evidence.

| Field | What belongs in it |
| --- | --- |
| Purpose | What the process exists to do, in one sentence. |
| Why | Why it exists this way — the failure it prevents or the value it creates. Never restate the purpose. |
| Trigger | The exact event or condition that starts it. |
| Inputs | What it needs before it can start (issue, branch, evidence, decision). |
| Steps | The steps, in order. For deterministic processes these are fixed; for non-deterministic processes these are the bounds and the decision points, not a pretended fixed route. |
| Exit evidence | What proves it finished, and where that proof lives (link, SHA, timestamp). An assertion is not evidence. |
| Owner | Who is accountable for it. One owner per process; participants are named separately. |
| Failure / rollback | What happens when it fails, and how to get back to a known-good state. |
| Last verified | The date the guide was last confirmed against the live process. A date, never "recently". |

## Extension rule

Extend either list only with a definition and an example. A new
category needs both before any process is classified into it. Never
leave a category undefined, and never force a process into a category
it does not fit: an unclassified process is listed as a gap in the
[process index](process-index.md) with its owning sub-issue, until
its category is decided.

## Governing documents

- [gitops.md](../agents/gitops.md) — the deterministic delivery
  processes (branching §6, TDD §7, PR requirements §9, merge policy
  §11, completion report §15, post-merge verification §17, merge
  queue §19.5, policy gate §22, process decisions in the repository
  §23, anti-work-loss §24).
- [platforms.md](../agentic-org/platforms.md) §5 and §7 — the
  governed RSI model and its implementation order.
- [coo.md](../agentic-org/coo.md) §3.3 — operational process
  integrity: what every material workflow must define.
- [process-index.md](process-index.md) — the index: every documented
  process, its category, its owner, and its guide.

## Status

Taxonomy v1, landed 2026-11-07 under #3464. Changes go through the
#3463 program (one sub-issue per change); the keep-refresh rule for
these guides is owned by #3468 and is not restated here.
