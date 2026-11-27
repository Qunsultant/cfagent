/**
 * @deprecated Retired by #6101 step 5 (2026-11-26) — the tenant
 * run-ledger projection carrier-config read. The carrier table was
 * dropped by migration 0093 and there is no carrier config left to
 * read. Superseded by src/data/createJobRunRecordPorts.ts
 * (recordLedgerRunD1 — writes go to D1 directly, with no carriers).
 * This file is a frozen stub: no implementation, no callers, no
 * exports. Do not add consumers. Deletion needs zero consumers plus
 * an owner decision plus a gate amendment (gitops §22); recorded in
 * docs/architecture/transition/deprecations.md (#6101).
 */
export {};
