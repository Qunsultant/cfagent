/**
 * @deprecated Retired by #6101 (2026-11-26) — the #4069 dual-ledger suite: scan runs merged with D1-projected canonical rows.
 * Superseded by src/data/createJobRunRecordPorts.ts (recordLedgerRunD1 — one ledger, D1 only). The describes below are skipped
 * placeholders: the test titles are preserved so no test disappears,
 * but no dead-world assertion is resurrected — the world this suite
 * pinned no longer exists. (Tests are excluded from gate (j); the
 * note is carried anyway so the file states its own retirement.)
 */
import { describe, it } from "vitest";

describe.skip("runFromScanRun (#4069)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("GET /workflow-runs merges scan runs (#4069)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});

describe.skip("goal leg omits the canonical store (#4069 Q2)", () => {
  it.skip("retired by #6101 — the pinned world no longer exists; no assertion runs", () => {});
});
