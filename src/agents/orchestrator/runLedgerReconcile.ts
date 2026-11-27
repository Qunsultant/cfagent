/**
 * @deprecated Retired by #6101 step 5 (2026-11-26) — the run-ledger
 * sweep: an operator-invoked reconcile (limit 100 rows per ledger per
 * call, route POST /api/ops/run-ledger-reconcile) that backfilled
 * rows the projector had missed. Superseded by
 * src/data/createJobRunRecordPorts.ts (recordLedgerRunD1 — writes go
 * to D1 directly at the source, so there is nothing left to
 * reconcile and no sweep to run). This file is a frozen stub: no
 * implementation, no callers, no exports. Do not add consumers.
 * Deletion needs zero consumers plus an owner decision plus a gate
 * amendment (gitops §22); recorded in
 * docs/architecture/transition/deprecations.md (#6101).
 */
export {};
