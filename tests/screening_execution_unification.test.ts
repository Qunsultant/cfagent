/**
 * Issue #982 (screening consolidation S2) — one execution path.
 *
 * Pins:
 *  (i)   an NLQ options screen executes through UnifiedOptionsService and
 *        persists a canonical mas_reports run (source "options_scanner",
 *        entry-point provenance trigger "nlq"), retrievable through the
 *        reports read path (listScheduledReports — the function the
 *        reports routes serve from);
 *  (ii)  an NLQ stock screen, when the stock-screen port is threaded,
 *        runs through the port (the ScreenerAgent service seam) and
 *        persists a canonical mas_reports run (source "screener",
 *        trigger "nlq") retrievable the same way; the watchlist_save
 *        fallback screen uses the port too;
 *  (iii) premium /premium/options-scan executes through
 *        UnifiedOptionsService (spy seam) with its response body and
 *        canonical persistence unchanged; the MCP paid_options_screener
 *        tool likewise executes through the service;
 *  (iv)  schedule update validates a newly supplied payload through the
 *        S1 schema builder — invalid payloads are rejected with the
 *        field-named error, valid ones keep the schedule's existing
 *        identity (never the caller's), and timing-only or
 *        non-screening updates pass through untouched;
 *  (v)   no options engine is constructed directly in the NLQ execution
 *        layer, the premium routes, or the MCP payment commands
 *        (grep-verifiable acceptance criterion of #982).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import { readFileSync } from "node:fs";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { planNLQ, executeNLQQueryAsync } from "../src/agents/nlq";
import type { NLQPlan } from "../src/agents/nlq";
import type { NLQStockScreenPort } from "../src/agents/nlq";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { listScheduledReports } from "../src/services/scheduledReports";
import { handlePremiumRoutes, type PremiumRouteContext } from "../src/agents/routes/premium";
import { ETradeAgenticPaymentService } from "../src/services/agenticPayments";
import { PaidOptionsScreenerCommand } from "../src/mcps/openaimp/agenticPaymentCommands";
import { resolveScheduleUpdate } from "../src/services/scheduleManagement";
import type { Env } from "../src/types";

const mockEnv = {
  ETRADE_API_KEY: "synthetic-test-key",
  ETRADE_API_SECRET: "synthetic-test-secret",
  ETRADE_ENV: "SANDBOX",
  ETRADE_ACCOUNT_ID: "00000000",
} as unknown as Env;

function nvdaChainFixture() {
  const expiryDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const quoteTimestamp = Date.now();
  return {
    NVDA: {
      symbol: "NVDA",
      underlyingPrice: 100,
      selectedExpiry: {
        year: expiryDate.getUTCFullYear(),
        month: expiryDate.getUTCMonth() + 1,
        day: expiryDate.getUTCDate(),
      },
      pairs: [
        {
          call: {
            timeStamp: quoteTimestamp,
            adjustedFlag: false,
            optionType: "CALL",
            strikePrice: 100,
            symbol: "NVDATESTC100",
            bid: 2,
            ask: 2.2,
            lastPrice: 2.1,
            volume: 500,
            openInterest: 1000,
            delta: 0.52,
            gamma: 0.04,
            theta: -0.06,
            impliedVolatility: 0.38,
          },
          put: {
            timeStamp: quoteTimestamp,
            adjustedFlag: false,
            optionType: "PUT",
            strikePrice: 100,
            symbol: "NVDATESTP100",
            bid: 2,
            ask: 2.2,
            lastPrice: 2.1,
            volume: 400,
            openInterest: 900,
            delta: 0.48,
            gamma: 0.04,
            theta: -0.05,
            impliedVolatility: 0.4,
          },
        },
      ],
    },
  } as never;
}

describe("#982 S2: one execution path for NLQ / MCP / premium", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;

  beforeEach(() => {
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql as never);
    DynamicOptionsScreener.setTestChainsFixture(nvdaChainFixture());
  });

  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
    vi.restoreAllMocks();
  });

  it("(i) NLQ options screen runs through the service and persists a canonical run", async () => {
    const executeSpy = vi.spyOn(UnifiedOptionsService.prototype, "execute");
    const plan = await planNLQ(mockEnv, "Screen call options for NVDA with delta over 0.40");
    expect(plan.tradingData?.action).toBe("options_screen");

    const res = await executeNLQQueryAsync(orm, "trader_user", plan, mockEnv, "trader_user");
    expect(res.targetTable).toBe("etrade_options_screener");
    expect(res.count).toBeGreaterThan(0);

    // Execution went through UnifiedOptionsService with a screen action.
    const screenCalls = executeSpy.mock.calls.filter((c) => (c[0] as { action?: string })?.action === "screen");
    expect(screenCalls.length).toBeGreaterThanOrEqual(1);

    // The canonical run is in mas_reports and retrievable via the
    // reports read path, with entry-point provenance recorded.
    const reports = listScheduledReports(sql as never, { sourceFilter: "options_scanner" });
    expect(reports).toHaveLength(1);
    expect(reports[0].title).toContain("NVDA");
    const body = JSON.parse(reports[0].body || "{}");
    expect(body.trigger).toBe("nlq");
    expect(body.result.contracts.length).toBe(res.count);
  });

  it("(ii) NLQ stock screen runs through the stock-screen port and persists a canonical run", async () => {
    const run = {
      timestamp: "2026-10-22T07:30:00.000Z",
      universe: "NASDAQ100",
      sector: "ALL",
      success: true,
      totalScanned: 3,
      matchedCount: 2,
      filterSummary: "minPrice >= 10",
      discoveryMessage: "",
      allStocks: [
        { symbol: "ACME", companyName: "Acme Corp", sector: "Technology", lastPrice: 50, changePercent: 2.5, source: "E*TRADE" },
        { symbol: "BETA", companyName: "Beta Inc", sector: "Finance", lastPrice: 20, changePercent: -1, source: "E*TRADE" },
        { symbol: "GAMM", companyName: "Gamma LLC", sector: "Health", lastPrice: 5, changePercent: 0.5, source: "E*TRADE" },
      ],
      opportunities: [{ symbol: "ACME" }],
    };
    const runScreen = vi.fn(async () => run);
    const port: NLQStockScreenPort = { runScreen };

    const plan = {
      domain: "trading",
      operation: "screen",
      tradingData: { action: "screen", filters: { minPrice: 10 } },
    } as unknown as NLQPlan;

    const res = await executeNLQQueryAsync(orm, "trader_user", plan, mockEnv, "trader_user", undefined, { stockScreenPort: port });

    // The port (ScreenerAgent service seam) received the validated
    // filters and the caller's login.
    expect(runScreen).toHaveBeenCalledTimes(1);
    expect(runScreen.mock.calls[0][0].filters).toMatchObject({ minPrice: 10 });
    expect(runScreen.mock.calls[0][0].userLogin).toBe("trader_user");

    // The envelope is built from the service run.
    expect(res.status).toBe("matches_found");
    expect(res.count).toBe(2);
    expect(res.rows).toHaveLength(3);
    expect(res.rows[0].symbol).toBe("ACME");
    expect(res.rows[0].price).toBe("$50.00");

    // The canonical run persisted with screener provenance + nlq trigger.
    const reports = listScheduledReports(sql as never, { sourceFilter: "screener" });
    expect(reports).toHaveLength(1);
    expect(reports[0].title).toContain("NASDAQ100");
    const body = JSON.parse(reports[0].body || "{}");
    expect(body.trigger).toBe("nlq");
    expect(body.matchedCount).toBe(2);
    expect(body.totalScanned).toBe(3);
  });

  it("(ii-b) NLQ watchlist_save fallback screen uses the stock-screen port", async () => {
    const runScreen = vi.fn(async () => ({
      timestamp: "2026-10-22T07:31:00.000Z",
      universe: "NASDAQ100",
      sector: "ALL",
      success: true,
      totalScanned: 2,
      matchedCount: 2,
      filterSummary: "",
      discoveryMessage: "",
      allStocks: [],
      opportunities: [{ symbol: "ACME" }, { symbol: "BETA" }],
    }));
    const port: NLQStockScreenPort = { runScreen };
    const plan = {
      domain: "trading",
      operation: "watchlist_save",
      tradingData: { action: "watchlist_save", watchlistName: "Port Picks", symbols: [] },
    } as unknown as NLQPlan;

    const res = await executeNLQQueryAsync(orm, "trader_user", plan, mockEnv, "trader_user", undefined, { stockScreenPort: port });
    expect(runScreen).toHaveBeenCalledTimes(1);
    expect(res.targetTable).toBe("mas_watchlists");
    expect(res.rows[0].status).toBe("SAVED");
    expect(String(res.rows[0].symbols)).toContain("ACME");
    expect(String(res.rows[0].symbols)).toContain("BETA");
  });

  it("(iii) premium options-scan executes through UnifiedOptionsService; body + persistence unchanged", async () => {
    const executeSpy = vi.spyOn(UnifiedOptionsService.prototype, "execute");
    // Drive the gated endpoint straight to fulfillment (payment
    // gating itself is pinned by the agentic-payments suites).
    vi.spyOn(ETradeAgenticPaymentService.prototype, "handleGatedEndpoint").mockImplementation(
      async (_req: unknown, _resource: unknown, _price: unknown, _desc: unknown, fulfill: unknown) => {
        const out = await (fulfill as (receipt: unknown) => Promise<unknown>)({
          payer: "0xSYNTHETIC_PAYER",
          receiptId: "synthetic-receipt",
        });
        return Response.json(out as Record<string, unknown>);
      }
    );
    const ctx: PremiumRouteContext = { env: mockEnv, getOrm: () => orm };
    const request = new Request("https://agent.internal/api/premium/options-scan?symbol=NVDA", { method: "GET" });
    const response = await handlePremiumRoutes(request, new URL(request.url), "/api/premium/options-scan", "session-1", ctx);
    expect(response).not.toBeNull();
    const body = (await response!.json()) as Record<string, unknown>;

    // Executed through the service, screen action, caller's symbols.
    expect(executeSpy).toHaveBeenCalledTimes(1);
    const serviceReq = executeSpy.mock.calls[0][0] as { action?: string; symbols?: string[] };
    expect(serviceReq.action).toBe("screen");
    expect(serviceReq.symbols).toEqual(["NVDA"]);

    // Response body contract unchanged: the screenResult IS the
    // service's screen data.
    expect(body.success).toBe(true);
    expect(body.service).toBeDefined();
    const serviceData = (await executeSpy.mock.results[0].value).data;
    expect(body.screenResult).toEqual(serviceData);
    expect((body.screenResult as { matchedCount: number }).matchedCount).toBeGreaterThan(0);

    // Canonical persistence still happens in the route, as before.
    const reports = listScheduledReports(sql as never, { sourceFilter: "options_scanner" });
    expect(reports).toHaveLength(1);
    expect(reports[0].title).toContain("NVDA");
  });

  it("(iii-b) MCP paid_options_screener executes through UnifiedOptionsService", async () => {
    const executeSpy = vi.spyOn(UnifiedOptionsService.prototype, "execute");
    vi.spyOn(ETradeAgenticPaymentService.prototype, "verifyPayment").mockResolvedValue({
      valid: true,
      receipt: { receiptId: "synthetic-receipt", txHash: "0xsynthetic" },
    } as never);
    const cmd = new PaidOptionsScreenerCommand();
    const out = (await cmd.execute(
      { underlying: "NVDA", contractType: "CALL", paymentSignature: "synthetic-signature" },
      { env: mockEnv, orm, sessionId: "mcp-session", audit: vi.fn() } as never
    )) as Record<string, unknown>;

    expect(executeSpy).toHaveBeenCalledTimes(1);
    expect((executeSpy.mock.calls[0][0] as { action?: string }).action).toBe("screen");
    expect(out.status).toBe(200);
    expect(out.paid).toBe(true);
    expect(Array.isArray(out.contracts)).toBe(true);
    expect(out.matchesCount).toBeGreaterThan(0);
  });

  it("(iv) schedule update validates new payloads through the S1 builder", () => {
    const current = {
      type: "cron" as const,
      cron: "0 9 * * 1",
      callback: "autonomousMarketScreen",
      payload: { universe: "NASDAQ100", maxItems: 10, userLogin: "trader1", trigger: "scheduled" },
    };

    // Invalid: maxItems of the wrong type -> the S1 field-named error.
    const badMax = resolveScheduleUpdate(current, { payload: { universe: "NASDAQ100", maxItems: "ten" } }, Date.now());
    expect(badMax.ok).toBe(false);
    if (!badMax.ok) expect(badMax.error).toContain("maxItems");

    // Invalid: a mis-typed nested filter names the field.
    const badFilter = resolveScheduleUpdate(
      current,
      { payload: { universe: "NASDAQ100", filters: { minPeRatio: "high" } } },
      Date.now()
    );
    expect(badFilter.ok).toBe(false);
    if (!badFilter.ok) expect(badFilter.error).toContain("minPeRatio");

    // Valid update: criteria apply; identity comes from the EXISTING
    // schedule, never from the caller's payload.
    const good = resolveScheduleUpdate(
      current,
      { payload: { universe: "SP500", maxItems: 25, userLogin: "someone-else" } },
      Date.now()
    );
    expect(good.ok).toBe(true);
    if (good.ok) {
      const payload = good.payload as Record<string, unknown>;
      expect(payload.universe).toBe("SP500");
      expect(payload.maxItems).toBe(25);
      expect(payload.userLogin).toBe("trader1");
      expect(payload.trigger).toBe("scheduled");
    }

    // Timing-only update: payload is not re-validated or rewritten
    // (legacy payloads stay updatable).
    const timingOnly = resolveScheduleUpdate(current, { intervalSeconds: 3600 }, Date.now());
    expect(timingOnly.ok).toBe(true);
    if (timingOnly.ok) expect(timingOnly.payload).toEqual(current.payload);

    // Non-screening callbacks: payload passes through unvalidated.
    const other = resolveScheduleUpdate(
      { type: "cron" as const, cron: "0 9 * * 1", callback: "expireStaleOrderDraft", payload: { anything: true } },
      { payload: { maxItems: "not-a-screening-field" } },
      Date.now()
    );
    expect(other.ok).toBe(true);
    if (other.ok) expect(other.payload).toEqual({ maxItems: "not-a-screening-field" });
  });

  it("(v) no direct engine construction remains in the NLQ layer, premium routes, or MCP commands", () => {
    const engineConstruction = /new\s+(DynamicOptionsScreener|OpportunityScanner)\s*\(/;
    for (const rel of [
      "src/agents/nlq/execution.ts",
      "src/agents/nlqOptionsStrategy.ts",
      "src/agents/routes/premium.ts",
      "src/mcps/openaimp/agenticPaymentCommands.ts",
    ]) {
      const text = readFileSync(rel, "utf8");
      expect(engineConstruction.test(text), `${rel} must not construct an options engine directly`).toBe(false);
    }
    // The execution layer routes through the unified service.
    expect(readFileSync("src/agents/nlq/execution.ts", "utf8")).toContain("new UnifiedOptionsService(");
    expect(readFileSync("src/agents/routes/premium.ts", "utf8")).toContain("new UnifiedOptionsService(");
  });
});
