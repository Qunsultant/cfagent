import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { ETradeService } from "../src/services/etrade";
import { AGENT_DIDS } from "../src/agents/did";
import { storeAccessTokens } from "../src/security/etradeOAuth";
import { __resetTokenCache } from "../src/security/etradeTokenCache";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { DynamicMarketScreener } from "../src/trading/screener";
import type { TradingOrderLeg } from "../src/trading/interfaces";
import type { NasdaqStockListing } from "../src/services/nasdaqListings";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import { planNLQ, executeNLQQuery } from "../src/agents/nlq";
import type { Env } from "../src/types";

describe("E*TRADE Agentic Trading Hub & Screening Engine", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  let etrade: ETradeService;
  const sessionId = "trader_session_001";
  const userDid = "did:user:github:trader_user";

  const mockEnv: Env = {
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    ORCHESTRATOR_AGENT: {} as any,
    ETRADE_ENVIRONMENT: "sandbox",
  };

  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    DynamicMarketScreener.setTestListingsFixture(null);
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
    etrade = new ETradeService(orm, mockEnv, "test-user");
  });

  afterEach(() => {
    __resetTokenCache();
  });

  // =========================================================================
  // 1. Market Screener & Scanning Engine
  // =========================================================================
  describe("Market Screener & Technical Scanning", () => {
    it("screens default universe and returns technical indicators and AI signals", () => {
      const result = etrade.screenStocks({});
      expect(result.stocks.length).toBeGreaterThanOrEqual(10);
      expect(result.totalScreened).toBeGreaterThanOrEqual(10);

      const nvda = result.stocks.find((s) => s.symbol === "NVDA");
      expect(nvda).toBeDefined();
      expect(nvda?.price).toBeGreaterThan(100);
      expect(nvda?.rsi14).toBeDefined();
      expect(nvda?.macdSignal).toBeDefined();
      expect(nvda?.sector).toBe("Semiconductors");
      expect(["BULLISH_MOMENTUM", "OVERSOLD_BOUNCE", "RANGE_BOUND", "OVERBOUGHT"]).toContain(nvda?.signal);
    });

    it("filters equities by sector (e.g. Technology or Semiconductors)", () => {
      const techResult = etrade.screenStocks({ sector: "Semiconductors" });
      expect(techResult.stocks.length).toBeGreaterThanOrEqual(2);
      expect(techResult.stocks.every((s) => s.sector === "Semiconductors")).toBe(true);
      expect(techResult.stocks.some((s) => s.symbol === "NVDA")).toBe(true);
      expect(techResult.stocks.some((s) => s.symbol === "AMD")).toBe(true);
    });

    it("filters equities by RSI (e.g. oversold maxRsi < 40 or momentum minRsi > 55)", () => {
      const momentumStocks = etrade.screenStocks({ minRsi: 55 });
      expect(momentumStocks.stocks.every((s) => s.rsi14 >= 55)).toBe(true);

      const oversoldStocks = etrade.screenStocks({ maxRsi: 40 });
      expect(oversoldStocks.stocks.every((s) => s.rsi14 <= 40)).toBe(true);
    });

    it("filters equities by price movement (gainersOnly / losersOnly)", () => {
      const gainers = etrade.screenStocks({ gainersOnly: true });
      expect(gainers.stocks.every((s) => s.changePercent >= 0)).toBe(true);

      const losers = etrade.screenStocks({ losersOnly: true });
      expect(losers.stocks.every((s) => s.changePercent <= 0)).toBe(true);
    });

    it("filters equities by minimum market capitalization", () => {
      const megaCaps = etrade.screenStocks({ minMarketCap: 1_000_000_000_000 }); // $1T+
      expect(megaCaps.stocks.every((s) => s.marketCap >= 1_000_000_000_000)).toBe(true);
      expect(megaCaps.stocks.some((s) => s.symbol === "MSFT" || s.symbol === "AAPL" || s.symbol === "NVDA")).toBe(true);
    });

    it("applies relative-volume screening only when average volume is available", () => {
      const quote = {
        ...MOCK_TEST_UNIVERSE[0],
        volume: 20_000_000,
        averageVolume: 10_000_000,
      };
      const screener = new DynamicMarketScreener();
      const matched = screener.screenWithQuotes([quote], { momentum: "high_relative_volume" });
      expect(matched.stocks).toHaveLength(1);

      const unavailable = screener.screenWithQuotes([MOCK_TEST_UNIVERSE[0]], { momentum: "high_relative_volume" });
      expect(unavailable.stocks).toHaveLength(0);
      expect(unavailable.ledger?.rejections[0].reason).toContain("N/A");
    });
  });

  // =========================================================================
  // 2. Real-Time Quotes
  // =========================================================================
  describe("Real-Time Quotes", () => {
    it("retrieves real-time quote with bid, ask, and 52-week statistics", () => {
      const quote = etrade.getQuote("NVDA");
      expect(quote.symbol).toBe("NVDA");
      expect(quote.companyName).toBe("NVIDIA Corporation");
      expect(quote.lastPrice).toBeGreaterThan(0);
      expect(quote.bid).toBeLessThanOrEqual(quote.ask);
      expect(quote.volume).toBeGreaterThan(1_000_000);
      expect(quote.high52).toBeGreaterThan(quote.low52);
    });

    it("generates deterministic quote for any custom ticker", () => {
      const quote = etrade.getQuote("GOOGL");
      expect(quote.symbol).toBe("GOOGL");
      expect(quote.lastPrice).toBeGreaterThan(0);
      expect(quote.bid).toBeGreaterThan(0);
      expect(quote.ask).toBeGreaterThanOrEqual(quote.bid);
    });
  });

  // =========================================================================
  // 3. Human-in-the-Loop (HITL) Order Preview & Execution with DIDs
  // =========================================================================
  describe("HITL Order Preview & Execution with Agent DIDs", () => {
    it("previews an order draft, stamps Agent DID, and saves to SQLite mas_trades", () => {
      const draft = etrade.previewOrder({
        sessionId,
        symbol: "NVDA",
        orderAction: "BUY",
        quantity: 15,
        orderType: "MARKET",
      });

      expect(draft.orderId).toMatch(/^ord_[a-f0-9]{8}$/);
      expect(draft.symbol).toBe("NVDA");
      expect(draft.orderAction).toBe("BUY");
      expect(draft.quantity).toBe(15);
      expect(draft.estimatedPrice).toBeGreaterThan(0);
      expect(draft.estimatedTotal).toBeGreaterThan(0);
      expect(draft.status).toBe("previewed");
      expect(draft.proposerDid).toBe(AGENT_DIDS.TRADING);
      expect(draft.proofSignature).toMatch(/^sig_0x/);

      // Verify persisted in mas_trades ORM repository
      const saved = orm.trades.findById(draft.orderId);
      expect(saved).toBeDefined();
      expect(saved?.symbol).toBe("NVDA");
      expect(saved?.action).toBe("BUY");
      expect(saved?.quantity).toBe(15);
      expect(saved?.proposerDid).toBe(AGENT_DIDS.TRADING);
      expect(saved?.status).toBe("previewed");
    });

    it("approval without broker credentials fails honestly and leaves the draft previewed", async () => {
      // §7 adaptation (#2389): this test previously asserted the
      // platform's local fabrication — approval stamped the draft
      // executed with an invented reference in an environment with no
      // broker credentials at all. Approval now places through the
      // real broker client; with no credentials configured the honest
      // outcome is a failure and the draft stays previewed. The
      // broker-confirmed success direction is pinned in
      // tests/autopilot_execution_honesty_2389.test.ts.
      const draft = etrade.previewOrder({
        sessionId,
        symbol: "MSFT",
        orderAction: "BUY",
        quantity: 5,
        orderType: "MARKET",
      });

      const execResult = await etrade.executeOrder(draft.orderId, userDid, "approved");
      expect(execResult.success).toBe(false);
      expect(execResult.status).toBe("failed");
      expect(execResult.orderId).toBe(draft.orderId);
      expect(execResult.authorizerDid).toBe(userDid);
      expect(execResult.executionId).toBe("");

      // Verify no database update claimed an execution
      const updated = orm.trades.findById(draft.orderId);
      expect(updated?.status).toBe("previewed");
      expect(updated?.orderRef ?? "").not.toMatch(/^et_ref_/);
    });

    it("rejects an order draft when human authorizer declines", async () => {
      const draft = etrade.previewOrder({
        sessionId,
        symbol: "TSLA",
        orderAction: "SELL",
        quantity: 10,
      });

      // #2389: executeOrder is async now (await added; behaviour unchanged).
      const execResult = await etrade.executeOrder(draft.orderId, userDid, "rejected");
      expect(execResult.success).toBe(false);
      expect(execResult.status).toBe("rejected");

      const updated = orm.trades.findById(draft.orderId);
      expect(updated?.status).toBe("rejected");
    });

    it("retrieves open broker positions and portfolio balances", () => {
      const initial = etrade.getPositions();
      expect(initial.account.accountId).toBeDefined();
      expect(initial.positions).toEqual([]);

      // Record a broker-confirmed execution on the draft, exactly as
      // the platform persists it after a successful placement
      // (§7 adaptation, #2389: approval no longer settles locally in
      // an environment with no broker credentials — positions derive
      // from executed records, and that derivation is this test's
      // subject).
      const draft = etrade.previewOrder({ sessionId, symbol: "NVDA", orderAction: "BUY", quantity: 15 });
      orm.trades.update(draft.orderId, {
        status: "executed",
        orderRef: "et_order_2389_pos",
        authorizerDid: userDid,
        updatedAt: new Date().toISOString(),
      });

      const portfolio = etrade.getPositions();
      expect(portfolio.account.totalAccountValue).toBeGreaterThan(0);
      expect(portfolio.positions.length).toBe(1);

      const firstPos = portfolio.positions[0];
      expect(firstPos.symbol).toBe("NVDA");
      expect(firstPos.quantity).toBe(15);
      expect(firstPos.costBasis).toBeGreaterThan(0);
      expect(firstPos.marketPrice).toBeGreaterThan(0);
      expect(firstPos.marketValue).toBeGreaterThan(0);
    });
  });

  // =========================================================================
  // 4. Model Context Protocol (MCP) Trading Commands
  // =========================================================================
  describe("E*TRADE Model Context Protocol (MCP) Commands", () => {
    const auditMock = vi.fn();
    const mcpContext = {
      get env() { return mockEnv; },
      get orm() { return orm; },
      sessionId,
      audit: auditMock,
    };

    it("etrade_market_scan: reports unsupported sector/RSI criteria for listing data", async () => {
      const cmd = McpToolFactory.getTool("etrade_market_scan");
      expect(cmd).toBeDefined();

      DynamicMarketScreener.setTestListingsFixture([{
        symbol: "LIVE",
        companyName: "Live Corp",
        exchange: "nasdaq",
        lastPrice: 50,
        change: 1,
        changePercent: 2,
        marketCap: 1_000_000_000,
      }]);
      try {
        const res = await cmd.execute({ sector: "Semiconductors", minRsi: 50 }, mcpContext);
        expect(res.stocks).toHaveLength(0);
        expect(res.validationError).toContain("sector, RSI");
        expect(res.discovery.candidateCount).toBe(1);
        expect(auditMock).toHaveBeenCalledWith("etrade.market_scanned", "trading", expect.any(Object));
      } finally {
        DynamicMarketScreener.setTestListingsFixture(null);
      }
    });

    it("etrade_get_quote: retrieves real-time quote", async () => {
      const cmd = McpToolFactory.getTool("etrade_get_quote");
      expect(cmd).toBeDefined();

      const quote = await cmd.execute({ symbol: "AAPL" }, mcpContext);
      expect(quote.symbol).toBe("AAPL");
      expect(quote.lastPrice).toBeGreaterThan(0);
      expect(quote.bid).toBeGreaterThan(0);
    });

    it("etrade_preview_order: drafts order preview with safety guarantees", async () => {
      const cmd = McpToolFactory.getTool("etrade_preview_order");
      expect(cmd).toBeDefined();

      const preview = await cmd.execute(
        {
          symbol: "AMD",
          orderAction: "BUY",
          quantity: 20,
          orderType: "MARKET",
        },
        mcpContext
      );

      expect(preview.orderId).toMatch(/^ord_/);
      expect(preview.proposerDid).toBe(AGENT_DIDS.TRADING);
      expect(preview.status).toBe("previewed");
      expect(preview.safetyNotice).toContain("HUMAN APPROVAL REQUIRED");
    });

    it("etrade_execute_order: approval without broker credentials fails honestly", async () => {
      // §7 adaptation (#2389): this test previously asserted the
      // fabricated success the platform produced on approval. The MCP
      // context env carries no broker credentials, so the honest
      // outcome is a failed result and the draft is never stamped.
      // First preview
      const previewCmd = McpToolFactory.getTool("etrade_preview_order");
      const draft = await previewCmd.execute(
        { symbol: "PLTR", orderAction: "BUY", quantity: 50 },
        mcpContext
      );

      // Now execute
      const execCmd = McpToolFactory.getTool("etrade_execute_order");
      const executed = await execCmd.execute(
        { orderId: draft.orderId, decision: "approved" },
        mcpContext
      );

      expect(executed.success).toBe(false);
      expect(executed.status).toBe("failed");
      expect(executed.orderId).toBe(draft.orderId);
      expect(orm.trades.findById(draft.orderId)?.status).toBe("previewed");
    });

    it("etrade_get_positions: returns broker account holdings", async () => {
      const cmd = McpToolFactory.getTool("etrade_get_positions");
      const pos = await cmd.execute({}, mcpContext);
      expect(pos.account).toBeDefined();
      expect(Array.isArray(pos.positions)).toBe(true);
    });
  });

  // =========================================================================
  // 5. Natural Language Query (NLQ) Trading Interface
  // =========================================================================
  describe("Natural Language Query (NLQ) Trading Integration", () => {
    it("NLQ classifies 'screen tech stocks with RSI < 35' into trading domain", async () => {
      const plan = await planNLQ(mockEnv, "screen tech stocks with RSI < 35");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("screen");
      expect(plan.tradingData?.filters?.sector).toBe("Technology");
      expect(plan.tradingData?.filters?.maxRsi).toBe(35);

      const result = executeNLQQuery(orm, sessionId, plan);
      expect(result.domain).toBe("trading");
      expect(result.rows).toBeDefined();
    });

    it("NLQ classifies 'quote NVDA' and returns real-time quote card", async () => {
      const plan = await planNLQ(mockEnv, "quote NVDA");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("quote");
      expect(plan.tradingData?.symbol).toBe("NVDA");

      const result = executeNLQQuery(orm, sessionId, plan);
      expect(result.domain).toBe("trading");
      expect(result.count).toBe(1);
      expect(result.rows[0].symbol).toBe("NVDA");
      expect(result.rows[0].lastPrice).toBeDefined();
    });

    it("NLQ classifies 'buy 10 shares of NVDA' and creates order draft preview", async () => {
      const plan = await planNLQ(mockEnv, "buy 10 shares of NVDA");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("preview_order");
      expect(plan.tradingData?.symbol).toBe("NVDA");
      expect(plan.tradingData?.quantity).toBe(10);
      expect(plan.tradingData?.orderAction).toBe("BUY");

      const result = executeNLQQuery(orm, sessionId, plan);
      expect(result.domain).toBe("trading");
      expect(result.count).toBe(1);
      expect(result.rows[0].orderId).toMatch(/^ord_/);
      expect(result.rows[0].status).toBe("PREVIEWED");
      expect(result.rows[0].proposerDid).toBe(AGENT_DIDS.TRADING);

      // Verify draft exists in database
      const draft = orm.trades.findById(result.rows[0].orderId as string);
      expect(draft).toBeDefined();
      expect(draft?.symbol).toBe("NVDA");
      expect(draft?.quantity).toBe(10);
    });

    it("NLQ classifies 'show my portfolio positions' and returns holdings", async () => {
      // Record a broker-confirmed execution on the draft first
      // (§7 adaptation, #2389: approval no longer settles locally —
      // the executed record is seeded the way the platform persists
      // it after a real placement; the NLQ positions read is the
      // subject under test).
      const draft = etrade.previewOrder({ sessionId, symbol: "MSFT", orderAction: "BUY", quantity: 10 });
      orm.trades.update(draft.orderId, {
        status: "executed",
        orderRef: "et_order_2389_nlq",
        authorizerDid: userDid,
        updatedAt: new Date().toISOString(),
      });

      const plan = await planNLQ(mockEnv, "show my portfolio positions");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("positions");

      const result = executeNLQQuery(orm, sessionId, plan);
      expect(result.domain).toBe("trading");
      expect(result.count).toBeGreaterThan(0);
      expect(result.rows[0].symbol).toBeDefined();
      expect(result.rows[0].marketValue).toBeDefined();
    });

    it("NLQ classifies 'Quote NVDA' and executeNLQQueryAsync fetches live quote with formatted market cap", async () => {
      const { executeNLQQueryAsync } = await import("../src/agents/nlq");
      const plan = await planNLQ(mockEnv, "Quote NVDA");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("quote");
      expect(plan.tradingData?.symbol).toBe("NVDA");

      const result = await executeNLQQueryAsync(orm, sessionId, plan, mockEnv, "test-user");
      expect(result.domain).toBe("trading");
      expect(result.count).toBe(1);
      const row = result.rows[0];
      expect(row.symbol).toBe("NVDA");
      expect(row.lastPrice).toBeDefined();
      expect(row.marketCap).not.toBe("$0.0B");
      expect(row.marketCap).toMatch(/\$[0-9.]+[TB]/);
      expect(row.source).toMatch(/Live|Market/);
    });

    it("DynamicMarketScreener.screenMarkets enriches stocks with real-time quotes", async () => {
      const listings: NasdaqStockListing[] = MOCK_TEST_UNIVERSE.filter((stock) => stock.sector === "Semiconductors").map((stock) => ({
        symbol: stock.symbol,
        companyName: stock.companyName,
        exchange: "nasdaq",
        lastPrice: stock.lastPrice,
        change: stock.change,
        changePercent: stock.changePercent,
        marketCap: (stock.marketCap || 0) * 1e9,
      }));
      DynamicMarketScreener.setTestListingsFixture(listings);
      const result = await etrade.screenMarketsAsync({ exchange: "NASDAQ", minPrice: 1, limit: 3 });
      expect(result.stocks.length).toBeGreaterThan(0);
      expect(result.stocks[0].price).toBeGreaterThan(0);
      expect(result.stocks[0].marketCap).toBeGreaterThan(0);
      expect(result.stocks.every((stock) => stock.listingExchange === "NASDAQ")).toBe(true);
    });

    it("screens the dynamic listings universe using visible exchange and price filters", async () => {
      const listings: NasdaqStockListing[] = [
        { symbol: "PASS", companyName: "Pass Corp", exchange: "nasdaq", lastPrice: 40, change: 2, changePercent: 5, marketCap: 100_000_000_000 },
        { symbol: "OTHER_EXCHANGE", companyName: "Other Corp", exchange: "nyse", lastPrice: 40, change: 2, changePercent: 5, marketCap: 100_000_000_000 },
        { symbol: "TOO_CHEAP", companyName: "Cheap Corp", exchange: "nasdaq", lastPrice: 5, change: 2, changePercent: 5, marketCap: 100_000_000_000 },
        { symbol: "LOSER", companyName: "Down Corp", exchange: "nasdaq", lastPrice: 40, change: -2, changePercent: -5, marketCap: 100_000_000_000 },
      ];
      DynamicMarketScreener.setTestListingsFixture(listings);

      const result = await etrade.screenMarketsAsync({
        exchange: "NASDAQ",
        minPrice: 20,
        maxPrice: 100,
        minMarketCap: 50,
        gainersOnly: true,
        limit: 20,
      });

      expect(result.discovery?.candidateCount).toBe(3);
      expect(result.stocks.map((stock) => stock.symbol)).toEqual(["PASS"]);
      expect(result.stocks[0].source).toContain("Nasdaq all-exchange stock listings");
    });

    it("explains an empty live candidate universe with mover and watchlist counts", async () => {
      DynamicMarketScreener.setTestListingsFixture([]);
      const result = await etrade.screenMarketsAsync({});

      expect(result.status).toBe("no_universe");
      expect(result.discovery?.candidateCount).toBe(0);
      expect(result.discovery?.message).toContain("Dynamic all-exchange listing request returned no rows");
    });

    it("NLQ classifies 'Preview buy 10 shares of NVDA at market' and executeNLQQueryAsync drafts order with live quote", async () => {
      const { executeNLQQueryAsync } = await import("../src/agents/nlq");
      const plan = await planNLQ(mockEnv, "Preview buy 10 shares of NVDA at market");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("preview_order");
      expect(plan.tradingData?.symbol).toBe("NVDA");
      expect(plan.tradingData?.quantity).toBe(10);

      const result = await executeNLQQueryAsync(orm, sessionId, plan, mockEnv, "test-user");
      expect(result.domain).toBe("trading");
      expect(result.count).toBe(1);
      const row = result.rows[0];
      expect(row.symbol).toBe("NVDA");
      expect(row.quantity).toBe(10);
      expect(row.action).toBe("BUY");
      expect(row.estimatedPrice).toBeDefined();
      expect(row.estimatedTotal).toBeDefined();
      expect(row.status).toBe("PREVIEWED");
    });
  });

  // =========================================================================
  // 6. Security Layer & Aspect-Oriented Sandbox Guards
  // =========================================================================
  describe("Security Layer & Aspect-Oriented Sandbox Guards", () => {
    it("etrade_auth_status MCP command inspects token health and active environment", async () => {
      const res = await McpToolFactory.executeTool("etrade_auth_status", {}, {
        env: mockEnv,
        orm,
        sessionId,
        audit: vi.fn(),
      });
      expect(res.broker).toBe("etrade");
      expect(res.environment).toBe("sandbox");
      expect(res.activeEnvironment).toBeDefined();
    });

    it("etrade_account_discovery MCP command discovers account list via real API contract", async () => {
      const res = await McpToolFactory.executeTool("etrade_account_discovery", {}, {
        env: mockEnv,
        orm,
        sessionId,
        audit: vi.fn(),
      });
      expect(res.accounts).toBeDefined();
      expect(Array.isArray(res.accounts)).toBe(true);
      expect(res.count).toBe(res.accounts.length);
    });

    it("assertSandboxUrlSafety blocks outgoing calls to live production when isLive is false", async () => {
      const { assertSandboxUrlSafety } = await import("../src/aspects/loggingAspect");
      const { ETradeErrorCode } = await import("../src/aspects/errorCodes");

      expect(() => {
        assertSandboxUrlSafety("https://api.etrade.com/v1/market/quote/NVDA.json", false);
      }).toThrowError(/SECURITY VIOLATION/);

      // Safe sandbox URLs must be allowed
      expect(() => {
        assertSandboxUrlSafety("https://apisb.etrade.com/v1/market/quote/NVDA.json", false);
      }).not.toThrow();

      // In live production mode, api.etrade.com must be allowed
      expect(() => {
        assertSandboxUrlSafety("https://api.etrade.com/v1/market/quote/NVDA.json", true);
      }).not.toThrow();
    });

    it("assertSandboxUrlSafety cannot be bypassed with userinfo or percent-encoded hosts (#1034/#1035)", async () => {
      const { assertSandboxUrlSafety } = await import("../src/aspects/loggingAspect");

      // Userinfo trick: the real host IS api.etrade.com (production). The old
      // substring check saw "apisb.etrade.com" inside the userinfo and let it through.
      expect(() => {
        assertSandboxUrlSafety("https://apisb.etrade.com@api.etrade.com/v1/market/quote/NVDA.json", false);
      }).toThrowError(/SECURITY VIOLATION/);

      // Percent-encoded host: invisible to the substring check, decoded by the URL parser.
      expect(() => {
        assertSandboxUrlSafety("https://%61pi.etrade.com/v1/market/quote/NVDA.json", false);
      }).toThrowError(/SECURITY VIOLATION/);

      // A non-E*TRADE host that merely contains the production hostname is not
      // live production (parity with the #843-#847 exact-hostname semantics).
      expect(() => {
        assertSandboxUrlSafety("https://api.etrade.com.evil.com/v1/market/quote/NVDA.json", false);
      }).not.toThrow();
    });

    it("fetchQuoteRemote rejects E*TRADE Sandbox Google mock stubs and returns authentic equity quotes", async () => {
      // NVDA quote must have NVIDIA Corporation and authentic pricing, NOT GOOGLE INC CL A or 577.51
      const nvda = await etrade.fetchQuoteRemote("NVDA");
      expect(nvda.symbol).toBe("NVDA");
      expect(nvda.companyName).toBe("NVIDIA Corporation");
      expect(nvda.companyName).not.toContain("GOOGLE INC");
      expect(nvda.lastPrice).not.toBe(577.51);
      expect(nvda.lastPrice).toBe(228.38);

      // AAPL quote must have Apple Inc. and authentic pricing, NOT GOOGLE INC CL A or 577.51
      const aapl = await etrade.fetchQuoteRemote("AAPL");
      expect(aapl.symbol).toBe("AAPL");
      expect(aapl.companyName).toBe("Apple Inc.");
      expect(aapl.companyName).not.toContain("GOOGLE INC");
      expect(aapl.lastPrice).not.toBe(577.51);

      // MSFT quote must have Microsoft Corporation and authentic pricing, NOT GOOGLE INC CL A or 577.51
      const msft = await etrade.fetchQuoteRemote("MSFT");
      expect(msft.symbol).toBe("MSFT");
      expect(msft.companyName).toBe("Microsoft Corporation");
      expect(msft.companyName).not.toContain("GOOGLE INC");
      expect(msft.lastPrice).not.toBe(577.51);
    });

    it("automatically recovers from E*TRADE preview timeout by acquiring fresh preview and clientOrderId", async () => {
      const liveEnv: Env = {
        ETRADE_CONSUMER_KEY: "mock_ckey",
        ETRADE_CONSUMER_SECRET: "mock_csecret",
        ETRADE_OAUTH_TOKEN: "mock_token",
        ETRADE_OAUTH_TOKEN_SECRET: "mock_tsecret",
        ETRADE_ACCOUNT_ID_KEY: "acct_83921048",
        ETRADE_ENVIRONMENT: "sandbox",
      } as Env;

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        // 1. Initial place call fails with E*TRADE timeout error
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              Error: {
                message: "For your protection, we have timed out your original order request. If you would like to place this order, please resubmit it now.",
              },
            }),
            { status: 400 }
          )
        )
        // 2. Auto-recovery calls previewOrder with a fresh unique clientOrderId
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              PreviewOrderResponse: {
                PreviewIds: [{ previewId: "999111" }],
                Order: [{ estimatedTotalAmount: 198.0 }],
              },
            }),
            { status: 200 }
          )
        )
        // 3. Auto-recovery re-submits placeOrder with the new previewId and fresh clientOrderId
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              PlaceOrderResponse: {
                OrderIds: [{ orderId: "888222" }],
              },
            }),
            { status: 200 }
          )
        );

      const tradingService = new ETradeService(orm, liveEnv, "test-user");
      const res = await tradingService.placeOrderRemote({
        orderId: "ord_51765383",
        symbol: "NVDA",
        action: "BUY",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 198.0,
        previewId: "old_expired_preview_123",
        userLogin: "did:user:github:openaimp",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(res.success).toBe(true);
      expect(res.status).toBe("executed");
      expect(res.executionId).toBe("et_order_888222");
      expect(res.brokerOrderRef).toBe("et_order_888222");

      // Verify the retry place request payload used the new previewId and a fresh clientOrderId
      const retryPlaceCall = fetchSpy.mock.calls[2];
      const retryBody = JSON.parse(retryPlaceCall[1]?.body as string);
      expect(retryBody.PlaceOrderRequest.PreviewIds[0].previewId).toBe(999111);
      expect(retryBody.PlaceOrderRequest.clientOrderId).not.toBe("ord51765383");
    });

    it("blocks order placement gracefully with actionable error when account key / OAuth connection is missing", async () => {
      const unauthEnv: Env = {
        ETRADE_CONSUMER_KEY: "mock_ckey",
        ETRADE_CONSUMER_SECRET: "mock_csecret",
        ETRADE_ENVIRONMENT: "sandbox",
      } as Env;

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        // fetchAccounts fails because user has no stored OAuth tokens
        .mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));

      const tradingService = new ETradeService(orm, unauthEnv, "test-user");
      const res = await tradingService.placeOrderRemote({
        orderId: "ord_unauth_123",
        symbol: "JPM",
        action: "BUY",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 293.0,
        userLogin: "did:user:github:openaimp",
      });

      expect(res.success).toBe(false);
      expect(res.status).toBe("failed");
      expect(res.message).toContain("E*TRADE Execution Blocked");
      expect(res.message).toMatch(/Account Not Connected|No active brokerage account|Session Expired|Token rejected/i);
      // Ensure it never attempted to place an order to /accounts//orders/place
      const calledUrls = fetchSpy.mock.calls.map((c) => String(c[0]));
      expect(calledUrls.some((u) => u.includes("/accounts//orders/place"))).toBe(false);
    });

    it("automatically recovers and acquires previewId when initial order lacks previewId and triggers E*TRADE timeout", async () => {
      const liveEnv: Env = {
        ETRADE_CONSUMER_KEY: "mock_ckey",
        ETRADE_CONSUMER_SECRET: "mock_csecret",
        ETRADE_OAUTH_TOKEN: "mock_token",
        ETRADE_OAUTH_TOKEN_SECRET: "mock_tsecret",
        ETRADE_ACCOUNT_ID_KEY: "acct_83921048",
        ETRADE_ENVIRONMENT: "sandbox",
      } as Env;

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        // 1. Initial place call fails with timeout because previewId was omitted/expired
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              Error: {
                message: "For your protection, we have timed out your original order request. If you would like to place this order, please resubmit it now.",
              },
            }),
            { status: 400 }
          )
        )
        // 2. Auto-recovery previewOrder acquires previewId
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              PreviewOrderResponse: {
                PreviewIds: [{ previewId: "555888" }],
                Order: [{ estimatedTotalAmount: 293.0 }],
              },
            }),
            { status: 200 }
          )
        )
        // 3. placeOrder executes with acquired previewId
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              PlaceOrderResponse: {
                OrderIds: [{ orderId: "333444" }],
              },
            }),
            { status: 200 }
          )
        );

      const tradingService = new ETradeService(orm, liveEnv, "test-user");
      const res = await tradingService.placeOrderRemote({
        orderId: "ord_no_preview_id",
        symbol: "JPM",
        action: "BUY",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 293.0,
        // Notice: previewId is completely omitted
        userLogin: "did:user:github:openaimp",
      });

      expect(fetchSpy).toHaveBeenCalledTimes(3);
      expect(res.success).toBe(true);
      expect(res.executionId).toBe("et_order_333444");

      // Verify that the PlaceOrderRequest retry sent the newly acquired previewId
      const placeCall = fetchSpy.mock.calls[2];
      const placeBody = JSON.parse(placeCall[1]?.body as string);
      expect(placeBody.PlaceOrderRequest.PreviewIds[0].previewId).toBe(555888);
    });

    it("recovers from preview timeout when E*TRADE returns XML previewId response", async () => {
      const liveEnv: Env = {
        ETRADE_CONSUMER_KEY: "mock_ckey",
        ETRADE_CONSUMER_SECRET: "mock_csecret",
        ETRADE_OAUTH_TOKEN: "mock_token",
        ETRADE_OAUTH_TOKEN_SECRET: "mock_tsecret",
        ETRADE_ACCOUNT_ID_KEY: "acct_83921048",
        ETRADE_ENVIRONMENT: "sandbox",
      } as Env;

      const fetchSpy = vi.spyOn(globalThis, "fetch")
        // 1. Initial place call fails with timeout
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              Error: {
                message: "For your protection, we have timed out your original order request. If you would like to place this order, please resubmit it now.",
              },
            }),
            { status: 400 }
          )
        )
        // 2. previewOrder returns XML format
        .mockResolvedValueOnce(
          new Response(
            `<PreviewOrderResponse>
              <PreviewIds><previewId>777999</previewId></PreviewIds>
              <Order><estimatedTotalAmount>293.00</estimatedTotalAmount></Order>
            </PreviewOrderResponse>`,
            { status: 200, headers: { "Content-Type": "application/xml" } }
          )
        )
        // 3. Retry placeOrder succeeds
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              PlaceOrderResponse: {
                OrderIds: [{ orderId: "666111" }],
              },
            }),
            { status: 200 }
          )
        );

      const tradingService = new ETradeService(orm, liveEnv, "test-user");
      const res = await tradingService.placeOrderRemote({
        orderId: "ord_timeout_xml",
        symbol: "JPM",
        action: "BUY",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 293.0,
        previewId: "expired_id",
        userLogin: "did:user:github:openaimp",
      });

      expect(res.success).toBe(true);
      expect(res.executionId).toBe("et_order_666111");

      const retryPlaceCall = fetchSpy.mock.calls[2];
      const retryBody = JSON.parse(retryPlaceCall[1]?.body as string);
      expect(retryBody.PlaceOrderRequest.PreviewIds[0].previewId).toBe(777999);
    });

    it("creates preview draft for HITL authorization even when broker returns collar notice or validation warning without previewId", async () => {
      const tokenStore = new Map<string, string>();
      const sessionStore = {
        idFromName: (name: string) => name,
        get: (_id: unknown) => ({
          fetch: async (request: Request) => {
            const payload = await request.json() as { op: string; ns: string; key: string; value?: string };
            const key = `${payload.ns}:${payload.key}`;
            if (payload.op === "get") return Response.json({ value: tokenStore.get(key) ?? null });
            if (payload.op === "put") {
              tokenStore.set(key, payload.value ?? "");
              return Response.json({ ok: true });
            }
            if (payload.op === "delete") {
              tokenStore.delete(key);
              return Response.json({ ok: true });
            }
            return Response.json({ error: "Unsupported operation" }, { status: 400 });
          },
        }),
      };
      const testEnv: Env = {
        ETRADE_CONSUMER_KEY: "mock_ckey",
        ETRADE_CONSUMER_SECRET: "mock_csecret",
        ETRADE_OAUTH_TOKEN: "mock_token",
        ETRADE_OAUTH_TOKEN_SECRET: "mock_tsecret",
        ETRADE_ACCOUNT_ID_KEY: "acct_83921048",
        ETRADE_ENVIRONMENT: "sandbox",
        SESSION_STORE: sessionStore as any,
      } as Env;
      await storeAccessTokens(testEnv, "openaimp", "mock_token", "mock_tsecret", "TEST");

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any) => {
        const url = String(input);
        if (url.includes("/quote/")) {
          return new Response(
            JSON.stringify({
              QuoteResponse: {
                QuoteData: [
                  {
                    All: {
                      lastTrade: 54.43,
                      bid: 54.22,
                      ask: 54.30,
                      companyName: "Bank of America Corporation",
                    },
                  },
                ],
              },
            }),
            { status: 200 }
          );
        }
        if (url.includes("/orders/preview")) {
          return new Response(
            `<PreviewOrderResponse>
              <messageList>
                <Message>
                  <code>1029</code>
                  <description>Proposed limit price $43.30 is outside prevailing market collar threshold</description>
                </Message>
              </messageList>
            </PreviewOrderResponse>`,
            { status: 200 }
          );
        }
        return new Response("Not Found", { status: 404 });
      });

      const tradingService = new ETradeService(orm, testEnv, "openaimp");
      const draft = await tradingService.previewOrderRemote({
        sessionId: "openaimp",
        symbol: "BAC",
        action: "BUY",
        quantity: 1,
        orderType: "LIMIT",
        limitPrice: 43.30,
      });

      expect(draft).toBeDefined();
      expect(draft.orderId).toMatch(/^ord_/);
      expect(draft.status).toBe("previewed");
      expect(draft.symbol).toBe("BAC");
      expect(draft.quantity).toBe(1);
      expect(draft.limitPrice).toBe(43.30);
      expect(draft.proposerDid).toBe("did:agent:openaimp:trading");
      expect(draft.authorizerDid).toBe("did:user:github:openaimp");
      expect(draft.previewNotes).toContain("Proposed limit price $43.30 is outside prevailing market collar");
    });

    it("requires a connected broker preview for option strategies and never falls back to simulated pricing", async () => {
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Underlying quote must not be requested for an option strategy"));
      const optionLegs: TradingOrderLeg[] = [
        { underlyingSymbol: "CRWV", securityType: "OPTN", side: "SELL", quantity: 1, optionType: "PUT", strike: 30, expirationDate: "2026-11-20" },
        { underlyingSymbol: "CRWV", securityType: "OPTN", side: "BUY", quantity: 1, optionType: "PUT", strike: 25, expirationDate: "2026-11-20" },
      ];
      try {
        await expect(new ETradeService(orm, mockEnv, "openaimp").previewOrderRemote({
          sessionId: "openaimp",
          symbol: "CRWV",
          orderAction: "BUY",
          quantity: 1,
          orderType: "LIMIT",
          limitPrice: 0.75,
          optionLegs,
          strategyNetDebit: -75,
        })).rejects.toThrow(/Connect and authorize E\*TRADE/);

        expect(fetchSpy).not.toHaveBeenCalled();
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it("does not provide a hard-coded default securities universe", async () => {
      const screener = new DynamicMarketScreener();
      const defaultUni = screener.getDefaultUniverse();
      expect(defaultUni).toEqual([]);
    });

    it("searches the dynamic listings table by ticker and company name", async () => {
      try {
        DynamicMarketScreener.setTestListingsFixture([{
          symbol: "DELL",
          companyName: "Dell Technologies Inc.",
          exchange: "nasdaq",
          lastPrice: 120,
          change: 1,
          changePercent: 0.84,
          marketCap: 50_000_000_000,
        }]);
        const tradingService = new ETradeService(orm, mockEnv, "test-user");
        const res = await tradingService.screenMarketsAsync({ search: "DELL" });
        expect(res.ledger.universeSymbols).toContain("DELL");
        expect(res.stocks[0].companyName).toBe("Dell Technologies Inc.");
      } finally {
        DynamicMarketScreener.setTestListingsFixture(null);
      }
    });

    it("does not assign fake RSI values when the provider omits indicators", async () => {
      DynamicMarketScreener.setTestUniverseFixture([]);
      try {
        const screener = new DynamicMarketScreener();
        const res = screener.screenWithQuotes([{
          symbol: "CUSTOM",
          companyName: "Custom Corp",
          lastPrice: 100,
          price: 100,
          change: 1,
          changePercent: 1,
          bid: 99.9,
          ask: 100.1,
          volume: 1000,
          open: 99,
          high: 101,
          low: 98,
          week52High: 120,
          week52Low: 80,
          timestamp: new Date().toISOString(),
        }], { maxRsi: 40 });
        expect(res.stocks).toHaveLength(0);
        expect(res.ledger.rejections[0].reason).toContain("N/A");
      } finally {
        DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
      }
    });
  });
});

