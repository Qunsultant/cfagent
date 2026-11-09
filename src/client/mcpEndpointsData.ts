/**
 * API & Model Context Protocol (MCP) Endpoints Metadata & Sample Payloads
 */

export interface McpToolMeta {
  name: string;
  category: string;
  description: string;
  schema: Record<string, any>;
  sampleArgs: Record<string, any>;
}

export interface McpResourceMeta {
  uri: string;
  name: string;
  description: string;
  mimeType: string;
}

export interface McpPromptMeta {
  name: string;
  description: string;
  args: Array<{ name: string; description: string; required?: boolean }>;
}

export interface RestEndpointMeta {
  id: string;
  category: "Agents & NLQ" | "Payments & DIDs" | "Enterprise Data & Ledger" | "Monetization & Ads" | "Referrals & Community" | "System & Audit" | "Trading & E*TRADE" | "Market Data Research & Quoting";
  method: "GET" | "POST" | "DELETE";
  path: string;
  title: string;
  description: string;
  authRequired: boolean;
  sampleBody?: Record<string, any>;
  sampleCurl: string;
  /** Documented response shape (what a 200 response carries). Issue #325. */
  sampleResponse?: Record<string, any>;
}

export const MCP_TOOLS_CATALOG: McpToolMeta[] = [
  {
    name: "knowledge_search",
    category: "Knowledge & RAG",
    description: "Search the organization's enterprise knowledge base using semantic vector RAG intelligence retrieval.",
    schema: {
      type: "object",
      properties: { query: { type: "string", description: "Search query or natural language inquiry" } },
      required: ["query"],
    },
    sampleArgs: { query: "What algorithmic screening workflows are available?" },
  },
  {
    name: "draft_payment",
    category: "Financial Ledger",
    description: "Prepare an explicit human-authorized payment intent draft with Agent DID attestation across Stripe, PayPal, or Lemon Squeezy.",
    schema: {
      type: "object",
      properties: {
        amount: { type: "number", description: "Amount in USD (e.g. 35.00)" },
        currency: { type: "string", description: "Currency code (default: USD)" },
        customer: { type: "string", description: "Customer name or organization" },
        gateway: { type: "string", enum: ["stripe", "paypal", "lemonsqueezy"], description: "Payment gateway processor" },
        action: { type: "string", enum: ["charge", "refund", "invoice"], description: "Payment action type" },
        description: { type: "string", description: "Order description or note" },
      },
      required: ["amount", "customer"],
    },
    sampleArgs: { amount: 35.0, currency: "USD", customer: "Acme Logistics", gateway: "stripe", action: "charge", description: "Pro Token Compute Subscription" },
  },
  {
    name: "confirm_payment_draft",
    category: "HITL & Security",
    description: "Authorize or reject a pending payment draft using Human-in-the-Loop (HITL) approval with cryptographic verification.",
    schema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "Payment draft ID to execute or reject" },
        decision: { type: "string", enum: ["approved", "rejected"], description: "Reviewer decision" },
        note: { type: "string", description: "Optional compliance audit note" },
      },
      required: ["draftId", "decision"],
    },
    sampleArgs: { draftId: "pay_1a2b3c4d", decision: "approved", note: "Approved by finance manager via MCP" },
  },
  {
    name: "get_payment_gateways",
    category: "Financial Ledger",
    description: "Introspect active configuration and connectivity for Stripe, PayPal, and Lemon Squeezy processors with Agent DIDs.",
    schema: { type: "object", properties: {} },
    sampleArgs: {},
  },
  {
    name: "get_transactions",
    category: "Financial Ledger",
    description: "Retrieve verified transaction ledger with cryptographic Agent DID signatures and gateway settlement references.",
    schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Maximum transactions to return (default: 20)" },
        status: { type: "string", description: "Filter by status (completed, awaiting_confirmation, etc.)" },
      },
    },
    sampleArgs: { limit: 10 },
  },
  {
    name: "execute_nlq",
    category: "Natural Language SQL",
    description: "Submit natural language database, market-data, or options-strategy work as a background job; retrieve its result with get_async_job.",
    schema: {
      type: "object",
      properties: { query: { type: "string", description: "Natural language query against database or message history" } },
      required: ["query"],
    },
    sampleArgs: { query: "List all database tables and schema" },
  },
  {
    name: "get_async_job",
    category: "Async Jobs",
    description: "Get the status and completed result for a background capability job.",
    schema: {
      type: "object",
      properties: { jobId: { type: "string", description: "Job ID returned on submission" } },
      required: ["jobId"],
    },
    sampleArgs: { jobId: "00000000-0000-4000-8000-000000000000" },
  },
  {
    name: "list_async_jobs",
    category: "Async Jobs",
    description: "List recent background jobs for the current session.",
    schema: { type: "object", properties: {} },
    sampleArgs: {},
  },
  {
    name: "list_database_tables",
    category: "Enterprise Data & Ledger",
    description: "Introspect institutional relational tables, schema columns, record structures, and live row counts managed by the data repository.",
    schema: { type: "object", properties: {} },
    sampleArgs: {},
  },
  {
    name: "query_table_data",
    category: "Enterprise Data & Ledger",
    description: "Query rows from any enterprise table with pagination, column inspection, and full-text keyword filtering.",
    schema: {
      type: "object",
      properties: {
        tableName: { type: "string", description: "Target institutional table (mas_categories, mas_external_ads, etc.)" },
        search: { type: "string", description: "Optional keyword search filter" },
        limit: { type: "number", description: "Maximum rows to return" },
        offset: { type: "number", description: "Row offset" },
      },
      required: ["tableName"],
    },
    sampleArgs: { tableName: "mas_categories", limit: 5 },
  },
  {
    name: "manage_categories",
    category: "Taxonomy & Partners",
    description: "CRUD operations on referral and partnership categories taxonomy in firm records.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "delete"], description: "Category operation" },
        id: { type: "string", description: "Category ID (required for delete)" },
        name: { type: "string", description: "Category display name" },
        description: { type: "string", description: "Category summary" },
        icon: { type: "string", description: "Category emoji icon" },
      },
      required: ["action"],
    },
    sampleArgs: { action: "list" },
  },
  {
    name: "manage_referrals",
    category: "Taxonomy & Partners",
    description: "Manage community and partner referral links, tracking clicks, sign-ups, and developer earnings.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "record_click"], description: "Referral operation" },
        id: { type: "string", description: "Referral ID" },
        title: { type: "string", description: "Link title or service name" },
        url: { type: "string", description: "Target URL" },
        category: { type: "string", description: "Category" },
        rewardText: { type: "string", description: "Reward text" },
      },
      required: ["action"],
    },
    sampleArgs: { action: "list" },
  },
  {
    name: "manage_external_ads",
    category: "Monetization & Ads",
    description: "Manage external ad network inventory (Google AdSense, EthicalAds, Carbon Ads, Direct) with live CPM/CPC impression tracking.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "create", "track_impression", "track_click"], description: "Ad operation" },
        id: { type: "string", description: "Ad placement ID" },
        network: { type: "string", enum: ["google", "adsense", "ethicalads", "carbon", "direct"] },
        placement: { type: "string", enum: ["header_leaderboard", "in_stream", "footer_deck", "sidebar"] },
        title: { type: "string", description: "Ad title" },
        tagline: { type: "string", description: "Tagline" },
        targetUrl: { type: "string", description: "Destination URL" },
      },
      required: ["action"],
    },
    sampleArgs: { action: "list" },
  },
  {
    name: "get_revenue_summary",
    category: "Monetization & Ads",
    description: "Retrieve comprehensive platform revenue breakdown across ad network CPM/CPC earnings, marketplace listings, and processing fees.",
    schema: { type: "object", properties: {} },
    sampleArgs: {},
  },
  {
    name: "manage_session_memory",
    category: "Agent Memory",
    description: "Read, write, or clear persistent memory facts and user preferences stored across sessions.",
    schema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "set", "delete", "clear"], description: "Memory action" },
        key: { type: "string", description: "Fact key" },
        value: { type: "string", description: "Fact value" },
      },
      required: ["action"],
    },
    sampleArgs: { action: "list" },
  },
  {
    name: "get_audit_events",
    category: "Observability",
    description: "Query real-time audit event stream for router decisions, LLM Judge evaluations, HITL approvals, and agent executions.",
    schema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "Number of recent events (default: 25)" },
        type: { type: "string", description: "Exact event type to match (e.g. etrade.auth_blocked)" },
        agent: { type: "string", description: "Exact agent to match" },
        before: { type: "string", description: "Exclusive upper bound (ISO timestamp)" },
        after: { type: "string", description: "Exclusive lower bound (ISO timestamp)" },
      },
    },
    sampleArgs: { limit: 15 },
  },
  {
    name: "etrade_market_scan",
    category: "Trading & E*TRADE",
    description: "Scan equity markets using technical criteria (RSI-14, MACD, momentum, sector, market cap, volume) via E*TRADE Market APIs.",
    schema: {
      type: "object",
      properties: {
        sector: { type: "string", description: "Sector filter (Technology, Financial, Healthcare, etc.)" },
        minRsi: { type: "number", description: "Minimum RSI-14 value" },
        maxRsi: { type: "number", description: "Maximum RSI-14 value (e.g. 35 for oversold)" },
        minMarketCap: { type: "number", description: "Minimum market cap in billions (e.g. 50)" },
        onlyGainers: { type: "boolean", description: "Filter only positive 24h gainers" },
        onlyLosers: { type: "boolean", description: "Filter only negative 24h losers" },
        limit: { type: "number", description: "Max stocks to return (default 10)" },
      },
    },
    sampleArgs: { sector: "Technology", maxRsi: 45, limit: 5 },
  },
  {
    name: "etrade_get_quote",
    category: "Trading & E*TRADE",
    description: "Retrieve real-time Level 1 equity quote, bid/ask spread, 52-week high/low, and RSI technicals from E*TRADE.",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, MSFT)" },
      },
      required: ["symbol"],
    },
    sampleArgs: { symbol: "NVDA" },
  },
  {
    name: "etrade_preview_order",
    category: "Trading & E*TRADE",
    description: "Prepare an order draft in preview status with cryptographic Trading Agent DID attestation. DOES NOT execute trades without explicit human approval.",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker symbol" },
        action: { type: "string", enum: ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"], description: "Order action" },
        quantity: { type: "number", description: "Number of shares" },
        orderType: { type: "string", enum: ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"], description: "Order pricing type" },
        limitPrice: { type: "number", description: "Limit price (required for LIMIT orders)" },
      },
      required: ["symbol", "action", "quantity"],
    },
    sampleArgs: { symbol: "NVDA", action: "BUY", quantity: 10, orderType: "LIMIT", limitPrice: 125.5 },
  },
  {
    name: "etrade_execute_order",
    category: "HITL & Security",
    description: "Authorize or reject a pending E*TRADE equity order draft using Human-in-the-Loop approval with cryptographic DID stamp.",
    schema: {
      type: "object",
      properties: {
        draftId: { type: "string", description: "Draft Order ID (ord_xxxxxxxx)" },
        decision: { type: "string", enum: ["approved", "rejected"], description: "Reviewer authorization decision" },
        note: { type: "string", description: "Optional compliance note" },
      },
      required: ["draftId", "decision"],
    },
    sampleArgs: { draftId: "ord_1a2b3c4d", decision: "approved" },
  },
  {
    name: "etrade_get_positions",
    category: "Trading & E*TRADE",
    description: "Retrieve current portfolio holdings, equity positions, unrealized gain/loss, and purchasing power from E*TRADE brokerage.",
    schema: { type: "object", properties: {} },
    sampleArgs: {},
  },
  {
    name: "market_data_get_quote",
    category: "Market Data Research & Quoting",
    description: "Retrieve real-time market quote, bid/ask spread, 24h change, and volume using market-data engines (Yahoo Finance or Alpaca Market Data v2).",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker or crypto pair (e.g. NVDA, AAPL, BTC/USD)" },
        provider: { type: "string", enum: ["yfinance", "alpaca", "hybrid"], description: "Market data provider" },
      },
      required: ["symbol"],
    },
    sampleArgs: { symbol: "NVDA", provider: "hybrid" },
  },
  {
    name: "market_data_company_fundamentals",
    category: "Market Data Research & Quoting",
    description: "Extract comprehensive company fundamentals, valuation ratios (P/E, PEG, Price-to-Book, Beta), and Wall Street analyst targets via Yahoo Finance.",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, MSFT)" },
      },
      required: ["symbol"],
    },
    sampleArgs: { symbol: "NVDA" },
  },
  {
    name: "market_data_historical_bars",
    category: "Market Data Research & Quoting",
    description: "Query historical OHLCV pricing bars, VWAP, and volume series for equities and crypto.",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker symbol or crypto pair" },
        timeframe: { type: "string", description: "Bar timeframe (default: '1D')" },
        limit: { type: "number", description: "Number of bars to return (default: 30)" },
      },
      required: ["symbol"],
    },
    sampleArgs: { symbol: "NVDA", timeframe: "1D", limit: 30 },
  },
  {
    name: "market_data_research",
    category: "Market Data Research & Quoting",
    description: "Generate an autonomous equity research report synthesizing real-time quoting, institutional valuation, technical RSI/MACD indicators, analyst consensus, and cryptographic W3C Agent DID attestation.",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker symbol (e.g. NVDA, AAPL, MSFT)" },
      },
      required: ["symbol"],
    },
    sampleArgs: { symbol: "NVDA" },
  },
  {
    name: "alpaca_snapshot",
    category: "Market Data Research & Quoting",
    description: "Query real-time Level 1/2 market snapshot, NBBO bid/ask prices, trade prints, and daily volume via Alpaca Market Data v2.",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker symbol or crypto pair (e.g. NVDA, BTC/USD)" },
      },
      required: ["symbol"],
    },
    sampleArgs: { symbol: "NVDA" },
  },
  {
    name: "alpaca_account",
    category: "Market Data Research & Quoting",
    description: "Query Alpaca Securities brokerage account details, cash balance, buying power, and portfolio equity with agentic DID audit tracing.",
    schema: { type: "object", properties: {} },
    sampleArgs: {},
  },
  {
    name: "alpaca_positions",
    category: "Market Data Research & Quoting",
    description: "Query open equity and crypto portfolio positions from Alpaca Securities with agentic DID audit tracing.",
    schema: { type: "object", properties: {} },
    sampleArgs: {},
  },
  {
    name: "alpaca_orders",
    category: "Market Data Research & Quoting",
    description: "Query active and filled orders from Alpaca Securities with status filter and agentic DID audit tracing.",
    schema: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "closed", "all"], description: "Order status filter (default: open)" },
      },
    },
    sampleArgs: { status: "open" },
  },
  {
    name: "alpaca_place_order",
    category: "Market Data Research & Quoting",
    description: "Place a stock, ETF, or crypto order on Alpaca Securities with Agent DID attestation and audit tracing.",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker symbol (e.g. NVDA, AAPL, BTC/USD)" },
        qty: { type: "number", description: "Number of shares or contract units" },
        side: { type: "string", enum: ["buy", "sell"], description: "Order side (buy or sell)" },
        type: { type: "string", enum: ["market", "limit", "stop", "stop_limit"], description: "Order execution type" },
        limit_price: { type: "number", description: "Limit price (required if type is limit)" },
      },
      required: ["symbol", "qty", "side"],
    },
    sampleArgs: { symbol: "NVDA", qty: 1, side: "buy", type: "limit", limit_price: 135.0 },
  },
  {
    name: "alpaca_execute_order",
    category: "Market Data Research & Quoting",
    description: "Execute a previewed Alpaca order draft by orderId after explicit human approval. Settles the stored draft through the same placement client as alpaca_place_order; no draft, no placement.",
    schema: {
      type: "object",
      properties: {
        orderId: { type: "string", description: "The previewed draft id (alp_ord_...)" },
        decision: { type: "string", enum: ["approved", "rejected"], description: "Human decision (default: approved)" },
      },
      required: ["orderId"],
    },
    sampleArgs: { orderId: "alp_ord_1a2b3c4d", decision: "approved" },
  },
  {
    name: "alpaca_get_quote",
    category: "Market Data Research & Quoting",
    description: "Retrieve a live market quote (price, bid/ask, volume, OHLC) for an equity ticker from Alpaca Market Data v2. Live-only: the result carries provider 'alpaca', provenance 'live', and a timestamp.",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Stock ticker symbol (e.g. AAPL, NVDA)" },
      },
      required: ["symbol"],
    },
    sampleArgs: { symbol: "AAPL" },
  },
  {
    name: "alpaca_preview_order",
    category: "Market Data Research & Quoting",
    description: "Preview an Alpaca equity or options order draft with Agent DID attestation. Safety guarantee: NO SHARES ARE BOUGHT OR SOLD. Awaiting human confirmation — place via alpaca_place_order only on explicit approval. Every draft carries priceSource (user, or live quote with provider + timestamp).",
    schema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Ticker symbol (e.g. NVDA, AAPL)" },
        action: { type: "string", enum: ["BUY", "SELL", "BUY_TO_COVER", "SELL_SHORT"], description: "Order action" },
        quantity: { type: "number", description: "Number of shares to trade" },
        orderType: { type: "string", enum: ["MARKET", "LIMIT", "STOP", "STOP_LIMIT"], description: "Execution order type (default: MARKET)" },
        limitPrice: { type: "number", description: "Limit price for limit orders" },
      },
      required: ["symbol", "action", "quantity"],
    },
    sampleArgs: { symbol: "AAPL", action: "BUY", quantity: 10, orderType: "LIMIT", limitPrice: 340.0 },
  },
  {
    name: "agentdb.chain.status",
    category: "AgentDB Reads",
    description: "Read a chain's projected status from AgentDB (latest chain + schedule rows, projection only). Read-only; tenant resolved from the caller's environment.",
    schema: {
      type: "object",
      properties: {
        chainId: { type: "string", description: "The persisted chain identity (the synthesized record id)" },
      },
      required: ["chainId"],
    },
    sampleArgs: { chainId: "c1" },
  },
  {
    name: "agentdb.jobs.history",
    category: "AgentDB Reads",
    description: "List a chain's projected shard jobs from AgentDB (latest row per job, newest first, projection only). Read-only; tenant resolved from the caller's environment.",
    schema: {
      type: "object",
      properties: {
        chainId: { type: "string", description: "The chain the jobs ran (or were submitted) for" },
      },
      required: ["chainId"],
    },
    sampleArgs: { chainId: "c1" },
  },
  {
    name: "agentdb.audit.history",
    category: "AgentDB Reads",
    description: "List a chain's projected audit events from AgentDB (one row per lifecycle event, newest first, projection only). Read-only; tenant resolved from the caller's environment.",
    schema: {
      type: "object",
      properties: {
        chainId: { type: "string", description: "The chain the audit events belong to" },
      },
      required: ["chainId"],
    },
    sampleArgs: { chainId: "c1" },
  },
  {
    name: "agentdb.reports.list",
    category: "AgentDB Reads",
    description: "List canonical reports from AgentDB (latest row per report, newest first; with reportId, that one report — projection only). Read-only; bodies are never included. Tenant resolved from the caller's environment.",
    schema: {
      type: "object",
      properties: {
        reportId: { type: "string", description: "Optional canonical report id; when absent, all reports for the tenant are listed" },
      },
    },
    sampleArgs: {},
  },
];

export const MCP_RESOURCES_CATALOG: McpResourceMeta[] = [
  {
    uri: "sqlite://schema/tables",
    name: "Enterprise Data Schema & Table Metadata",
    description: "Complete database introspection of all 10 relational tables with columns, types, and primary keys.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://trading/orders",
    name: "E*TRADE Orders Ledger & Audit Trail",
    description: "Persistent ledger of previewed and executed equity trades in mas_trades with Agent DID attestations.",
    mimeType: "application/json",
  },
  {
    uri: "etrade://portfolio/positions",
    name: "E*TRADE Brokerage Portfolio Holdings",
    description: "Active positions, market value, unrealized P&L, and account purchasing power.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://revenue/summary",
    name: "Platform Financials & Revenue Analytics",
    description: "Multi-stream gross revenue, ad network RPM, marketplace fees, and net profit margins.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://categories/list",
    name: "Referral & Tool Categories Taxonomy",
    description: "Active taxonomy of partner categories, sort priorities, and metadata.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://external-ads/inventory",
    name: "Ad Network Placements Inventory",
    description: "Live external ad placements (Google Ads, EthicalAds, Carbon, Direct) with views, clicks, and earnings.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://memory/facts",
    name: "Persistent Session Memory Vault",
    description: "Long-term key-value user facts and preferences stored in the session memory vault.",
    mimeType: "application/json",
  },
  {
    uri: "sqlite://audit/recent",
    name: "Recent System Audit & Observability Stream",
    description: "Recent 20 router decisions, judge guardrail evaluations, and agent execution events.",
    mimeType: "application/json",
  },
];

export const MCP_PROMPTS_CATALOG: McpPromptMeta[] = [
  {
    name: "etrade_market_scan_summary",
    description: "Generate structured market scanning summary and trade proposal ideas based on technical indicators.",
    args: [
      { name: "sector", description: "Sector to analyze (e.g. Technology)" },
      { name: "strategy", description: "Strategy focus: 'oversold_bounce', 'momentum_breakout', or 'value'" },
    ],
  },
  {
    name: "audit_security_review",
    description: "Audit agent decisions, guardrail safety scores, and financial authorizations for compliance risks.",
    args: [{ name: "timeframe", description: "Audit period (e.g. 'recent', 'today', '24h')" }],
  },
  {
    name: "revenue_performance_analysis",
    description: "Synthesize platform ad network performance, RPM trends, and recommend monetization strategies.",
    args: [{ name: "focus", description: "Analysis focus ('overall', 'ads', 'referrals', 'processing_fees')" }],
  },
  {
    name: "nlq_schema_exploration",
    description: "Explore enterprise schema and generate optimized analytical query plans for business metrics.",
    args: [{ name: "goal", description: "Analytical goal or question to answer from the database" }],
  },
];

export const REST_APIS_CATALOG: RestEndpointMeta[] = [
  {
    id: "api_chat",
    category: "Agents & NLQ",
    method: "POST",
    path: "/api/chat",
    title: "Multi-Agent Conversation (synchronous reply)",
    description:
      "Runs one agentic chat turn on the canonical chat pipeline (AI decision routing across search, payments, tasks, and memory sub-agents) and returns the completed reply as JSON. True streaming remains available over the agent WebSocket chat; this route is explicit synchronous (streaming: false).",
    authRequired: true,
    sampleBody: { messages: [{ role: "user", content: "What are the latest platform trading capabilities?" }] },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/chat \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Hello AI Assistant"}]}'`,
    sampleResponse: {
      reply: "The assistant's completed answer text for this turn.",
      route: {
        agent: "routed agent id (e.g. search, trading, research, payments, tasks, memory)",
        confidence: 0.93,
        reason: "judge routing rationale",
        needsConfirmation: false,
      },
      model: "Neural model identifier used for the turn",
      streaming: false,
    },
  },
  {
    id: "api_nlq",
    category: "Agents & NLQ",
    method: "POST",
    path: "/api/nlq",
    title: "Natural Language Query Engine",
    description: "Translates natural language questions into deterministic read-only business queries executed safely via typed repositories.",
    authRequired: true,
    sampleBody: { query: "List all database tables and schema" },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/nlq \\
  -H "Content-Type: application/json" \\
  -d '{"query":"List all database tables and schema"}'`,
  },
  {
    id: "api_schema_tables",
    category: "Enterprise Data & Ledger",
    method: "GET",
    path: "/api/schema/tables",
    title: "List Enterprise Tables & Schema",
    description: "Returns schema metadata, column types, primary keys, and row counts for all 8 relational tables.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/schema/tables`,
  },
  {
    id: "api_schema_query",
    category: "Enterprise Data & Ledger",
    method: "POST",
    path: "/api/schema/query",
    title: "Execute Table Data Query",
    description: "Queries rows from any database table with limit, offset, and keyword filtering.",
    authRequired: true,
    sampleBody: { table: "mas_categories", limit: 10 },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/schema/query \\
  -H "Content-Type: application/json" \\
  -d '{"table":"mas_categories","limit":10}'`,
  },
  {
    id: "api_categories_get",
    category: "Referrals & Community",
    method: "GET",
    path: "/api/categories",
    title: "List Referral Categories",
    description: "Retrieves active partner categories sorted by priority order from taxonomy records.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/categories`,
  },
  {
    id: "api_categories_post",
    category: "Referrals & Community",
    method: "POST",
    path: "/api/categories",
    title: "Create Referral Category",
    description: "Creates a new category in the business taxonomy using the enterprise repository.",
    authRequired: true,
    sampleBody: { name: "Web3 & Zero Knowledge", icon: "⚡", description: "Decentralized and ZK infrastructure", sortOrder: 6 },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/categories \\
  -H "Content-Type: application/json" \\
  -d '{"name":"Web3 & Zero Knowledge","icon":"⚡","description":"ZK tooling","sortOrder":6}'`,
  },
  {
    id: "api_referrals_get",
    category: "Referrals & Community",
    method: "GET",
    path: "/api/referrals",
    title: "List Referral Links",
    description: "Retrieves placed affiliate and referral links with click counters and referred signups.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/referrals`,
  },
  {
    id: "api_referrals_post",
    category: "Referrals & Community",
    method: "POST",
    path: "/api/referrals",
    title: "Publish Referral Link",
    description: "Publishes a new tool or platform referral link for user account with category attribution.",
    authRequired: true,
    sampleBody: { title: "Algorithmic Market Data Pro", url: "https://example.com/market-pro?ref=team", category: "AI & Dev Tools", rewardText: "Get $10 in free API credits" },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/referrals \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Market Intelligence","url":"https://example.com/intel?ref=demo","category":"AI & Dev Tools","rewardText":"$10 credits"}'`,
  },
  {
    id: "api_revenue_get",
    category: "Monetization & Ads",
    method: "GET",
    path: "/api/revenue",
    title: "Platform Revenue Summary",
    description: "Computes multi-stream platform financials: ad network CPM/CPC, marketplace fees, payment transaction processing fees, net profit, and RPM.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/revenue`,
  },
  {
    id: "api_external_ads_get",
    category: "Monetization & Ads",
    method: "GET",
    path: "/api/external-ads",
    title: "List External Ad Network Units",
    description: "Queries active Google Ads, EthicalAds, Carbon Ads, and Direct sponsor placements with CPM/CPC rates and live earnings.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/external-ads`,
  },
  {
    id: "api_external_ads_post",
    category: "Monetization & Ads",
    method: "POST",
    path: "/api/external-ads",
    title: "Register Ad Network Unit",
    description: "Registers or updates a placement unit across Google Ads, EthicalAds, Carbon, or Direct sponsors.",
    authRequired: true,
    sampleBody: { title: "Google Cloud Vertex AI GPUs", network: "google", placement: "header_leaderboard", tagline: "Deploy high-throughput inference", targetUrl: "https://cloud.google.com/vertex-ai", cpmRate: 24.5, cpcRate: 2.1 },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/external-ads \\
  -H "Content-Type: application/json" \\
  -d '{"title":"Google Cloud Vertex AI","network":"google","placement":"header_leaderboard","tagline":"Fast GPUs","targetUrl":"https://cloud.google.com","cpmRate":24.5,"cpcRate":2.1}'`,
  },
  {
    id: "api_payments_status",
    category: "Payments & DIDs",
    method: "GET",
    path: "/api/payments/status",
    title: "Payment Gateways & DID Registry",
    description: "Returns connection status for Stripe, PayPal, and Lemon Squeezy with known Agent DIDs and User DID.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/payments/status`,
  },
  {
    id: "api_payments_tx",
    category: "Payments & DIDs",
    method: "GET",
    path: "/api/payments/transactions",
    title: "Transaction Ledger with DIDs",
    description: "Returns financial audit log with cryptographic DID attestation signatures, gateway references, and amounts.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/payments/transactions`,
  },
  {
    id: "api_payments_create",
    category: "Payments & DIDs",
    method: "POST",
    path: "/api/payments/create",
    title: "Draft Payment Intent",
    description: "Creates a payment intent across Stripe, PayPal, or Lemon Squeezy with verifiable Agent DID attestation.",
    authRequired: true,
    sampleBody: { amount: 50.0, currency: "USD", customer: "Acme Logistics", gateway: "stripe", action: "charge", description: "1M Token Allowance" },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/payments/create \\
  -H "Content-Type: application/json" \\
  -d '{"amount":50.0,"currency":"USD","customer":"Acme Logistics","gateway":"stripe","action":"charge"}'`,
  },
  {
    id: "api_payments_confirm",
    category: "Payments & DIDs",
    method: "POST",
    path: "/api/payments/confirm",
    title: "HITL Payment Confirmation",
    description: "Authorizes and executes a pending payment draft, updating the institutional ledger and gateway status.",
    authRequired: true,
    sampleBody: { draftId: "pay_1a2b3c4d", decision: "approved", note: "Approved via REST API" },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/payments/confirm \\
  -H "Content-Type: application/json" \\
  -d '{"draftId":"pay_1a2b3c4d","decision":"approved","note":"Approved"}'`,
  },
  {
    id: "api_mcp_jsonrpc",
    category: "System & Audit",
    method: "POST",
    path: "/api/mcp",
    title: "MCP JSON-RPC 2.0 Endpoint",
    description: "Unified Model Context Protocol handler supporting initialize, ping, tools/list, tools/call, resources/list, resources/read, prompts/list, prompts/get.",
    authRequired: false,
    sampleBody: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_revenue_summary", arguments: {} } },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/mcp \\
  -H "Content-Type: application/json" \\
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'`,
  },
  {
    id: "api_etrade_status",
    category: "Trading & E*TRADE",
    method: "GET",
    path: "/api/etrade/status",
    title: "E*TRADE Broker Connectivity & DID Status",
    description: "Returns connection status to E*TRADE by Morgan Stanley, account info, live/sandbox mode, and Trading Agent DID.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/etrade/status`,
  },
  {
    id: "api_etrade_screen",
    category: "Trading & E*TRADE",
    method: "POST",
    path: "/api/etrade/screen",
    title: "Market Scanner & Screener",
    description: "Screens equities based on sector, RSI-14 oversold/overbought criteria, market cap, and momentum.",
    authRequired: true,
    sampleBody: { sector: "Technology", maxRsi: 45, limit: 10 },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/etrade/screen \\
  -H "Content-Type: application/json" \\
  -d '{"sector":"Technology","maxRsi":45,"limit":10}'`,
  },
  {
    id: "api_etrade_quote",
    category: "Trading & E*TRADE",
    method: "GET",
    path: "/api/etrade/quote?symbol=NVDA",
    title: "Real-Time Equity Quote",
    description: "Fetches live Level 1 quote, bid/ask spread, volume, 52-week high/low, and RSI technicals for a ticker symbol.",
    authRequired: true,
    sampleCurl: `curl -X GET "https://agent.openaimp.com/api/etrade/quote?symbol=NVDA"`,
  },
  {
    id: "api_etrade_preview_order",
    category: "Trading & E*TRADE",
    method: "POST",
    path: "/api/etrade/order/preview",
    title: "Preview Equity Order (HITL Draft)",
    description: "Drafts a stock order with cryptographic Trading Agent DID attestation in mas_trades without moving funds.",
    authRequired: true,
    sampleBody: { symbol: "NVDA", action: "BUY", quantity: 10, orderType: "LIMIT", limitPrice: 125.5 },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/etrade/order/preview \\
  -H "Content-Type: application/json" \\
  -d '{"symbol":"NVDA","action":"BUY","quantity":10,"orderType":"LIMIT","limitPrice":125.5}'`,
  },
  {
    id: "api_etrade_execute_order",
    category: "Trading & E*TRADE",
    method: "POST",
    path: "/api/etrade/order/execute",
    title: "Execute / Authorize Order Draft",
    description: "Executes an approved draft or cancels it, recording the human authorizer DID and broker order confirmation.",
    authRequired: true,
    sampleBody: { draftId: "ord_1a2b3c4d", decision: "approved" },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/etrade/order/execute \\
  -H "Content-Type: application/json" \\
  -d '{"draftId":"ord_1a2b3c4d","decision":"approved"}'`,
  },
  {
    id: "api_etrade_positions",
    category: "Trading & E*TRADE",
    method: "GET",
    path: "/api/etrade/positions",
    title: "Portfolio Holdings & Positions",
    description: "Returns portfolio summary, cash balances, and equity positions with live market values and unrealized P&L.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/etrade/positions`,
  },
  {
    id: "api_etrade_orders",
    category: "Trading & E*TRADE",
    method: "GET",
    path: "/api/etrade/orders",
    title: "Order Ledger & Audit History",
    description: "Queries persistent institutional order ledger of all previewed, executed, and cancelled orders.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/etrade/orders`,
  },
  {
    id: "api_market_data_quote",
    category: "Market Data Research & Quoting",
    method: "GET",
    path: "/api/market-data/quote?symbol=NVDA&provider=hybrid",
    title: "Market Data Real-Time Quote",
    description: "Fetches live equity or crypto quote and bid/ask spread via Yahoo Finance, Alpaca Market Data v2, or Hybrid.",
    authRequired: true,
    sampleCurl: `curl -X GET "https://agent.openaimp.com/api/market-data/quote?symbol=NVDA&provider=hybrid"`,
  },
  {
    id: "api_market_data_fundamentals",
    category: "Market Data Research & Quoting",
    method: "GET",
    path: "/api/market-data/fundamentals?symbol=NVDA",
    title: "Company Fundamentals & Valuation Ratios",
    description: "Returns institutional valuation metrics, P/E, PEG, Price-to-Book, Beta, and Wall Street price targets from Yahoo Finance.",
    authRequired: true,
    sampleCurl: `curl -X GET "https://agent.openaimp.com/api/market-data/fundamentals?symbol=NVDA"`,
  },
  {
    id: "api_market_data_bars",
    category: "Market Data Research & Quoting",
    method: "GET",
    path: "/api/market-data/bars?symbol=NVDA&timeframe=1D&limit=30",
    title: "Historical OHLCV Bars",
    description: "Retrieves daily or intraday OHLCV bars, volume, and VWAP for technical analysis and charts.",
    authRequired: true,
    sampleCurl: `curl -X GET "https://agent.openaimp.com/api/market-data/bars?symbol=NVDA&timeframe=1D&limit=30"`,
  },
  {
    id: "api_market_data_research",
    category: "Market Data Research & Quoting",
    method: "GET",
    path: "/api/market-data/research?symbol=NVDA",
    title: "Autonomous Equity Research Report",
    description: "Generates end-to-end research synthesis with AI analysis, technical indicators (RSI-14/MACD), and cryptographic Agent DID attestation.",
    authRequired: true,
    sampleCurl: `curl -X GET "https://agent.openaimp.com/api/market-data/research?symbol=NVDA"`,
  },
  {
    id: "api_market_data_snapshot",
    category: "Market Data Research & Quoting",
    method: "GET",
    path: "/api/market-data/snapshot?symbol=NVDA",
    title: "Alpaca Real-Time Market Snapshot",
    description: "Queries Level 1/2 quotes, NBBO bid/ask sizes, latest trade execution, and daily bar via Alpaca Market Data v2.",
    authRequired: true,
    sampleCurl: `curl -X GET "https://agent.openaimp.com/api/market-data/snapshot?symbol=NVDA"`,
  },
  {
    id: "api_market_data_compare",
    category: "Market Data Research & Quoting",
    method: "POST",
    path: "/api/market-data/compare",
    title: "Multi-Ticker Valuation Comparison",
    description: "Compares quotes, valuation multiples, and analyst ratings across up to 6 tickers side-by-side.",
    authRequired: true,
    sampleBody: { symbols: ["NVDA", "AAPL", "MSFT", "GOOGL"] },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/market-data/compare \\
  -H "Content-Type: application/json" \\
  -d '{"symbols":["NVDA","AAPL","MSFT"]}'`,
  },
  {
    id: "api_market_data_providers",
    category: "Market Data Research & Quoting",
    method: "GET",
    path: "/api/market-data/providers",
    title: "Market Data Providers Connectivity & Status",
    description: "Inspects connectivity, configuration, API credentials, and capabilities of Yahoo Finance and Alpaca integrations.",
    authRequired: true,
    sampleCurl: `curl -X GET https://agent.openaimp.com/api/market-data/providers`,
  },
  {
    id: "api_async_jobs",
    category: "System & Audit",
    method: "GET",
    path: "/api/jobs?limit=30",
    title: "List Async Jobs",
    description: "Lists recent background work for the authenticated session; this control-plane endpoint responds immediately.",
    authRequired: true,
    sampleCurl: `curl -X GET "https://agent.openaimp.com/api/jobs?limit=30"`,
  },
  {
    id: "api_async_job_status",
    category: "System & Audit",
    method: "GET",
    path: "/api/jobs/{jobId}",
    title: "Get Async Job Status and Result",
    description: "Retrieves queued/running status or the completed result/error for one session-scoped asynchronous job.",
    authRequired: true,
    sampleCurl: `curl -X GET "https://agent.openaimp.com/api/jobs/00000000-0000-4000-8000-000000000000"`,
  },
  // Issue #656: surface the #314/#313 routes.
  {
    id: "api_environment",
    category: "Trading & E*TRADE",
    method: "POST",
    path: "/api/environment",
    title: "Switch E*TRADE Environment",
    description: "Switches between sandbox and production E*TRADE environments (both spellings supported).",
    authRequired: true,
    sampleBody: { environment: "sandbox" },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/environment \\
  -H "Content-Type: application/json" \\
  -d '{"environment":"sandbox"}'`,
  },
  {
    id: "api_options_strategy",
    category: "Trading & E*TRADE",
    method: "POST",
    path: "/api/options/strategy",
    title: "Options Strategy Analysis",
    description: "Runs the quant pipeline + LLM ranking for options strategies on a symbol.",
    authRequired: true,
    sampleBody: { symbol: "AAPL", question: "Best bullish defined-risk strategy?" },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/options/strategy \\
  -H "Content-Type: application/json" \\
  -d '{"symbol":"AAPL"}'`,
  },
  {
    id: "api_nlq_webhook",
    category: "Agents & NLQ",
    method: "POST",
    path: "/api/nlq/webhook",
    title: "NLQ Webhook",
    description: "Natural-language query webhook (all three spellings supported).",
    authRequired: true,
    sampleBody: { text: "Screen NASDAQ100 for momentum" },
    sampleCurl: `curl -X POST https://agent.openaimp.com/api/nlq/webhook \\
  -H "Content-Type: application/json" \\
  -d '{"text":"Screen NASDAQ100"}'`,
  },
];
