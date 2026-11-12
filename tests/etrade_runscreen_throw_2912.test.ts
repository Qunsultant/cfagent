/**
 * Issue #2912 (G5): the E*TRADE runScreen-throw failure path must
 * persist-then-deliver like the success paths. Issue #4278: the
 * throw under test comes from the engine seam now (the route calls
 * the seam, not the agent) — the failure path itself is unchanged.
 *
 * Before this slice, a runScreen throw (issue #424) published a failure
 * notification from a minimal object and never wrote a canonical row —
 * the failed run was invisible in Reports (screenRunFinalize.ts named
 * it as a known exception: the thrown object "is not a persistable run
 * result"). Pins:
 *  - a runScreen throw produces exactly one canonical failed row AND
 *    one notification, persist before deliver, and the throw still
 *    propagates (the route contract is unchanged);
 *  - the persisted row carries the failed-run shape (success false,
 *    zero counts, empty sets, the thrown error, trigger manual);
 *  - persisting the same failed result twice yields exactly one row
 *    (generationId dedup), so a retry never double-counts;
 *  - the stored failed row reads back as a failed Reports row with
 *    the error in its summary, not as a missing run;
 *  - "already running" (#832) still short-circuits to 429 with no
 *    persist and no notification.
 */
import { describe, it, expect } from "vitest";
import { executeEtradeScreen } from "../src/agents/routes/etradeBrokerScreen";
import { persistScreenerReportCanonical, type ReportDispatchContext } from "../src/agents/orchestrator/reportDispatch";
import { listScheduledReports } from "../src/services/scheduledReports";
import { runSummaryFromReport } from "../src/services/runSummaries";
import { MockSqlStorage } from "./mock-sql";

function routeCtx(
  events: string[],
  persisted: unknown[],
  bridged: unknown[],
  seam: (input: unknown) => Promise<unknown>,
) {
  return {
    env: {},
    readSettingRaw: () => null,
    audit: () => {},
    persistScreenerReportCanonical: async (r: unknown) => {
      events.push("persist");
      persisted.push(r);
    },
    scheduleScreenerFollowups: async (o: unknown) => {
      events.push("deliver");
      bridged.push(o);
    },
    // Issue #4278: the throw under test comes from the engine
    // seam now (the route calls the seam, not the agent).
    runStockScreenViaEngine: seam,
  } as never;
}

const FAILED = {
  timestamp: "2026-11-03T12:00:00.000Z",
  trigger: "manual" as const,
  universe: "TECH",
  sector: "ALL",
  success: false,
  totalScanned: 0,
  matchedCount: 0,
  opportunities: [],
  allStocks: [],
  discoveryMessage: "",
  error: "E*TRADE unavailable",
  userLogin: "alice",
};

describe("E*TRADE runScreen throw (#2912)", () => {
  it("persists one canonical failed row, then delivers, then propagates the throw", async () => {
    const events: string[] = [];
    const persisted: unknown[] = [];
    const bridged: unknown[] = [];
    // The agent is the seam's gates + read-back; the fake seam below throws instead.
    const agent = {} as never;
    await expect(
      executeEtradeScreen({
        ctx: routeCtx(events, persisted, bridged, async () => {
          throw new Error("E*TRADE unavailable");
        }),
        sessionId: "s1",
        requestedEnv: "TEST",
        userLogin: "alice",
        agent,
        universe: "TECH",
        validatedFilters: {},
      }),
    ).rejects.toThrow("E*TRADE unavailable");

    expect(events).toEqual(["persist", "deliver"]);
    expect(persisted).toHaveLength(1);
    const row = persisted[0] as Record<string, unknown>;
    expect(row.success).toBe(false);
    expect(row.error).toBe("E*TRADE unavailable");
    expect(row.totalScanned).toBe(0);
    expect(row.matchedCount).toBe(0);
    expect(row.opportunities).toEqual([]);
    expect(row.allStocks).toEqual([]);
    expect(row.universe).toBe("TECH");
    expect(row.trigger).toBe("manual");
    expect(row.userLogin).toBe("alice");
    expect(bridged).toHaveLength(1);
  });

  it("already running still short-circuits to 429 with no persist and no notification", async () => {
    const events: string[] = [];
    const persisted: unknown[] = [];
    const bridged: unknown[] = [];
    const agent = {} as never;
    const res = await executeEtradeScreen({
      ctx: routeCtx(events, persisted, bridged, async () => {
        throw new Error("screen already running for this account");
      }),
      sessionId: "s1",
      requestedEnv: "TEST",
      userLogin: "alice",
      agent,
      universe: "TECH",
      validatedFilters: {},
    });
    expect(res.status).toBe(429);
    expect(events).toEqual([]);
    expect(persisted).toHaveLength(0);
    expect(bridged).toHaveLength(0);
  });

  it("persisting the same failed result twice yields exactly one canonical row", async () => {
    const sql = new MockSqlStorage() as never;
    const ctx = {
      env: {},
      ensureTables: () => sql,
      getOrm: () => {
        throw new Error("screener persist must not use the ORM");
      },
      reportDispatchHitlKey: "report_dispatch_hitl",
      reportConfirmationTtlMs: 86_400_000,
    } as unknown as ReportDispatchContext;
    await persistScreenerReportCanonical(ctx, { ...FAILED });
    await persistScreenerReportCanonical(ctx, { ...FAILED });
    const hits = listScheduledReports(sql as never, { userLogin: "alice" });
    expect(hits).toHaveLength(1);
    expect(hits[0].runId).toBe("screener:2026-11-03T12:00:00.000Z");
  });

  it("the stored failed row reads back as a failed Reports row with the error", async () => {
    const sql = new MockSqlStorage() as never;
    const ctx = {
      env: {},
      ensureTables: () => sql,
      getOrm: () => {
        throw new Error("screener persist must not use the ORM");
      },
      reportDispatchHitlKey: "report_dispatch_hitl",
      reportConfirmationTtlMs: 86_400_000,
    } as unknown as ReportDispatchContext;
    await persistScreenerReportCanonical(ctx, { ...FAILED });
    const hits = listScheduledReports(sql as never, { userLogin: "alice" });
    expect(hits).toHaveLength(1);
    const summary = runSummaryFromReport(hits[0]);
    expect(summary.status).toBe("failed");
    expect(summary.summary).toContain("E*TRADE unavailable");
    expect(summary.reportId).toBe(hits[0].id);
  });
});
