/**
 * Issue #2860 (audit Factor 6, stateless) — durable
 * stage claims / checkpoints.
 *
 * The audit's Factor 6 complaint was in-memory stage
 * claims. Verified 2026-11-03, no code change needed —
 * G6 (#2913) and G8 (#2869) already made the production
 * sites durable, and the remaining in-memory pieces are
 * either fallbacks unreachable in production or
 * primitives with no production caller. These pins lock
 * that verdict so a later slice cannot silently reintroduce
 * an in-memory production claim:
 *
 *  1. Delivery suppression: the ONE production builder
 *     (orchestrator asyncJobsContext) wires the SQL-backed
 *     store (G6). The executor's in-memory suppressor is
 *     created only when a context carries none — and every
 *     production context comes from that one builder.
 *  2. Stage claims: the ONLY production caller of
 *     consumeAnalysisDone is the production helper (G8),
 *     which passes the SQL-backed store whenever the
 *     agent has SQL (production always does); the
 *     in-memory fallback covers only SQL-less contexts.
 *  3. Batch checkpoint tracker: createBatchCheckpoint is
 *     an in-memory primitive with NO production caller —
 *     the durable form in production is the job's
 *     canonical record / workflow collation, not this
 *     tracker. If a later slice wires it into production,
 *     this pin fails first and forces the durability
 *     question to be answered in that slice.
 *  4. Stage-runner checkpoints: the projection reads
 *     durable mas_async_jobs rows and never writes — it
 *     cannot disagree with the job record, because it IS
 *     a read of the job record.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function walkSrc(pattern: RegExp): string[] {
  const hits: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".ts")) {
        if (pattern.test(readFileSync(path, "utf8"))) hits.push(path);
      }
    }
  };
  walk("src");
  return hits;
}

describe("Factor 6 durable claims / checkpoints (#2860)", () => {
  it("the production async-jobs builder wires SQL-backed delivery suppression", () => {
    const src = readFileSync("src/agents/orchestrator.ts", "utf8");
    expect(src).toContain(
      "deliverySuppressor: createDeliverySuppressor(createSqlDeliverySuppressionStore",
    );
  });

  it("the only production caller of consumeAnalysisDone is the SQL-or-fallback helper", () => {
    const callers = walkSrc(/consumeAnalysisDone\(/).filter(
      (p) => p !== "src/workflows/stageReportConsumer.ts",
    );
    expect(callers).toEqual(["src/workflows/stageReportProduction.ts"]);
    const helper = readFileSync("src/workflows/stageReportProduction.ts", "utf8");
    expect(helper).toContain("createSqlStageClaimStore");
  });

  it("the in-memory batch checkpoint tracker has no production caller", () => {
    const callers = walkSrc(/createBatchCheckpoint\(/).filter(
      (p) => p !== "src/workflows/stageBatching.ts",
    );
    expect(callers).toEqual([]);
  });

  it("the stage-runner checkpoint projection reads durable job rows and never writes", () => {
    const src = readFileSync("src/workflows/stageRunnerCheckpoint.ts", "utf8");
    expect(src).toContain("mas_async_jobs");
    expect(src).not.toContain("INSERT INTO");
    expect(src).not.toContain("UPDATE ");
    expect(src).not.toContain("DELETE FROM");
  });
});
