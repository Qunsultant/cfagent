# Audit Tamper-Response Runbook

Issue #3156 (Q7, #945). What to do when an audit chain fails
verification, and what to do when the audit gate blocks money
execution. Roles, not persons, at each step.

## Trigger: a verification failure

A verification failure announces itself two ways, both loud by
design:

1. An `audit.tamper_detected` row in `mas_events` (agent
   `orchestrator`, session `system`). Its payload carries the
   finding: `chain` (`mas_events` or `d1-chain`), `tenantId` for
   the d1-chain, `brokenIndex`, `reason`, and `detectedAt`.
2. A `console.error` line: `[audit-tamper] chain verification
   FAILED ...` with the same fields.

The live trigger is the nightly retention pass
(`POST /schedules/trigger-retention`, Worker `0 4` cron): it
verifies the `mas_events` chain BEFORE any pruning and reports
`auditChainVerification` + `auditChainPruneSkipped` in its
response. A failed verification there also means the prune was
skipped (see step 3).

## Step 1 — Confirm the alert (operator)

Find the alert row in the audit explorer (or query `mas_events`
for `type = 'audit.tamper_detected'`, newest first). Confirm
`chain`, `brokenIndex`, and `reason`:

- `mas_events`: `brokenIndex` is the index into the insertion
  order (rowid order) of the first broken row. Every row from
  that index onward is in the affected range.
- `d1-chain`: `brokenIndex` is the index into sequence order
  for that tenant; `reason` names the broken sequence.

If no alert row exists but verification is failing, treat it as
a second incident: the alert path itself is broken (its write
failure throws — it is never swallowed). Escalate to the
platform admin; do not proceed to review on console output
alone.

## Step 2 — Mark the affected range untrusted (data steward)

The affected range — from `brokenIndex` onward — is UNTRUSTED
for audit purposes until a review says otherwise, and it stays
untrusted thereafter even after review: a broken chain is never
rewritten, repaired, or re-anchored by this procedure. Record
the untrusted range (chain, first broken index/sequence,
reason, detected time) on the tracking issue. Do not delete
rows, do not edit payloads or hashes, do not "fix" a link.

## Step 3 — Preserve evidence (automatic + operator)

Preservation is automatic: while verification fails, the
nightly retention pass SKIPS the storage-retention prune
(`auditChainPruneSkipped: true`), so no `mas_events` row is
pruned that run. The orphan sweep, snapshot export, and
job-outcome prune still run — they do not touch `mas_events`,
and the snapshot export preserves a copy of the tables.

Operator duties: do not run any manual prune, wipe, or
clear-table operation against `mas_events` while verification
fails. Do not delete the `audit.tamper_detected` rows
themselves — they are part of the evidence. Note that appending
an alert row onto a broken tail does NOT repair or hide the
break: the original break still fails every later verification.

## Step 4 — Review assignment (platform admin)

The platform admin assigns the review: the security reviewer
investigates cause (tampered payload, bypass writer, deleted
middle row, reordered row — the `reason` field narrows it);
the data steward confirms the affected scope from step 2.
Findings and the disposition go on the tracking issue, not in
chat: what broke, which range is affected, whether any
consequential action's audit evidence is in the range, and
what compensating evidence exists (gateway records, ledger
rows, snapshots).

## Step 5 — Re-verification after review

Re-run verification via the nightly retention trigger (or its
manual trigger). Outcomes:

- Valid: the chain verifies again. This happens only if the
  break was transient to the verification itself (for example
  a read failure), never because a broken link was repaired —
  a genuinely broken link stays broken.
- Still failing: expected for a real break. The alert repeats
  on every nightly run by design — it is the standing reminder
  that the range in step 2 is untrusted. The review in step 4
  is the closure record; there is no auto-clear.
  Acknowledgement suppression (a recorded review silencing
  repeat alerts) is a future slice, not this procedure — do not
  invent it by deleting alert rows.

## Gate-blocked money execution (503 `payment.gate_blocked`)

Separately from chain verification, a money execution
(confirm, capture) can be blocked by the audit gate
(`payment.gate_blocked` audit, HTTP 503). Causes, in order of
likelihood:

1. The D1 policy store (`AGENT_DB`) is unbound or
   unreachable. The gate fails CLOSED by owner directive
   (2026-11-04, #3156): a consequential action blocks when
   audit cannot be verified, INCLUDING when the policy store
   is unreachable.
2. The audit write itself failed (the pre-execution
   `payment.execution_started` record could not be written).

Operator response: check the `AGENT_DB` binding and the D1
audit-policy tables (the schema is ensured on first gate use,
so a missing table means the binding itself is wrong or the
database is unavailable); check `mas_events` writability.
Restore the store; never bypass the gate — there is no flag,
no fallback, and no code path that skips it, by design.

Accepted cost, stated plainly: a D1 policy-store outage
blocks money execution even when the `mas_events` audit write
itself would succeed. That is the fail-closed directive, not a
bug to work around.

## Out of scope (separate follow-ons, not this procedure)

- R2 archival of audit evidence.
- Changing the blocking set, the chain scheme, or the
  retention windows (90d messages, 365d events+memory — live
  nightly values, unchanged by #3156).
- Wiring the same gate into the remaining money surfaces
  (webhook settlement, billing-service subscription changes,
  cfpay account-to-account operations, credit issuance). Those
  use the same `gatePaymentExecution` helper afterwards; they
  are not gated by this slice.
