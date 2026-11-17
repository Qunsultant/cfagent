/**
 * #920 ([#913 S2]): NLQ relative limit orders ("% below/above market") must
 * price off a LIVE E*TRADE quote or be refused — never off the static
 * curated `defaultPrice` table.
 *
 * Before this fix, `extractOrderParameters` derived the limit price from
 * `curatedStockUniverse.defaultPrice` with no live quote and no provenance
 * label, and execution silently fell back to that static-derived price
 * whenever the quote lookup did not produce a usable live price.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeService } from "../src/services/etrade";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { planNLQ, executeNLQQuery, executeNLQQueryAsync, extractOrderParameters } from "../src/agents/nlq";
import type { Env, ETradeQuote } from "../src/types";

const liveEnv: Env = {
  APP_BASE_URL: "https://agent.openaimp.com",
  ETRADE_ENVIRONMENT: "live",
  // Issue #5147: this suite pins the E*TRADE quote path, so the selection is
  // explicit — the no-selection default is the platform default (Alpaca).
  TENANT_BROKER_ID: "etrade",
} as Env;

// JPM is in the curated universe (static defaultPrice) — the symbol whose
// relative order used to be priced straight off the static table.
const CURATED_ONLY = "JPM";

function liveQuote(symbol: string, lastPrice: number): ETradeQuote {
  return {
    symbol,
    companyName: "Live Corp",
    lastPrice,
    price: lastPrice,
    change: 1,
    changePercent: 0.2,
    bid: lastPrice - 0.05,
    ask: lastPrice + 0.05,
    volume: 1000,
    open: lastPrice,
    high: lastPrice,
    low: lastPrice,
    week52High: lastPrice * 1.1,
    week52Low: lastPrice * 0.9,
    quoteStatus: "REALTIME",
    source: "E*TRADE REST API [PROD / Live]",
    timestamp: new Date().toISOString(),
  };
}

describe("#920 NLQ relative pricing provenance", () => {
  let orm: DatabaseORM;
  const sessionId = "nlq_relative_pricing_session";

  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    orm = new DatabaseORM(new MockSqlStorage());
    orm.initializeSchema(sessionId);
  });

  afterEach(() => {
    DynamicMarketScreener.setTestUniverseFixture([]);
    vi.restoreAllMocks();
  });

  it("parser records the offset but derives NO price from the static table", () => {
    const order = extractOrderParameters(`buy 10 shares of ${CURATED_ONLY} at 5% below market price`);
    expect(order).not.toBeNull();
    expect(order?.relativePriceOffsetPercent).toBe(-5);
    expect(order?.orderType).toBe("LIMIT");
    expect(order?.limitPrice).toBeUndefined();
  });

  it("source pin: orderParams.ts carries no static-price derivation", () => {
    const src = readFileSync("src/agents/nlq/orderParams.ts", "utf8");
    expect(src).not.toContain("curated?.defaultPrice");
    expect(src).not.toMatch(/defaultPrice\s*\*/);
    expect(src).not.toMatch(/defaultPrice\s*\)/);
  });

  // #922 ([#913 S4]) supersedes the STATIC_FALLBACK refusal row: in the
  // live env the sync service quote for JPM now FAILS EXPLICIT before any
  // draft is created, so the relative order is refused by exception — still
  // no draft, still no static-derived price.
  it("sync execution REFUSES a relative order when no live quote exists (fails explicit, #922)", async () => {
    const plan = await planNLQ(liveEnv, `buy 10 shares of ${CURATED_ONLY} at 5% below market price`);
    expect(plan.tradingData?.action).toBe("preview_order");
    expect(plan.tradingData?.relativePriceOffsetPercent).toBe(-5);
    expect(() => executeNLQQuery(orm, sessionId, plan, liveEnv)).toThrow(/live quote unavailable/i);
  });

  it("sync execution prices a relative order off the LIVE quote when one exists", async () => {
    vi.spyOn(ETradeService.prototype, "getQuote").mockReturnValue(liveQuote(CURATED_ONLY, 200));
    const plan = await planNLQ(liveEnv, `buy 10 shares of ${CURATED_ONLY} at 5% below market price`);
    const result = executeNLQQuery(orm, sessionId, plan, liveEnv);
    expect(result.count).toBe(1);
    // 5% below the live $200.00 quote = $190.00 — NOT 5% below any static price.
    expect(result.summary).toContain("190.00");
  });

  it("async execution REFUSES a relative order when the remote quote is a static fallback", async () => {
    vi.spyOn(ETradeService.prototype, "fetchQuoteRemote").mockResolvedValue({
      ...liveQuote(CURATED_ONLY, 222),
      quoteStatus: "STATIC_FALLBACK",
      source: "Curated universe static price (no live E*TRADE response)",
    });
    const plan = await planNLQ(liveEnv, `buy 10 shares of ${CURATED_ONLY} at 5% below market price`);
    const result = await executeNLQQueryAsync(orm, sessionId, plan, liveEnv, "test-user");
    expect(result.count).toBe(0);
    expect(result.rows).toHaveLength(0);
    expect(result.summary).toMatch(/live E\*TRADE quote/i);
  });

  it("async execution prices a relative order off the LIVE remote quote", async () => {
    vi.spyOn(ETradeService.prototype, "fetchQuoteRemote").mockResolvedValue(liveQuote(CURATED_ONLY, 300));
    // #922: previewOrderRemote re-fetches via the platform quote path,
    // which no longer serves a curated static fallback in the live env.
    // The scenario under test is "a live quote exists", so that seam
    // returns the same live quote rather than a static fallback.
    vi.spyOn(ETradeTradingPlatform.prototype, "getQuote").mockResolvedValue(liveQuote(CURATED_ONLY, 300));
    const plan = await planNLQ(liveEnv, `buy 10 shares of ${CURATED_ONLY} at 10% above market price`);
    const result = await executeNLQQueryAsync(orm, sessionId, plan, liveEnv, "test-user");
    expect(result.count).toBe(1);
    // 10% above the live $300.00 quote = $330.00.
    expect(result.summary).toContain("330.00");
  });
});
