# RSI governance definition — completion (#1774, parent #1717, F-43)

Completes the RSI governance capability definition that the business
assessment left Partially Defined (CAP-GOV-03, Level 2 Repeatable;
GAP-01: experiment tracking partially manual). This document DEFINES
the process; it does not claim the process is verified in production.
The assessment rows PROC-02/03/05/06 that carry Unverified
verification levels stay Unverified until evidence, not prose, closes
them — the trial ledger below is the evidence mechanism for PROC-06.

## 1. The loop, defined

1. **Propose** — an agent records a hypothesis and an owner in the
   trial ledger (`src/rsi/trialLedger.ts`). A trial without a
   hypothesis and an owner cannot exist: the port rejects blanks.
2. **Run** — the trial moves to `running`. Only a running trial
   accepts telemetry.
3. **Measure** — telemetry is appended as events, one per metric
   observation (`{ metric, value, unit }`). Telemetry never changes
   status and never overwrites an earlier observation.
4. **Evaluate** — an evaluation event (`pass` | `fail` + evidence)
   moves the trial to `completed`. Evaluation evidence is free text
   naming what was observed; an evaluation without evidence is not
   accepted by the port's contract (callers must supply it).
5. **Decide** — a human owner records `approved` or `rejected` with
   their approver identity. No decision, no adoption: `adoptTrial`
   throws unless the derived status is `approved`, and a rejected
   trial can never adopt.
6. **Adopt** — adoption is a separate event from approval, so
   "approved but not yet adopted" is a visible state, not a gap.

## 2. Separation of duties

- The proposer is not the evaluator and not the approver. The port
  records identities as given; it does not infer authority from a
  caller string — who counts as an owner is an operator decision
  recorded in the decision event's `approver` field.
- The evaluator must be independent of the trial's proposer: a
  persuasive explanation is never a substitute for the required
  approval (cf. the RSI-CEO role definition, which forbids
  pressuring evaluators to reinterpret failures as success).

## 3. Integrity

- The event log is append-only: the store contract exposes no update
  or delete operation.
- Events are SHA-256 hash-chained (`previousEventHash` /
  `eventHash`, same construction as `src/security/iaaaAudit.ts`).
  `verifyTrialChain` recomputes every hash and link; tampering,
  reordering, or relinking fails verification.
- Status is derived from the log, never stored as a mutable field,
  so the current state cannot drift from the recorded history.

## 4. Store decision (from #1774, stated before building)

The scan names a trial-ledger Durable Object. No new DO class is
created by this slice: the ledger is a port over existing DO SQLite
stores (`TrialLedgerSqlExecutor`, the DO SqlStorage exec shape), and
the in-memory store is for tests and embedding. A dedicated DO class
would require a new wrangler migration tag; if the owner directs one,
that is a follow-up slice, not a silent substitution.

## 5. Explicitly NOT settled by this document

- **Retention**: how long trial events are kept, and where they are
  archived long-term, is unsettled (same open shape as the IAAA
  audit retention decision). The chain detects tampering; it does
  not set a retention policy.
- **Production wiring**: no live call site records trials yet. The
  port is the evidence mechanism; wiring it into self-heal and
  evaluator paths is a follow-up slice with its own tests.
- **PROC-02/03/05/06 verification levels**: unchanged by this
  document. PROC-06 becomes verifiable through ledger evidence;
  it is not hereby verified.

#CISO-bhdm
