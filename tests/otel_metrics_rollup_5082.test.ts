/**
 * Issue #5082 (S2, observability program #5080) — the #1819
 * resource rollup absorbed as the first metric: the rollup
 * data is readable as metrics from the one store.
 *
 * TDD Red first: the rollup metrics seam (the optional
 * `metrics` dep on runResourceRollup in
 * src/agents/resourceGoals.ts, and the recorder's
 * recordResourceRollup) does not exist yet in the wired form,
 * so the end-to-end leg of this file fails at import.
 *
 * Design (recorded in the PR body):
 * - The rollup goal (runResourceRollup) keeps its contract:
 *   it writes the daily rollup rows to D1 and returns the
 *   sums. After the write, when a metrics recorder is provided
 *   (an optional dep — the goal works unchanged without one),
 *   it hands the rows to the recorder. The recorder converts
 *   each row into the resource gauges (rows_read, rows_written,
 *   ops) and evaluates the SLO gauge. A metrics failure never
 *   fails the rollup goal (best-effort, swallowed).
 * - This is the acceptance proof for S2: the #1819 rollup data
 *   is readable as metrics from the one metrics store — the
 *   same rows the rollup wrote to D1 are the rows the recorder
 *   emitted as metrics. No second metrics store, no duplicate
 *   rollup.
 * - The rollup is already daily-aggregated (one row per
 *   ns/op/caller/trigger per day), so the metric volume is one
 *   gauge value per row per day — the lowest possible volume,
 *   and the reason the rollup is the right FIRST metric for
 *   the free tier.
 *
 * The D1 double is the shared MockD1Database (real
 * node:sqlite) via createD1ResourceDb — the same pattern
 * tests/resource_rollup_alert_1819.test.ts uses — because the
 * rollup goal reads its totals through the D1ResourceUsageAdapter
 * (DML catalogue + drizzle), which a hand-rolled double cannot
 * serve. Usage events are seeded through the adapter's record
 * path, so the totals are real aggregates, not stubbed.
 */
import { describe, it, expect } from "vitest";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import { runResourceRollup } from "../src/agents/resourceGoals";
import { createOtelMetricsRecorder } from "../src/observability/otelMetricsRecorder";
import type { OtelMetricsSettings } from "../src/observability/otelMetrics";
import type { DailyRollupRow } from "../src/telemetry/resourceRollup";
import { createD1ResourceDb, D1ResourceUsageAdapter } from "../src/data/d1ResourceUsageAdapter";
import { MockD1Database } from "./mock-d1";

/**
 * Seed usage events for the previous UTC day (2026-11-16,
 * the day the 2026-11-17T01:30:00Z rollup tick aggregates)
 * and return a db the rollup goal can read. Two groups:
 * - SessionStore/get (login, user): 3 events x 10,000 read /
 *   100 written -> ops 3, rowsRead 30,000, rowsWritten 300.
 * - SessionStore/put (session, cron): 2 events x 15,000 read /
 *   2,500 written -> ops 2, rowsRead 30,000, rowsWritten 5,000.
 * Grand total: ops 5, rowsRead 60,000, rowsWritten 5,300.
 * SLO: 60,000 / 5,000,000 = 1.2% — within SLO.
 */
async function seedRollupDb() {
  const db = createD1ResourceDb(new MockD1Database() as never);
  const adapter = new D1ResourceUsageAdapter(db);
  const tsMs = Date.parse("2026-11-16T12:00:00Z");
  for (let i = 0; i < 3; i++) {
    await adapter.record({
      ns: "SessionStore",
      op: "get",
      caller: "login",
      trigger: "user",
      rowsRead: 10000,
      rowsWritten: 100,
      timestampMs: tsMs,
    });
  }
  for (let i = 0; i < 2; i++) {
    await adapter.record({
      ns: "SessionStore",
      op: "put",
      caller: "session",
      trigger: "cron",
      rowsRead: 15000,
      rowsWritten: 2500,
      timestampMs: tsMs,
    });
  }
  return db;
}

const SETTINGS: OtelMetricsSettings = {
  exportIntervalMs: 60000,
  freeTierDailyWriteLimit: 100000,
  freeTierDailyReadQueryLimit: 10000,
  healthPipelineMaxFailureRate: 0.05,
  sloResourceRowsReadMaxPct: 0.7,
};

describe("The #1819 rollup reads through the one metrics model", () => {
  it("the rollup goal hands its rows to the metrics recorder (same rows, one model)", async () => {
    const provider = new MeterProvider();
    const meter = provider.getMeter("cfagent-rollup-test");
    const recordedRows: DailyRollupRow[][] = [];
    const recorder = createOtelMetricsRecorder({ meter, settings: SETTINGS, isEnabled: () => true });
    // Spy on the recorder's rollup entry: wrap it to capture the rows.
    const original = recorder.recordResourceRollup.bind(recorder);
    recorder.recordResourceRollup = (rows: readonly DailyRollupRow[]) => {
      recordedRows.push([...rows]);
      original(rows);
    };

    const db = await seedRollupDb();
    // 2026-11-17T01:30:00Z is the rollup tick; the previous UTC day is 2026-11-16.
    const result = await runResourceRollup({
      db,
      nowMs: Date.parse("2026-11-17T01:30:00Z"),
      metrics: recorder,
    });
    expect(result.day).toBe("2026-11-16");
    expect(result.groups).toBe(2);
    expect(result.ops).toBe(5);
    expect(result.rowsRead).toBe(60000);
    expect(result.rowsWritten).toBe(5300);
    // The SAME rows the goal wrote are the rows the recorder received.
    expect(recordedRows).toHaveLength(1);
    expect(recordedRows[0]).toHaveLength(2);
    expect(recordedRows[0][0].ns).toBe("SessionStore");
    expect(recordedRows[0][0].op).toBe("get");
    expect(recordedRows[0][0].rowsRead).toBe(30000);
    expect(recordedRows[0][1].op).toBe("put");
    expect(recordedRows[0][1].rowsWritten).toBe(5000);
    // The SLO was evaluated from the day's grand total (60,000 of 5,000,000 = 1.2% — within SLO).
    expect(recorder.lastSlo()).toEqual({ withinSlo: true, pct: 0.012 });
    await provider.shutdown();
  });

  it("the rollup goal works unchanged without a metrics recorder (the dep is optional)", async () => {
    const db = await seedRollupDb();
    const result = await runResourceRollup({
      db,
      nowMs: Date.parse("2026-11-17T01:30:00Z"),
    });
    expect(result.day).toBe("2026-11-16");
    expect(result.groups).toBe(2);
    expect(result.ops).toBe(5);
  });

  it("a metrics failure never fails the rollup goal (best-effort)", async () => {
    const throwingRecorder = {
      recordResourceRollup: () => {
        throw new Error("recorder down");
      },
    } as unknown as Parameters<typeof runResourceRollup>[0]["metrics"];
    const db = await seedRollupDb();
    const result = await runResourceRollup({
      db,
      nowMs: Date.parse("2026-11-17T01:30:00Z"),
      metrics: throwingRecorder,
    });
    expect(result.day).toBe("2026-11-16");
    expect(result.ops).toBe(5);
  });
});
