import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  YahooFinanceProvider,
  AlpacaMarketDataProvider,
  HybridMarketDataProvider,
  MarketDataResearchService,
} from "../src/services/marketDataResearch";
import { AGENT_DIDS } from "../src/agents/did";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MCP_RESOURCES, MCP_PROMPTS, readMCPResource } from "../src/mcps/openaimp/index";
import { planNLQ, executeNLQQuery } from "../src/agents/nlq";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";

describe("Market Data Research & Quoting (Yahoo Finance & Alpaca APIs)", () => {
  const mockEnv: Env = {
    APP_BASE_URL: "https://agent.openaimp.com",
    AI_SEARCH_ENDPOINT: "https://ai-search.internal",
    ORCHESTRATOR_AGENT: {} as any,
    ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
    ALPACA_DATA_URL: "https://data.alpaca.markets",
    MARKET_DATA_PROVIDER: "hybrid",
  };

  let yfProvider: YahooFinanceProvider;
  let alpacaProvider: AlpacaMarketDataProvider;
  let hybridProvider: HybridMarketDataProvider;
  let researchService: MarketDataResearchService;
  let orm: DatabaseORM;
  const sessionId = "test_research_session_001";
  const userDid = "did:user:github:analyst_user";

  beforeEach(() => {
    // #411: hermetic suite — no real network. #923 (epic #913 S5) removed
    // the providers' deterministic fallback data, so with fetch blocked
    // every live market-data call now rejects with an explicit unavailable error
    // instead of returning fallback values; the tests below pin that
    // rejection (live behaviour itself is pinned by the mocked-fetch
    // suites: market_data_provenance, market_data_substrate_live_only_p923, and the
    // data-provider Yahoo/Alpaca suites).
    vi.stubGlobal("fetch", async () => {
      throw new Error(
        "network disabled in market_data_research tests (#411): providers must use their deterministic fallback"
      );
    });
    yfProvider = new YahooFinanceProvider();
    alpacaProvider = new AlpacaMarketDataProvider();
    hybridProvider = new HybridMarketDataProvider();
    researchService = new MarketDataResearchService(mockEnv);

    const sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema(sessionId);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // =========================================================================
  // 1. Yahoo Finance Provider (yfinance)
  // =========================================================================
  describe("YahooFinanceProvider", () => {
    it("fetch failure rejects explicit unavailable instead of a fallback quote (#923)", async () => {
      await expect(yfProvider.getQuote("NVDA")).rejects.toThrow(/unavailable/i);
    });

    it("fetch failure rejects explicit unavailable instead of profile fundamentals (#923)", async () => {
      await expect(yfProvider.getFundamentals("MSFT")).rejects.toThrow(/unavailable/i);
    });

    it("fetch failure rejects explicit unavailable instead of synthetic bars (#923)", async () => {
      await expect(yfProvider.getHistoricalBars("AAPL", "1D", 30)).rejects.toThrow(/unavailable/i);
    });

    it("unknown tickers reject — no hash-invented profile (#923)", async () => {
      await expect(yfProvider.getQuote("CUSTOMCORP")).rejects.toThrow(/unavailable/i);
    });
  });

  // =========================================================================
  // 2. Alpaca Market Data Provider
  // =========================================================================
  describe("AlpacaMarketDataProvider", () => {
    it("unconfigured Alpaca quote rejects — no profile quote (#923)", async () => {
      await expect(alpacaProvider.getQuote("AAPL")).rejects.toThrow(/unavailable/i);
    });

    it("unconfigured Alpaca snapshot rejects — no profile snapshot (#923)", async () => {
      await expect(alpacaProvider.getMarketSnapshot("NVDA")).rejects.toThrow(/unavailable/i);
    });

    it("unconfigured Alpaca crypto quote and snapshot reject (#923)", async () => {
      await expect(alpacaProvider.getQuote("BTC/USD")).rejects.toThrow(/unavailable/i);
      await expect(alpacaProvider.getMarketSnapshot("BTC/USD")).rejects.toThrow(/unavailable/i);
    });
  });

  // =========================================================================
  // 3. Hybrid Market Data Provider
  // =========================================================================
  describe("HybridMarketDataProvider (Alpaca Real-Time + YFinance Valuation)", () => {
    it("offline hybrid quote rejects — no blended profile quote (#923)", async () => {
      await expect(hybridProvider.getQuote("GOOGL")).rejects.toThrow(/unavailable/i);
    });
  });

  // =========================================================================
  // 4. MarketDataResearchService Facade & Autonomous Agent Attestation
  // =========================================================================
  describe("MarketDataResearchService Facade", () => {
    it("offline research report rejects — no non-live report is assembled (#923)", async () => {
      await expect(researchService.generateResearchReport("NVDA")).rejects.toThrow(/unavailable/i);
    });

    it("offline comparison rejects — no profile comparison (#923)", async () => {
      await expect(researchService.compareStocks(["NVDA", "AMD", "MSFT"])).rejects.toThrow(
        /unavailable/i,
      );
    }, 15000);

    it("inspects live health status of market data providers", async () => {
      const statuses = await researchService.getProviderStatuses();
      expect(statuses.length).toBe(3);
      const yf = statuses.find((s) => s.provider === "yfinance");
      const alpaca = statuses.find((s) => s.provider === "alpaca");
      expect(yf?.configured).toBe(true);
      expect(alpaca?.configured).toBe(false);
    });
  });

  // =========================================================================
  // 5. GoF MCP Tool Commands Integration
  // =========================================================================
  describe("GoF MCP Tool Commands", () => {
    const getContext = () => ({
      env: mockEnv,
      orm,
      sessionId,
      audit: () => {},
    });

    it("market_data_get_quote tool rejects offline — no fallback quote (#923)", async () => {
      await expect(
        McpToolFactory.executeTool("market_data_get_quote", {
          symbol: "TSLA",
          provider: "hybrid",
        }, getContext()),
      ).rejects.toThrow(/unavailable/i);
    });

    it("foss_get_quote alias tool rejects offline — same as canonical (#1906)", async () => {
      await expect(
        McpToolFactory.executeTool("foss_get_quote", {
          symbol: "TSLA",
          provider: "hybrid",
        }, getContext()),
      ).rejects.toThrow(/unavailable/i);
    });

    it("market_data_company_fundamentals tool rejects offline — no profile fundamentals (#923)", async () => {
      await expect(
        McpToolFactory.executeTool("market_data_company_fundamentals", {
          symbol: "AAPL",
        }, getContext()),
      ).rejects.toThrow(/unavailable/i);
    });

    it("market_data_historical_bars tool rejects offline — no synthetic bars (#923)", async () => {
      await expect(
        McpToolFactory.executeTool("market_data_historical_bars", {
          symbol: "AMZN",
          period: "1mo",
          timeframe: "1d",
        }, getContext()),
      ).rejects.toThrow(/unavailable/i);
    });

    it("market_data_research tool rejects offline — no non-live report (#923)", async () => {
      await expect(
        McpToolFactory.executeTool("market_data_research", {
          symbol: "PLTR",
        }, getContext()),
      ).rejects.toThrow(/unavailable/i);
    });

    it("alpaca_snapshot tool rejects offline — no profile snapshot (#923)", async () => {
      const ctx = {
        ...getContext(),
        audit: () => {},
      };

      await expect(
        McpToolFactory.executeTool("alpaca_snapshot", {
          symbol: "BTC/USD",
        }, ctx),
      ).rejects.toThrow(/unavailable/i);
    });

    it("executes alpaca_account tool via McpToolFactory with agentic DID audit tracing", async () => {
      const audits: any[] = [];
      const ctx = {
        ...getContext(),
        audit: (type: string, domain: string, payload: any) => {
          audits.push({ type, domain, payload });
        },
      };

      const result = await McpToolFactory.executeTool("alpaca_account", {}, ctx);
      expect(result).toBeDefined();
      expect(audits.some((a) => a.type === "alpaca.account.query" && a.domain === "trading")).toBe(true);
    });

    it("executes alpaca_positions tool via McpToolFactory with agentic DID audit tracing", async () => {
      const audits: any[] = [];
      const ctx = {
        ...getContext(),
        audit: (type: string, domain: string, payload: any) => {
          audits.push({ type, domain, payload });
        },
      };

      const result = await McpToolFactory.executeTool("alpaca_positions", {}, ctx);
      expect(result).toBeDefined();
      expect(audits.some((a) => a.type === "alpaca.positions.query" && a.domain === "trading")).toBe(true);
    });

    it("executes alpaca_orders tool via McpToolFactory with status filter and audit tracing", async () => {
      const audits: any[] = [];
      const ctx = {
        ...getContext(),
        audit: (type: string, domain: string, payload: any) => {
          audits.push({ type, domain, payload });
        },
      };

      const result = await McpToolFactory.executeTool("alpaca_orders", { status: "all" }, ctx);
      expect(result).toBeDefined();
      expect(audits.some((a) => a.type === "alpaca.orders.query" && a.payload.status === "all")).toBe(true);
    });

    it("executes alpaca_place_order tool via McpToolFactory with agentic DID audit tracing", async () => {
      const audits: any[] = [];
      const ctx = {
        ...getContext(),
        audit: (type: string, domain: string, payload: any) => {
          audits.push({ type, domain, payload });
        },
      };

      const result = await McpToolFactory.executeTool("alpaca_place_order", {
        symbol: "NVDA",
        qty: 1,
        side: "buy",
        type: "limit",
        limit_price: 120.5,
      }, ctx);

      expect(result).toBeDefined();
      expect(audits.some((a) => a.type === "alpaca.order.place" && a.payload.symbol === "NVDA")).toBe(true);
    });

    it("supports both ALPACA_API_KEY and ALPACA_API_KEY_ID environment variable configurations", () => {
      const envWithStandardKey: Env = {
        ...mockEnv,
        ALPACA_API_KEY: "test_key_alpaca",
        ALPACA_SECRET_KEY: "test_secret_alpaca",
      };
      const provider1 = new AlpacaMarketDataProvider(envWithStandardKey);
      expect(provider1.getApiKey()).toBe("test_key_alpaca");
      expect(provider1.getApiSecret()).toBe("test_secret_alpaca");
      expect(provider1.isConfigured()).toBe(true);

      const service = new MarketDataResearchService(envWithStandardKey);
      const statuses = service.getProviderStatuses();
      const alpacaStatus = statuses.find((s) => s.provider === "alpaca");
      expect(alpacaStatus?.configured).toBe(true);
      expect(alpacaStatus?.mode).toBe("live_api");
    });
  });

  // =========================================================================
  // 6. MCP Protocol Resources & Prompts
  // =========================================================================
  describe("MCP Resources & Prompts", () => {
    it("exposes market-data resources in MCP_RESOURCES", () => {
      const uris = MCP_RESOURCES.map((r) => r.uri);
      expect(uris).toContain("market-data://market/quote/NVDA");
      expect(uris).toContain("market-data://research/fundamentals/NVDA");
      expect(uris).toContain("market-data://providers/status");
    });

    it("lists deprecated legacy resource aliases in MCP_RESOURCES (#1906)", () => {
      const uris = MCP_RESOURCES.map((r) => r.uri);
      expect(uris).toContain("foss://market/quote/NVDA");
      expect(uris).toContain("foss://research/fundamentals/NVDA");
      expect(uris).toContain("foss://providers/status");
    });

    it("market-data quote resource rejects offline — no fallback quote (#923)", async () => {
      await expect(readMCPResource("market-data://market/quote/NVDA", { orm, sessionId })).rejects.toThrow(
        /unavailable/i,
      );
    });

    it("reads market-data providers status resource", async () => {
      const res = await readMCPResource("market-data://providers/status", { orm, sessionId });
      expect(res.uri).toBe("market-data://providers/status");
      const legacy = await readMCPResource("foss://providers/status", { orm, sessionId });
      expect(legacy.uri).toBe("foss://providers/status");
      expect(JSON.parse(legacy.text)).toEqual(JSON.parse(res.text));
      const parsed = JSON.parse(res.text);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed.some((p: any) => p.provider === "yfinance")).toBe(true);
    });

    it("exposes and renders market_data_equity_research_report prompt", () => {
      const prompt = MCP_PROMPTS.find((p) => p.name === "market_data_equity_research_report");
      expect(prompt).toBeDefined();
      expect(prompt?.description).toContain("equity research report");
      expect(prompt?.arguments?.some((a) => a.name === "symbol")).toBe(true);
    });

    it("exposes deprecated legacy prompt alias (#1906)", () => {
      const prompt = MCP_PROMPTS.find((p) => p.name === "foss_equity_research_report");
      expect(prompt).toBeDefined();
      expect(prompt?.arguments?.some((a) => a.name === "symbol")).toBe(true);
    });
  });

  // =========================================================================
  // 7. Natural Language Query (NLQ) Routing & Execution
  // =========================================================================
  describe("NLQ Agentic Research & Quoting Integration", () => {
    it("plans NLQ query for equity research (research NVDA)", async () => {
      const plan = await planNLQ(mockEnv, "Perform market-data equity research on NVDA using yfinance and Alpaca");
      expect(plan.domain).toBe("research");
      expect(plan.researchData?.action).toBe("report");
      expect(plan.researchData?.symbol).toBe("NVDA");
    });

    it("plans NLQ query for market quote (quote BTC/USD)", async () => {
      const plan = await planNLQ(mockEnv, "Get live Alpaca quote and NBBO spread for BTC/USD");
      expect(plan.domain).toBe("research");
      expect(plan.researchData?.action).toBe("quote");
      expect(plan.researchData?.symbol).toBe("BTC/USD");
    });

    it("plans NLQ query for stock comparison (compare NVDA and AMD)", async () => {
      const plan = await planNLQ(mockEnv, "Compare valuation multiples between NVDA and AMD");
      expect(plan.domain).toBe("research");
      expect(plan.researchData?.action).toBe("compare");
      expect(plan.researchData?.symbols).toContain("NVDA");
      expect(plan.researchData?.symbols).toContain("AMD");
    });

    it("executes NLQ research report query and returns explicit unavailable, no rows (#923)", async () => {
      const plan = await planNLQ(mockEnv, "Run deep research on NVDA");
      const result = executeNLQQuery(orm, sessionId, plan, mockEnv, userDid);

      expect(result.domain).toBe("research");
      expect(result.count).toBe(0);
      expect(result.status).toBe("error");
      expect(result.rows.length).toBe(0);
      expect(result.summary).toContain("NVDA");
      expect(result.summary).toMatch(/unavailable/i);
      expect(result.summary).toMatch(/#923/);
    });

    it("executes NLQ quote query and returns explicit unavailable, no rows (#923)", async () => {
      const plan = await planNLQ(mockEnv, "Get market-data quote for AAPL on yfinance");
      const result = executeNLQQuery(orm, sessionId, plan, mockEnv, userDid);

      expect(result.domain).toBe("research");
      expect(result.count).toBe(0);
      expect(result.status).toBe("error");
      expect(result.rows.length).toBe(0);
      expect(result.summary).toMatch(/unavailable/i);
    });

    it("executes NLQ comparison query and returns explicit unavailable, no rows (#923)", async () => {
      const plan = await planNLQ(mockEnv, "Compare valuation of NVDA and AMD");
      const result = executeNLQQuery(orm, sessionId, plan, mockEnv, userDid);

      expect(result.domain).toBe("research");
      expect(result.count).toBe(0);
      expect(result.status).toBe("error");
      expect(result.rows.length).toBe(0);
      expect(result.summary).toMatch(/unavailable/i);
    });
  });
});
