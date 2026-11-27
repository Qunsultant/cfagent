/**
 * Issue #1999 (Phase 4): stage contracts. Gather gets a first-class
 * failure state (distinct from missing fields), and a lost audit
 * insert warns instead of vanishing.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { MockD1Database } from "./mock-d1";
import {
  createD1AuditEventDb,
  D1AuditEventStore,
} from "../src/data/d1AuditEventAdapter";

/**
 * #6102: a D1 that works everywhere EXCEPT the audit chain's
 * tail-hash read — the one read the store performs through
 * `db.all()`, whose `prepare()` throw propagates RAW (drizzle's
 * `run()` path would wrap it in a "Failed query" message and lose
 * the cause). The schema ensure still succeeds on the real mock
 * underneath, so the failure surfaces from the insert path as
 * `code dml.d1.mas_events.read_tail_hash: db down` — the lost
 * audit insert the warn must name.
 */
function tailHashFailingD1(message: string): unknown {
  const real = new MockD1Database();
  return {
    prepare: (sql: string) => {
      if (/SELECT event_hash FROM mas_events/i.test(sql)) {
        throw new Error(message);
      }
      return real.prepare(sql);
    },
    batch: (statements: unknown[]) => real.batch(statements as never[]),
  };
}

/** #6102: the service's audit() is sync fire-and-forget into D1 —
// poll briefly until the row lands instead of asserting a race. */
async function pollAuditEvents(store: D1AuditEventStore, type: string, expected = 1) {
  let rows: Awaited<ReturnType<D1AuditEventStore["findMany"]>> = [];
  for (let i = 0; i < 50; i++) {
    rows = await store.findMany({ where: { type } });
    if (rows.length >= expected) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  return rows;
}

function auditPayload(row: { payload: unknown }) {
  return typeof row.payload === "string" ? JSON.parse(row.payload) : row.payload;
}

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

  it("a scheduled audit row carries system principalKind + owner login", async () => {
    // #6102: the service's audit() writes to D1 now (the fake ORM
    // events repo is dead) — bind a fresh mock AGENT_DB per test.
    const d1Mock = new MockD1Database();
    const d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
    const svc = new ScheduledTasksService(
      { AGENT_DB: d1Mock } as never,
      {} as never,
      "alice",
    );
    (svc as unknown as { audit: (t: string, p: Record<string, unknown>) => void }).audit(
      "goal_screen.workflow_submitted",
      { jobId: "goal-screen:manual:alice:income:2026-10-28T00:00:00.000Z" },
    );
    const rows = await pollAuditEvents(d1Store, "goal_screen.workflow_submitted");
    expect(rows).toHaveLength(1);
    expect(rows[0].sessionId).toBe("alice");
    expect(auditPayload(rows[0])).toMatchObject({ principalKind: "system" });
  });

  it("IV collection persist failure reports failure instead of success (#1999)", async () => {
    // #6102: the persist-failure audit writes to D1 now.
    const d1Mock = new MockD1Database();
    const d1Store = new D1AuditEventStore(createD1AuditEventDb(d1Mock as never));
    const svc = new ScheduledTasksService(
      { AGENT_DB: d1Mock } as never,
      {
        storeCanonicalReport: () => { throw new Error("disk full"); },
      } as never,
      "alice",
    );
    const stored = await (svc as unknown as { persistIvCollectionReport: (r: unknown, t: string) => Promise<boolean> }).persistIvCollectionReport(
      { date: "2026-10-28", recorded: 1, alreadyRecorded: 0, failed: 0, outcomes: [] },
      "2026-10-28T00:00:00.000Z",
    );
    expect(stored).toBe(false);
    const audits = await pollAuditEvents(d1Store, "options.iv_collection_persist_failed");
    expect(audits.find((a) => a.type === "options.iv_collection_persist_failed")).toBeDefined();
  });

  it("IV collection persist success reports stored (#1999)", async () => {
    const svc = new ScheduledTasksService(
      {} as never,
      { storeCanonicalReport: () => "iv_collection:2026-10-28", events: { create: () => {} } } as never,
      "alice",
    );
    const stored = await (svc as unknown as { persistIvCollectionReport: (r: unknown, t: string) => Promise<boolean> }).persistIvCollectionReport(
      { date: "2026-10-28", recorded: 1, alreadyRecorded: 0, failed: 0, outcomes: [] },
      "2026-10-28T00:00:00.000Z",
    );
    expect(stored).toBe(true);
  });

  it("a lost audit insert warns with type + login instead of vanishing", async () => {
    // #3515 S3: the lost audit insert now travels as a structured
    // scheduledTasks.audit_insertion_failed event (level warn) on the
    // console-info JSON fallback, not a console.warn line.
    // #6102: the D1 write path is exercised with a throwing D1, so
    // the service's audit() catch — not a null port's silent skip —
    // is what warns.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const svc = new ScheduledTasksService(
      { AGENT_DB: tailHashFailingD1("db down") } as never,
      {} as never,
      "alice",
    );
    (svc as unknown as { audit: (t: string, p: Record<string, unknown>) => void }).audit(
      "etrade.auth_blocked",
      { userLogin: "alice", kind: "stocks" },
    );
    // The audit() helper is sync fire-and-forget — poll the spy
    // until the warn lands instead of asserting a race.
    let failed: { operation: string; level: string; fields: Record<string, unknown> } | undefined;
    for (let i = 0; i < 50 && !failed; i++) {
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
      failed = events.find((e) => e.operation === "scheduledTasks.audit_insertion_failed");
      if (!failed) await new Promise((r) => setTimeout(r, 20));
    }
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("warn");
    expect(failed?.fields.type).toBe("etrade.auth_blocked");
    expect(failed?.fields.userLogin).toBe("alice");
    expect(String(failed?.fields.error ?? "")).toContain("db down");
    infoSpy.mockRestore();
  });
});
