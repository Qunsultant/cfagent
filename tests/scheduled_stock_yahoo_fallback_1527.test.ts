/**
 * Issue #1527: scheduled stock screens fall back to Yahoo when E*TRADE
 * auth is dead — whole-run fallback, clearly labeled, never presented
 * as E*TRADE live. Ruling (Venus, 2026-10-25): scheduled stocks only,
 * auth-dead only; per-element gap-fill stays preferred where it covers
 * the case; reconnecting E*TRADE moots it while the session lives.
 *
 * Contract pins (as amended by #3655 for the scheduled stock path):
 * - A guard-blocked E*TRADE scheduled stock run FAILS LOUD with the
 *   guard's coded error instead of completing via Yahoo — no screen
 *   attempt, no fallback marker, no screener.completed, and the
 *   normal screener.failed event carries the guard error.
 * - A guard-blocked sharded ask likewise fails loud and never
 *   submits a shard chain.
 * - The Yahoo data mode / PDF provenance / bridge-outcome pins
 *   below still hold for the goal-screen stock leg, which keeps the
 *   #1527 behavior under the #4436 explicit mode, and for the mode
 *   wording itself.
 * - A goal-leg mode-run completion emits NO failure notice (no
 *   screener.failed); the mode labeling is the signal. The
 *   guard's deduped episode alert already fired inside the guard.
 * - A mode run that itself fails goes through the normal failure path
 *   (audit + session message + screener.failed).
 * - Deliberate Yahoo runs (provider "yahoo" configured) carry NO
 *   Yahoo data mode; E*TRADE-live runs are unchanged.
 *
 * Supersession note: #1369 pinned "blocked → screener.failed". #1527
 * supersedes that pin for the case where the Yahoo fallback succeeds;
 * stock_preflight_failure_notify_1369.test.ts now pins the fallback-
 * failure case instead (blocked + fallback fails → failed).
 *
 * Supersession note 2 (#3655, 2026-11-07): the whole-run Yahoo
 * fallback is REMOVED from the scheduled stock path
 * (ScheduledTasksService.autonomousMarketScreen) — a guard-blocked
 * run now fails LOUD with the guard's coded error instead of
 * completing via Yahoo. The three fallback-behaviour pins below are
 * re-pinned to that contract. The fallback MARKER machinery itself
 * (PDF provenance lines, bridge outcome) is replaced by the explicit
 * Yahoo data mode in #4436 and stays pinned here in its new form:
 * the goal-screen stock leg still runs under the mode, and the
 * mode wording is shared.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import type { Env } from "../src/types";
import { screenerProvenanceLines } from "../src/trading/screenerReportPdf";
import { screenerOutcomeFromEvent } from "../src/services/screenerFollowups";

const YAHOO_MODE = "full-dataset" as const;

function yahooSuccessResult() {
  return {
    timestamp: new Date().toISOString(),
    trigger: "scheduled",
    provider: "yahoo",
    universe: "TECH",
    sector: "ALL",
    success: true,
    totalScanned: 10,
    expectedCount: 10,
    matchedCount: 2,
    opportunities: [{ symbol: "AAPL" }, { symbol: "MSFT" }],
    allStocks: [],
    discoveryMessage: "",
    filterSummary: "test",
  };
}

describe("scheduled stock Yahoo fallback (#1527)", () => {
  let mockEnv: Env;
  let mockOrm: DatabaseORM;

  beforeEach(() => {
    const mockSql = { exec: vi.fn(() => []) };
    mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
      // Phase 3 (#6550): monetization is ON via
      // environment.config.json; the paid gate fails the run with the
      // price-catalogue error before the auth guard runs, so the
      // guard-blocked pins never see FAILURE_AUTH_NO_SESSION. These
      // tests pin the guard behaviour, not payment, so it stays off.
      MONETIZATION_ENABLED: "false",
    } as unknown as Env;
    mockOrm = new DatabaseORM(mockSql as any);
  });

// Issue #4278: the screen runs through the one engine seam, not the
// agent's runScreen. The seam fake delegates to the stub agent's
// runScreen: it flattens the seam input back into the runScreen
// request (provider/sector ride the spec on the routes, the
// overrides on the scheduled path) and returns the stub's result
// as the engine run's one shard. The seam itself is pinned in
// tests/stock_entry_routing_4278.test.ts.
const delegateSeamFake = (runScreen: (req: any) => Promise<any>) => async (input: any) => {
  const flat = {
    trigger: input.spec.trigger,
    sector: input.commandOverrides?.sector ?? input.spec.filters?.sector,
    universe: input.spec.universe,
    maxSymbols: input.commandOverrides?.maxSymbols,
    filters: input.spec.filters,
    userLogin: input.userLogin,
    environment: input.environment,
    portfolioContext: input.portfolioContext,
    provider: input.commandOverrides?.provider ?? input.spec.provider,
    broker: input.commandOverrides?.broker,
    ...(input.commandOverrides?.mode
      ? { mode: input.commandOverrides.mode, modeSource: input.commandOverrides.modeSource }
      : {}),
  };
  const result = await runScreen(flat);
  return {
    results: [result],
    collation: null,
    jobId: input.spec?.jobId ?? "test-job",
    workflowId: "wf-1",
  };
};

  function fallbackService(runScreenImpl: (req: any) => Promise<any>) {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const publish = vi.fn(async () => {});
    const audit = vi.fn(() => {});
    const runScreen = vi.fn(runScreenImpl);
    (service as any).publishScreenerEvent = publish;
    (service as any).audit = audit;
    (service as any).guardScheduledAuth = async () => ({
      blocked: true,
      error: "⚠️ [FAILURE_AUTH_NO_SESSION] E*TRADE connection missing — scheduled stock screen is blocked.",
    });
    (service as any).getScreenerAgent = () => ({ runScreen });
    (service as any).runStockScreenViaEngine = delegateSeamFake(runScreen);
    return { service, publish, audit, runScreen };
  }

  it("PDF provenance names a full-dataset run as a Yahoo testing mode, not plain Yahoo and never E*TRADE (#4436)", () => {
    const lines = screenerProvenanceLines({
      provider: "yahoo",
      yahooDataMode: YAHOO_MODE,
    } as any);
    expect(lines.quotesLine).toMatch(/Yahoo/);
    expect(lines.quotesLine).toMatch(/full-dataset testing mode/i);
    expect(lines.quotesLine).toMatch(/delayed/);
    expect(lines.quotesLine).not.toMatch(/E\*TRADE live/);
    expect(lines.methodologyQuotes).toMatch(/full-dataset testing mode/i);
    expect(lines.methodologyQuotes).not.toMatch(/No fallback data substituted/);
    // Controls: plain Yahoo and E*TRADE wording are unchanged.
    expect(screenerProvenanceLines({ provider: "yahoo" } as any).quotesLine).toBe(
      "Quotes: Yahoo Finance quotes (delayed)"
    );
    expect(screenerProvenanceLines({ provider: "etrade" } as any).quotesLine).toBe(
      "Quotes: E*TRADE live snapshots"
    );
  });

  // Issue #3655: the #1527 whole-run Yahoo fallback is gone from the
  // scheduled stock path. A guard-blocked run FAILS LOUD with the
  // guard's coded error — it never screens via Yahoo, never carries
  // the fallback marker, and emits the normal failure event.
  it("a guard-blocked run fails loud with the coded guard error and never screens via Yahoo (#3655)", async () => {
    const { service, publish, audit, runScreen } = fallbackService(async () => yahooSuccessResult());
    // Issue #3990: the guard runs only for etrade-provider runs, and
    // the platform default is alpaca now — a bare {} no longer
    // reaches the guard. These tests pin the E*TRADE guard, so the
    // provider is named explicitly.
    const result = await service.autonomousMarketScreen({ provider: "etrade" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("FAILURE_AUTH_NO_SESSION");
    expect(runScreen).not.toHaveBeenCalled();
    const events = publish.mock.calls.map((c) => c[0]);
    expect(events.find((e: any) => e.type === "screener.completed")).toBeUndefined();
    const failed = events.find((e: any) => e.type === "screener.failed");
    expect(failed).toBeDefined();
    expect(failed.error).toContain("FAILURE_AUTH_NO_SESSION");
    expect((result as any).data?.yahooDataMode).toBeUndefined();
    expect(failed.yahooDataMode).toBeUndefined();
    const fallbackAudits = audit.mock.calls.filter((c) => c[0] === "screener.run_fallback");
    expect(fallbackAudits.length).toBe(0);
  });

  // Issue #3655: same fail-loud contract for the sharded ask — the
  // blocked run never submits a shard chain and never falls back to
  // a monolithic Yahoo screen.
  it("a guard-blocked sharded run fails loud and never submits a shard chain (#3655)", async () => {
    const { service, publish, runScreen } = fallbackService(async () => yahooSuccessResult());
    // Issue #4780: the tripwire rides the seam the stock sharded path
    // actually submits through (submitStockScreenViaEngine) — the
    // shardSubmit port is gone.
    const submitStockScreen = vi.fn(async () => ({ jobId: "never", workflowId: "wf-never" }));
    (service as any).submitStockScreenViaEngine = submitStockScreen;
    const result = await service.autonomousMarketScreen({ sharded: true, provider: "etrade" });
    expect(result.success).toBe(false);
    expect(result.error).toContain("FAILURE_AUTH_NO_SESSION");
    expect(submitStockScreen).not.toHaveBeenCalled();
    expect(runScreen).not.toHaveBeenCalled();
    const events = publish.mock.calls.map((c) => c[0]);
    expect(events.find((e: any) => e.type === "screener.completed")).toBeUndefined();
    expect(events.find((e: any) => e.type === "screener.failed")).toBeDefined();
  });

  // Issue #3655: the guard blocks BEFORE any screen attempt, so a
  // Yahoo failure inside the screen is never reached — the failure
  // event carries the guard's coded error, not the Yahoo error, and
  // no completed event is emitted.
  it("a guard-blocked run's failure carries the guard error, never a Yahoo error it never reached (#3655)", async () => {
    const { service, publish, runScreen } = fallbackService(async () => {
      throw new Error("Yahoo quotes unavailable");
    });
    const result = await service.autonomousMarketScreen({ provider: "etrade" });
    expect(result.success).toBe(false);
    expect(runScreen).not.toHaveBeenCalled();
    const events = publish.mock.calls.map((c) => c[0]);
    const failed = events.find((e: any) => e.type === "screener.failed");
    expect(failed).toBeDefined();
    expect(failed.error).toContain("FAILURE_AUTH_NO_SESSION");
    expect(failed.error).not.toContain("Yahoo quotes unavailable");
    expect(events.find((e: any) => e.type === "screener.completed")).toBeUndefined();
  });

  it("an unblocked E*TRADE run carries no fallback marker", async () => {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const publish = vi.fn(async () => {});
    const runScreen = vi.fn(async () => ({
      ...yahooSuccessResult(),
      provider: "etrade",
    }));
    (service as any).publishScreenerEvent = publish;
    (service as any).audit = vi.fn(() => {});
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    (service as any).getScreenerAgent = () => ({ runScreen });
    (service as any).runStockScreenViaEngine = delegateSeamFake(runScreen);
    const result = await service.autonomousMarketScreen({});
    expect(result.success).toBe(true);
    const req = runScreen.mock.calls[0][0];
    expect(req.yahooDataMode).toBeUndefined();
    expect(req.provider).not.toBe("yahoo");
    const completed = publish.mock.calls.map((c) => c[0]).find((e: any) => e.type === "screener.completed");
    expect(completed.yahooDataMode).toBeUndefined();
  });

  it("a deliberately configured Yahoo run carries no fallback marker and skips the guard", async () => {
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const publish = vi.fn(async () => {});
    const runScreen = vi.fn(async () => yahooSuccessResult());
    const guard = vi.fn(async () => ({ blocked: true, error: "must not be consulted" }));
    (service as any).publishScreenerEvent = publish;
    (service as any).audit = vi.fn(() => {});
    (service as any).guardScheduledAuth = guard;
    (service as any).getScreenerAgent = () => ({ runScreen });
    (service as any).runStockScreenViaEngine = delegateSeamFake(runScreen);
    const result = await service.autonomousMarketScreen({ provider: "yahoo" });
    expect(result.success).toBe(true);
    expect(guard).not.toHaveBeenCalled();
    expect(runScreen.mock.calls[0][0].provider).toBe("yahoo");
    expect(runScreen.mock.calls[0][0].yahooDataMode).toBeUndefined();
    const completed = publish.mock.calls.map((c) => c[0]).find((e: any) => e.type === "screener.completed");
    expect(completed.yahooDataMode).toBeUndefined();
  });

  it("the bridge outcome carries the Yahoo data mode on completed events (#4436)", () => {
    const outcome = screenerOutcomeFromEvent({
      type: "screener.completed",
      timestamp: new Date().toISOString(),
      universe: "TECH",
      trigger: "scheduled",
      sector: "ALL",
      totalScanned: 10,
      matchedCount: 2,
      opportunities: [],
      yahooDataMode: YAHOO_MODE,
    } as any);
    expect((outcome as any).yahooDataMode).toBe(YAHOO_MODE);
    const plain = screenerOutcomeFromEvent({
      type: "screener.completed",
      timestamp: new Date().toISOString(),
      universe: "TECH",
      trigger: "scheduled",
      sector: "ALL",
      totalScanned: 10,
      matchedCount: 2,
      opportunities: [],
    } as any);
    expect((plain as any).yahooDataMode).toBeUndefined();
  });
});
