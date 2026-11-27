/**
 * @deprecated Retired by #6101 step 5 (2026-11-26) — the shared
 * run-ledger projector (#4116, #6099): the one D1 writer for run
 * ledgers across the three carriers (queue, ORM, sweep). It copied
 * DO rows into D1 — reports, async jobs, run records, outcomes —
 * with the twin link stamped where it resolved exactly.
 * Superseded by src/data/createJobRunRecordPorts.ts (recordLedgerRunD1
 * — writes go to D1 directly at the source, so there is no copy step
 * left to run; the D1 store is src/data/d1JobRunRecordAdapter.ts). This
 * file is a frozen stub: no implementation, no callers, no exports.
 * Do not add consumers. Deletion needs zero consumers plus an owner
 * decision plus a gate amendment (gitops §22); recorded in
 * docs/architecture/transition/deprecations.md (#6101).
 */
export {};
