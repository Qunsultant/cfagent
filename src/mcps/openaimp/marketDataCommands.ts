/**
 * Market Data Research & Quoting Model Context Protocol (MCP) Tool Commands
 *
 * Implements:
 * - GoF Command Pattern: Encapsulates market-data operations (yfinance & Alpaca) as executable MCP commands.
 * - SOLID Single Responsibility Principle: Each command executes a discrete research or quoting capability.
 * - GoF Adapter Pattern: Directly adapted into Vercel AI SDK tools for agent self-consumption.
 *
 * #1727 (parent #1717, slice (g)): every command resolves its market-data
 * switch (src/config/marketDataModes.ts) in order run (per-call `mode`
 * input) > session > user (context.scopedMarketDataModes) > global env >
 * built-in (this surface's legacy = "mcp" for every switch here).
 * An unrecognized winning value FAILS CLOSED to "mcp",
 * console-logged + audited as market_data.config_error (no fall-through).
 * The `mode` input is a plain optional string (not a zod enum) so
 * an invalid value reaches execute and fails closed instead of
 * being rejected by schema validation — the #1726 idiom. The
 * jsonSchema/zodSchema `required` lists keep their legacy entries
 * (symbol required, qty required): the rest/market-data/trading-mode
 * defaults (NVDA, qty 1, aliases) apply at execute level when the
 * caller bypasses schema validation or the transport passes a
 * missing field through — exactly the #1726 quote idiom. No
 * endpoint is removed, no code path is deleted: every legacy
 * branch is preserved under its mode value.
 */

import { z } from "zod";
import type { IMcpToolCommand, McpToolContext } from "../../patterns/interfaces";
import { MarketDataResearchService, marketDataResearchBarsSourceLabel } from "../../services/marketDataResearch";
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
  marketDataQuoteAuditEvent,
  marketDataFundamentalsAuditEvent,
  marketDataResearchAuditEvent,
  marketDataBarsAuditEvent,
  marketDataSnapshotAudit,
  marketDataReadsAuditEvent,
  normalizeMarketDataOrderInput,
  marketDataOrderAuditEvent,
  marketDataOrderAuditPayload,
  type MarketDataModeValues,
  type ResolvedMarketDataSwitch,
} from "../../config/marketDataModes";

/** Builds the level set for one switch from the MCP context + run value. */
function marketDataModeLevels(
  context: McpToolContext,
  key: keyof MarketDataModeValues,
  run: unknown,
  envVar: string
) {
  return levelsForMarketDataSwitch(context.scopedMarketDataModes, key, run, envValueForSwitch(context.env, envVar));
}

/** Logs + audits market_data.config_error when a resolution failed closed. */
function auditMarketDataConfigError(
  context: McpToolContext,
  switchName: string,
  resolved: ResolvedMarketDataSwitch<any>,
  agent: "research" | "trading"
) {
  if (!resolved.invalid) return;
  context.audit?.(marketDataConfigErrorEvent(), agent, {
    switch: switchName,
    raw: resolved.raw,
    level: resolved.level,
    failedClosedTo: resolved.mode,
  });
}

/** MCP-mode symbol requirement (legacy): a missing/blank symbol throws, it never defaults. */
function requireMcpSymbol(input: any): string {
  if (typeof input?.symbol !== "string" || !input.symbol.trim()) {
    throw new Error("symbol is required");
  }
  return input.symbol;
}

/**
 * 1. Market Data Get Quote Command
 * Fetches real-time equity or crypto quote from Yahoo Finance, Alpaca, or Hybrid.
 */
export class MarketDataGetQuoteCommand implements IMcpToolCommand {
  readonly name = "market_data_get_quote";
  readonly description = "Retrieve market quote, bid/ask spread, 24h change, and volume using market-data engines (Yahoo Finance or Alpaca Market Data v2). Live-only (#923): the result carries `provenance` 'live'; when a live fetch fails the command throws an explicit unavailable error — no static or generated substitute is served.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker or crypto pair (e.g. NVDA, AAPL, MSFT, BTC/USD)" },
      provider: { type: "string", enum: ["yfinance", "alpaca", "hybrid"], description: "Market data provider (default: hybrid)" },
      mode: { type: "string", description: "#1727 run-level MARKET_DATA_QUOTE_MODE override (mcp | rest)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker or crypto pair"),
    provider: z.enum(["yfinance", "alpaca", "hybrid"]).default("hybrid").optional(),
    mode: z.string().optional().describe("#1727 run-level MARKET_DATA_QUOTE_MODE override (mcp | rest)"),
  });

  async execute(input: { symbol: string; provider?: "yfinance" | "alpaca" | "hybrid"; mode?: string }, context: McpToolContext) {
    const resolved = resolveMarketDataQuoteMode(marketDataModeLevels(context, "quote", (input as any)?.mode, MARKET_DATA_QUOTE_MODE_SWITCH), "mcp");
    auditMarketDataConfigError(context, MARKET_DATA_QUOTE_MODE_SWITCH, resolved, "research");
    const service = new MarketDataResearchService(context.env);
    if (resolved.mode === "rest") {
      const symbol = (typeof (input as any)?.symbol === "string" ? (input as any).symbol.trim() : "") || "NVDA";
      return await service.getQuote(symbol, input.provider || "hybrid");
    }
    const symbol = requireMcpSymbol(input);
    const quote = await service.getQuote(symbol, input.provider || "hybrid");
    const event = marketDataQuoteAuditEvent("mcp");
    if (event) context.audit?.(event, "research", { symbol: input.symbol, provider: quote.provider, price: quote.price, provenance: quote.provenance });
    return quote;
  }
}

/**
 * 2. Market Data Company Fundamentals Command
 * Retrieves institutional valuation metrics, P/E, PEG, P/B, Beta, and analyst price targets via Yahoo Finance.
 */
export class MarketDataFundamentalsCommand implements IMcpToolCommand {
  readonly name = "market_data_company_fundamentals";
  readonly description = "Extract comprehensive company fundamentals, valuation ratios (P/E, PEG, Price-to-Book, Beta), 52-week statistics, and analyst targets via Yahoo Finance. Live-only (#923): the result carries `provenance` 'live'; when live fundamentals cannot be fetched the command throws an explicit unavailable error — no profile or formula-estimated analyst fields are served.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, MSFT)" },
      mode: { type: "string", description: "#1727 run-level MARKET_DATA_FUNDAMENTALS_MODE override (mcp | rest)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker symbol"),
    mode: z.string().optional().describe("#1727 run-level MARKET_DATA_FUNDAMENTALS_MODE override (mcp | rest)"),
  });

  async execute(input: { symbol: string; mode?: string }, context: McpToolContext) {
    const resolved = resolveMarketDataFundamentalsMode(marketDataModeLevels(context, "fundamentals", (input as any)?.mode, MARKET_DATA_FUNDAMENTALS_MODE_SWITCH), "mcp");
    auditMarketDataConfigError(context, MARKET_DATA_FUNDAMENTALS_MODE_SWITCH, resolved, "research");
    const service = new MarketDataResearchService(context.env);
    if (resolved.mode === "rest") {
      const symbol = (typeof (input as any)?.symbol === "string" ? (input as any).symbol.trim() : "") || "NVDA";
      return await service.getFundamentals(symbol);
    }
    const symbol = requireMcpSymbol(input);
    const fundamentals = await service.getFundamentals(symbol);
    const event = marketDataFundamentalsAuditEvent("mcp");
    if (event) context.audit?.(event, "research", { symbol: input.symbol, marketCap: fundamentals.marketCap, pe: fundamentals.peTrailing, provenance: fundamentals.provenance });
    return fundamentals;
  }
}

/**
 * 3. Market Data Historical Bars Command
 * Retrieves daily or intraday OHLCV bars for technical chart analysis.
 */
export class MarketDataHistoricalBarsCommand implements IMcpToolCommand {
  readonly name = "market_data_historical_bars";
  readonly description = "Query historical OHLCV pricing bars, VWAP, and volume series for equities and crypto. Live-only (#923): every bar carries `provenance` 'live'; when the provider fetch fails the command throws an explicit unavailable error — no synthetic bars are served.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol or crypto pair" },
      timeframe: { type: "string", description: "Bar timeframe (default: '1D')" },
      limit: { type: "number", description: "Number of bars to return (default: 30, max: 90)" },
      provider: { type: "string", enum: ["yfinance", "alpaca", "hybrid"], description: "#1727 rest-mode provider override (default: yfinance; ignored in mcp mode)" },
      mode: { type: "string", description: "#1727 run-level MARKET_DATA_BARS_MODE override (mcp | rest)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker or crypto pair"),
    timeframe: z.string().default("1D").optional(),
    limit: z.number().int().min(1).max(90).default(30).optional(),
    provider: z.enum(["yfinance", "alpaca", "hybrid"]).optional().describe("#1727 rest-mode provider override (default: yfinance; ignored in mcp mode)"),
    mode: z.string().optional().describe("#1727 run-level MARKET_DATA_BARS_MODE override (mcp | rest)"),
  });

  async execute(input: { symbol: string; timeframe?: string; limit?: number; provider?: "yfinance" | "alpaca" | "hybrid"; mode?: string }, context: McpToolContext) {
    const resolved = resolveMarketDataBarsMode(marketDataModeLevels(context, "bars", (input as any)?.mode, MARKET_DATA_BARS_MODE_SWITCH), "mcp");
    auditMarketDataConfigError(context, MARKET_DATA_BARS_MODE_SWITCH, resolved, "research");
    const service = new MarketDataResearchService(context.env);
    if (resolved.mode === "rest") {
      const symbol = (typeof (input as any)?.symbol === "string" ? (input as any).symbol.trim() : "") || "NVDA";
      const provider = input.provider || "yfinance";
      const bars = await service.getHistoricalBars(symbol, input.timeframe || "1D", input.limit || 30, provider);
      const provenance = bars[0]?.provenance ?? "generated";
      return {
        symbol: symbol.toUpperCase(),
        provider,
        timeframe: input.timeframe || "1D",
        count: bars.length,
        bars,
        provenance,
        source: marketDataResearchBarsSourceLabel(provider, provenance),
        timestamp: new Date().toISOString(),
      };
    }
    const symbol = requireMcpSymbol(input);
    const bars = await service.getHistoricalBars(symbol, input.timeframe || "1D", input.limit || 30);
    const provenance = bars[0]?.provenance ?? "generated";
    const event = marketDataBarsAuditEvent("mcp");
    if (event) context.audit?.(event, "research", { symbol: input.symbol, count: bars.length, provenance });
    return { symbol: input.symbol.toUpperCase(), count: bars.length, provenance, bars };
  }
}

/**
 * 4. Market Data Research Synthesis Command
 * Generates an end-to-end equity research report with AI analysis, technical indicators, and cryptographic Agent DID stamp.
 */
export class MarketDataResearchCommand implements IMcpToolCommand {
  readonly name = "market_data_research";
  readonly description = "Generate an autonomous equity research report synthesizing quoting, valuation, technical RSI/MACD indicators, analyst targets, and cryptographic W3C Agent DID attestation. Live-only (#923): the report carries `provenance` 'live' and its attestation binds that provenance into the signed payload; when any live input cannot be fetched the command throws an explicit unavailable error — no non-live report is assembled.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, MSFT, TSLA)" },
      mode: { type: "string", description: "#1727 run-level MARKET_DATA_RESEARCH_MODE override (mcp | rest)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker symbol"),
    mode: z.string().optional().describe("#1727 run-level MARKET_DATA_RESEARCH_MODE override (mcp | rest)"),
  });

  async execute(input: { symbol: string; mode?: string }, context: McpToolContext) {
    const resolved = resolveMarketDataResearchMode(marketDataModeLevels(context, "research", (input as any)?.mode, MARKET_DATA_RESEARCH_MODE_SWITCH), "mcp");
    auditMarketDataConfigError(context, MARKET_DATA_RESEARCH_MODE_SWITCH, resolved, "research");
    const service = new MarketDataResearchService(context.env);
    if (resolved.mode === "rest") {
      const symbol = (typeof (input as any)?.symbol === "string" ? (input as any).symbol.trim() : "") || "NVDA";
      const report = await service.generateResearchReport(symbol);
      context.audit?.(marketDataResearchAuditEvent("rest"), "research", { symbol, rating: report.analystRating, did: report.agentAttestation.did, provenance: report.provenance });
      return report;
    }
    const symbol = requireMcpSymbol(input);
    const report = await service.generateResearchReport(symbol);
    context.audit?.(marketDataResearchAuditEvent("mcp"), "research", { symbol: input.symbol, rating: report.analystRating, did: report.agentAttestation.did, provenance: report.provenance });
    return report;
  }
}

/**
 * 5. Alpaca Market Snapshot Command
 * Retrieves Level 1/2 quotes, latest trade executions, and NBBO order book spread from Alpaca Market Data v2.
 */
export class AlpacaSnapshotCommand implements IMcpToolCommand {
  readonly name = "alpaca_snapshot";
  readonly description = "Query real-time Level 1/2 market snapshot, NBBO bid/ask prices, trade prints, and daily volume via Alpaca Market Data v2.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol or crypto pair (e.g. NVDA, BTC/USD)" },
      mode: { type: "string", description: "#1727 run-level MARKET_DATA_SNAPSHOT_MODE override (mcp | rest)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker or crypto pair"),
    mode: z.string().optional().describe("#1727 run-level MARKET_DATA_SNAPSHOT_MODE override (mcp | rest)"),
  });

  async execute(input: { symbol: string; mode?: string }, context: McpToolContext) {
    const resolved = resolveMarketDataSnapshotMode(marketDataModeLevels(context, "snapshot", (input as any)?.mode, MARKET_DATA_SNAPSHOT_MODE_SWITCH), "mcp");
    auditMarketDataConfigError(context, MARKET_DATA_SNAPSHOT_MODE_SWITCH, resolved, "trading");
    const service = new MarketDataResearchService(context.env);
    if (resolved.mode === "rest") {
      const symbol = (typeof (input as any)?.symbol === "string" ? (input as any).symbol.trim() : "") || "NVDA";
      const snapshot = await service.getAlpacaSnapshot(symbol);
      const [event, payload] = marketDataSnapshotAudit("rest", symbol, snapshot);
      context.audit?.(event, "trading", payload);
      return snapshot;
    }
    const symbol = requireMcpSymbol(input);
    const snapshot = await service.getAlpacaSnapshot(symbol);
    const [event, payload] = marketDataSnapshotAudit("mcp", input.symbol, snapshot);
    context.audit?.(event, "trading", payload);
    return snapshot;
  }
}

/**
 * 6. Alpaca Account Command
 * Queries Alpaca account balances, buying power, and portfolio equity with agentic DID audit tracing.
 */
export class AlpacaAccountCommand implements IMcpToolCommand {
  readonly name = "alpaca_account";
  readonly description = "Query Alpaca Securities brokerage account details, cash balance, buying power, and portfolio equity with agentic DID audit tracing.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      mode: { type: "string", description: "#1727 run-level ALPACA_READS_MODE override (mcp | rest | none)" },
    },
  };

  readonly zodSchema = z.object({
    mode: z.string().optional().describe("#1727 run-level ALPACA_READS_MODE override (mcp | rest | none)"),
  });

  async execute(_input: Record<string, unknown>, context: McpToolContext) {
    const resolved = resolveAlpacaReadsMode(marketDataModeLevels(context, "reads", (_input as any)?.mode, ALPACA_READS_MODE_SWITCH), "mcp");
    auditMarketDataConfigError(context, ALPACA_READS_MODE_SWITCH, resolved, "trading");
    const service = new MarketDataResearchService(context.env);
    const result = await service.getAlpacaAccount();
    const event = marketDataReadsAuditEvent(resolved.mode, "account");
    if (event) {
      context.audit?.(event, "trading", {
        success: result.success,
        accountId: result.account?.id,
        buyingPower: result.account?.buying_power,
        portfolioValue: result.account?.portfolio_value,
      });
    }
    return result;
  }
}

/**
 * 7. Alpaca Positions Command
 * Queries open equity and crypto portfolio positions from Alpaca Securities with agentic DID audit tracing.
 */
export class AlpacaPositionsCommand implements IMcpToolCommand {
  readonly name = "alpaca_positions";
  readonly description = "Query open equity and crypto portfolio positions from Alpaca Securities with agentic DID audit tracing.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      mode: { type: "string", description: "#1727 run-level ALPACA_READS_MODE override (mcp | rest | none)" },
    },
  };

  readonly zodSchema = z.object({
    mode: z.string().optional().describe("#1727 run-level ALPACA_READS_MODE override (mcp | rest | none)"),
  });

  async execute(_input: Record<string, unknown>, context: McpToolContext) {
    const resolved = resolveAlpacaReadsMode(marketDataModeLevels(context, "reads", (_input as any)?.mode, ALPACA_READS_MODE_SWITCH), "mcp");
    auditMarketDataConfigError(context, ALPACA_READS_MODE_SWITCH, resolved, "trading");
    const service = new MarketDataResearchService(context.env);
    const result = await service.getAlpacaPositions();
    const event = marketDataReadsAuditEvent(resolved.mode, "positions");
    if (event) {
      context.audit?.(event, "trading", {
        success: result.success,
        count: result.positions?.length || 0,
        symbols: result.positions?.map((p: any) => p.symbol) || [],
      });
    }
    return result;
  }
}

/**
 * 8. Alpaca Orders Command
 * Queries active and filled orders from Alpaca Securities with status filter and agentic DID audit tracing.
 */
export class AlpacaOrdersCommand implements IMcpToolCommand {
  readonly name = "alpaca_orders";
  readonly description = "Query active and filled orders from Alpaca Securities with status filter and agentic DID audit tracing.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      status: { type: "string", enum: ["open", "closed", "all"], description: "Order status filter (default: open)" },
      mode: { type: "string", description: "#1727 run-level ALPACA_READS_MODE override (mcp | rest | none)" },
    },
  };

  readonly zodSchema = z.object({
    status: z.enum(["open", "closed", "all"]).default("open").optional(),
    mode: z.string().optional().describe("#1727 run-level ALPACA_READS_MODE override (mcp | rest | none)"),
  });

  async execute(input: { status?: "open" | "closed" | "all"; mode?: string }, context: McpToolContext) {
    const resolved = resolveAlpacaReadsMode(marketDataModeLevels(context, "reads", (input as any)?.mode, ALPACA_READS_MODE_SWITCH), "mcp");
    auditMarketDataConfigError(context, ALPACA_READS_MODE_SWITCH, resolved, "trading");
    const service = new MarketDataResearchService(context.env);
    // Status default is open in every mode (pinned, not switched — see #1727).
    const status = input.status || "open";
    const result = await service.getAlpacaOrders(status);
    const event = marketDataReadsAuditEvent(resolved.mode, "orders");
    if (event) {
      context.audit?.(event, "trading", {
        status,
        count: result.orders?.length || 0,
      });
    }
    return result;
  }
}

/**
 * 9. Alpaca Place Order Command
 * Places an equity, ETF, or crypto order via Alpaca Trading API v2 with Agent DID cryptographic attestation.
 *
 * #1727: the order switch (ALPACA_ORDER_MODE) selects input
 * normalization + audit per src/config/marketDataModes.ts. The alias
 * fields (quantity, orderAction, orderType, limitPrice) are
 * accepted in the schema so they survive transport parsing; they
 * are IGNORED in mcp mode (verbatim legacy) and honored in market-data /
 * trading modes. No HITL gate exists on this path on either surface
 * today; the switch changes normalization + audit only.
 */
export class AlpacaPlaceOrderCommand implements IMcpToolCommand {
  readonly name = "alpaca_place_order";
  readonly description = "Place a stock, ETF, or crypto order on Alpaca Securities with Agent DID attestation and audit tracing.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Ticker symbol (e.g. NVDA, AAPL, BTC/USD)" },
      qty: { type: "number", description: "Number of shares or contract units" },
      side: { type: "string", enum: ["buy", "sell"], description: "Order side (buy or sell)" },
      type: { type: "string", enum: ["market", "limit", "stop", "stop_limit"], description: "Order execution type" },
      limit_price: { type: "number", description: "Limit price (required if type is limit)" },
      time_in_force: { type: "string", enum: ["day", "gtc", "ioc", "fok"], description: "Time in force" },
      extended_hours: { type: "boolean", description: "Allow execution in pre-market, after-hours, and overnight EXTO sessions" },
      order_class: { type: "string", enum: ["simple", "bracket", "oco", "oto"], description: "Order class ('bracket' for parent orders with take-profit and stop-loss legs)" },
      take_profit: {
        type: "object",
        properties: {
          limit_price: { type: "number", description: "Limit price for take-profit leg" },
        },
        required: ["limit_price"],
        description: "Take-profit bracket leg parameters",
      },
      take_profit_limit_price: { type: "number", description: "Convenience alias for take-profit limit price" },
      stop_loss: {
        type: "object",
        properties: {
          stop_price: { type: "number", description: "Stop trigger price for stop-loss leg" },
          limit_price: { type: "number", description: "Optional limit price for stop-loss limit leg" },
        },
        required: ["stop_price"],
        description: "Stop-loss bracket leg parameters",
      },
      stop_loss_stop_price: { type: "number", description: "Convenience alias for stop-loss stop price" },
      stop_loss_limit_price: { type: "number", description: "Convenience alias for stop-loss limit price" },
      quantity: { type: "number", description: "#1727 market-data/trading-mode alias for qty (ignored in mcp mode)" },
      orderAction: { type: "string", description: "#1727 market-data-mode alias for side (ignored in mcp/trading modes)" },
      orderType: { type: "string", description: "#1727 market-data-mode alias for type (ignored in mcp/trading modes)" },
      limitPrice: { type: "number", description: "#1727 market-data-mode alias for limit_price (ignored in mcp/trading modes)" },
      mode: { type: "string", description: "#1727 run-level ALPACA_ORDER_MODE override (mcp | market-data | trading)" },
    },
    required: ["symbol", "qty", "side"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Ticker symbol"),
    qty: z.number().positive().describe("Order quantity"),
    side: z.enum(["buy", "sell"]).describe("Order side"),
    type: z.enum(["market", "limit", "stop", "stop_limit"]).default("market").optional(),
    limit_price: z.number().positive().optional().describe("Limit price"),
    time_in_force: z.enum(["day", "gtc", "ioc", "fok"]).default("day").optional(),
    extended_hours: z.boolean().optional().describe("Allow extended-hours execution"),
    order_class: z.enum(["simple", "bracket", "oco", "oto"]).optional().describe("Order class ('bracket' for parent orders with TP/SL legs)"),
    take_profit: z.object({ limit_price: z.number().positive() }).optional().describe("Take-profit bracket leg"),
    take_profit_limit_price: z.number().positive().optional().describe("Take-profit limit price"),
    stop_loss: z.object({ stop_price: z.number().positive(), limit_price: z.number().positive().optional() }).optional().describe("Stop-loss bracket leg"),
    stop_loss_stop_price: z.number().positive().optional().describe("Stop-loss stop price"),
    stop_loss_limit_price: z.number().positive().optional().describe("Stop-loss limit price"),
    quantity: z.number().positive().optional().describe("#1727 market-data/trading-mode alias for qty (ignored in mcp mode)"),
    orderAction: z.string().optional().describe("#1727 market-data-mode alias for side (ignored in mcp/trading modes)"),
    orderType: z.string().optional().describe("#1727 market-data-mode alias for type (ignored in mcp/trading modes)"),
    limitPrice: z.number().positive().optional().describe("#1727 market-data-mode alias for limit_price (ignored in mcp/trading modes)"),
    mode: z.string().optional().describe("#1727 run-level ALPACA_ORDER_MODE override (mcp | market-data | trading)"),
  });

  async execute(
    input: {
      symbol: string;
      qty: number;
      side: "buy" | "sell";
      type?: "market" | "limit" | "stop" | "stop_limit";
      limit_price?: number;
      time_in_force?: "day" | "gtc" | "ioc" | "fok";
      extended_hours?: boolean;
      order_class?: "simple" | "bracket" | "oco" | "oto";
      take_profit?: { limit_price: number };
      take_profit_limit_price?: number;
      stop_loss?: { stop_price: number; limit_price?: number };
      stop_loss_stop_price?: number;
      stop_loss_limit_price?: number;
      quantity?: number;
      orderAction?: string;
      orderType?: string;
      limitPrice?: number;
      mode?: string;
    },
    context: McpToolContext
  ) {
    const resolved = resolveAlpacaOrderMode(marketDataModeLevels(context, "order", (input as any)?.mode, ALPACA_ORDER_MODE_SWITCH), "mcp");
    auditMarketDataConfigError(context, ALPACA_ORDER_MODE_SWITCH, resolved, "trading");
    const service = new MarketDataResearchService(context.env);
    const normalized = normalizeMarketDataOrderInput(input as any, resolved.mode);

    // Validate bracket combos (#3658): fail closed before broker contact
    if (normalized.order_class === "bracket") {
      if (!normalized.take_profit?.limit_price || !normalized.stop_loss?.stop_price) {
        return {
          success: false,
          message: "Bracket orders require both take_profit (limit_price) and stop_loss (stop_price) parameters.",
          refusal: "invalid_bracket_parameters",
        };
      }

      if (normalized.type === "stop_limit") {
        return {
          success: false,
          message: "Bracket orders are not compatible with stop_limit parent order type.",
          refusal: "invalid_bracket_order_type",
        };
      }

      const tpLimit = normalized.take_profit.limit_price;
      const slStop = normalized.stop_loss.stop_price;
      const entryPrice = normalized.limit_price;

      if (normalized.side === "buy") {
        if (entryPrice !== undefined && (tpLimit <= entryPrice || slStop >= entryPrice)) {
          return {
            success: false,
            message: `Invalid bracket prices for BUY order: take-profit ($${tpLimit}) must be greater than entry ($${entryPrice}) and stop-loss ($${slStop}) must be less than entry ($${entryPrice}).`,
            refusal: "invalid_bracket_prices",
          };
        }
        if (tpLimit <= slStop) {
          return {
            success: false,
            message: `Invalid bracket prices for BUY order: take-profit ($${tpLimit}) must be greater than stop-loss ($${slStop}).`,
            refusal: "invalid_bracket_prices",
          };
        }
      } else if (normalized.side === "sell") {
        if (entryPrice !== undefined && (tpLimit >= entryPrice || slStop <= entryPrice)) {
          return {
            success: false,
            message: `Invalid bracket prices for SELL order: take-profit ($${tpLimit}) must be less than entry ($${entryPrice}) and stop-loss ($${slStop}) must be greater than entry ($${entryPrice}).`,
            refusal: "invalid_bracket_prices",
          };
        }
        if (tpLimit >= slStop) {
          return {
            success: false,
            message: `Invalid bracket prices for SELL order: take-profit ($${tpLimit}) must be less than stop-loss ($${slStop}).`,
            refusal: "invalid_bracket_prices",
          };
        }
      }
    }

    // Issue #3782: the tool's limit price is supplied by the caller
    // (the agent acting on the user's request / approved draft), so
    // the call declares user provenance — the price is asserted by
    // the caller, never derived from an ambient quote. The guard in
    // placeOrder refuses the placement if that declaration is absent.
    const result = await service.placeAlpacaOrder({ ...normalized, priceSource: { kind: "user" } });
    context.audit?.(marketDataOrderAuditEvent(resolved.mode), "trading", marketDataOrderAuditPayload(resolved.mode, normalized, result));
    return result;
  }
}

/**
 * #1906: deprecated alias for a renamed MCP tool. The alias carries the
 * legacy tool name so existing MCP clients keep working; it delegates
 * execution, schemas, and audit behavior to the canonical command
 * unchanged. The alias name string itself is the alias definition
 * (allowed by the #1906 brief); no other new legacy-label string is
 * introduced by this slice. Alias removal is a follow-up slice.
 */
export class DeprecatedToolAlias implements IMcpToolCommand {
  readonly name: string;
  readonly description: string;
  readonly jsonSchema: IMcpToolCommand["jsonSchema"];
  readonly zodSchema: IMcpToolCommand["zodSchema"];

  constructor(name: string, private readonly canonical: IMcpToolCommand) {
    this.name = name;
    this.description = `Deprecated alias for ${canonical.name}; use ${canonical.name} instead.`;
    this.jsonSchema = canonical.jsonSchema;
    this.zodSchema = canonical.zodSchema;
  }

  execute(input: any, context: McpToolContext): Promise<any> {
    return this.canonical.execute(input, context);
  }
}

/**
 * 10. Alpaca Place Bracket Ladder Command (#3673)
 * Places a TOS-style multi-tier bracket ladder (grid order) with step increments and paired TP/SL exits.
 */
export class AlpacaPlaceBracketLadderCommand implements IMcpToolCommand {
  readonly name = "alpaca_place_bracket_ladder";
  readonly description =
    "Place a multi-tier bracket ladder (grid / scale-in / scale-out) on Alpaca with step increments and paired take-profit and stop-loss exits for each tier.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Ticker symbol (e.g. AAPL, NVDA)" },
      side: { type: "string", enum: ["buy", "sell"], description: "Order side ('buy' or 'sell')" },
      base_price: { type: "number", description: "Initial entry price level" },
      basePrice: { type: "number", description: "CamelCase alias for base_price" },
      step_increment: { type: "number", description: "Dollar price interval between tiers (e.g. 1.00)" },
      stepIncrement: { type: "number", description: "CamelCase alias for step_increment" },
      tiers: { type: "number", description: "Number of ladder tiers/rungs (1 to 20)" },
      qty_per_tier: { type: "number", description: "Number of shares per tier" },
      quantityPerTier: { type: "number", description: "CamelCase alias for qty_per_tier" },
      quantities: {
        type: "array",
        items: { type: "number" },
        description: "Optional array of quantities per tier (length must equal tiers)",
      },
      take_profit_delta: { type: "number", description: "Profit target distance from tier entry price" },
      takeProfitDelta: { type: "number", description: "CamelCase alias for take_profit_delta" },
      stop_loss_delta: { type: "number", description: "Protective stop distance from tier entry price" },
      stopLossDelta: { type: "number", description: "CamelCase alias for stop_loss_delta" },
      direction: {
        type: "string",
        enum: ["ascending", "descending"],
        description: "Tier direction ('ascending' steps up, 'descending' steps down)",
      },
      time_in_force: { type: "string", enum: ["day", "gtc"], description: "Time in force ('day' or 'gtc')" },
      extended_hours: { type: "boolean", description: "Allow extended-hours execution" },
    },
    required: ["symbol", "side", "tiers"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Ticker symbol"),
    side: z.enum(["buy", "sell"]).describe("Order side"),
    base_price: z.number().positive().optional().describe("Base price"),
    basePrice: z.number().positive().optional().describe("Base price alias"),
    step_increment: z.number().positive().optional().describe("Step increment"),
    stepIncrement: z.number().positive().optional().describe("Step increment alias"),
    tiers: z.number().int().min(1).max(20).describe("Number of tiers"),
    qty_per_tier: z.number().positive().optional().describe("Quantity per tier"),
    quantityPerTier: z.number().positive().optional().describe("Quantity per tier alias"),
    quantities: z.array(z.number().positive()).optional().describe("Quantities per rung"),
    take_profit_delta: z.number().positive().optional().describe("Take-profit offset"),
    takeProfitDelta: z.number().positive().optional().describe("Take-profit offset alias"),
    stop_loss_delta: z.number().positive().optional().describe("Stop-loss offset"),
    stopLossDelta: z.number().positive().optional().describe("Stop-loss offset alias"),
    direction: z.enum(["ascending", "descending"]).default("ascending").optional(),
    time_in_force: z.enum(["day", "gtc"]).default("day").optional(),
    extended_hours: z.boolean().optional(),
  });

  async execute(input: any, context: McpToolContext) {
    const { executeBracketLadder } = await import("../../services/bracketLadder");
    const basePrice = input.base_price ?? input.basePrice ?? 100.0;
    const stepIncrement = input.step_increment ?? input.stepIncrement ?? 1.0;
    const quantityPerTier = input.qty_per_tier ?? input.quantityPerTier ?? 1;
    const takeProfitDelta = input.take_profit_delta ?? input.takeProfitDelta ?? 1.0;
    const stopLossDelta = input.stop_loss_delta ?? input.stopLossDelta ?? 2.0;

    const receipt = await executeBracketLadder(
      {
        symbol: String(input.symbol || "").toUpperCase(),
        side: input.side,
        basePrice,
        stepIncrement,
        tiers: Number(input.tiers),
        quantityPerTier,
        quantities: input.quantities,
        takeProfitDelta,
        stopLossDelta,
        direction: input.direction || "ascending",
        timeInForce: input.time_in_force || "day",
        extendedHours: input.extended_hours,
      },
      context.env,
    );

    context.audit?.("alpaca.bracket_ladder_placed", "trading", {
      symbol: receipt.symbol,
      side: receipt.side,
      ladderId: receipt.ladderId,
      tiersPlaced: receipt.tiersPlaced,
      tiersRequested: receipt.tiersRequested,
      totalQuantity: receipt.totalQuantity,
    });

    return receipt;
  }
}

/**
 * 11. Alpaca Cancel Bracket Ladder Command (#3673)
 * Cancels all open order rungs associated with a bracket ladder batch or target symbol.
 */
export class AlpacaCancelBracketLadderCommand implements IMcpToolCommand {
  readonly name = "alpaca_cancel_bracket_ladder";
  readonly description = "Cancel all unfilled orders in a bracket ladder batch by ladder ID or symbol.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      ladder_id: { type: "string", description: "Ladder ID prefix to cancel" },
      ladderId: { type: "string", description: "CamelCase alias for ladder_id" },
      symbol: { type: "string", description: "Symbol to cancel open orders for" },
      order_ids: {
        type: "array",
        items: { type: "string" },
        description: "Exact list of order IDs to cancel",
      },
      orderIds: {
        type: "array",
        items: { type: "string" },
        description: "CamelCase alias for order_ids",
      },
    },
  };

  readonly zodSchema = z.object({
    ladder_id: z.string().optional(),
    ladderId: z.string().optional(),
    symbol: z.string().optional(),
    order_ids: z.array(z.string()).optional(),
    orderIds: z.array(z.string()).optional(),
  });

  async execute(input: any, context: McpToolContext) {
    const { cancelBracketLadder } = await import("../../services/bracketLadder");
    const ladderId = input.ladder_id ?? input.ladderId;
    const orderIds = input.order_ids ?? input.orderIds;

    const receipt = await cancelBracketLadder(
      {
        ladderId,
        symbol: input.symbol,
        orderIds,
      },
      context.env,
    );

    context.audit?.("alpaca.bracket_ladder_cancelled", "trading", {
      ladderId: receipt.ladderId,
      symbol: receipt.symbol,
      cancelledCount: receipt.cancelledCount,
      orderIds: receipt.orderIds,
    });

    return receipt;
  }
}

/**
 * 12. Alpaca Get Quote Command (#3782)
 * Fetches a live equity quote from Alpaca Market Data v2 — the
 * copilot's broker (COPILOT_BROKER_ID), so the copilot's quote leg
 * runs on Alpaca instead of reaching for the E*TRADE quote tool.
 * Live-only (#923, same as market_data_get_quote with provider
 * "alpaca"): the result carries provider "alpaca" + provenance
 * "live" + timestamp; when a live fetch fails the command throws an
 * explicit unavailable error — no static or generated substitute.
 */
export class AlpacaGetQuoteCommand implements IMcpToolCommand {
  readonly name = "alpaca_get_quote";
  readonly description =
    "Retrieve a live market quote (price, bid/ask, volume, OHLC) for an equity ticker from Alpaca Market Data v2. Live-only: the result carries provider 'alpaca', provenance 'live', and a timestamp; when Alpaca cannot serve a live quote the command throws an explicit unavailable error — no static or generated substitute is served.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. AAPL, NVDA, MSFT)" },
    },
    required: ["symbol"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).max(20).describe("Stock ticker symbol (e.g. AAPL, NVDA, MSFT)"),
  });

  async execute(input: { symbol: string }, context: McpToolContext) {
    const symbol = requireMcpSymbol(input);
    const service = new MarketDataResearchService(context.env);
    const quote = await service.getQuote(symbol, "alpaca");
    const event = marketDataQuoteAuditEvent("mcp");
    if (event) context.audit?.(event, "research", { symbol, provider: quote.provider, price: quote.price, provenance: quote.provenance });
    return quote;
  }
}

/**
 * 13. Alpaca Preview Order Command (#3782)
 * Drafts an equity or options order proposal on Alpaca (the
 * copilot's broker) with Agent DID attestation — the Alpaca
 * counterpart of etrade_preview_order, completing the catalog's
 * declared orderPreview capability as an agent tool. Safety
 * guarantee: NO SHARES ARE BOUGHT OR SOLD. Awaiting human
 * confirmation (place via alpaca_place_order on explicit approval).
 *
 * Issue #3782 guardrail, same as the E*TRADE preview path: a
 * LIMIT draft with no user-supplied limit prices off the LIVE
 * Alpaca quote (getQuote throws when no live quote is available,
 * so no draft is created); a user-supplied limit always wins over
 * the quote; every draft carries priceSource.
 */
export class AlpacaPreviewOrderCommand implements IMcpToolCommand {
  readonly name = "alpaca_preview_order";
  readonly description =
    "Preview an Alpaca equity or options order draft (BUY, SELL, BUY_TO_COVER, SELL_SHORT) with Agent Decentralized Identifier (DID) cryptographic attestation. Safety guarantee: NO SHARES ARE BOUGHT OR SOLD. Awaiting human confirmation — place via alpaca_place_order only on explicit approval.";

  readonly jsonSchema = {
    type: "object" as const,
    properties: {
      symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, PLTR)" },
      action: { type: "string", enum: ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"], description: "Order action" },
      quantity: { type: "number", description: "Number of shares to trade" },
      orderType: { type: "string", enum: ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"], description: "Execution order type (default: MARKET)" },
      limitPrice: { type: "number", description: "Limit price for limit orders (user-supplied; wins over the live quote)" },
      stopPrice: { type: "number", description: "Stop price for stop orders" },
      orderClass: { type: "string", enum: ["simple", "bracket", "oco", "oto"], description: "Order class ('bracket' for parent orders with take-profit and stop-loss legs)" },
      takeProfit: {
        type: "object",
        properties: { limitPrice: { type: "number", description: "Limit price for take-profit leg" } },
        required: ["limitPrice"],
        description: "Take-profit bracket leg parameters",
      },
      stopLoss: {
        type: "object",
        properties: {
          stopPrice: { type: "number", description: "Stop trigger price for stop-loss leg" },
          limitPrice: { type: "number", description: "Optional limit price for stop-loss limit leg" },
        },
        required: ["stopPrice"],
        description: "Stop-loss bracket leg parameters",
      },
      assetClass: { type: "string", enum: ["equity", "options"], description: "Asset class (default: equity)" },
      optionLegs: { type: "array", items: { type: "object" }, description: "Option legs for a multi-leg strategy order" },
      strategyNetDebit: { type: "number", description: "Net strategy price for an options order (positive is debit, negative is credit)" },
    },
    required: ["symbol", "action", "quantity"],
  };

  readonly zodSchema = z.object({
    symbol: z.string().min(1).describe("Stock ticker symbol"),
    action: z.enum(["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"]).describe("Order action"),
    quantity: z.number().positive().describe("Number of shares"),
    orderType: z.enum(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]).optional().default("MARKET").describe("Order type"),
    limitPrice: z.number().optional().describe("Limit price"),
    stopPrice: z.number().optional().describe("Stop price"),
    orderClass: z.enum(["simple", "bracket", "oco", "oto"]).optional().describe("Order class"),
    takeProfit: z.object({ limitPrice: z.number() }).optional().describe("Take-profit bracket leg"),
    stopLoss: z.object({ stopPrice: z.number(), limitPrice: z.number().optional() }).optional().describe("Stop-loss bracket leg"),
    assetClass: z.enum(["equity", "options"]).optional().describe("Asset class"),
    optionLegs: z.array(z.any()).optional().describe("Option legs"),
    strategyNetDebit: z.number().optional().describe("Net strategy price"),
  });

  async execute(input: any, context: McpToolContext) {
    // Issue #3782: the registry lives behind the src/trading public
    // seam (index.ts) — the #290 boundary test forbids importing a
    // trading-internal path from outside src/trading/. The import
    // stays dynamic so the trading tree (which itself reaches the
    // MCP client modules) loads at call time, not module load.
    const { TradingPlatformRegistry } = await import("../../trading");
    const platform = TradingPlatformRegistry.getPlatform("alpaca", context.env, context.orm, context.sessionId);
    const draft = await platform.previewOrder({
      assetClass: input.assetClass,
      symbol: input.symbol,
      action: input.action || input.orderAction,
      orderAction: input.orderAction || input.action,
      quantity: input.quantity,
      orderType: input.orderType,
      limitPrice: input.limitPrice,
      stopPrice: input.stopPrice,
      orderClass: input.orderClass,
      takeProfit: input.takeProfit,
      stopLoss: input.stopLoss,
      optionLegs: input.optionLegs,
      strategyNetDebit: input.strategyNetDebit,
      sessionId: context.sessionId,
    });
    context.audit?.("alpaca.order_previewed", "trading", {
      orderId: draft.orderId,
      symbol: draft.symbol,
      action: draft.action,
      quantity: draft.quantity,
      estimatedTotal: draft.estimatedTotal,
      proposerDid: draft.proposerDid,
    });
    return {
      orderId: draft.orderId,
      status: "previewed",
      requiresConfirmation: true,
      symbol: draft.symbol,
      action: draft.action,
      quantity: draft.quantity,
      orderType: draft.orderType,
      orderClass: (draft as any).orderClass,
      takeProfit: (draft as any).takeProfit,
      stopLoss: (draft as any).stopLoss,
      broker: "alpaca",
      limitPrice: draft.limitPrice,
      stopPrice: draft.stopPrice,
      estimatedPrice: draft.estimatedPrice,
      estimatedTotal: draft.estimatedTotal,
      estimatedCommission: draft.estimatedCommission,
      // Issue #3782: price provenance rides with the draft — the
      // preview card renders it and never treats an estimated price
      // as the order price.
      priceSource: draft.priceSource,
      proposerDid: draft.proposerDid,
      authorizerDid: draft.authorizerDid,
      proofSignature: draft.proofSignature,
      safetyNotice: "SAFETY GUARANTEE: NO CAPITAL HAS BEEN MOVED. HUMAN APPROVAL REQUIRED BEFORE BROKER EXECUTION.",
      securityGuarantee: "NO MONEY HAS BEEN MOVED & NO SHARES TRADED. Stamped with Agent DID. Requires human confirmation via alpaca_place_order.",
      previewMessage: draft.previewMessage,
    };
  }
}

