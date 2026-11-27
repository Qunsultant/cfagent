/**
 * @deprecated Retired by #6101 step 5 (2026-11-26) — the
 * best-effort projection hooks (report, async job, run record,
 * outcome): the call sites that asked the projector to copy a DO
 * row into D1. Superseded by src/data/createJobRunRecordPorts.ts
 * (recordLedgerRunD1 — call sites write D1 directly now). This file
 * is a frozen stub: no implementation, no callers, no exports. Do
 * not add consumers. Deletion needs zero consumers plus an owner
 * decision plus a gate amendment (gitops §22); recorded in
 * docs/architecture/transition/deprecations.md (#6101).
 */
export {};
