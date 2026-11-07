/**
 * Issue #1999 (Phase 4): stage contracts. Gather gets a first-class
 * failure state (distinct from missing fields), and a lost audit
 * insert warns instead of vanishing.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import { ScheduledTasksService } from "../src/services/scheduledTasks";

const LISTINGS: NasdaqStockListing[] = [
  { symbol: "AAA", companyName: "AAA Corp", exchange: "NASDAQ", lastPrice: 100, change: 1, changePercent: 1 },
  { symbol: "BBB", companyName: "BBB Corp", exchange: "NASDAQ", lastPrice: 100, change: 1, changePercent: 1 },
];

afterEach(() => {
  DynamicMarketScreener.setTestListingsFixture(null);
  vi.restoreAllMocks();
});

describe("stage contracts (#1999)", () => {
  it("a throwing gather hook yields a failed gather state, never a silent leg", async () => {
    DynamicMarketScreener.setTestListingsFixture(LISTINGS);
    const hook = {
      enrich: async () => {
        throw new Error("gather boom");
      },
    };
    const result = await new DynamicMarketScreener().screenLive(
      { momentum: "bullish_breakout" },
      { enrichment: hook as never },
    );
    expect(result.matchedCount).toBe(0);
    expect(result.validationError).toMatch(/gather failed/);
    expect(result.gather).toMatchObject({ status: "failed", error: "gather boom", stored: 0 });
  });

  it("a hook returning no evaluable rows reports gather ok, not failed", async () => {
    DynamicMarketScreener.setTestListingsFixture(LISTINGS);
    const hook = {
      enrich: async () => ({
        runId: "goal-run-11",
        enrichedQuotes: [],
        missingSymbols: ["AAA", "BBB"],
        missingFields: {},
        gapFilledCount: 0,
        routeVersionHash: "abc123",
      }),
    };
    const result = await new DynamicMarketScreener().screenLive(
      { momentum: "bullish_breakout" },
      { enrichment: hook as never },
    );
    expect(result.matchedCount).toBe(0);
    expect(result.gather).toMatchObject({ status: "ok", stored: 0, missing: 2 });
  });

  it("a scheduled audit row carries system principalKind + owner login", () => {
    const rows: Array<{ sessionId?: string; payload?: Record<string, unknown> }> = [];
    const svc = new ScheduledTasksService(
      {} as never,
      { events: { create: (row: { sessionId?: string; payload?: Record<string, unknown> }) => { rows.push(row); } } } as never,
      "alice",
    );
    (svc as unknown as { audit: (t: string, p: Record<string, unknown>) => void }).audit(
      "goal_screen.workflow_submitted",
      { jobId: "goal-screen:manual:alice:income:2026-10-28T00:00:00.000Z" },
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("alice");
    expect(rows[0].payload).toMatchObject({ principalKind: "system" });
  });

  it("IV collection persist failure reports failure instead of success (#1999)", () => {
    const audits: Array<{ type: string }> = [];
    const svc = new ScheduledTasksService(
      {} as never,
      {
        storeCanonicalReport: () => { throw new Error("disk full"); },
        events: { create: (row: { type: string }) => { audits.push(row); } },
      } as never,
      "alice",
    );
    const stored = (svc as unknown as { persistIvCollectionReport: (r: unknown, t: string) => boolean }).persistIvCollectionReport(
      { date: "2026-10-28", recorded: 1, alreadyRecorded: 0, failed: 0, outcomes: [] },
      "2026-10-28T00:00:00.000Z",
    );
    expect(stored).toBe(false);
    expect(audits.find((a) => a.type === "options.iv_collection_persist_failed")).toBeDefined();
  });

  it("IV collection persist success reports stored (#1999)", () => {
    const svc = new ScheduledTasksService(
      {} as never,
      { storeCanonicalReport: () => "iv_collection:2026-10-28", events: { create: () => {} } } as never,
      "alice",
    );
    const stored = (svc as unknown as { persistIvCollectionReport: (r: unknown, t: string) => boolean }).persistIvCollectionReport(
      { date: "2026-10-28", recorded: 1, alreadyRecorded: 0, failed: 0, outcomes: [] },
      "2026-10-28T00:00:00.000Z",
    );
    expect(stored).toBe(true);
  });

  it("a lost audit insert warns with type + login instead of vanishing", () => {
    // #3515 S3: the lost audit insert now travels as a structured
    // scheduledTasks.audit_insertion_failed event (level warn) on the
    // console-info JSON fallback, not a console.warn line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const svc = new ScheduledTasksService(
      {} as never,
      { events: { create: () => { throw new Error("db down"); } } } as never,
      "alice",
    );
    (svc as unknown as { audit: (t: string, p: Record<string, unknown>) => void }).audit(
      "etrade.auth_blocked",
      { userLogin: "alice", kind: "stocks" },
    );
    const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
    for (const call of infoSpy.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0])) as {
          operation?: unknown;
          level?: unknown;
          fields?: unknown;
        };
        if (parsed && typeof parsed.operation === "string") {
          events.push({
            operation: parsed.operation,
            level: typeof parsed.level === "string" ? parsed.level : "",
            fields:
              parsed.fields && typeof parsed.fields === "object"
                ? (parsed.fields as Record<string, unknown>)
                : {},
          });
        }
      } catch {
        // Non-JSON console.info lines are not structured events.
      }
    }
    const failed = events.find((e) => e.operation === "scheduledTasks.audit_insertion_failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("warn");
    expect(failed?.fields.type).toBe("etrade.auth_blocked");
    expect(failed?.fields.userLogin).toBe("alice");
    expect(String(failed?.fields.error ?? "")).toContain("db down");
    infoSpy.mockRestore();
  });
});
