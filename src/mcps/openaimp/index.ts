/**
 * Model Context Protocol (MCP) Server for Multi-Agent Studio
 * The server's catalog and execution layer: all platform capabilities
 * as MCP Tools, Resources, and Prompts. The wire dispatch lives in
 * ./handler (issue #2494: the SDK Server + StreamableHTTP transport
 * composition) — this module owns WHAT the server exposes and how a
 * call executes, never how JSON-RPC is framed.
 *
 * Implements SOLID Principles & GoF Design Patterns:
 * - Single Responsibility Principle (SRP): JSON-RPC routing is separated from command execution.
 * - Open/Closed Principle (OCP): New tools register in McpToolFactory without changing this server.
 * - GoF Command Pattern: Tools execute via IMcpToolCommand instances.
 * - GoF Facade Pattern: Subsystems accessed through McpSystemFacade.
 */

import type { AsyncJobSubmission, Env } from "../../types";
import type { DatabaseORM } from "../../orm";
import { computeMarketplaceRevenueSummary } from "../../data/marketplacePorts";
import { McpToolFactory } from "./commands";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import type { ObservabilitySink } from "../../observability/observabilityPorts";
import type { McpPrincipal, ToolPermissionPort } from "./mcpPermissionPorts";
import { McpSystemFacade } from "../../patterns/facade";
import {
  MEMORY_READ_MODE_SWITCH,
  applyMemoryReadCap,
  memoryConfigErrorEvent,
  resolveMemoryReadMode,
} from "../../config/knowledgeMemoryModes";
import { createStructuredLogger } from "../../observability/structuredLogger";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "mcps/openaimp/index",
});

export interface MCPRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

export interface MCPResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: any;
  error?: {
    code: number;
    message: string;
    data?: any;
  };
}

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
}

export interface MCPResourceDefinition {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

export interface MCPPromptDefinition {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * Issue #2494: the OpenAIMP MCP server's name — PROVISIONAL (owner
 * pick pending). This constant is the single place the name lives,
 * beside the folder it names (src/mcps/openaimp/): renaming the
 * server is renaming this value and that folder, nothing else. The
 * `initialize` serverInfo name is served from here via
 * MCP_SERVER_INFO.
 */
export const OPENAIMP_MCP_SERVER_NAME = "openaimp";

export const MCP_SERVER_INFO = {
  name: OPENAIMP_MCP_SERVER_NAME,
  title: "Multi-Agent Studio Enterprise MCP Server",
  version: "1.0.0",
  description: "Exposes asynchronous agent capabilities, SQLite ORM, HITL payments with DIDs, NLQ, trading, and platform operations via MCP. Tool calls return job IDs; use get_async_job or list_async_jobs to retrieve results.",
  protocolVersion: "2024-11-05",
};

/**
 * All Tools exposed via MCP dynamically collected from McpToolFactory (GoF Factory Pattern)
 */
export const MCP_TOOLS: MCPToolDefinition[] = McpToolFactory.getToolDefinitions() as MCPToolDefinition[];

/**
 * Resources exposed via MCP
 */
export const MCP_RESOURCES: MCPResourceDefinition[] = [
  {
    uri: "sqlite://schema/tables",
    name: "Database Tables & Schema",
    description: "Comprehensive schema definitions and row counts for all SQLite tables in Multi-Agent Studio.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://revenue/summary",
    name: "Platform Revenue Summary",
    description: "Real-time financial summary of gross revenue, ad earnings, transaction fees, and net profit.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://categories/list",
    name: "Referral Categories Taxonomy",
    description: "Active referral and partner link taxonomy categories.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://external-ads/inventory",
    name: "External Ad Network Inventory",
    description: "Active advertising placements, impression counters, and earnings.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://memory/facts",
    name: "Persistent Session Facts",
    description: "Grounding facts and long-term user preferences saved in SQLite.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://audit/recent",
    name: "Observability Audit Stream",
    description: "Recent router decisions, HITL authorizations, and agent execution events.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://trading/orders",
    name: "E*TRADE Order Ledger",
    description: "Historical equity orders, execution statuses, and cryptographic Agent DID stamps.",
    mimeType: "application/json",
  },
  {
    uri: "etrade://portfolio/positions",
    name: "E*TRADE Account Positions & Holdings",
    description: "Active equity portfolio holdings, cost basis, and unrealized market gains/losses.",
    mimeType: "application/json",
  },
  {
    uri: "market-data://market/quote/NVDA",
    name: "Market Data Quote (Yahoo Finance & Alpaca)",
    description: "Real-time Level 1 quote and NBBO bid/ask spread for active ticker.",
    mimeType: "application/json",
  },
  {
    uri: "market-data://research/fundamentals/NVDA",
    name: "Market Data Company Fundamentals & Valuations",
    description: "Institutional P/E, PEG, price targets, and balance sheet metrics from Yahoo Finance.",
    mimeType: "application/json",
  },
  {
    uri: "market-data://providers/status",
    name: "Market Data Providers Health",
    description: "Connection status, rate limits, and capabilities of Yahoo Finance and Alpaca integrations.",
    mimeType: "application/json",
  },
  // #1906: deprecated aliases for the market-data resources above.
  // Same handlers; the requested URI is echoed back. Removal is a
  // follow-up slice.
  {
    uri: "foss://market/quote/NVDA",
    name: "Market Data Quote (Yahoo Finance & Alpaca)",
    description: "Deprecated alias for market-data://market/quote/NVDA; use market-data://market/quote/NVDA instead.",
    mimeType: "application/json",
  },
  {
    uri: "foss://research/fundamentals/NVDA",
    name: "Market Data Company Fundamentals & Valuations",
    description: "Deprecated alias for market-data://research/fundamentals/NVDA; use market-data://research/fundamentals/NVDA instead.",
    mimeType: "application/json",
  },
  {
    uri: "foss://providers/status",
    name: "Market Data Providers Health",
    description: "Deprecated alias for market-data://providers/status; use market-data://providers/status instead.",
    mimeType: "application/json",
  },
];

/**
 * Prompts exposed via MCP
 */
export const MCP_PROMPTS: MCPPromptDefinition[] = [
  {
    name: "audit_security_review",
    description: "Security and compliance review of pending financial drafts and cryptographic DID proof signatures.",
    arguments: [
      { name: "draftId", description: "Draft payment ID to inspect", required: true },
    ],
  },
  {
    name: "revenue_performance_analysis",
    description: "Analyze monetization efficiency across external ad networks (CPM/CPC) and recommend inventory optimizations.",
    arguments: [],
  },
  {
    name: "nlq_schema_exploration",
    description: "Formulate optimal natural language queries to explore data and relationships across SQLite tables.",
    arguments: [],
  },
  {
    name: "market_data_equity_research_report",
    description: "Generate comprehensive equity research report synthesizing fundamentals, technical indicators, and analyst price targets via Yahoo Finance and Alpaca.",
    arguments: [
      { name: "symbol", description: "Stock ticker symbol (e.g. NVDA, AAPL, MSFT)", required: true },
    ],
  },
  // #1906: deprecated alias for the renamed prompt above. prompts/get
  // finds by name and echoes prompt.name, so no rendering change is
  // needed. Removal is a follow-up slice.
  {
    name: "foss_equity_research_report",
    description: "Deprecated alias for market_data_equity_research_report; use market_data_equity_research_report instead.",
    arguments: [
      { name: "symbol", description: "Stock ticker symbol (e.g. NVDA, AAPL, MSFT)", required: true },
    ],
  },
];

/**
 * Executes an MCP Tool Call using the GoF Command Pattern and Facade Pattern.
 */
export async function executeMCPTool(
  toolName: string,
  args: Record<string, any>,
  context: {
    env: Env;
    orm: DatabaseORM;
    sessionId: string;
    /** #1744: calling principal + gate port; unset → factory defaults (system, production port). */
    principal?: McpPrincipal;
    /** #2341: acting-identity resolver, spread through to the tool context like the scoped carriers (see McpToolContext.actingLogin). */
    actingLogin?: () => string | undefined;
    /** #2428: mesh-trace traceparent resolver, spread through to the tool context like the actingLogin carrier (see McpToolContext.traceparent). */
    traceparent?: () => string | undefined;
    permissionPort?: ToolPermissionPort;
    permissionDecisionSink?: ObservabilitySink;
    /** #1722: NLQ_MODE session/user carriers, spread through to the tool context. */
    scopedNlqModes?: import("../../config/nlqModes").NlqScopedModes;
    /** #1723: KNOWLEDGE_MODE / MEMORY_READ_MODE carriers, spread likewise. */
    scopedKnowledgeModes?: import("../../config/knowledgeMemoryModes").KnowledgeScopedModes;
    scopedMemoryModes?: import("../../config/knowledgeMemoryModes").MemoryScopedModes;
    /** #1724: JOB_LIST_ENVELOPE carrier, spread through to the tool context. */
    scopedJobListModes?: import("../../config/asyncJobModes").JobListScopedModes;
    /** #1728: agentic-payments / premium-gating carriers, spread likewise. */
    scopedPaymentsModes?: import("../../config/agenticPaymentsModes").PaymentsScopedModes;
    /** #1729: GOAL_COMPILE_MODE carrier, spread likewise. */
    scopedGoalChainModes?: import("../../config/goalChainModes").GoalChainScopedModes;
    /** #1686: optional DO blob handle, spread through to the tool context like the scoped carriers (the factory spread forwards it to the tool command). */
    storage?: import("../../trading").NasdaqUniverseRouteBundleInput["storage"];
    audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
    submitJob?: (job: AsyncJobSubmission) => Promise<{
      jobId: string;
      status: "queued";
      statusUrl: string;
    }>;
    getJob?: (jobId: string) => unknown;
    listJobs?: () => unknown[];
  }
): Promise<any> {
  const facade = new McpSystemFacade(context.env, context.orm, context.sessionId);
  return McpToolFactory.executeTool(toolName, args, {
    ...context,
    facade,
    // #1744: denial events stream via #1743's sink (built from env
    // when the caller supplied none); sink failure never fails the call.
    permissionDecisionSink:
      context.permissionDecisionSink ?? createObservabilitySink(context.env),
  });
}

/**
 * Reads an MCP Resource by URI.
 */
export async function readMCPResource(
  uri: string,
  context: {
    orm: DatabaseORM;
    sessionId: string;
    /** #1723: env for the MEMORY_READ_MODE env level (resource protocol has no run carrier). */
    env?: Env;
    /** #1723: optional audit channel for memory.config_error on an invalid env value. */
    audit?: (type: string, agent: any, payload: Record<string, unknown>) => void;
  }
): Promise<{ uri: string; mimeType: string; text: string }> {
  const { orm, sessionId } = context;

  // #1906: deprecated legacy resource URIs dispatch to the same handlers
  // as their canonical market-data:// URIs; the REQUESTED uri is echoed
  // back (existing behavior), so legacy callers see their own URI.
  const dispatchUri = uri.startsWith("foss://") ? uri.replace("foss://", "market-data://") : uri;

  switch (dispatchUri) {
    case "sqlite://schema/tables": {
      const tables = orm.listTables();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(tables, null, 2),
      };
    }
    case "sqlite://revenue/summary": {
      // #2345: revenue computes over the marketplace ports
      // (fleet counters when D1-bound) + the DO-resident ledger.
      const mp = await orm.marketplacePorts(context.env ?? {});
      const summary = await computeMarketplaceRevenueSummary(mp, orm.transactions);
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(summary, null, 2),
      };
    }
    case "sqlite://categories/list": {
      const mp = await orm.marketplacePorts(context.env ?? {});
      const categories = await mp.categories.findMany({ orderBy: "sort_order ASC" });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(categories, null, 2),
      };
    }
    case "sqlite://external-ads/inventory": {
      const mp = await orm.marketplacePorts(context.env ?? {});
      const ads = await mp.externalAds.findMany({ orderBy: "earnings DESC" });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(ads, null, 2),
      };
    }
    case "sqlite://memory/facts": {
      // #1723: MEMORY_READ_MODE over the read cap only. The resource
      // protocol carries no per-call mode, so only the env level
      // applies here (builtin legacy = "uncapped"); an invalid env
      // value fails closed to uncapped, is logged, and is audited
      // when the caller supplied an audit channel.
      const resolved = resolveMemoryReadMode(
        { env: (context.env as unknown as Record<string, unknown> | undefined)?.[MEMORY_READ_MODE_SWITCH] },
        "uncapped"
      );
      if (resolved.invalid) {
        structuredLog.error(memoryConfigErrorEvent(), {
          message: `[memory] invalid ${MEMORY_READ_MODE_SWITCH} value ${JSON.stringify(resolved.raw)} — failing closed to "uncapped"`,
          switch: MEMORY_READ_MODE_SWITCH,
          raw: resolved.raw ?? null,
          resolved: "uncapped",
        });
        context.audit?.(memoryConfigErrorEvent(), "orchestrator", {
          setting: MEMORY_READ_MODE_SWITCH,
          value: resolved.raw ?? "",
          resolved: "uncapped",
        });
      }
      const memories = applyMemoryReadCap(
        orm.memory.findMany({ orderBy: "updated_at DESC" }),
        resolved.mode
      );
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(memories, null, 2),
      };
    }
    case "sqlite://audit/recent": {
      const events = orm.events.findMany({ where: { sessionId }, orderBy: "created_at DESC", limit: 30 });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(events, null, 2),
      };
    }
    case "sqlite://trading/orders": {
      const orders = orm.trades.findMany({ orderBy: "created_at DESC", limit: 50 });
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(orders, null, 2),
      };
    }
    case "etrade://portfolio/positions": {
      const { ETradeService } = await import("../../services/etrade");
      const etrade = new ETradeService(orm, undefined, sessionId);
      const holdings = etrade.getPositions();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(holdings, null, 2),
      };
    }
    case "market-data://providers/status": {
      const { MarketDataResearchService } = await import("../../services/marketDataResearch");
      const marketDataResearch = new MarketDataResearchService();
      const statuses = marketDataResearch.getProviderStatuses();
      return {
        uri,
        mimeType: "application/json",
        text: JSON.stringify(statuses, null, 2),
      };
    }
    default: {
      if (dispatchUri.startsWith("market-data://market/quote/")) {
        const sym = dispatchUri.replace("market-data://market/quote/", "");
        const { MarketDataResearchService } = await import("../../services/marketDataResearch");
        const marketDataResearch = new MarketDataResearchService();
        const quote = await marketDataResearch.getQuote(sym);
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(quote, null, 2),
        };
      }
      if (dispatchUri.startsWith("market-data://research/fundamentals/")) {
        const sym = dispatchUri.replace("market-data://research/fundamentals/", "");
        const { MarketDataResearchService } = await import("../../services/marketDataResearch");
        const marketDataResearch = new MarketDataResearchService();
        const fundamentals = await marketDataResearch.getFundamentals(sym);
        return {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(fundamentals, null, 2),
        };
      }
      throw new Error(`MCP Resource not found: ${uri}`);
    }
  }
}
