/**
 * REST endpoint catalogue for the API explorer and the Tools tab.
 *
 * Static by design, not by drift: no server list source exists for
 * these entries. The generated OpenAPI spec covers only a subset of
 * the routes and carries no runner samples (sample bodies, sample
 * curl commands, documented responses), so the entries cannot be
 * derived from it. Deriving this catalogue from the spec is
 * follow-up work for #6439 (the doc + enforcement slice).
 *
 * This file is the remainder of src/client/mcpEndpointsData.ts: the
 * MCP tool/resource/prompt catalogues moved to the served catalogue
 * (GET /api/mcp/catalog, #6438) and the old file was retired. Keep
 * this list honest: an entry here must name a live route, and a
 * description must not state a count the live response does not
 * carry (the list-tables entry once claimed a table count that
 * matched no inventory).
 */
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
    description: "Returns schema metadata, column types, primary keys, and row counts for the relational tables.",
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
