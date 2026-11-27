/**
 * @deprecated Retired by #6101 (2026-11-26) — the DO SQLite adapter
 * for the job_run_records table. The DO run-ledger write stops: the
 * ledger lives in D1 now. Superseded by
 * src/data/d1JobRunRecordAdapter.ts (D1JobRunRecordStore — the one
 * run-record writer). This file is a frozen stub: no implementation,
 * no callers, no exports. Do not add consumers. Deletion needs zero
 * consumers plus an owner decision plus a gate amendment (gitops §22);
 * recorded in docs/architecture/transition/deprecations.md (#6101).
 */
export {};
