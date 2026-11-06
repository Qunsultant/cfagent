import { describe, it, expect, beforeEach, vi } from "vitest";
import { generateObject, generateText } from "ai";
import { planNLQ, executeNLQQuery, executeNaturalLanguageQuery, formatMarketCap, extractOrderParameters } from "../src/agents/nlq";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { DynamicMarketScreener } from "../src/trading/screener";
import { MOCK_TEST_UNIVERSE } from "./fixtures/mockUniverse";
import type { Env } from "../src/types";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateObject: vi.fn(),
    generateText: vi.fn(),
  };
});

describe("Natural Language Query (NLQ) Engine", () => {
  let sql: MockSqlStorage;
  let orm: DatabaseORM;
  const mockEnv: Env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
  };

  beforeEach(() => {
    DynamicMarketScreener.setTestUniverseFixture(MOCK_TEST_UNIVERSE);
    sql = new MockSqlStorage();
    orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
  });

  describe("NLQ Planner Fast-paths", () => {
    it("parses stock listing price, exchange, market-cap, and result-limit filters", async () => {
      const plan = await planNLQ(
        mockEnv,
        "Screen Nasdaq stocks priced between $20 and $200 with market cap above $50B; show 30 stocks"
      );

      expect(plan.tradingData?.action).toBe("screen");
      expect(plan.tradingData?.filters?.exchange).toBe("NASDAQ");
      expect(plan.tradingData?.filters?.minPrice).toBe(20);
      expect(plan.tradingData?.filters?.maxPrice).toBe(200);
      expect(plan.tradingData?.filters?.minMarketCap).toBe(50);
      expect(plan.tradingData?.filters?.limit).toBe(30);
    });

    it("parses the stock price-range shortcut without adding sector or RSI constraints", async () => {
      const plan = await planNLQ(mockEnv, "Find stocks priced between $20 and $200");

      expect(plan.tradingData?.action).toBe("screen");
      expect(plan.tradingData?.filters?.minPrice).toBe(20);
      expect(plan.tradingData?.filters?.maxPrice).toBe(200);
      expect(plan.tradingData?.filters?.sector).toBeUndefined();
      expect(plan.tradingData?.filters?.minRsi).toBeUndefined();
      expect(plan.tradingData?.filters?.maxRsi).toBeUndefined();
    });

    it("classifies schema and table queries into domain 'tables'", async () => {
      const plan = await planNLQ(mockEnv, "List all database tables and schema");
      expect(plan.domain).toBe("tables");
      expect(plan.operation).toBe("list");
    });

    it("classifies category creation into domain 'category_mutation'", async () => {
      const plan = await planNLQ(mockEnv, "Add category 'Autonomous Agents' to categories table");
      expect(plan.domain).toBe("category_mutation");
      expect(plan.operation).toBe("create");
      expect(plan.categoryData?.name).toBe("Autonomous Agents");
    });

    it("classifies table data requests into domain 'table_data'", async () => {
      const plan = await planNLQ(mockEnv, "Show referral categories");
      expect(plan.domain).toBe("table_data");
      expect(plan.targetTable).toBe("mas_categories");
    });

    it("routes strategy evaluation ledger requests ahead of generic table queries", async () => {
      const plan = await planNLQ(
        mockEnv,
        "list all strategies evaluated for NVDA bullish target $260"
      );

      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("options_strategies");
      expect(plan.tradingData?.symbol).toBe("NVDA");
      expect(plan.tradingData?.filters).toMatchObject({
        showEvaluations: true,
        request: { symbol: "NVDA", thesis: "bullish", targetPrice: 260 },
      });
    });

    it("keeps Auto Options Research panel suffixes on the strategy-evaluation path", async () => {
      const plan = await planNLQ(
        mockEnv,
        "list all strategies evaluated for NVDA bullish target $260; scan up to 10 underlyings; quote age reference 60 seconds"
      );

      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("options_strategies");
      expect(plan.tradingData?.filters).toMatchObject({
        showEvaluations: true,
        request: { symbol: "NVDA", thesis: "bullish", targetPrice: 260, maxQuoteAgeSeconds: 60 },
      });
    });

    it("classifies options flow queries into domain 'trading' with action 'options_flow'", async () => {
      const plan = await planNLQ(mockEnv, "Show unusual options flow for NVDA");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("options_flow");
      expect(plan.tradingData?.symbol).toBe("NVDA");
      expect(plan.tradingData?.filters?.unusualOnly).toBe(true);
    });

    it("classifies conversation questions into domain 'conversation'", async () => {
      const plan = await planNLQ(mockEnv, "How many questions did the user ask?");
      expect(plan.domain).toBe("conversation");
      expect(plan.role).toBe("user");
    });
  });

  describe("NLQ Query Execution over DatabaseORM", () => {
    it("executes domain 'tables' and returns schema metadata", () => {
      const plan = {
        domain: "tables" as const,
        operation: "list" as const,
        terms: "",
        role: "any" as const,
        since: null,
        limit: 25,
      };

      const result = executeNLQQuery(orm, "test_session", plan);
      expect(result.domain).toBe("tables");
      expect(result.count).toBe(11); // 11 after mas_reports (#278)
      expect(result.rows.some((r) => r.tableName === "mas_categories")).toBe(true);
      expect(result.rows.some((r) => r.tableName === "mas_trades")).toBe(true);
      expect(result.rows.some((r) => r.tableName === "mas_external_ads")).toBe(true);
    });

    it("executes domain 'category_mutation' and adds new category to mas_categories", () => {
      const initialCount = orm.categories.count();
      const plan = {
        domain: "category_mutation" as const,
        operation: "create" as const,
        categoryData: {
          name: "Edge Compute & Serverless",
          description: "Edge infrastructure and workers",
          icon: "⚡",
        },
        terms: "Edge Compute & Serverless",
        role: "any" as const,
        since: null,
        limit: 25,
      };

      const result = executeNLQQuery(orm, "test_session", plan);
      expect(result.domain).toBe("category_mutation");
      expect(result.count).toBe(initialCount + 1);

      const added = orm.categories.findMany().find((c) => c.name === "Edge Compute & Serverless");
      expect(added).toBeDefined();
      expect(added?.icon).toBe("⚡");
    });

    it("executes domain 'table_data' and returns rows from target table", () => {
      const plan = {
        domain: "table_data" as const,
        operation: "list" as const,
        targetTable: "mas_external_ads",
        terms: "",
        role: "any" as const,
        since: null,
        limit: 10,
      };

      const result = executeNLQQuery(orm, "test_session", plan);
      expect(result.domain).toBe("table_data");
      expect(result.rows.length).toBeGreaterThan(0);
      expect(result.rows[0].cpm_rate ?? result.rows[0].cpmRate).toBeDefined();
    });
  });

  describe("Market Screener NLQ & Audit Ledger Verification", () => {
    it("formatMarketCap scales raw dollars and billions accurately without redundant unit suffixes", () => {
      // Raw dollar numbers (from Yahoo Finance / live feeds)
      expect(formatMarketCap(3.39e12)).toBe("$3.39T");
      expect(formatMarketCap(2.53e11)).toBe("$253.00B");
      expect(formatMarketCap(4.5e10)).toBe("$45.00B");
      // Billion-normalized numbers (from internal screener universe)
      expect(formatMarketCap(3390)).toBe("$3.39T");
      expect(formatMarketCap(253)).toBe("$253.0B");
      expect(formatMarketCap(45.2)).toBe("$45.2B");
      // Edge cases
      expect(formatMarketCap(undefined)).toBe("N/A");
      expect(formatMarketCap(0)).toBe("N/A");
    });

    it("executes 'Show top momentum gainers' with strict filter enforcement, audit ledger, and fail-closed validation", async () => {
      const plan = await planNLQ(mockEnv, "Show top momentum gainers");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("screen");
      expect(plan.tradingData?.filters?.gainersOnly).toBe(true);

      const result = executeNLQQuery(orm, "test_session", plan);
      expect(result.targetTable).toBe("etrade_market_screener");
      expect(result.status).toBe("matches_found");

      // Verify every returned row is strictly positive
      expect(result.rows.length).toBeGreaterThan(0);
      for (const row of result.rows) {
        expect(String(row.change)).toMatch(/^\+/);
        expect(row.actionAvailable).toContain("Preview Buy/Sell");
        expect(row.changePeriod).toBe("1D (Regular Trading Day)");
        expect(row.rsiLookback).toBe("14-Period Daily RSI");
        expect(row.calculationVersion).toBe("MACD (12, 26, 9 EMA)");
        expect(row.priorClose).toBeDefined();
        // Market cap should NEVER have nonsensical trillion prefixes like $3390000000.00T
        expect(String(row.marketCap)).not.toMatch(/\$3390000000/);
        expect(String(row.marketCap)).toMatch(/^\$[0-9.]+[TB]$/);
        // MACD signal should be an authentic technical indicator, not a pattern name
        expect(String(row.macdSignal)).not.toContain("Support Bounce at 50-Day EMA");
        expect(String(row.macdSignal)).not.toContain("New 52-Week High Breakout");
        expect(String(row.macdSignal)).toMatch(/MACD|Centerline|Divergence/);
      }

      // Verify Scan Ledger is present and accurately documents rejected symbols
      expect(result.scanLedger).toBeDefined();
      const ledger = result.scanLedger as any;
      expect(ledger.universeSymbols).toHaveLength(10);
      expect(ledger.totalEvaluated).toBe(10);
      expect(ledger.passedCount + ledger.rejectedCount).toBe(10);
      // Losers like AVGO, AAPL, TSLA, GOOGL, META must be in rejections with clear explanations
      expect(ledger.rejections.some((r: any) => r.symbol === "AVGO")).toBe(true);
      const avgoRej = ledger.rejections.find((r: any) => r.symbol === "AVGO");
      expect(avgoRej.reason).toContain("violates gainersOnly rule");
    });
  });

  describe("Hybrid Tiered NLQ Planning (LLM Structured Outputs & Deterministic Fallback)", () => {
    it("marks deterministic fast-path plans with planSource 'fastpath' when AI binding is omitted", async () => {
      const plan = await planNLQ(mockEnv, "Find stocks priced between $20 and $200");
      expect(plan.planSource).toBe("fastpath");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("screen");
    });

    it("respects skipLLM option and executes fast-path directly", async () => {
      const envWithAI: Env = {
        ...mockEnv,
        AI: { run: vi.fn() } as any,
      };
      const plan = await planNLQ(envWithAI, "List all database tables and schema", { skipLLM: true });
      expect(plan.planSource).toBe("fastpath");
      expect(plan.domain).toBe("tables");
    });

    it("uses LLM structured output when Workers AI binding is functional", async () => {
      const envWithAI: Env = {
        ...mockEnv,
        AI: { run: vi.fn() } as any,
      };

      const mockLlmPlan = {
        domain: "trading" as const,
        operation: "search" as const,
        tradingData: {
          action: "screen" as const,
          filters: { minPrice: 50, maxPrice: 150, sector: "Technology" },
        },
        terms: "tech stocks 50 to 150",
        role: "any" as const,
        since: null,
        limit: 25,
      };

      vi.mocked(generateObject).mockResolvedValueOnce({
        object: mockLlmPlan,
      } as any);

      const plan = await planNLQ(envWithAI, "Find tech stocks between $50 and $150");
      expect(generateObject).toHaveBeenCalled();
      expect(plan.planSource).toBe("llm");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.filters?.sector).toBe("Technology");
    });

    it("falls back to deterministic rules with planSource 'fallback' when LLM throws an error", async () => {
      const envWithAI: Env = {
        ...mockEnv,
        AI: { run: vi.fn() } as any,
      };

      vi.mocked(generateObject).mockRejectedValueOnce(new Error("Workers AI Rate Limit / 429 Overloaded"));
      vi.mocked(generateText).mockRejectedValueOnce(new Error("Backup generateText timeout"));

      const plan = await planNLQ(envWithAI, "Show referral categories");
      expect(plan.planSource).toBe("fallback");
      expect(plan.domain).toBe("table_data");
      expect(plan.targetTable).toBe("mas_categories");
    });

    it("recovers via secondary generateText with JSON extraction if generateObject throws", async () => {
      const envWithAI: Env = {
        ...mockEnv,
        AI: { run: vi.fn() } as any,
      };

      vi.mocked(generateObject).mockRejectedValueOnce(new Error("Schema constraint not supported by model"));
      vi.mocked(generateText).mockResolvedValueOnce({
        text: JSON.stringify({
          domain: "tables",
          operation: "list",
          terms: "",
          limit: 10,
        }),
      } as any);

      const plan = await planNLQ(envWithAI, "What tables exist in the database?");
      expect(plan.planSource).toBe("llm");
      expect(plan.domain).toBe("tables");
    });

    it("propagates planSource to executeNaturalLanguageQuery result", async () => {
      const result = await executeNaturalLanguageQuery(
        orm,
        "test_session",
        "Show referral categories",
        mockEnv
      );

      expect(result.plan.planSource).toBe("fastpath");
      expect(result.result.planSource).toBe("fastpath");
      expect(result.result.domain).toBe("table_data");
    });
  });

  describe("Options Strategy NLQ Routing & LLM Validation", () => {
    it("routes 'find strategies where max profit is more than max loss' to options_opportunities and sets maxProfitGreaterThanMaxLoss", async () => {
      const query = "find strategies where max profit is more than max loss; scan up to 25 underlyings; quote age reference 60 seconds";
      const plan = await planNLQ(mockEnv, query, { context: "options", validateWithLLM: true });
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("options_opportunities");
      expect(plan.tradingData?.strategyFilter?.maxProfitGreaterThanMaxLoss).toBe(true);
      expect(plan.tradingData?.request?.minRewardRisk).toBe(1.0);
      expect(plan.tradingData?.scope?.kind).toBe("universe");
      expect(plan.tradingData?.scope?.maxSymbols).toBeLessThanOrEqual(25);
      expect(plan.tradingData?.scope?.maxSymbols).toBeGreaterThan(0);
    });

    it("evaluates and validates options query with LLM validation metadata", async () => {
      const query = "find strategies where max profit is more than max loss";
      // Mock LLM validation response to avoid real API call (prevents timeout)
      vi.mocked(generateObject).mockResolvedValueOnce({
        object: {
          isValid: true,
          detectedDomain: "options_strategy",
          suggestedAction: "options_opportunities",
          preventedStockScreenerFallback: true,
        },
      } as any);
      const result = await executeNaturalLanguageQuery(orm, "test_session", query, mockEnv, {
        context: "options",
        validateWithLLM: true,
      });

      expect(result.result.llmValidation).toBeDefined();
      expect(result.result.llmValidation?.isValid).toBe(true);
      expect(result.result.llmValidation?.detectedDomain).toBe("options_strategy");
      expect(result.result.llmValidation?.suggestedAction).toBe("options_opportunities");
      expect(result.result.llmValidation?.preventedStockScreenerFallback).toBe(true);
      // Crucial: Must NEVER return stock market screener or penny stocks for an options strategy prompt!
      expect(result.result.targetTable).not.toBe("etrade_market_screener");
      expect(result.plan.tradingData?.action).not.toBe("screen");
    });

    it("guards against fallback to stock screener when options keywords are present", async () => {
      const plan = await planNLQ(mockEnv, "find strategies where max profit is more than max loss");
      expect(plan.tradingData?.action).toBe("options_opportunities");
      expect(plan.tradingData?.action).not.toBe("screen");
    });

    it("parses explicit reward:risk ratios like 1:2, 1:3, 1:4, 2x, and percentages like 50%", async () => {
      const plan12 = await planNLQ(mockEnv, "find strategies where max profit is greater than max loss by 1:2");
      expect(plan12.tradingData?.request?.minRewardRisk).toBe(2.0);
      expect(plan12.tradingData?.strategyFilter?.minRewardRisk).toBe(2.0);
      expect(plan12.tradingData?.strategyFilter?.maxProfitGreaterThanMaxLoss).toBe(true);

      const plan13 = await planNLQ(mockEnv, "find strategies where max profit is greater than max loss by 1:3");
      expect(plan13.tradingData?.request?.minRewardRisk).toBe(3.0);

      const plan14 = await planNLQ(mockEnv, "find strategies where max profit is greater than max loss by 1:4");
      expect(plan14.tradingData?.request?.minRewardRisk).toBe(4.0);

      const planPct = await planNLQ(mockEnv, "find strategies where max profit is greater than max loss by 50%");
      expect(planPct.tradingData?.request?.minRewardRisk).toBe(1.5);

      const plan2x = await planNLQ(mockEnv, "find strategies where max profit is 2x max loss");
      expect(plan2x.tradingData?.request?.minRewardRisk).toBe(2.0);
    });
  });

  describe("Order Planning and Relative Pricing Fast-Paths", () => {
    it("extracts order parameters from voice transcript 'buy 1 order of nvda at 30% below market price'", () => {
      const order = extractOrderParameters("buy 1 order of nvda at 30% below market price");
      expect(order).toBeDefined();
      expect(order?.symbol).toBe("NVDA");
      expect(order?.quantity).toBe(1);
      expect(order?.orderAction).toBe("BUY");
      expect(order?.orderType).toBe("LIMIT");
      expect(order?.relativePriceOffsetPercent).toBe(-30);
      // #913/#920: the parser derives NO price — relative orders are priced
      // at execution from a live E*TRADE quote or refused.
      expect(order?.limitPrice).toBeUndefined();
    });

    it("plans order previews with relative discounts accurately via planNLQ", async () => {
      const plan = await planNLQ(mockEnv, "buy 1 order of nvda at 30% below market price");
      expect(plan.domain).toBe("trading");
      expect(plan.tradingData?.action).toBe("preview_order");
      expect(plan.tradingData?.symbol).toBe("NVDA");
      expect(plan.tradingData?.quantity).toBe(1);
      expect(plan.tradingData?.orderType).toBe("LIMIT");
      expect(plan.tradingData?.relativePriceOffsetPercent).toBe(-30);
    });

    it("handles alternative filler phrases: 'buy 10 shares of AAPL at 10% discount to market price'", () => {
      const order = extractOrderParameters("buy 10 shares of AAPL at 10% discount to market price");
      expect(order?.symbol).toBe("AAPL");
      expect(order?.quantity).toBe(10);
      expect(order?.orderType).toBe("LIMIT");
      expect(order?.relativePriceOffsetPercent).toBe(-10);
    });

    it("handles premium limit orders: 'sell 5 shares of AMD at 10% above market price'", () => {
      const order = extractOrderParameters("sell 5 shares of AMD at 10% above market price");
      expect(order?.symbol).toBe("AMD");
      expect(order?.quantity).toBe(5);
      expect(order?.orderAction).toBe("SELL");
      expect(order?.orderType).toBe("LIMIT");
      expect(order?.relativePriceOffsetPercent).toBe(10);
    });

    it("handles contract and lot terminology: 'buy 1 contract of spy'", () => {
      const order = extractOrderParameters("buy 1 contract of spy");
      expect(order?.symbol).toBe("SPY");
      expect(order?.quantity).toBe(1);
      expect(order?.orderType).toBe("MARKET");
    });
  });
});


