/**
 * Issue #835 — mas_reports persistence atomicity pins (regression).
 *
 * RCA: `persistScheduledReportSql` is documented "Never throws" — it
 * returns `string | null`, null on any write failure. The ScreenerAgent
 * caller (#832) wrapped the call in try/catch intending "fail the run
 * loudly", but never checked the return value, so the catch was dead code
 * for real write failures: a failed INSERT returned null, the run proceeded
 * to Deliver and reported success, and mas_reports silently had no row
 * (Reports tab vs Slack divergence). The atomicity was fake.
 *
 * Pins:
 *  - Structural (the fix): `persistRun` in src/agents/screener-agent.ts
 *    captures the helper's return value and throws when it is null, inside
 *    the #832 try whose catch rethrows "Failed to persist report metadata".
 *    (ScreenerAgent is an agents-SDK Durable Object class and cannot be
 *    imported into vitest; the caller contract is pinned at the source seam,
 *    the same pattern as tests/stub_orm_elimination.test.ts.)
 *
 * Red/green note: the structural pins FAIL on the pre-fix source (the call
 * result was discarded) and pass with the fix; the behavioral pins pass on
 * both sides by design (they pin the helper's unchanged contract).
 *
 * Issue #783 supersession (2026-10-21): the write this suite made atomic
 * turned out to be a DEAD write — ScreenerAgent's own mas_reports copy
 * had no reader; every report surface reads the orchestrator instance's
 * store, where the canonical copy is written at generation through the
 * #308 seam. #783 removes the screener-side write entirely, so the
 * structural pins below now pin the removal: the divergence #832/#835
 * chased (Reports tab vs delivered report) cannot recur from a write
 * that does not exist. The single-home behaviour is pinned in
 * tests/screener_reports_single_home.test.ts.
 *
 * Issue #6101 (step 8): the never-throws canonical store is
 * storeReportAtGeneration (async, null on failure) writing D1
 * agent_reports; persistScheduledReportSql is DELETED, so the two
 * behavioral pins that characterized it were deleted with it — the
 * contract itself is pinned in tests/scheduled-reports.test.ts
 * ("never throws on a broken store") and tests/reports_d1_6101.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("ScreenerAgent.persistRun no longer writes mas_reports (#783 removal)", () => {
  const src = readFileSync(path.join(repoRoot, "src/agents/screener-agent.ts"), "utf-8");
  const start = src.indexOf("private async persistRun");
  const persistRun = src.slice(start, start + 4000);

  it("persistRun still exists and keeps the delivery cache (latest/history)", () => {
    expect(start).toBeGreaterThan(-1);
    expect(persistRun).toContain("LATEST_KEY");
    expect(persistRun).toContain("HISTORY_KEY");
  });

  it("persistRun contains no mas_reports persistence block", () => {
    expect(persistRun).not.toContain("persistScheduledReportSql");
    expect(persistRun).not.toContain("Failed to persist report metadata");
  });

  it("the whole agent carries no second report home", () => {
    expect(src).not.toContain("persistScheduledReportSql");
    expect(src).not.toContain("mas_reports");
  });
});
