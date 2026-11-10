/**
 * #1727 (parent #1717, slice (g)): Market-data MCP vs REST unification —
 * SEVEN runtime config switches over the scan appendix (g) pairs
 * (F01–F05), one per pair, resolved in src/config/marketDataModes.ts.
 *
 * RED pins (written BEFORE the implementation; the first run must
 * fail on the missing module). Both modes are pinned per pair:
 * the default (per-surface legacy — MCP surface keeps MCP behavior,
 * REST surfaces keep REST behavior, exactly the #1726 accepted
 * interpretation of the identical standing-rule text) AND the
 * switched mode, plus fail-closed on invalid values.
 *
 * Switches (values case-insensitive, whitespace ignored):
 * - MARKET_DATA_QUOTE_MODE: "mcp" | "rest" (F01 quote)
 * - MARKET_DATA_FUNDAMENTALS_MODE: "mcp" | "rest" (F01 fundamentals)
 * - MARKET_DATA_RESEARCH_MODE: "mcp" | "rest" (F01 research; audit-name
 *   decision recorded: the REST spelling `market_data.research_generated`
 *   is the canonical spelling for new consumers — it matches the
 *   past-tense underscore convention of the whole /market-data *_queried
 *   family — while the MCP spelling `market_data.research.generated`
 *   stays available under mode=mcp; neither spelling is deleted)
 * - MARKET_DATA_BARS_MODE: "mcp" | "rest" (F02 bars)
 * - MARKET_DATA_SNAPSHOT_MODE: "mcp" | "rest" (F03 snapshot)
 * - ALPACA_READS_MODE: "mcp" | "rest" | "none" (F04 reads;
 *   three-way: MCP *.query vs /market-data *_queried vs /trading silence.
 *   Defaults: MCP→mcp, /market-data→rest, /trading→none, so #1733 (m)
 *   keeps full freedom over the REST-twin default — this slice
 *   wires the lever, it does not pre-decide the twin question)
 * - ALPACA_ORDER_MODE: "mcp" | "market-data" | "trading" (F05 place
 *   order; three-way normalization + audit. Defaults: MCP→mcp,
 *   /market-data→market-data, /trading→trading)
 *
 * Resolution order (owner directive 2026-10-26):
 *   run (MCP input `mode` / REST query `?mode=` / body `mode`)
 *   > session > user (optional `scopedMarketDataModes` carriers)
 *   > global env > built-in (per-surface legacy).
 * First non-blank level wins; an unrecognized winning value FAILS
 * CLOSED to the surface legacy, console-logged + audited as
 * `market_data.config_error` (no fall-through).
 *
 * Scan-vs-code corrections pinned here (appendix (g) was written
 * against an older tree; current main governs):
 * - MCP quote/fundamentals DO audit today (market_data.quote.fetched /
 *   market_data.fundamentals.fetched) — the appendix claim that MCP
 *   audits "snapshot/bars/research but not quote/fundamentals"
 *   is stale; the audit-presence divergence is REST-silence vs
 *   MCP-audit, not MCP-inconsistency.
 * - MCP orders status DOES default to open today (zod default +
 *   execute `|| "open"` + service default) — the scan's "no
 *   default" claim is stale; status default is pinned, not
 *   switched, and is open in every mode on every surface.
 * - MCP account/positions/orders audit payloads are IDENTICAL to
 *   the /market-data *_queried payloads — F04's divergence is the event
 *   NAME (+ /trading silence), not the payload.
 * - MarketDataResearchService.getHistoricalBars defaults provider to
 *   yfinance — MCP's 3-arg call and REST's explicit default
 *   already agree on the VALUE; F02's divergence is the provider
 *   OVERRIDE + envelope + audit, not the default value.
 *
 * No endpoint is removed, no code path is deleted. Alpaca order
 * placement carries no HITL gate on either surface today; this
 * slice neither adds nor weakens one — the order switch changes
 * input normalization + audit only, never the service call's
 * placement semantics, and no switch value can disable an
 * enforcement (there is none on this path to disable).
 *
 * #1906: canonical order-mode value is "market-data"; the legacy
 * "foss" value is accepted as a deprecated alias input (same
 * normalization + audit). Canonical env vars are MARKET_DATA_*_MODE
 * / ALPACA_*_MODE; a legacy FOSS_*_MODE var is honored only when
 * the canonical var is unset or empty, and a non-blank canonical
 * value always wins (even when invalid, so misconfiguration still
 * fails closed). Alias removal is a follow-up slice.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/services/marketDataResearch", () => {
  const fns = {
    getQuote: vi.fn(async (symbol: string, provider?: string) => ({
      symbol,
      price: 195.5,
      provider: provider || "hybrid",
      provenance: "live",
    })),
    getFundamentals: vi.fn(async (symbol: string) => ({
      symbol,
      marketCap: 1000,
      peTrailing: 25,
      provenance: "live",
    })),
    getHistoricalBars: vi.fn(async (symbol: string, _tf: string, _limit: number, provider?: string) => {
      (fns as any).__lastBarsArgs = [symbol, _tf, _limit, provider];
      return [{ t: 1, c: 100, provenance: "live" }];
    }),
    generateResearchReport: vi.fn(async (symbol: string) => ({
      symbol,
      analystRating: "buy",
      agentAttestation: { did: "did:test:123" },
      provenance: "live",
    })),
    getAlpacaSnapshot: vi.fn(async (symbol: string) => ({
      symbol,
      assetClass: "us_equity",
      latestTrade: { price: 195.5 },
      latestQuote: { bidPrice: 195.0, askPrice: 196.0 },
      provenance: "live",
    })),
    getAlpacaAccount: vi.fn(async () => ({
      success: true,
      account: { id: "acc1", buying_power: 10000, portfolio_value: 50000 },
    })),
    getAlpacaPositions: vi.fn(async () => ({
      success: true,
      positions: [{ symbol: "NVDA" }],
    })),
    getAlpacaOrders: vi.fn(async (status?: string) => {
      (fns as any).__lastOrdersStatus = status;
      return { success: true, orders: [{ id: "o1" }] };
    }),
    placeAlpacaOrder: vi.fn(async (params: any) => {
      (fns as any).__lastOrderParams = params;
      return {
        success: true,
        orderId: "ord1",
        status: "accepted",
        symbol: params.symbol,
        qty: params.qty,
        side: params.side,
      };
    }),
  };
  const seen: any[] = [];
  class MockMarketDataResearchService {
    constructor(...args: any[]) {
      seen.push({ ctor: args, svc: this });
      Object.assign(this, fns);
    }
  }
  const marketDataResearchBarsSourceLabel = (provider: string, provenance: string) =>
    provenance === "live" ? `MOCK-LIVE ${provider}` : `MOCK-GENERATED ${provider}`;
  return {
    MarketDataResearchService: MockMarketDataResearchService,
    marketDataResearchBarsSourceLabel,
    __mockMarketData: { fns, seen },
  };
});

vi.mock("../src/trading", async () => {
  const schemas = await vi.importActual<any>("../src/trading/screeningSchemas");
  // Issue #3892: the placement schema derives its enum from the registry, so a
  // module-level stub of the trading boundary must expose it as well.
  const advanced = await vi.importActual<any>("../src/trading/advancedOrders");
  // Issue #3930: services/feedJobs.ts spreads SECTOR_IDS at module scope
  // (isKnownIndexId's runtime mirror of the IndexId union), so the stub
  // must expose it or the file fails collection. Real values, via the
  // defining leaf module — never a hardcoded copy of the list.
  const membership = await vi.importActual<any>("../src/trading/indexMembership");
  return {
    parseStockScreenRequest: schemas.parseStockScreenRequest,
    ADVANCED_ORDER_TYPES: advanced.ADVANCED_ORDER_TYPES,
    SECTOR_IDS: membership.SECTOR_IDS,
  };
});

import {
  MARKET_DATA_QUOTE_MODE_SWITCH,
  MARKET_DATA_FUNDAMENTALS_MODE_SWITCH,
  MARKET_DATA_RESEARCH_MODE_SWITCH,
  MARKET_DATA_BARS_MODE_SWITCH,
  MARKET_DATA_SNAPSHOT_MODE_SWITCH,
  ALPACA_READS_MODE_SWITCH,
  ALPACA_ORDER_MODE_SWITCH,
  marketDataConfigErrorEvent,
  envValueForSwitch,
  levelsForMarketDataSwitch,
  resolveMarketDataQuoteMode,
  resolveMarketDataFundamentalsMode,
  resolveMarketDataResearchMode,
  resolveMarketDataBarsMode,
  resolveMarketDataSnapshotMode,
  resolveAlpacaReadsMode,
  resolveAlpacaOrderMode,
  resolveMarketDataRestSwitch,
} from "../src/config/marketDataModes";
import {
  MarketDataGetQuoteCommand,
  MarketDataFundamentalsCommand,
  MarketDataHistoricalBarsCommand,
  MarketDataResearchCommand,
  AlpacaSnapshotCommand,
  AlpacaAccountCommand,
  AlpacaPositionsCommand,
  AlpacaOrdersCommand,
  AlpacaPlaceOrderCommand,
} from "../src/mcps/openaimp/marketDataCommands";
import {
  handleMarketDataQuoteResearchRoutes,
  type MarketDataResearchRouteContext,
} from "../src/agents/routes/marketDataResearch";
import {
  handleAlpacaMarketDataRoutes,
  handleAlpacaTradingRoutes,
  type AlpacaRouteContext,
} from "../src/agents/routes/alpaca";
import * as marketDataMod from "../src/services/marketDataResearch";

const marketDataMocks = (marketDataMod as any).__mockMarketData as { fns: any; seen: any[] };

function mcpCtx(overrides: any = {}) {
  return {
    env: {},
    orm: {},
    sessionId: "test-user",
    audit: vi.fn(),
    ...overrides,
  };
}

function auditEvents(ctx: any): Array<[string, any, any]> {
  return (ctx.audit as any).mock.calls as Array<[string, any, any]>;
}

function auditNames(ctx: any): string[] {
  return auditEvents(ctx).map((c) => c[0]);
}

function restCtx(overrides: any = {}): MarketDataResearchRouteContext & AlpacaRouteContext {
  return {
    env: {},
    audit: vi.fn(),
    getScreenerAgent: (() => {
      throw new Error("screener not under test");
    }) as any,
    persistScreenerReportCanonical: (async () => {}) as any,
    ...overrides,
  } as any;
}

async function getBody(res: Response | null): Promise<any> {
  expect(res).not.toBeNull();
  return res!.json();
}

beforeEach(() => {
  vi.clearAllMocks();
  marketDataMocks.seen.length = 0;
});

/* ================= A. Resolver unit pins ================= */

describe("marketDataModes resolver", () => {
  it("exposes the seven switch names and the config_error event", () => {
    expect(MARKET_DATA_QUOTE_MODE_SWITCH).toBe("MARKET_DATA_QUOTE_MODE");
    expect(MARKET_DATA_FUNDAMENTALS_MODE_SWITCH).toBe("MARKET_DATA_FUNDAMENTALS_MODE");
    expect(MARKET_DATA_RESEARCH_MODE_SWITCH).toBe("MARKET_DATA_RESEARCH_MODE");
    expect(MARKET_DATA_BARS_MODE_SWITCH).toBe("MARKET_DATA_BARS_MODE");
    expect(MARKET_DATA_SNAPSHOT_MODE_SWITCH).toBe("MARKET_DATA_SNAPSHOT_MODE");
    expect(ALPACA_READS_MODE_SWITCH).toBe("ALPACA_READS_MODE");
    expect(ALPACA_ORDER_MODE_SWITCH).toBe("ALPACA_ORDER_MODE");
    expect(marketDataConfigErrorEvent()).toBe("market_data.config_error");
  });

  it("falls through blank levels to the built-in legacy", () => {
    const r = resolveMarketDataQuoteMode({ run: undefined, session: "", user: "  ", env: undefined }, "mcp");
    expect(r.mode).toBe("mcp");
    expect(r.invalid).toBe(false);
    expect(r.level).toBe("builtin");
  });

  it("resolves run > session > user > env", () => {
    const base = { run: "rest", session: "mcp", user: "mcp", env: "mcp" };
    expect(resolveMarketDataQuoteMode(base, "mcp").mode).toBe("rest");
    expect(resolveMarketDataQuoteMode(base, "mcp").level).toBe("run");
    expect(resolveMarketDataQuoteMode({ ...base, run: undefined }, "mcp").mode).toBe("mcp");
    expect(resolveMarketDataQuoteMode({ ...base, run: undefined }, "mcp").level).toBe("session");
    expect(resolveMarketDataQuoteMode({ run: undefined, session: undefined, user: "rest", env: "mcp" }, "mcp").level).toBe("user");
    expect(resolveMarketDataQuoteMode({ run: undefined, session: undefined, user: undefined, env: "rest" }, "mcp").level).toBe("env");
  });

  it("normalizes case + whitespace", () => {
    expect(resolveMarketDataBarsMode({ run: "  REST " }, "mcp").mode).toBe("rest");
    expect(resolveAlpacaReadsMode({ run: "NONE" }, "mcp").mode).toBe("none");
    expect(resolveAlpacaOrderMode({ run: "FOSS" }, "mcp").mode).toBe("market-data");
    expect(resolveAlpacaOrderMode({ run: "market-data" }, "mcp").mode).toBe("market-data");
  });

  it("fails closed to the legacy on an unrecognized winning value, with NO fall-through", () => {
    const r = resolveMarketDataQuoteMode({ run: "bogus", session: "rest", env: "rest" }, "mcp");
    expect(r.mode).toBe("mcp");
    expect(r.invalid).toBe(true);
    expect(r.raw).toBe("bogus");
    expect(r.level).toBe("run");
  });

  it("env fallback honors legacy vars only when canonical is unset or empty (#1906)", () => {
    expect(envValueForSwitch({ [MARKET_DATA_QUOTE_MODE_SWITCH]: "rest" }, MARKET_DATA_QUOTE_MODE_SWITCH)).toBe("rest");
    expect(envValueForSwitch({ FOSS_QUOTE_MODE: "rest" }, MARKET_DATA_QUOTE_MODE_SWITCH)).toBe("rest");
    expect(envValueForSwitch({ [MARKET_DATA_QUOTE_MODE_SWITCH]: "", FOSS_QUOTE_MODE: "rest" }, MARKET_DATA_QUOTE_MODE_SWITCH)).toBe("rest");
    expect(envValueForSwitch({ [MARKET_DATA_QUOTE_MODE_SWITCH]: "mcp", FOSS_QUOTE_MODE: "rest" }, MARKET_DATA_QUOTE_MODE_SWITCH)).toBe("mcp");
    expect(envValueForSwitch({ [MARKET_DATA_QUOTE_MODE_SWITCH]: "bogus", FOSS_QUOTE_MODE: "rest" }, MARKET_DATA_QUOTE_MODE_SWITCH)).toBe("bogus");
  });

  it("rejects values outside each switch's own vocabulary", () => {
    expect(resolveAlpacaReadsMode({ run: "foss" }, "mcp").invalid).toBe(true);
    expect(resolveAlpacaOrderMode({ run: "rest" }, "mcp").invalid).toBe(true);
    expect(resolveAlpacaReadsMode({ run: "rest" }, "mcp").invalid).toBe(false);
    expect(resolveAlpacaOrderMode({ run: "trading" }, "mcp").invalid).toBe(false);
  });

  it("levelsForMarketDataSwitch maps session/user carriers", () => {
    const levels = levelsForMarketDataSwitch({ session: { quote: "rest" }, user: { quote: "mcp" } }, "quote", "RUN", "ENV");
    expect(levels).toEqual({ run: "RUN", session: "rest", user: "mcp", env: "ENV" });
  });

  it("resolveMarketDataRestSwitch audits market_data.config_error on invalid and returns the legacy", () => {
    const host: any = { env: {}, audit: vi.fn(), scopedMarketDataModes: undefined };
    const mode = resolveMarketDataRestSwitch(host, "quote", "bogus", "rest");
    expect(mode).toBe("rest");
    expect(host.audit).toHaveBeenCalledWith(
      "market_data.config_error",
      "research",
      expect.objectContaining({ switch: "MARKET_DATA_QUOTE_MODE", raw: "bogus", level: "run", failedClosedTo: "rest" })
    );
  });

  it("resolveMarketDataRestSwitch does not audit on valid values", () => {
    const host: any = { env: {}, audit: vi.fn(), scopedMarketDataModes: undefined };
    expect(resolveMarketDataRestSwitch(host, "quote", "mcp", "rest")).toBe("mcp");
    expect(host.audit).not.toHaveBeenCalled();
  });
});

/* ================= B. MCP command pins ================= */

describe("MCP market-data commands", () => {
  it("F01 quote default (mcp): symbol required, audits market_data.quote.fetched", async () => {
    const ctx = mcpCtx();
    await expect(new MarketDataGetQuoteCommand().execute({} as any, ctx)).rejects.toThrow("symbol is required");
    const out = await new MarketDataGetQuoteCommand().execute({ symbol: "NVDA" } as any, ctx);
    expect(out.price).toBe(195.5);
    expect(auditNames(ctx)).toContain("market_data.quote.fetched");
    expect(auditNames(ctx)).not.toContain("market_data.config_error");
  });

  it("F01 quote mode=rest: missing symbol defaults to NVDA, no quote audit", async () => {
    const ctx = mcpCtx();
    const out = await new MarketDataGetQuoteCommand().execute({ mode: "rest" } as any, ctx);
    expect(marketDataMocks.fns.getQuote).toHaveBeenCalledWith("NVDA", "hybrid");
    expect(out.symbol).toBe("NVDA");
    expect(auditNames(ctx)).not.toContain("market_data.quote.fetched");
  });

  it("F01 quote env MARKET_DATA_QUOTE_MODE=rest: rest behavior; session carrier honored; run beats session", async () => {
    const ctxEnv = mcpCtx({ env: { MARKET_DATA_QUOTE_MODE: "rest" } });
    await new MarketDataGetQuoteCommand().execute({} as any, ctxEnv);
    expect(marketDataMocks.fns.getQuote).toHaveBeenCalledWith("NVDA", "hybrid");
    expect(auditNames(ctxEnv)).not.toContain("market_data.quote.fetched");

    const ctxSession = mcpCtx({ scopedMarketDataModes: { session: { quote: "rest" } } });
    await new MarketDataGetQuoteCommand().execute({} as any, ctxSession);
    expect(marketDataMocks.fns.getQuote).toHaveBeenCalledWith("NVDA", "hybrid");

    const ctxRunBeats = mcpCtx({ scopedMarketDataModes: { session: { quote: "rest" } } });
    await new MarketDataGetQuoteCommand().execute({ symbol: "AAPL", mode: "mcp" } as any, ctxRunBeats);
    expect(marketDataMocks.fns.getQuote).toHaveBeenCalledWith("AAPL", "hybrid");
    expect(auditNames(ctxRunBeats)).toContain("market_data.quote.fetched");
  });

  it("F01 quote invalid mode fails closed to mcp + audits market_data.config_error", async () => {
    const ctx = mcpCtx();
    await expect(new MarketDataGetQuoteCommand().execute({ mode: "bogus" } as any, ctx)).rejects.toThrow("symbol is required");
    expect(auditNames(ctx)).toContain("market_data.config_error");
    expect(auditEvents(ctx).find((c) => c[0] === "market_data.config_error")![2]).toMatchObject({
      switch: "MARKET_DATA_QUOTE_MODE",
      raw: "bogus",
      failedClosedTo: "mcp",
    });
  });

  it("F01 fundamentals default audits market_data.fundamentals.fetched; rest mode defaults NVDA with no audit", async () => {
    const ctx = mcpCtx();
    await expect(new MarketDataFundamentalsCommand().execute({} as any, ctx)).rejects.toThrow("symbol is required");
    await new MarketDataFundamentalsCommand().execute({ symbol: "MSFT" } as any, ctx);
    expect(auditNames(ctx)).toContain("market_data.fundamentals.fetched");
    const ctxRest = mcpCtx();
    await new MarketDataFundamentalsCommand().execute({ mode: "rest" } as any, ctxRest);
    expect(marketDataMocks.fns.getFundamentals).toHaveBeenCalledWith("NVDA");
    expect(auditNames(ctxRest)).not.toContain("market_data.fundamentals.fetched");
  });

  it("F01 research default audits market_data.research.generated; rest mode audits market_data.research_generated + NVDA default", async () => {
    const ctx = mcpCtx();
    await new MarketDataResearchCommand().execute({ symbol: "NVDA" } as any, ctx);
    expect(auditNames(ctx)).toContain("market_data.research.generated");
    expect(auditNames(ctx)).not.toContain("market_data.research_generated");
    const ctxRest = mcpCtx();
    const report = await new MarketDataResearchCommand().execute({ mode: "rest" } as any, ctxRest);
    expect(report.symbol).toBe("NVDA");
    expect(auditNames(ctxRest)).toContain("market_data.research_generated");
    expect(auditNames(ctxRest)).not.toContain("market_data.research.generated");
    const payload = auditEvents(ctxRest).find((c) => c[0] === "market_data.research_generated")![2];
    expect(payload).toMatchObject({ symbol: "NVDA", rating: "buy", did: "did:test:123" });
  });

  it("F02 bars default (mcp): small envelope + market_data.bars.fetched audit, no provider override", async () => {
    const ctx = mcpCtx();
    const out = await new MarketDataHistoricalBarsCommand().execute({ symbol: "NVDA" } as any, ctx);
    expect(out).toEqual({ symbol: "NVDA", count: 1, provenance: "live", bars: expect.any(Array) });
    expect(out).not.toHaveProperty("provider");
    expect(out).not.toHaveProperty("timeframe");
    expect(out).not.toHaveProperty("timestamp");
    expect(auditNames(ctx)).toContain("market_data.bars.fetched");
    expect(marketDataMocks.fns.__lastBarsArgs[3]).toBeUndefined();
  });

  it("F02 bars rest mode: provider passed (default yfinance), fuller envelope, no bars audit", async () => {
    const ctx = mcpCtx();
    const out = await new MarketDataHistoricalBarsCommand().execute({ symbol: "NVDA", mode: "rest" } as any, ctx);
    expect(marketDataMocks.fns.__lastBarsArgs).toEqual(["NVDA", "1D", 30, "yfinance"]);
    expect(out).toMatchObject({ symbol: "NVDA", provider: "yfinance", timeframe: "1D", count: 1, provenance: "live" });
    expect(out).toHaveProperty("bars");
    expect(out).toHaveProperty("source");
    expect(out).toHaveProperty("timestamp");
    expect(auditNames(ctx)).not.toContain("market_data.bars.fetched");
    const ctxAlpaca = mcpCtx();
    await new MarketDataHistoricalBarsCommand().execute({ symbol: "NVDA", mode: "rest", provider: "alpaca" } as any, ctxAlpaca);
    expect(marketDataMocks.fns.__lastBarsArgs[3]).toBe("alpaca");
  });

  it("F02 bars mcp mode ignores a provider input (legacy 3-arg call)", async () => {
    const ctx = mcpCtx();
    await new MarketDataHistoricalBarsCommand().execute({ symbol: "NVDA", mode: "mcp", provider: "alpaca" } as any, ctx);
    expect(marketDataMocks.fns.__lastBarsArgs[3]).toBeUndefined();
    expect(auditNames(ctx)).toContain("market_data.bars.fetched");
  });

  it("F03 snapshot default audits alpaca.snapshot; rest mode defaults NVDA + alpaca.snapshot_queried", async () => {
    const ctx = mcpCtx();
    await expect(new AlpacaSnapshotCommand().execute({} as any, ctx)).rejects.toThrow("symbol is required");
    await new AlpacaSnapshotCommand().execute({ symbol: "NVDA" } as any, ctx);
    const mcpPayload = auditEvents(ctx).find((c) => c[0] === "alpaca.snapshot")![2];
    expect(mcpPayload).toMatchObject({ symbol: "NVDA", assetClass: "us_equity", tradePrice: 195.5 });
    const ctxRest = mcpCtx();
    await new AlpacaSnapshotCommand().execute({ mode: "rest" } as any, ctxRest);
    const restPayload = auditEvents(ctxRest).find((c) => c[0] === "alpaca.snapshot_queried")![2];
    expect(restPayload).toMatchObject({ symbol: "NVDA", price: 195.5, bid: 195.0, ask: 196.0, assetClass: "us_equity" });
    expect(auditNames(ctxRest)).not.toContain("alpaca.snapshot");
  });

  it("F04 account/positions/orders default audits *.query; rest mode audits *_queried with the same payloads; none mode is silent", async () => {
    const ctx = mcpCtx();
    await new AlpacaAccountCommand().execute({} as any, ctx);
    await new AlpacaPositionsCommand().execute({} as any, ctx);
    await new AlpacaOrdersCommand().execute({} as any, ctx);
    expect(auditNames(ctx)).toEqual(expect.arrayContaining(["alpaca.account.query", "alpaca.positions.query", "alpaca.orders.query"]));
    expect(marketDataMocks.fns.__lastOrdersStatus).toBe("open");
    const ctxRest = mcpCtx();
    await new AlpacaAccountCommand().execute({ mode: "rest" } as any, ctxRest);
    await new AlpacaPositionsCommand().execute({ mode: "rest" } as any, ctxRest);
    await new AlpacaOrdersCommand().execute({ status: "closed", mode: "rest" } as any, ctxRest);
    expect(auditNames(ctxRest)).toEqual(
      expect.arrayContaining(["alpaca.account_queried", "alpaca.positions_queried", "alpaca.orders_queried"])
    );
    expect(marketDataMocks.fns.__lastOrdersStatus).toBe("closed");
    expect(auditEvents(ctxRest).find((c) => c[0] === "alpaca.account_queried")![2]).toMatchObject({
      success: true,
      accountId: "acc1",
      buyingPower: 10000,
      portfolioValue: 50000,
    });
    const ctxNone = mcpCtx();
    await new AlpacaAccountCommand().execute({ mode: "none" } as any, ctxNone);
    expect(ctxNone.audit).not.toHaveBeenCalled();
  });

  it("F05 place order default (mcp): verbatim input + alpaca.order.place full audit", async () => {
    const ctx = mcpCtx();
    await new AlpacaPlaceOrderCommand().execute(
      { symbol: "nvda", qty: 2, side: "buy", type: "limit", limit_price: 100, quantity: 99, orderAction: "sell" } as any,
      ctx
    );
    expect(marketDataMocks.fns.__lastOrderParams).toMatchObject({ symbol: "nvda", qty: 2, side: "buy" });
    expect(marketDataMocks.fns.__lastOrderParams.qty).not.toBe(99);
    const payload = auditEvents(ctx).find((c) => c[0] === "alpaca.order.place")![2];
    expect(payload).toMatchObject({ symbol: "nvda", qty: 2, side: "buy", type: "limit", limitPrice: 100, orderId: "ord1", status: "accepted", success: true });
  });

  it("F05 place order market-data mode: /market-data normalization + alpaca.order_placed full audit", async () => {
    const ctx = mcpCtx();
    await new AlpacaPlaceOrderCommand().execute(
      { symbol: " nvda ", quantity: 3, orderAction: "BUY", orderType: "LIMIT", limitPrice: 101, mode: "market-data" } as any,
      ctx
    );
    expect(marketDataMocks.fns.__lastOrderParams).toMatchObject({ symbol: "NVDA", qty: 3, side: "buy", type: "limit", limit_price: 101, time_in_force: "day" });
    const payload = auditEvents(ctx).find((c) => c[0] === "alpaca.order_placed")![2];
    expect(payload).toMatchObject({ symbol: "NVDA", qty: 3, side: "buy", type: "limit", limitPrice: 101, orderId: "ord1", status: "accepted", success: true });
  });

  it("F05 place order legacy foss mode value is a deprecated alias for market-data (#1906)", async () => {
    const ctx = mcpCtx();
    await new AlpacaPlaceOrderCommand().execute(
      { symbol: " nvda ", quantity: 3, orderAction: "BUY", orderType: "LIMIT", limitPrice: 101, mode: "foss" } as any,
      ctx
    );
    expect(marketDataMocks.fns.__lastOrderParams).toMatchObject({ symbol: "NVDA", qty: 3, side: "buy", type: "limit", limit_price: 101, time_in_force: "day" });
    const payload = auditEvents(ctx).find((c) => c[0] === "alpaca.order_placed")![2];
    expect(payload).toMatchObject({ symbol: "NVDA", qty: 3, side: "buy", type: "limit", limitPrice: 101, orderId: "ord1", status: "accepted", success: true });
  });

  it("F05 place order trading mode: /trading normalization + minimal alpaca.order_placed audit; qty defaults to 1", async () => {
    const ctx = mcpCtx();
    await new AlpacaPlaceOrderCommand().execute({ symbol: " nvda ", side: "buy", mode: "trading" } as any, ctx);
    expect(marketDataMocks.fns.__lastOrderParams).toMatchObject({ symbol: "nvda", qty: 1, side: "buy" });
    const payload = auditEvents(ctx).find((c) => c[0] === "alpaca.order_placed")![2];
    expect(payload).toEqual({ symbol: "nvda", qty: 1, side: "buy", status: "accepted" });
  });

  it("F05 place order invalid mode fails closed to mcp + audits market_data.config_error", async () => {
    const ctx = mcpCtx();
    await new AlpacaPlaceOrderCommand().execute({ symbol: "NVDA", qty: 1, side: "buy", mode: "bogus" } as any, ctx);
    expect(auditNames(ctx)).toContain("market_data.config_error");
    expect(auditNames(ctx)).toContain("alpaca.order.place");
  });
});

/* ================= C. REST route pins ================= */

describe("REST market-data routes", () => {
  it("F01 /market-data/quote default: NVDA, no audit; ?mode=mcp: required 400 + market_data.quote.fetched", async () => {
    const ctx = restCtx();
    const res = await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/quote"), new URL("https://x/api/market-data/quote"), "/api/market-data/quote", "s", ctx);
    const body = await getBody(res);
    expect(body.symbol).toBe("NVDA");
    expect(ctx.audit).not.toHaveBeenCalled();
    const ctxMcp = restCtx();
    const missing = await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/quote?mode=mcp"), new URL("https://x/api/market-data/quote?mode=mcp"), "/api/market-data/quote", "s", ctxMcp);
    expect(missing!.status).toBe(400);
    expect(await missing!.json()).toEqual({ error: "symbol is required" });
    await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/quote?symbol=AAPL&mode=mcp"), new URL("https://x/api/market-data/quote?symbol=AAPL&mode=mcp"), "/api/market-data/quote", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("market_data.quote.fetched");
  });

  it("F01 /market-data/quote invalid mode fails closed to rest + audits market_data.config_error", async () => {
    const ctx = restCtx();
    const res = await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/quote?mode=bogus"), new URL("https://x/api/market-data/quote?mode=bogus"), "/api/market-data/quote", "s", ctx);
    expect((await getBody(res)).symbol).toBe("NVDA");
    expect((ctx.audit as any).mock.calls.map((c: any) => c[0])).toContain("market_data.config_error");
  });

  it("F01 /market-data/fundamentals default: NVDA, no audit; mcp mode audits market_data.fundamentals.fetched", async () => {
    const ctx = restCtx();
    const res = await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/fundamentals"), new URL("https://x/api/market-data/fundamentals"), "/api/market-data/fundamentals", "s", ctx);
    expect((await getBody(res)).symbol).toBe("NVDA");
    expect(ctx.audit).not.toHaveBeenCalled();
    const ctxMcp = restCtx();
    await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/fundamentals?symbol=MSFT&mode=mcp"), new URL("https://x/api/market-data/fundamentals?symbol=MSFT&mode=mcp"), "/api/market-data/fundamentals", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("market_data.fundamentals.fetched");
  });

  it("F01 /market-data/research default audits market_data.research_generated; mcp mode audits market_data.research.generated", async () => {
    const ctx = restCtx();
    await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/research"), new URL("https://x/api/market-data/research"), "/api/market-data/research", "s", ctx);
    expect((ctx.audit as any).mock.calls.map((c: any) => c[0])).toContain("market_data.research_generated");
    const ctxMcp = restCtx();
    await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/research?symbol=NVDA&mode=mcp"), new URL("https://x/api/market-data/research?symbol=NVDA&mode=mcp"), "/api/market-data/research", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("market_data.research.generated");
    const missing = await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/research?mode=mcp&symbol="), new URL("https://x/api/market-data/research?mode=mcp&symbol="), "/api/market-data/research", "s", restCtx());
    expect(missing!.status).toBe(400);
  });

  it("F02 /market-data/bars default: fuller envelope + provider yfinance, no audit; mcp mode: small envelope + market_data.bars.fetched", async () => {
    const ctx = restCtx();
    const res = await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/bars"), new URL("https://x/api/market-data/bars"), "/api/market-data/bars", "s", ctx);
    const body = await getBody(res);
    expect(body).toMatchObject({ symbol: "NVDA", provider: "yfinance", timeframe: "1D", count: 1, provenance: "live" });
    expect(body).toHaveProperty("bars");
    expect(body).toHaveProperty("source");
    expect(body).toHaveProperty("timestamp");
    expect(ctx.audit).not.toHaveBeenCalled();
    const ctxMcp = restCtx();
    const resMcp = await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/bars?symbol=NVDA&mode=mcp"), new URL("https://x/api/market-data/bars?symbol=NVDA&mode=mcp"), "/api/market-data/bars", "s", ctxMcp);
    const bodyMcp = await getBody(resMcp);
    expect(bodyMcp).toEqual({ symbol: "NVDA", count: 1, provenance: "live", bars: expect.any(Array) });
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("market_data.bars.fetched");
    expect(marketDataMocks.fns.__lastBarsArgs[3]).toBeUndefined();
  });

  it("F02 /market-data/bars rest mode honors an explicit provider", async () => {
    const ctx = restCtx();
    const res = await handleMarketDataQuoteResearchRoutes(new Request("https://x/api/market-data/bars?symbol=NVDA&provider=alpaca"), new URL("https://x/api/market-data/bars?symbol=NVDA&provider=alpaca"), "/api/market-data/bars", "s", ctx);
    expect((await getBody(res)).provider).toBe("alpaca");
    expect(marketDataMocks.fns.__lastBarsArgs[3]).toBe("alpaca");
  });

  it("F03 /market-data/snapshot default: NVDA + alpaca.snapshot_queried; mcp mode: required 400 + alpaca.snapshot", async () => {
    const ctx = restCtx();
    await handleAlpacaMarketDataRoutes(new Request("https://x/api/market-data/snapshot"), new URL("https://x/api/market-data/snapshot"), "/api/market-data/snapshot", "s", ctx);
    expect((ctx.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.snapshot_queried");
    const ctxMcp = restCtx();
    const missing = await handleAlpacaMarketDataRoutes(new Request("https://x/api/market-data/snapshot?mode=mcp"), new URL("https://x/api/market-data/snapshot?mode=mcp"), "/api/market-data/snapshot", "s", ctxMcp);
    expect(missing!.status).toBe(400);
    await handleAlpacaMarketDataRoutes(new Request("https://x/api/market-data/snapshot?symbol=AAPL&mode=mcp"), new URL("https://x/api/market-data/snapshot?symbol=AAPL&mode=mcp"), "/api/market-data/snapshot", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.snapshot");
  });

  it("F04 /market-data/alpaca reads default *_queried; mcp mode *.query; none mode silent; env none silences", async () => {
    const ctx = restCtx();
    await handleAlpacaMarketDataRoutes(new Request("https://x/api/market-data/alpaca/account"), new URL("https://x/api/market-data/alpaca/account"), "/api/market-data/alpaca/account", "s", ctx);
    await handleAlpacaMarketDataRoutes(new Request("https://x/api/market-data/alpaca/positions"), new URL("https://x/api/market-data/alpaca/positions"), "/api/market-data/alpaca/positions", "s", ctx);
    await handleAlpacaMarketDataRoutes(new Request("https://x/api/market-data/alpaca/orders?status=closed"), new URL("https://x/api/market-data/alpaca/orders?status=closed"), "/api/market-data/alpaca/orders", "s", ctx);
    const names = (ctx.audit as any).mock.calls.map((c: any) => c[0]);
    expect(names).toEqual(expect.arrayContaining(["alpaca.account_queried", "alpaca.positions_queried", "alpaca.orders_queried"]));
    expect(marketDataMocks.fns.__lastOrdersStatus).toBe("closed");
    const ctxMcp = restCtx();
    await handleAlpacaMarketDataRoutes(new Request("https://x/api/market-data/alpaca/account?mode=mcp"), new URL("https://x/api/market-data/alpaca/account?mode=mcp"), "/api/market-data/alpaca/account", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.account.query");
    const ctxNone = restCtx();
    await handleAlpacaMarketDataRoutes(new Request("https://x/api/market-data/alpaca/account?mode=none"), new URL("https://x/api/market-data/alpaca/account?mode=none"), "/api/market-data/alpaca/account", "s", ctxNone);
    expect(ctxNone.audit).not.toHaveBeenCalled();
    const ctxEnv = restCtx({ env: { ALPACA_READS_MODE: "none" } });
    await handleAlpacaMarketDataRoutes(new Request("https://x/api/market-data/alpaca/account"), new URL("https://x/api/market-data/alpaca/account"), "/api/market-data/alpaca/account", "s", ctxEnv);
    expect(ctxEnv.audit).not.toHaveBeenCalled();
    // #1906: deprecated legacy path routes to the same handler + audit.
    const ctxLegacy = restCtx();
    await handleAlpacaMarketDataRoutes(new Request("https://x/api/foss/alpaca/account"), new URL("https://x/api/foss/alpaca/account"), "/api/foss/alpaca/account", "s", ctxLegacy);
    expect((ctxLegacy.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.account_queried");
  });

  it("F04 /trading/alpaca reads default: NO audit (legacy, #1733 ground preserved); mode selects query/queried", async () => {
    const ctx = restCtx();
    await handleAlpacaTradingRoutes(new Request("https://x/api/trading/alpaca/account"), new URL("https://x/api/trading/alpaca/account"), "/api/trading/alpaca/account", "s", ctx);
    await handleAlpacaTradingRoutes(new Request("https://x/api/trading/alpaca/orders"), new URL("https://x/api/trading/alpaca/orders"), "/api/trading/alpaca/orders", "s", ctx);
    expect(ctx.audit).not.toHaveBeenCalled();
    expect(marketDataMocks.fns.__lastOrdersStatus).toBe("open");
    const ctxRest = restCtx();
    await handleAlpacaTradingRoutes(new Request("https://x/api/trading/alpaca/account?mode=rest"), new URL("https://x/api/trading/alpaca/account?mode=rest"), "/api/trading/alpaca/account", "s", ctxRest);
    expect((ctxRest.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.account_queried");
    const ctxMcp = restCtx();
    await handleAlpacaTradingRoutes(new Request("https://x/api/trading/alpaca/account?mode=mcp"), new URL("https://x/api/trading/alpaca/account?mode=mcp"), "/api/trading/alpaca/account", "s", ctxMcp);
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.account.query");
  });

  it("F05 /market-data/alpaca/order default: market-data normalization + full audit; trading/mcp modes select their contracts", async () => {
    const ctx = restCtx();
    const res = await handleAlpacaMarketDataRoutes(
      new Request("https://x/api/market-data/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: "nvda", quantity: 3, orderAction: "BUY", orderType: "LIMIT", limitPrice: 101 }) }),
      new URL("https://x/api/market-data/alpaca/order"),
      "/api/market-data/alpaca/order",
      "s",
      ctx
    );
    expect((await getBody(res)).success).toBe(true);
    expect(marketDataMocks.fns.__lastOrderParams).toMatchObject({ symbol: "NVDA", qty: 3, side: "buy", type: "limit", limit_price: 101 });
    const payload = (ctx.audit as any).mock.calls.find((c: any) => c[0] === "alpaca.order_placed")![2];
    expect(payload).toMatchObject({ symbol: "NVDA", qty: 3, side: "buy", type: "limit", limitPrice: 101, orderId: "ord1", success: true });
    const ctxTrading = restCtx();
    await handleAlpacaMarketDataRoutes(
      new Request("https://x/api/market-data/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: " nvda ", mode: "trading" }) }),
      new URL("https://x/api/market-data/alpaca/order"),
      "/api/market-data/alpaca/order",
      "s",
      ctxTrading
    );
    expect(marketDataMocks.fns.__lastOrderParams).toMatchObject({ symbol: "nvda", qty: 1 });
    expect((ctxTrading.audit as any).mock.calls.find((c: any) => c[0] === "alpaca.order_placed")![2]).toEqual({
      symbol: "nvda",
      qty: 1,
      side: "buy",
      status: "accepted",
    });
    const ctxMcp = restCtx();
    await handleAlpacaMarketDataRoutes(
      new Request("https://x/api/market-data/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: "nvda", qty: 2, side: "buy", mode: "mcp" }) }),
      new URL("https://x/api/market-data/alpaca/order"),
      "/api/market-data/alpaca/order",
      "s",
      ctxMcp
    );
    expect(marketDataMocks.fns.__lastOrderParams).toMatchObject({ symbol: "nvda", qty: 2 });
    expect((ctxMcp.audit as any).mock.calls.map((c: any) => c[0])).toContain("alpaca.order.place");
  });

  it("F05 /trading/alpaca/order default: trading normalization + minimal audit; market-data mode selects market-data contract", async () => {
    const ctx = restCtx();
    await handleAlpacaTradingRoutes(
      new Request("https://x/api/trading/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: " nvda " }) }),
      new URL("https://x/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctx
    );
    expect(marketDataMocks.fns.__lastOrderParams).toMatchObject({ symbol: "nvda", qty: 1, side: "buy" });
    expect((ctx.audit as any).mock.calls.find((c: any) => c[0] === "alpaca.order_placed")![2]).toEqual({
      symbol: "nvda",
      qty: 1,
      side: "buy",
      status: "accepted",
    });
    const ctxMarketData = restCtx();
    await handleAlpacaTradingRoutes(
      new Request("https://x/api/trading/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: "nvda", quantity: 4, orderAction: "SELL", orderType: "LIMIT", limitPrice: 99, mode: "market-data" }) }),
      new URL("https://x/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctxMarketData
    );
    expect(marketDataMocks.fns.__lastOrderParams).toMatchObject({ symbol: "NVDA", qty: 4, side: "sell", type: "limit", limit_price: 99 });
    expect((ctxMarketData.audit as any).mock.calls.find((c: any) => c[0] === "alpaca.order_placed")![2]).toMatchObject({
      symbol: "NVDA",
      type: "limit",
      limitPrice: 99,
      orderId: "ord1",
      success: true,
    });
  });

  it("F05 trading-order legacy foss mode value is a deprecated alias for market-data (#1906)", async () => {
    const ctxAlias = restCtx();
    await handleAlpacaTradingRoutes(
      new Request("https://x/api/trading/alpaca/order", { method: "POST", body: JSON.stringify({ symbol: "nvda", quantity: 4, orderAction: "SELL", orderType: "LIMIT", limitPrice: 99, mode: "foss" }) }),
      new URL("https://x/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctxAlias
    );
    expect(marketDataMocks.fns.__lastOrderParams).toMatchObject({ symbol: "NVDA", qty: 4, side: "sell", type: "limit", limit_price: 99 });
    expect((ctxAlias.audit as any).mock.calls.find((c: any) => c[0] === "alpaca.order_placed")![2]).toMatchObject({
      symbol: "NVDA",
      type: "limit",
      limitPrice: 99,
      orderId: "ord1",
      success: true,
    });
  });

  it("F05 order routes keep their missing-symbol 400s in every mode", async () => {
    const ctx = restCtx();
    const res = await handleAlpacaMarketDataRoutes(
      new Request("https://x/api/market-data/alpaca/order", { method: "POST", body: JSON.stringify({ qty: 1 }) }),
      new URL("https://x/api/market-data/alpaca/order"),
      "/api/market-data/alpaca/order",
      "s",
      ctx
    );
    expect(res!.status).toBe(400);
    const ctxT = restCtx();
    const resT = await handleAlpacaTradingRoutes(
      new Request("https://x/api/trading/alpaca/order", { method: "POST", body: JSON.stringify({}) }),
      new URL("https://x/api/trading/alpaca/order"),
      "/api/trading/alpaca/order",
      "s",
      ctxT
    );
    expect(resT!.status).toBe(400);
  });
});
