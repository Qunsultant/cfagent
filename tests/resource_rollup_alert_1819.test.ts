/**
 * Issue #1819 — rollup + cap-alert pure logic, fan-out, and D1 rollup store (RED).
 *
 * The day boundary is UTC midnight, verified from Cloudflare's own docs
 * (Workers pricing page: D1 "Free limits reset daily at 00:00 UTC", and DO
 * rows metering "match D1 pricing" per the DO table footnote 1) — not a
 * guess. Budgets are the Free-plan DO numbers from the same page:
 * 5M rows read/day, 100k rows written/day, 100k requests/day.
 *
 * Scope honesty pinned here: the projection sees SessionStore ops only, so
 * alert totals are a LOWER BOUND on account-wide usage — a SessionStore-only
 * breach at 70% implies the account is at >=70%, but no breach does NOT
 * prove account safety (other DO namespaces could push it over). The
 * DO-requests figure counts store ops (one stub.fetch per op) as the
 * request proxy, same lower-bound caveat.
 */
import { describe, it, expect } from "vitest";
import {
  FREE_TIER_BUDGETS,
  ALERT_FRACTION,
  alertThresholds,
  utcDayOf,
  utcDayBounds,
  previousUtcDay,
  evaluateCapAlert,
  rollupRowsFromTotals,
  buildComparisonReport,
  type CapCumulative,
} from "../src/telemetry/resourceRollup";
import { FanOutResourceUsageAdapter } from "../src/telemetry/fanOutResourceUsageAdapter";
import { createD1ResourceDb } from "../src/data/d1ResourceUsageAdapter";
import {
  ensureResourceRollupTables,
  writeDailyRollup,
  readDailyRollup,
  latestCompletedRollupDay,
  getAlertState,
  markAlerted,
  writeComparisonReport,
  readComparisonReport,
} from "../src/telemetry/resourceRollupStore";
import { MockD1Database } from "./mock-d1";

describe("budgets and thresholds (#1819)", () => {
  it("uses the verified Free-plan DO budgets", () => {
    expect(FREE_TIER_BUDGETS).toEqual({ rowsRead: 5_000_000, rowsWritten: 100_000, doRequests: 100_000 });
    expect(ALERT_FRACTION).toBe(0.7);
  });

  it("derives 70% thresholds exactly", () => {
    expect(alertThresholds()).toEqual({ rowsRead: 3_500_000, rowsWritten: 70_000, doRequests: 70_000 });
  });
});

describe("UTC day boundary", () => {
  it("utcDayOf reads the UTC calendar day, not local time", () => {
    // 2026-10-27 00:30 UTC is still 2026-10-26 in America/New_York.
    expect(utcDayOf(Date.parse("2026-10-27T00:30:00Z"))).toBe("2026-10-27");
    expect(utcDayOf(Date.parse("2026-10-26T23:30:00Z"))).toBe("2026-10-26");
  });

  it("utcDayBounds spans exactly one UTC day", () => {
    const { startMs, endMs } = utcDayBounds("2026-10-26");
    expect(startMs).toBe(Date.parse("2026-10-26T00:00:00Z"));
    expect(endMs).toBe(Date.parse("2026-10-27T00:00:00Z"));
    expect(endMs - startMs).toBe(86_400_000);
  });

  it("previousUtcDay steps back one UTC day", () => {
    expect(previousUtcDay(Date.parse("2026-10-27T01:30:00Z"))).toBe("2026-10-26");
    expect(previousUtcDay(Date.parse("2026-01-01T00:30:00Z"))).toBe("2025-12-31");
  });
});

describe("evaluateCapAlert", () => {
  const at = (c: Partial<CapCumulative>): CapCumulative => ({
    rowsRead: 0,
    rowsWritten: 0,
    ops: 0,
    ...c,
  });

  it("does not breach below 70% on any budget", () => {
    expect(evaluateCapAlert(at({ rowsRead: 3_499_999, rowsWritten: 69_999, ops: 69_999 })).breached).toBe(false);
  });

  it("breaches exactly at 70% (at-threshold alerts, not past-threshold)", () => {
    const out = evaluateCapAlert(at({ rowsRead: 3_500_000 }));
    expect(out.breached).toBe(true);
    expect(out.breaches).toEqual([
      { budget: "rowsRead", cumulative: 3_500_000, limit: 5_000_000, pct: 0.7 },
    ]);
  });

  it("reports every breached budget with its percentage", () => {
    const out = evaluateCapAlert(at({ rowsRead: 4_000_000, rowsWritten: 80_000, ops: 10 }));
    expect(out.breaches.map((b) => b.budget)).toEqual(["rowsRead", "rowsWritten"]);
    expect(out.breaches[0].pct).toBeCloseTo(0.8);
  });
});

describe("rollupRowsFromTotals", () => {
  it("maps bucketed totals to day-keyed rollup rows", () => {
    const rows = rollupRowsFromTotals(
      [
        { bucketStartMs: 0, ns: "sessions", op: "get", caller: "requireAuth", trigger: "user", ops: 10, rowsRead: 10, rowsWritten: 0 },
        { bucketStartMs: 0, ns: "sessions", op: "put", caller: "unknown", trigger: "unknown", ops: 2, rowsRead: 0, rowsWritten: 2 },
      ],
      "2026-10-26"
    );
    expect(rows).toEqual([
      { day: "2026-10-26", ns: "sessions", op: "get", caller: "requireAuth", trigger: "user", ops: 10, rowsRead: 10, rowsWritten: 0 },
      { day: "2026-10-26", ns: "sessions", op: "put", caller: "unknown", trigger: "unknown", ops: 2, rowsRead: 0, rowsWritten: 2 },
    ]);
  });
});

describe("buildComparisonReport", () => {
  it("carries instrumented totals, budgets, and the dashboard worksheet — never invented dashboard numbers", () => {
    const report = buildComparisonReport({
      day: "2026-10-26",
      rows: [
        { day: "2026-10-26", ns: "sessions", op: "get", caller: "requireAuth", trigger: "user", ops: 30_000, rowsRead: 30_000, rowsWritten: 0 },
      ],
    });
    expect(report.day).toBe("2026-10-26");
    expect(report.grandTotals).toEqual({ ops: 30_000, rowsRead: 30_000, rowsWritten: 0 });
    expect(report.pctOfBudget.rowsRead).toBeCloseTo(0.006);
    expect(report.dashboard).toBeNull();
    expect(report.dashboardSeriesToCompare.some((s) => s.includes("Durable Objects"))).toBe(true);
    expect(report.agreementCriteria.some((s) => s.includes("same order of magnitude"))).toBe(true);
  });
});

describe("FanOutResourceUsageAdapter", () => {
  it("delivers to every sink, and one sink throwing never blocks the others or the op", async () => {
    const seen: unknown[][] = [[], []];
    const throwing = {
      record: () => {
        throw new Error("AE down");
      },
    };
    const good = {
      record: (e: unknown) => {
        seen[1].push(e);
      },
    };
    const fan = new FanOutResourceUsageAdapter([throwing as never, good as never]);
    await expect(
      fan.record({ ns: "sessions", op: "get", rowsRead: 1, rowsWritten: 0, timestampMs: 1 })
    ).resolves.toBeUndefined();
    expect(seen[1]).toHaveLength(1);
  });
});

/**
 * #4282 P6a (#4384): the rollup store no longer issues raw
 * .prepare( calls — its statements live in the DML catalogue
 * and run through the Drizzle builder — so the old
 * SQL-text-dispatch fake cannot see them. The two store tests
 * below now run over the shared MockD1Database (real
 * node:sqlite) via createD1ResourceDb; the assertions are
 * unchanged behaviour (round-trip, idempotent re-run).
 */
function makeDb() {
  return createD1ResourceDb(new MockD1Database() as never);
}

describe("resourceRollupStore (fake D1)", () => {
  it("round-trips rollup rows, latest day, alert state, and comparison reports", async () => {
    const db = makeDb();
    await ensureResourceRollupTables(db);
    expect(await latestCompletedRollupDay(db)).toBeNull();
    await writeDailyRollup(db, "2026-10-26", [
      { day: "2026-10-26", ns: "sessions", op: "get", caller: "requireAuth", trigger: "user", ops: 5, rowsRead: 5, rowsWritten: 0 },
    ]);
    expect(await latestCompletedRollupDay(db)).toBe("2026-10-26");
    const rows = await readDailyRollup(db, "2026-10-26");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: "get", ops: 5 });

    expect(await getAlertState(db, "rowsRead", "2026-10-26")).toBeNull();
    await markAlerted(db, "rowsRead", "2026-10-26", true, "delivered via webhook");
    const state = await getAlertState(db, "rowsRead", "2026-10-26");
    expect(state).toMatchObject({ delivered: 1, note: "delivered via webhook" });

    await writeComparisonReport(db, "2026-10-26", { day: "2026-10-26" });
    expect(await readComparisonReport(db, "2026-10-26")).toMatchObject({ day: "2026-10-26" });
  });

  it("rollup rewrite for the same day replaces rows (idempotent re-run)", async () => {
    const db = makeDb();
    await ensureResourceRollupTables(db);
    const row = { day: "2026-10-26", ns: "sessions", op: "get", caller: "requireAuth", trigger: "user", ops: 5, rowsRead: 5, rowsWritten: 0 };
    await writeDailyRollup(db, "2026-10-26", [row]);
    await writeDailyRollup(db, "2026-10-26", [{ ...row, ops: 7, rowsRead: 7 }]);
    const rows = await readDailyRollup(db, "2026-10-26");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ops: 7, rowsRead: 7 });
  });
});
