/**
 * @deprecated Retired by #6101 step 5 (2026-11-26) — the queue
 * carrier for the run ledger: the message envelope that carried a
 * ledger row's claim-check reference to the projector.
 * Superseded by src/data/createJobRunRecordPorts.ts (recordLedgerRunD1
 * — writes go to D1 directly at the source, so no queue transport
 * carries ledger rows). This file is a frozen stub: no
 * implementation, no callers, no exports. Do not add consumers.
 * Deletion needs zero consumers plus an owner decision plus a gate
 * amendment (gitops §22); recorded in
 * docs/architecture/transition/deprecations.md (#6101).
 */
export {};
