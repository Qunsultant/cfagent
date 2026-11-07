/**
 * Platform Knowledge Base & Capabilities Service
 *
 * Provides a unified, structured knowledge graph of all platform capabilities,
 * 8 core workflows, 8 quantitative FAQs with multi-method execution playbooks,
 * 6 decisioning & logic engines, and step-by-step chat/UI usage instructions.
 */

import {
  FAQ_QUESTIONS,
  DECISIONING_SECTIONS,
  CAPABILITY_MATRIX,
  type FaqQuestionItem,
  type DecisioningSection,
  type CapabilityMatrixRow,
} from "../client/workflowsFaqData";

import { defaultRegistry } from "../trading";

/** Live strategy-catalog size, derived from the server registry so published counts cannot drift (issue #29). */
const STRATEGY_CATALOG_COUNT = defaultRegistry.list().length;

export interface PlatformWorkflowSummary {
  id: string;
  number: number;
  title: string;
  category: "stocks" | "options" | "flows" | "brokerage" | "scheduled" | "nlq" | "payments";
  categoryLabel: string;
  badge: string;
  subtitle: string;
  overview: string;
  apiEndpoint: string;
  targetTab: string;
  steps: Array<{ step: string; title: string; description: string }>;
  keyFeatures: string[];
  dataSources: string[];
  sampleQueryOrAction: string;
}

export const PLATFORM_WORKFLOWS_KNOWLEDGE: PlatformWorkflowSummary[] = [
  {
    id: "stock-screener",
    number: 1,
    title: "Stock Screener & Multi-Exchange Equity Discovery",
    category: "stocks",
    categoryLabel: "Stocks",
    badge: "Dual-Engine (Listings & Quotes)",
    subtitle: "Screen 8,000+ US equities dynamically across NASDAQ, NYSE, and AMEX with technical indicators and auditable scan ledgers.",
    overview: "The Stock Screener allows filtering across all active US equities by price, market cap, exchange, 14-period daily RSI, MACD momentum, and daily gainers/losers. It queries official Nasdaq multi-exchange listings (api.nasdaq.com) across 8,000+ active tickers, with resilient automatic fallback to the externalized curated universe (src/config/curatedStockUniverse.json) or Yahoo Finance feeds if upstream APIs are rate-limited. Downstream workflows (including Options Flow) query this screener first as their primary dynamic market underlyings engine.",
    apiEndpoint: "POST /api/etrade/screen · POST /api/market-data/screen",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Filter Configuration", description: "Configure exchange (NASDAQ, NYSE, AMEX, or ALL), price boundaries, market cap, sector, and trend (Gainers, Losers, Most Active)." },
      { step: "Step 2", title: "Dynamic Exchange Ingestion & Fallback Decision", description: "Queries official Nasdaq Screener API (api.nasdaq.com) across 8,000+ active tickers. If rate-limited, automatically falls back to externalized curated universe (src/config/curatedStockUniverse.json) or Yahoo Finance feeds." },
      { step: "Step 3", title: "Indicator Computation", description: "Calculates 14-Period Daily RSI and MACD (12, 26, 9 EMA) to classify momentum into Overbought, Oversold Bounce, Bullish, or Range-Bound." },
      { step: "Step 4", title: "Auditable Scan Ledger", description: "Compiles a complete audit ledger recording total evaluated tickers, passed candidates, and exact failure reasons for every rejected security." },
    ],
    keyFeatures: [
      "Dynamic all-exchange discovery with live Nasdaq, NYSE, and AMEX support.",
      "Autonomous fallback decision tree: prioritizes remote Nasdaq/Yahoo listings before gracefully falling back to externalized curated universe.",
      "Single Source of Truth for Options Flow: Options Flow queries this screener first to resolve active, liquid market underlyings partitioned by market cap rather than defaulting to a static list.",
      "Dual provider flexibility: connected-broker mode or 100% zero-credential market-data mode.",
      "Auditable scan ledger detailing why each security matched or failed criteria.",
    ],
    dataSources: [
      "Nasdaq Official Screener API (api.nasdaq.com/api/screener/stocks)",
      "Externalized Curated Stock Universe (src/config/curatedStockUniverse.json)",
      "Yahoo Finance Chart & Summary API (query1/query2.finance.yahoo.com)",
      "E*TRADE Market Quote & Orders API (api.etrade.com/v1/market/quote)",
    ],
    sampleQueryOrAction: "Screen NASDAQ stocks with price > $50 and RSI < 35 for oversold tech bounce",
  },
  {
    id: "options-strategy-discovery",
    number: 2,
    title: "Options Strategy Discovery & Greeks Engine",
    category: "options",
    categoryLabel: "Options",
    badge: `${STRATEGY_CATALOG_COUNT}-Strategy Catalog`,
    subtitle: "Discover, filter, and score optimal option setups across ${STRATEGY_CATALOG_COUNT} catalog strategies using calibrated pricing and Black-Scholes Greeks.",
    overview: "Evaluates multi-leg options structures (Iron Condors, Vertical Spreads, Butterflies, Calendars, Straddles, Strangles) against live calibrated option chains. Calculates Delta, Gamma, Theta, Vega, IV Rank, Probability of Profit (POP), and Expected Value (EV). Supports strict user budget and risk filtering (e.g. Max Loss <= $30, Max Profit > $0).",
    apiEndpoint: "POST /api/etrade/options/strategy · POST /api/etrade/options/screen",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Option Chain Ingestion", description: "Fetches live option chains with strikes, expirations, bid/ask spreads, open interest, and implied volatility." },
      { step: "Step 2", title: "Pricing Calibration", description: "Calibrates mid-market pricing with synthetic smoothing to eliminate wide spread anomalies and stale quotes." },
      { step: "Step 3", title: "Black-Scholes Greek & POP Computation", description: "Computes Delta, Gamma, Theta, Vega, and Probability of Profit (N(d2)) for every candidate structure." },
      { step: "Step 4", title: "Filter & Score Evaluation", description: "Filters candidates by user criteria (max loss, max profit, delta range, DTE) and computes multivariate composite ranking score." },
    ],
    keyFeatures: [
      `${STRATEGY_CATALOG_COUNT} distinct options strategies spanning directional, neutral, volatility, and income plays.`,
      "Strict parameter filtering: max loss, max profit, min win rate, strike bounds, and expiration windows.",
      "Black-Scholes analytical Greeks engine with continuous dividend and risk-free rate calibration.",
      "Expected Value (EV) calculation: EV = (POP * MaxProfit) - ((1 - POP) * MaxLoss) / Collateral.",
    ],
    dataSources: [
      "E*TRADE Option Chains API (api.etrade.com/v1/market/optionchains)",
      "E*TRADE Option Expirations API (api.etrade.com/v1/market/optionexpiredate)",
      "Calibrated Synthetic Pricing Engine (src/trading/options/calibratedOptionChains.ts)",
    ],
    sampleQueryOrAction: "Find bullish call spreads on NVDA expiring in 30-45 days with max loss <= $30 and max profit > $0",
  },
  {
    id: "options-flows",
    number: 3,
    title: "Options Flow Estimates & Institutional Activity Tracker (Modelled, Chain-Derived)",
    category: "flows",
    categoryLabel: "Flows",
    badge: "Smart Money Tracker",
    subtitle: "Track unusual options volume, modelled institutional sweep & block estimates, and sentiment anomalies derived from option-chain snapshots.",
    overview: "Derives modelled options-flow estimates from option-chain snapshots across the market — there is no live options trade-tape feed, so these are estimates, not executed prints. Filters by trade type (SWEEP, BLOCK, SPLIT), sentiment (BULLISH, BEARISH), moneyness (ITM, ATM, OTM), and minimum premium. Dynamically screens underlying equities using the Stock Screener first (with fallback to curated universe), computes Bull/Bear volume ratios, and aggregates top institutional ticker leaderboards.",
    apiEndpoint: "GET /api/options/flows · GET /api/options/flows/summary",
    targetTab: "options-flows",
    steps: [
      { step: "Step 1", title: "Dynamic Universe Resolution", description: "Queries DynamicMarketScreener to obtain active, liquid underlyings partitioned by mega/large/mid caps rather than using a static list." },
      { step: "Step 2", title: "Flow Derivation & Normalization", description: "Derives estimated flow from option-chain snapshots (contract volume, open interest, last price), normalizing strikes, expirations, spot prices, and modelled premiums. Side and size are inferred — these are estimates, not executed prints." },
      { step: "Step 3", title: "Anomaly & Sweep Classification", description: "Flags unusual estimated flow where Volume exceeds Open Interest (>1.5x) or modelled premium exceeds $100k+ with aggressive-at-ask positioning (Sweeps)." },
      { step: "Step 4", title: "Sentiment Aggregation & Leaderboards", description: "Computes net premium delta and ranks top bullish and bearish tickers in visual leaderboards." },
    ],
    keyFeatures: [
      "Integrated directly with Stock Screener as single source of truth for dynamic underlyings.",
      "Sweep vs Block trade discrimination with aggression tags (Above Ask, At Ask, Below Bid).",
      "Dynamic Bull/Bear sentiment ratios and institutional volume leaderboards.",
      "Audio/visual alert badges for large modelled flow items ($500k+ estimated premium).",
    ],
    dataSources: [
      "Stock Screener Dynamic Listings (api.nasdaq.com + Yahoo Finance)",
      "Option-Chain Snapshots (E*TRADE / Yahoo Finance) — modelled flow estimates; no trade-tape feed exists",
      "Historical Open Interest & Implied Volatility Surface",
    ],
    sampleQueryOrAction: "Show unusual bullish options sweeps over $100k premium today",
  },
  {
    id: "strategy-builder",
    number: 4,
    title: "Visual Multi-Leg Strategy Builder & Payoff Visualizer",
    category: "options",
    categoryLabel: "Options",
    badge: "Interactive Payoff Analyzer",
    subtitle: "Construct custom multi-leg options positions with real-time interactive payoff curves, breakevens, and risk metrics.",
    overview: "Allows constructing custom 1-to-4 leg options positions (calls, puts, stock shares). Interactively calculates max profit, max loss, breakeven price points, return on risk (RoR), and dynamic Greeks exposure across an underlying price continuum.",
    apiEndpoint: "POST /api/options/builder/payoff · POST /api/options/builder/analyze",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Leg Configuration", description: "Add individual legs specifying action (Buy/Sell), type (Call/Put/Stock), strike price, quantity, and expiration." },
      { step: "Step 2", title: "Payoff Curve Modeling", description: "Computes expiration payoff curve: PnL(S) = sum(leg_pnl(S)) across underlying price points from 0.5x to 1.5x spot." },
      { step: "Step 3", title: "Breakeven & Boundary Calculation", description: "Determines upper and lower breakeven boundaries, theoretical max gain, and max capital at risk." },
      { step: "Step 4", title: "Execution Proposal", description: "Generates one-click order ticket draft ready for Human-in-the-Loop review and execution." },
    ],
    keyFeatures: [
      "Dynamic payoff diagram rendering at expiration and pre-expiration (T+0).",
      "Automatic calculation of exact breakeven points and maximum theoretical drawdown.",
      "Multi-leg Greeks aggregation: Net Delta, Net Gamma, Net Theta, Net Vega.",
      "One-click transition from visual builder to broker order preview.",
    ],
    dataSources: [
      "Live Option Chain Pricing (connected broker & market-data providers)",
      "Black-Scholes Pricing & Payoff Math Models",
    ],
    sampleQueryOrAction: "Build an Iron Condor on SPY with 45 DTE and $5 wide wings",
  },
  {
    id: "portfolio-positions-sync",
    number: 5,
    title: "Broker Portfolio Positions & Account Sync",
    category: "brokerage",
    categoryLabel: "Brokerage",
    badge: "Positions & Account",
    subtitle: "Sync live E*TRADE positions, account balances, and unrealized PnL.",
    overview: "Syncs active stock and options positions from your connected E*TRADE account, with per-position quantity, cost basis, current market price, and unrealized PnL, plus account balance and purchasing power. Portfolio-level risk aggregation is available via GET /api/etrade/portfolio-risk: aggregate Delta, Gamma, Theta, Vega and Rho across open positions, SPY beta-weighted Delta (betas computed from live daily price history against SPY; the static universe table is used only as a marked fallback and coverage by provenance is reported), and total defined max loss vs NAV, plus correlation & concentration assessment (pairwise correlations among held names measured from live price history — sector proxy or unknown when unmeasurable, never assumed zero — with flags naming positions a candidate would duplicate) via POST /api/etrade/portfolio-risk/correlation, and portfolio-aware position sizing (NAV band as outer cap plus aggregate delta, total max-loss, and concentration budgets, each output naming its binding constraint) via POST /api/etrade/portfolio-risk/size, with a per-position breakdown; positions that cannot be priced or beta-weighted are listed as excluded rather than silently zeroed, and POST /api/etrade/portfolio-risk/evaluate states post-trade totals for a candidate. Draft hedge proposals sized from the aggregates (SPY shares or SPY puts, pre/post beta-weighted Delta stated, missing-beta symbols named) are available via POST /api/etrade/hedge/analyze — drafts for human review only, never auto-executed. Per-trade risk analysis is available separately via the Strategy Risk tools.",
    apiEndpoint: "GET /api/etrade/positions · GET /api/etrade/portfolio-risk · POST /api/etrade/portfolio-risk/evaluate",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Position Synchronization", description: "Fetches live positions, quantity, cost basis, current market price, and unrealized PnL from E*TRADE." },
      { step: "Step 2", title: "Account Overview", description: "Shows account balance, purchasing power, and per-position market value and unrealized PnL." },
      { step: "Step 3", title: "Portfolio Risk Aggregation", description: "Aggregate Delta/Gamma/Theta/Vega, SPY beta-weighted Delta, and total defined max loss vs NAV across all open positions (GET /api/etrade/portfolio-risk), with per-position rows and explicit exclusions for positions that cannot be resolved." },
    ],
    keyFeatures: [
      "Real-time account balance, purchasing power, and unrealized PnL tracking.",
      "Per-position quantity, cost basis, and market value for stocks and options.",
    ],
    dataSources: [
      "E*TRADE Accounts & Positions API (api.etrade.com/v1/accounts/{accountIdKey}/portfolio)",
    ],
    sampleQueryOrAction: "Show my E*TRADE positions and unrealized PnL",
  },
  {
    id: "automated-execution-hitl",
    number: 6,
    title: "Brokerage Order Execution with Human-in-the-Loop (HITL) Guardrails",
    category: "brokerage",
    categoryLabel: "Brokerage",
    badge: "DID-Attested HITL Guardrails",
    subtitle: "Prepare, preview, and safely execute stock and options orders with cryptographic DID attestations and mandatory human approval.",
    overview: "Enforces strict safety guardrails for real-world trading. The AI agent NEVER places orders autonomously without explicit human authorization. Orders are first prepared as an order preview draft (signed with Decentralized Identifier `did:agent:openaimp:trading`), showing estimated total, commission, and margin impact. Execution only proceeds when the user explicitly approves the proposal.",
    apiEndpoint: "POST /api/etrade/order/preview · POST /api/etrade/order/execute",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Order Drafting", description: "Agent or user drafts an order ticket with symbol, action (BUY/SELL), quantity, order type (LIMIT/MARKET), and price." },
      { step: "Step 2", title: "E*TRADE Preview Handshake", description: "Calls E*TRADE Preview API to validate account buying power, calculate exact commissions/fees, and obtain a previewId." },
      { step: "Step 3", title: "DID Attestation & Human Review", description: "Signs proposal with Agent DID and displays draft modal in UI. Requires user to review details and click 'Confirm & Execute'." },
      { step: "Step 4", title: "Authorized Execution & Audit", description: "Upon explicit confirmation, submits final order to E*TRADE broker API and records immutable event in SQLite audit ledger." },
    ],
    keyFeatures: [
      "Zero unconfirmed trading: strict Human-in-the-Loop guarantee prevents accidental money movement.",
      "Cryptographic Decentralized Identifier (DID) attestation on every order draft.",
      "Comprehensive pre-trade checks: buying power, account equity, margin requirements, market hours.",
      "Full audit trail in SQLite recording timestamps, user approvals, and broker order IDs.",
    ],
    dataSources: [
      "E*TRADE Order Preview API (api.etrade.com/v1/accounts/{accountIdKey}/orders/preview)",
      "E*TRADE Order Placement API (api.etrade.com/v1/accounts/{accountIdKey}/orders/place)",
      "Agent DID Registry & SQLite Audit Ledger (mas_events, mas_trades)",
    ],
    sampleQueryOrAction: "Preview buy order for 10 shares of AAPL at limit price $220.00",
  },
  {
    id: "background-cron-scheduling",
    number: 7,
    title: "Autonomous Background Execution, Intervals & Cron Schedules",
    category: "scheduled",
    categoryLabel: "Automation",
    badge: "Autonomous State Alarms",
    subtitle: "Execute scheduled market scans, proactive OAuth token renewals, and background notifications autonomously.",
    overview: "Leverages persistent state-machine alarms for resilient 24/7 background tasks. Automatically renews E*TRADE OAuth access tokens daily at 23:00 EDT / 22:00 EST (03:00 UTC), always at least an hour ahead of the midnight-ET expiration, runs autonomous market screening every 5 minutes (300 seconds), and broadcasts actionable market alerts over WebSockets.",
    apiEndpoint: "POST /api/tasks/schedule · GET /api/tasks/active",
    targetTab: "trading",
    steps: [
      { step: "Step 1", title: "Task Registration", description: "Registers cron schedules ('0 3 * * *' UTC) or interval alarms (every 300s) on agent startup via idempotent persistent alarms." },
      { step: "Step 2", title: "Proactive Token Renewal", description: "Executes OAuth renewal at 23:00 EDT / 22:00 EST, updating KV tokens and preventing mid-trading session session expiries." },
      { step: "Step 3", title: "Interval Market Screening", description: "Runs autonomous market scan across sectors, filtering top momentum or oversold candidates." },
      { step: "Step 4", title: "Real-Time WebSocket Broadcast", description: "Broadcasts opportunity alerts to connected client UIs via Durable Object WebSocket connections." },
    ],
    keyFeatures: [
      "Native persistent state scheduling: persists across restarts and idle cycles.",
      "Zero-downtime E*TRADE OAuth token management with proactive renewal before midnight ET.",
      "Periodic background market scanning with configurable sector and volatility filters.",
      "Real-time event broadcasting to UI without client polling.",
    ],
    dataSources: [
      "Autonomous State Machine Alarm Lifecycle (`schedule`, `scheduleEvery`)",
      "E*TRADE OAuth Renewal Endpoint (api.etrade.com/oauth/renew_access_token)",
      "SQLite Job Ledger (`mas_async_jobs`)",
    ],
    sampleQueryOrAction: "Schedule a background market scan for oversold tech stocks every 15 minutes",
  },
  {
    id: "nlq-conversational-agent",
    number: 8,
    title: "Natural Language Financial Intelligence (NLQ) & Conversational Execution",
    category: "nlq",
    categoryLabel: "Chat & NLQ",
    badge: "Vercel AI SDK + LLM Judge",
    subtitle: "Ask financial questions, query database tables, screen markets, and command tools seamlessly through natural chat.",
    overview: "Combines neural strategy AI models with an intelligent LLM Judge router. Understands user intents, retrieves facts from the platform knowledge base, queries SQLite database tables (ORM), screens equities, analyzes options payoffs, and drafts actions with Human-in-the-Loop safety.",
    apiEndpoint: "POST /api/chat · POST /api/nlq",
    targetTab: "chat",
    steps: [
      { step: "Step 1", title: "Intent Routing & Safety Classification", description: "LLM Judge evaluates prompt, classifying intent into search, trading, research, payments, tasks, or memory with confidence score." },
      { step: "Step 2", title: "Knowledge & Tool Retrieval", description: "Queries internal Platform Knowledge Base, SQLite tables, or market data feeds to gather grounded facts." },
      { step: "Step 3", title: "Multi-Agent Execution", description: "Executes appropriate MCP commands or drafts proposals requiring confirmation." },
      { step: "Step 4", title: "Streaming Response & Audit", description: "Streams structured markdown response with tool cards, citations, and records audit event in SQLite." },
    ],
    keyFeatures: [
      "Natural language understanding for complex multi-leg options queries and equity screening.",
      "Direct MCP tool dogfooding: search, database ORM, broker trading, market-data research, session memory.",
      "Grounded answers: cites internal platform capabilities, workflows, and exact UI navigation steps.",
      "Multi-turn conversational memory persisted in SQLite (`mas_memory`).",
    ],
    dataSources: [
      "Neural Strategy AI Engine (Llama 3.3 70B / Qwen / Mistral)",
      "Internal Platform Knowledge Base (Workflows, FAQs, Decisioning Logic)",
      "SQLite Database ORM (tables, transactions, trades, categories, audit logs)",
    ],
    sampleQueryOrAction: "What are the capabilities of this platform and how do I use the stock screener?",
  },
];

export interface KnowledgeSearchResult {
  id: string;
  title: string;
  type: "workflow" | "faq" | "decisioning" | "capability";
  category: string;
  summary: string;
  details: string;
  howToUse: string[];
  targetTab: string;
  apiEndpoint?: string;
  samplePrompt?: string;
  relevanceScore: number;
}

/**
 * Searches across all platform workflows, FAQs, decisioning engines, and capability matrix.
 */
export function searchPlatformKnowledge(
  query: string,
  options?: { maxResults?: number; category?: string }
): {
  query: string;
  count: number;
  results: KnowledgeSearchResult[];
  formattedAnswer: string;
} {
  const q = (query || "").trim().toLowerCase();
  const maxResults = options?.maxResults ?? 5;
  const targetCategory = options?.category?.toLowerCase();

  const terms = q.split(/\s+/).filter((t) => t.length > 2);
  const normalizedQ = q.replace(/[^a-z0-9]/g, "");

  // Dedicated handler for workflow count & analysis vs execution breakdown
  if (/\b(how\s+many\s+workflows|analysis\s+and\s+execution|analysis\s+vs\s+execution|execution\s+workflows|analysis\s+workflows|what\s+components.*apis)\b/i.test(q)) {
    const formattedAnswer = getAnalysisAndExecutionWorkflowsMarkdown();
    return {
      query,
      count: 14,
      results: PLATFORM_WORKFLOWS_KNOWLEDGE.slice(0, maxResults).map((wf) => ({
        id: wf.id,
        title: `Workflow ${wf.number}: ${wf.title}`,
        type: "workflow",
        category: wf.categoryLabel,
        summary: wf.subtitle,
        details: wf.overview,
        howToUse: [
          `Open the '${wf.targetTab}' tab in the platform navigation.`,
          ...wf.steps.map((s) => `${s.step} (${s.title}): ${s.description}`),
        ],
        targetTab: wf.targetTab,
        apiEndpoint: wf.apiEndpoint,
        samplePrompt: wf.sampleQueryOrAction,
        relevanceScore: 100,
      })),
      formattedAnswer,
    };
  }

  // If query is empty, return the comprehensive 8-workflow overview immediately
  if (terms.length === 0 || !normalizedQ) {
    const formattedAnswer = getPlatformOverviewMarkdown();
    return {
      query,
      count: PLATFORM_WORKFLOWS_KNOWLEDGE.length,
      results: PLATFORM_WORKFLOWS_KNOWLEDGE.slice(0, maxResults).map((wf) => ({
        id: wf.id,
        title: `Workflow ${wf.number}: ${wf.title}`,
        type: "workflow",
        category: wf.categoryLabel,
        summary: wf.subtitle,
        details: wf.overview,
        howToUse: [
          `Open the '${wf.targetTab}' tab in the platform navigation.`,
          ...wf.steps.map((s) => `${s.step} (${s.title}): ${s.description}`),
          `You can also invoke this via Chat with prompt: "${wf.sampleQueryOrAction}"`,
        ],
        targetTab: wf.targetTab,
        apiEndpoint: wf.apiEndpoint,
        samplePrompt: wf.sampleQueryOrAction,
        relevanceScore: 100,
      })),
      formattedAnswer,
    };
  }

  const results: KnowledgeSearchResult[] = [];

  // Helper score calculator
  const computeScore = (haystack: string, exactBonus = false): number => {
    let score = 0;
    const lower = haystack.toLowerCase();
    const normalizedH = lower.replace(/[^a-z0-9]/g, "");

    if (exactBonus && lower.includes(q)) {
      score += 50;
    }
    for (const term of terms) {
      if (lower.includes(term)) {
        score += 15;
      }
      const normTerm = term.replace(/[^a-z0-9]/g, "");
      if (normTerm.length > 3) {
        if (normalizedH.includes(normTerm)) {
          score += 30;
        }
        const stem = normTerm.replace(/(?:es|s)$/, "");
        if (stem.length > 3 && normalizedH.includes(stem)) {
          score += 35;
        }
      }
    }
    return score;
  };

  // 1. Search Workflows
  for (const wf of PLATFORM_WORKFLOWS_KNOWLEDGE) {
    if (targetCategory && wf.category.toLowerCase() !== targetCategory && targetCategory !== "all") {
      continue;
    }
    const searchableText = `${wf.title} ${wf.subtitle} ${wf.overview} ${wf.keyFeatures.join(" ")} ${wf.dataSources.join(" ")} ${wf.sampleQueryOrAction}`;
    const score = computeScore(searchableText, true);
    if (score > 0) {
      results.push({
        id: wf.id,
        title: `Workflow ${wf.number}: ${wf.title}`,
        type: "workflow",
        category: wf.categoryLabel,
        summary: wf.subtitle,
        details: wf.overview,
        howToUse: [
          `Open the '${wf.targetTab}' tab in the platform navigation.`,
          ...wf.steps.map((s) => `${s.step} (${s.title}): ${s.description}`),
          `You can also invoke this via Chat with prompt: "${wf.sampleQueryOrAction}"`,
        ],
        targetTab: wf.targetTab,
        apiEndpoint: wf.apiEndpoint,
        samplePrompt: wf.sampleQueryOrAction,
        relevanceScore: score + 15, // bias towards high-level workflows
      });
    }
  }

  // 2. Search FAQs
  for (const faq of FAQ_QUESTIONS) {
    const searchableText = `${faq.question} ${faq.summary} ${faq.theoreticalContext} ${faq.keyParameters} ${faq.samplePrompt}`;
    const score = computeScore(searchableText, true);
    if (score > 0) {
      results.push({
        id: faq.id,
        title: `FAQ ${faq.number}: ${faq.question}`,
        type: "faq",
        category: faq.categoryLabel,
        summary: faq.summary,
        details: `${faq.theoreticalContext}\n\nMathematical Basis: ${faq.mathematicalBasis || "Multivariate optimization"}`,
        howToUse: faq.methods.flatMap((m) => [
          `**${m.name}**: ${m.description}`,
          ...m.actionSteps.map((s) => `  - ${s}`),
        ]),
        targetTab: faq.targetTab,
        samplePrompt: faq.samplePrompt,
        relevanceScore: score + 20, // bias towards specific practical questions
      });
    }
  }

  // 3. Search Decisioning Engines
  for (const dec of DECISIONING_SECTIONS) {
    const rulesText = dec.rules.map((r) => `${r.name} ${r.description} ${r.formulaOrCode || ""}`).join(" ");
    const extraKeywords = dec.id === "pickbesttrades-engine"
      ? "pickbesttrades pick best trade recommendationagent recommendation agent best trade trade plan"
      : dec.id === "stock-screener-logic"
      ? "stock screener nasdaq fallback curated stock universe rsi macd"
      : "";
    const searchableText = `${dec.title} ${dec.subtitle} ${dec.overview} ${rulesText} ${extraKeywords}`;
    const score = computeScore(searchableText, true);
    if (score > 0) {
      results.push({
        id: dec.id,
        title: `Decision Engine ${dec.number}: ${dec.title}`,
        type: "decisioning",
        category: dec.badge,
        summary: dec.subtitle,
        details: dec.overview,
        howToUse: dec.rules.map((r) => `**${r.name}**: ${r.description}`),
        targetTab: "trading",
        samplePrompt: `Explain how the ${dec.title} evaluates setups`,
        relevanceScore: score + 25, // deep logic bias
      });
    }
  }

  // 4. Search Capability Matrix
  for (const cap of CAPABILITY_MATRIX) {
    const searchableText = `${cap.question} ${cap.primaryWorkflow} ${cap.secondaryWorkflow} ${cap.keyInputParameter}`;
    const score = computeScore(searchableText, true);
    if (score > 0) {
      results.push({
        id: `cap-${cap.primaryWorkflow}-${Math.random()}`,
        title: `Capability: ${cap.question}`,
        type: "capability",
        category: "Matrix",
        summary: `Primary: ${cap.primaryWorkflow} · Secondary: ${cap.secondaryWorkflow}`,
        details: `Key Inputs: ${cap.keyInputParameter} · Expected Output: ${cap.optimalOutputStructure}`,
        howToUse: [`Navigate to the '${cap.targetTab}' tab.`],
        targetTab: cap.targetTab,
        samplePrompt: cap.question,
        relevanceScore: score + 5,
      });
    }
  }

  // Sort descending by relevance score
  results.sort((a, b) => b.relevanceScore - a.relevanceScore);
  const topResults = results.slice(0, maxResults);

  // Generate clear, structured markdown synthesis
  const formattedAnswer = generateMarkdownAnswer(q, topResults);

  return {
    query,
    count: topResults.length,
    results: topResults,
    formattedAnswer,
  };
}

/**
 * Returns comprehensive markdown breaking down all 14 Analysis and Execution workflows,
 * their enabling components, and leveraged APIs.
 */
function getAnalysisAndExecutionWorkflowsMarkdown(): string {
  return [
    `### Analysis & Execution Workflows Directory (14 Total Workflows)`,
    ``,
    `The platform provides **14 distinct workflows**, categorized into **8 Analysis Workflows** and **6 Execution Workflows**:`,
    ``,
    `---`,
    `### 📊 Part 1: Analysis Workflows (8 Workflows — Read-Only & Quant)`,
    ``,
    `1. **A1: Multi-Exchange Stock Screener & Equity Momentum Analysis**`,
    `   - **Scope**: Screens 8,000+ US equities with 14-period RSI & MACD momentum across NASDAQ, NYSE, AMEX.`,
    `   - **Components**: \`DynamicMarketScreener\` + the platform's Yahoo provider (\`dataProviders/adapters.ts\`, bound via \`bindYahooScreenerDeps\`) inside the one screener pipeline, \`curatedStockUniverse.json\`, \`ETradeRestClient\`, \`MarketDataResearchService\`.`,
    `   - **APIs Leveraged**: \`api.nasdaq.com/api/screener/stocks\`, \`query1/query2.finance.yahoo.com\`, \`fc.yahoo.com\`, \`api.etrade.com/v1/market/quote\`.`,
    `   - **Endpoints**: \`POST /api/etrade/screen\`, \`POST /api/market-data/screen\`.`,
    ``,
    `2. **A2: Options Strategy Discovery, Greeks Modeling & EV Scoring**`,
    `   - **Scope**: Evaluates ${STRATEGY_CATALOG_COUNT} catalog options strategies against live option chains; computes Black-Scholes Greeks, IV Rank, and Expected Value (EV).`,
    `   - **Components**: \`UnifiedOptionsService\`, \`OptionsStrategyRegistry\` (${STRATEGY_CATALOG_COUNT} strategies), \`BlackScholesCalculator\`, \`CalibratedOptionChains\`.`,
    `   - **APIs Leveraged**: \`api.etrade.com/v1/market/optionchains\`, \`api.etrade.com/v1/market/optionexpiredate\`.`,
    `   - **Endpoints**: \`POST /api/etrade/options/strategy\`, \`POST /api/trading/options/unified\`.`,
    ``,
    `3. **A3: Raw Options Contract Screener & Chain Filtering**`,
    `   - **Scope**: Contract-level filtering by delta, volume, open interest, and 15 auditable rejection codes.`,
    `   - **Components**: \`DynamicOptionsScreener\` (\`optionsScreener.ts\`), \`PaidOptionsScreenerCommand\` (x402).`,
    `   - **APIs Leveraged**: \`api.etrade.com/v1/market/optionchains\`.`,
    `   - **Endpoints**: \`POST /api/trading/options/screen\`, \`POST /api/premium/options-scan\`.`,
    ``,
    `4. **A4: Options Flow Estimates & Institutional Smart Money Tracking (Modelled)**`,
    `   - **Scope**: Surfaces unusual modelled sweeps ($100k+ aggressive-at-ask estimates), blocks, volume/OI surges (>1.5x), and sentiment leaderboards.`,
    `   - **Components**: \`OptionsFlowService\` (\`flows/flowService.ts\`), \`DynamicMarketScreener\` (screener-first dynamic underlyings).`,
    `   - **APIs Leveraged**: \`api.nasdaq.com\` (dynamic cap buckets), option-chain snapshots (E*TRADE / Yahoo Finance) — modelled estimates; no live trade tape.`,
    `   - **Endpoints**: \`GET /api/options/flows/live\`, \`GET /api/options/flows/summary\`, \`GET /api/options/flows/news\`.`,
    ``,
    `5. **A5: Visual Multi-Leg Strategy Builder & Expiration Payoff Analysis**`,
    `   - **Scope**: Interactive payoff diagrams, breakeven boundaries, max loss/gain, and net Greeks across 1-4 leg structures.`,
    `   - **Components**: \`StrategyBuilderEngine\`, \`llmComparison.ts\` (llmIdeas.ts retired as a recommender by #29/#47; the pipeline + compare pattern is the only LLM strategy path).`,
    `   - **APIs Leveraged**: Live option chain feeds, Workers AI (\`Llama 3.3 70B\`).`,
    `   - **Endpoints**: \`POST /api/trading/options/compare\`, \`POST /api/trading/options/llm-ideas\`.`,
    ``,
    `6. **A6: Institutional Risk Management, Defense Playbooks & Portfolio Exposure**`,
    `   - **Scope**: Institutional risk anatomy (Capital at Risk, Max Loss, Greeks Matrix, Dollar Delta, POP, Breakeven buffers, Early Assignment Tail Risk, and multi-point stress tests) paired with actionable defense playbooks (NAV position sizing, 50% profit-taking, 2x credit stop loss, rolling and hedging). Universal "🛡️ Risk Analysis" button enabled across all strategies, flow prints, screener contracts, and trades with 1-click AI chat dispatch.`,
    `   - **Components**: \`RiskManagementEngine\`, \`RiskAnalysisModal\`, \`StrategyDiscoveryPanel\`, \`RawContractsScreener\`, \`FlowTradeDetailModal\`, \`ETradeTradingHub\`.`,
    `   - **APIs Leveraged**: \`api.etrade.com/v1/accounts/{id}/portfolio\`, \`api.etrade.com/v1/accounts/{id}/balance\`, analytical Black-Scholes math.`,
    `   - **Endpoints**: \`GET /api/etrade/positions\`, \`GET /api/etrade/accounts\`, \`POST /api/trading/options/screen\`.`,
    ``,
    `7. **A7: Zero-Credential Market Data Equity & Crypto Research**`,
    `   - **Scope**: Fundamental valuations (P/E, PEG, P/B), analyst targets, historical chart bars, and crypto Level 1 quotes.`,
    `   - **Components**: \`MarketDataResearchService\`, \`YahooFinanceProvider\`, \`AlpacaMarketDataProvider\`.`,
    `   - **APIs Leveraged**: \`query1.finance.yahoo.com\`, \`data.alpaca.markets/v2/stocks/quotes\`, \`data.alpaca.markets/v1beta3/crypto/quotes\`.`,
    `   - **Endpoints**: \`GET /api/market-data/quote\`, \`GET /api/market-data/fundamentals\`, \`GET /api/market-data/bars\`, \`GET /api/market-data/research\`.`,
    ``,
    `8. **A8: Conversational Financial Intelligence & NLQ Analytics**`,
    `   - **Scope**: Translates natural language questions into parameter-bound SQLite queries, options evaluations, and research scans.`,
    `   - **Components**: \`NLQPlanner\`, \`NLQExecutor\`, \`LLMJudge\` router, \`DatabaseORM\`, \`PlatformKnowledgeService\`.`,
    `   - **APIs Leveraged**: Neural Strategy AI Engine, Semantic Vector RAG Retrieval, Persistent Transactional SQLite storage.`,
    `   - **Endpoints**: \`POST /api/nlq\`, \`POST /api/chat\`, \`POST /nlq/webhook\`.`,
    ``,
    `---`,
    `### ⚡ Part 2: Execution Workflows (6 Workflows — Side-Effecting & Money Movement)`,
    ``,
    `1. **E1: Brokerage Order Preview & HITL Execution (E*TRADE)**`,
    `   - **Scope**: Zero unconfirmed trades: drafts orders with Agent DID attestations (\`did:agent:openaimp:trading\`) requiring human approval.`,
    `   - **Components**: \`ETradeRestClient\`, \`ETradeTradingHub\`, \`ETradePreviewOrderCommand\`, \`ETradeExecuteOrderCommand\`.`,
    `   - **APIs Leveraged**: \`api.etrade.com/v1/accounts/{id}/orders/preview\`, \`api.etrade.com/v1/accounts/{id}/orders/place\`, \`mas_trades\` WAL ledger.`,
    `   - **Endpoints**: \`POST /api/etrade/order/preview\`, \`POST /api/etrade/order/execute\`.`,
    ``,
    `2. **E2: Direct Equities & Crypto Order Placement (Alpaca Broker API)**`,
    `   - **Scope**: Direct paper/live market and limit orders for equities and crypto via Alpaca.`,
    `   - **Components**: \`AlpacaMarketDataProvider\`, \`AlpacaPlaceOrderCommand\`.`,
    `   - **APIs Leveraged**: \`api.alpaca.markets/v2/orders\`, \`api.alpaca.markets/v2/account\`, \`api.alpaca.markets/v2/positions\`.`,
    `   - **Endpoints**: \`POST /api/trading/alpaca/order\`, \`GET /api/trading/alpaca/orders\`.`,
    ``,
    `3. **E3: Autonomous Background Cron, Interval Alarms & Token Lifecycle Management**`,
    `   - **Scope**: Proactive E*TRADE OAuth renewal at 23:00 EDT / 22:00 EST, interval market scans every 5m (300s), async job runner, and WebSocket broadcasts.`,
    `   - **Components**: \`ScheduledTasksService\`, Persistent Alarm lifecycle (\`schedule\`, \`scheduleEvery\`), \`mas_async_jobs\`.`,
    `   - **APIs Leveraged**: \`api.etrade.com/oauth/renew_access_token\`, Autonomous State Alarms, WebSocket \`broadcast\`.`,
    `   - **Endpoints**: \`POST /api/schedules/trigger-screen\`, \`POST /api/schedules/trigger-renew\`, \`GET /api/jobs\`.`,
    ``,
    `4. **E4: Omnichannel Execution & One-Click Approvals (Slack, Email, Voice)**`,
    `   - **Scope**: Interactive Slack Block Kit trading (interactions verified against the Slack signing secret), inbound email trading with reply-to-approve (APPROVE <orderId>), session-authenticated in-app approval (\`GET /trade/approve\` forwards to the HITL execute path), and voice trading. No bearer/signed approval links exist: execution requires a draft still in 'previewed' state and matches the preview exactly; drafts expire unexecuted after 900 seconds.`,
    `   - **Components**: \`ETradeSlackTradingService\`, \`ETradeEmailTradingService\`, \`ETradeVoiceTradingService\`, \`ETradeWebhookService\`.`,
    `   - **APIs Leveraged**: Slack Web API, Inbound Corporate Email Gateway, Full-Duplex WebSockets (\`/voice/trade\`), HMAC-SHA256 webhooks.`,
    `   - **Endpoints**: \`POST /slack/events\`, \`POST /slack/interactions\`, \`GET /trade/approve\`, \`POST /api/trading/reports/webhook\`.`,
    ``,
    `5. **E5: Agentic Micropayments, Gateways & x402 Protocol Settlement**`,
    `   - **Scope**: Payment intent drafting across Stripe, PayPal, Lemon Squeezy, and HTTP 402 (x402) on-chain crypto micropayments ($0.05 USDC).`,
    `   - **Components**: \`PaymentGatewayService\`, \`PaymentStrategyFactory\`, \`x402Verifier\`, \`OptionsScannerMCP\`.`,
    `   - **APIs Leveraged**: \`api.stripe.com/v1/payment_intents\`, \`api-m.paypal.com\`, \`api.lemonsqueezy.com\`, Base / Ethereum RPC nodes.`,
    `   - **Endpoints**: \`POST /api/payments/create\`, \`POST /api/payments/confirm\`, \`POST /mcp/scanner\`.`,
    ``,
    `6. **E6: Enterprise Observability & Cryptographic Audit Ledger Execution**`,
    `   - **Scope**: Immutable transaction logging, router telemetry, and cryptographic verification stamps.`,
    `   - **Components**: \`DatabaseORM\` (\`mas_events\`, \`mas_trades\`), \`AuditEventPublisher\` & \`Observer\` pattern.`,
    `   - **APIs Leveraged**: SQLite WAL storage, W3C DID cryptographic registry.`,
    `   - **Endpoints**: \`GET /api/audit\`, \`sqlite://audit/recent\`.`,
  ].join("\n");
}

/**
 * Returns comprehensive markdown for the entire platform overview.
 */
function getPlatformOverviewMarkdown(): string {
  return [
    `### Platform Capabilities & How to Use Multi-Agent Studio`,
    ``,
    `Multi-Agent Studio (OpenAIMP) is an enterprise financial intelligence and multi-agent execution platform featuring **8 core workflows**:`,
    ``,
    `1. **Stock Screener & Multi-Exchange Equity Discovery** (Tab: \`trading\` | API: \`/api/etrade/screen\`, \`/api/market-data/screen\`)`,
    `   - Screens 8,000+ US equities dynamically across NASDAQ, NYSE, and AMEX with 14-period RSI and MACD momentum.`,
    `   - Fallback hierarchy: Nasdaq Screener API $\\rightarrow$ Yahoo Finance $\\rightarrow$ Externalized Curated Universe (\`curatedStockUniverse.json\`).`,
    ``,
    `2. **Options Strategy Discovery & Greeks Engine** (Tab: \`trading\` | API: \`/api/etrade/options/strategy\`)`,
    `   - Evaluates ${STRATEGY_CATALOG_COUNT} catalog options strategies using Black-Scholes Greeks, IV rank, and Probability of Profit.`,
    `   - Supports strict parameter filtering such as Max Loss $\\le$ $30 and Max Profit > $0.`,
    ``,
    `3. **Options Flow Estimates & Institutional Activity Tracker (Modelled, Chain-Derived)** (Tab: \`options-flows\` | API: \`/api/options/flows\`)`,
    `   - Tracks unusual volume, smart-money sweeps, blocks, and institutional sentiment as modelled estimates derived from option-chain snapshots — not live trade prints. Queries the Stock Screener first for active underlyings.`,
    ``,
    `4. **Visual Multi-Leg Strategy Builder** (Tab: \`trading\` | API: \`/api/options/builder/payoff\`)`,
    `   - Build custom 1-4 leg positions with real-time payoff diagrams, breakeven boundaries, and risk metrics.`,
    ``,
    `5. **Portfolio Positions & Account Sync** (Tab: \`trading\` | API: \`/api/etrade/positions\`)`,
    `   - Syncs broker positions with balances and per-position unrealized PnL, and aggregates portfolio Greeks (Delta/Gamma/Theta/Vega, SPY beta-weighted Delta, defined max loss vs NAV) via /api/etrade/portfolio-risk. Draft hedge proposals are available via /api/etrade/hedge/analyze (HITL review only).`,
    ``,
    `6. **Brokerage Order Execution with HITL Guardrails** (Tab: \`trading\` | API: \`/api/etrade/order/preview\`)`,
    `   - Safe trading: orders are drafted with Agent DIDs and require explicit human confirmation before execution.`,
    ``,
    `7. **Autonomous Background Cron & Alarms** (Tab: \`trading\` | Durable Objects)`,
    `   - 24/7 background market scans and automatic daily E*TRADE token renewal at 23:00 EDT / 22:00 EST.`,
    ``,
    `8. **Natural Language Financial Intelligence (NLQ)** (Tab: \`chat\` / \`nlq\`)`,
    `   - Conversational equity queries, database exploration via SQLite ORM, and tool execution.`,
    ``,
    `**How to use:** You can ask me any specific question in chat (e.g., *"How do I screen stocks for oversold tech?"* or *"How do I find max profit > 0 and max loss <= 30?"*) or switch to the corresponding tab in the navigation bar!`,
  ].join("\n");
}

/**
 * Formats a clean, user-friendly markdown response explaining platform capabilities and how to use them.
 */
function generateMarkdownAnswer(query: string, results: KnowledgeSearchResult[]): string {
  if (results.length === 0) {
    return [
      `### Platform Capabilities & How to Use Multi-Agent Studio`,
      ``,
      `Multi-Agent Studio (OpenAIMP) is an enterprise financial intelligence and multi-agent execution platform featuring **8 core workflows**:`,
      ``,
      `1. **Stock Screener & Multi-Exchange Equity Discovery** (Tab: \`trading\` | API: \`/api/etrade/screen\`, \`/api/market-data/screen\`)`,
      `   - Screens 8,000+ US equities dynamically across NASDAQ, NYSE, and AMEX with 14-period RSI and MACD momentum.`,
      `   - Fallback hierarchy: Nasdaq Screener API $\\rightarrow$ Yahoo Finance $\\rightarrow$ Externalized Curated Universe (\`curatedStockUniverse.json\`).`,
      ``,
      `2. **Options Strategy Discovery & Greeks Engine** (Tab: \`trading\` | API: \`/api/etrade/options/strategy\`)`,
      `   - Evaluates ${STRATEGY_CATALOG_COUNT} catalog options strategies using Black-Scholes Greeks, IV rank, and Probability of Profit.`,
      `   - Supports strict parameter filtering such as Max Loss $\\le$ $30 and Max Profit > $0.`,
      ``,
      `3. **Options Flow Estimates & Institutional Activity Tracker (Modelled, Chain-Derived)** (Tab: \`options-flows\` | API: \`/api/options/flows\`)`,
      `   - Tracks unusual volume, smart-money sweeps, blocks, and institutional sentiment as modelled estimates derived from option-chain snapshots — not live trade prints. Queries the Stock Screener first for active underlyings.`,
      ``,
      `4. **Visual Multi-Leg Strategy Builder** (Tab: \`trading\` | API: \`/api/options/builder/payoff\`)`,
      `   - Build custom 1-4 leg positions with real-time payoff diagrams, breakeven boundaries, and risk metrics.`,
      ``,
      `5. **Portfolio Positions & Account Sync** (Tab: \`trading\` | API: \`/api/etrade/positions\`)`,
      `   - Syncs broker positions with balances and per-position unrealized PnL, and aggregates portfolio Greeks (Delta/Gamma/Theta/Vega, SPY beta-weighted Delta, defined max loss vs NAV) via /api/etrade/portfolio-risk. Draft hedge proposals are available via /api/etrade/hedge/analyze (HITL review only).`,
      ``,
      `6. **Brokerage Order Execution with HITL Guardrails** (Tab: \`trading\` | API: \`/api/etrade/order/preview\`)`,
      `   - Safe trading: orders are drafted with Agent DIDs and require explicit human confirmation before execution.`,
      ``,
      `7. **Autonomous Background Cron & Alarms** (Tab: \`trading\` | Durable Objects)`,
      `   - 24/7 background market scans and automatic daily E*TRADE token renewal at 23:00 EDT / 22:00 EST.`,
      ``,
      `8. **Natural Language Financial Intelligence (NLQ)** (Tab: \`chat\` / \`nlq\`)`,
      `   - Conversational equity queries, database exploration via SQLite ORM, and tool execution.`,
      ``,
      `**How to use:** You can ask me any specific question in chat (e.g., *"How do I screen stocks for oversold tech?"* or *"How do I find max profit > 0 and max loss <= 30?"*) or switch to the corresponding tab in the navigation bar!`,
    ].join("\n");
  }

  const sections: string[] = [
    `### Platform Guidance for: "${query || "Platform Capabilities"}"`,
    ``,
  ];

  for (const item of results) {
    sections.push(`#### ${item.title}`);
    sections.push(`*Category: ${item.category} | UI Tab: \`${item.targetTab}\`*`);
    if (item.apiEndpoint) {
      sections.push(`*API Endpoint: \`${item.apiEndpoint}\`*`);
    }
    sections.push(``);
    sections.push(item.summary);
    sections.push(``);
    if (item.howToUse && item.howToUse.length > 0) {
      sections.push(`**How to Use / Action Steps:**`);
      for (const step of item.howToUse) {
        sections.push(`- ${step}`);
      }
      sections.push(``);
    }
    if (item.samplePrompt) {
      sections.push(`💡 **Try Asking in Chat:** *"${item.samplePrompt}"*`);
      sections.push(``);
    }
    sections.push(`---`);
  }

  return sections.join("\n");
}

export interface PlatformCapabilitiesDeskSummary {
  spokenSummary: string;
  markdownOverview: string;
  workflows: Array<{
    id: string;
    title: string;
    category: string;
    targetTab: string;
    samplePrompt: string;
  }>;
}

/**
 * Returns a high-level, actionable summary of platform capabilities
 * designed specifically for voice desk responses and discovery prompts.
 */
export function getPlatformCapabilitiesDeskSummary(): PlatformCapabilitiesDeskSummary {
  const workflows = [
    {
      id: "stock-screener",
      title: "Stock Screener & Market Movers",
      category: "Stocks",
      targetTab: "trading",
      samplePrompt: "Find top gainers and losers",
    },
    {
      id: "real-time-quotes",
      title: "Real-Time Equity Quotes & NBBO",
      category: "Quotes",
      targetTab: "trading",
      samplePrompt: "Quote NVDA",
    },
    {
      id: "options-strategy-discovery",
      title: "Options Strategy Discovery & Greeks Engine",
      category: "Options",
      targetTab: "trading",
      samplePrompt: "Find bull call spreads on SPY with max loss <= $30",
    },
    {
      id: "options-flows",
      title: "Options Flow Estimates & Institutional Sweeps (Modelled)",
      category: "Flows",
      targetTab: "options-flows",
      samplePrompt: "Show unusual options flow and sweeps",
    },
    {
      id: "multi-leg-builder",
      title: "Visual Multi-Leg Strategy Builder & Payoff",
      category: "Builder",
      targetTab: "trading",
      samplePrompt: "Build iron condor on TSLA",
    },
    {
      id: "portfolio-risk",
      title: "Portfolio Exposure & Reconciled Balances",
      category: "Portfolio",
      targetTab: "trading",
      samplePrompt: "What is my portfolio balance and positions?",
    },
    {
      id: "order-execution",
      title: "Brokerage Order Drafts (Strict HITL)",
      category: "Orders",
      targetTab: "trading",
      samplePrompt: "Buy 10 shares of NVDA at market",
    },
    {
      id: "scheduled-tasks",
      title: "Autonomous Background Alarms & Screening",
      category: "Scheduling",
      targetTab: "trading",
      samplePrompt: "Remind me to check AAPL in 10 minutes",
    },
  ];

  const spokenSummary =
    "The Voice Trading Desk provides 14 integrated market capabilities across analysis and execution. You can ask for real-time market quotes, technical screening across 8,000 equities, top gainers and losers, options strategy discovery with Black-Scholes Greeks, modelled options flow estimates, portfolio risk and balances, scheduled alerts, or draft trade order tickets with Human-in-the-Loop protection. What would you like to explore today?";

  const markdownOverview = [
    `### 🎙️ Voice Trading Desk: Platform Capabilities`,
    ``,
    `Multi-Agent Studio connects you to **14 integrated market analysis & execution workflows**:`,
    ``,
    `#### 📊 Market Analysis Capabilities`,
    `- 📈 **Real-Time Quotes**: Instant bid/ask NBBO, daily changes, and 52-week ranges. *(e.g. "Quote NVDA", "What is Apple trading at?")*`,
    `- 🔍 **Stock Screener & Movers**: Screen 8,000+ equities across NASDAQ, NYSE, and AMEX. *(e.g. "Find top gainers and losers", "Screen all tech stocks")*`,
    `- ⚡ **Options Strategy Discovery**: ${STRATEGY_CATALOG_COUNT} catalog strategies, calibrated pricing, and Black-Scholes Greeks. *(e.g. "Find bull call spreads on SPY", "Options ideas for NVDA")*`,
    `- 🌊 **Options Flow Tracker**: Surfaces unusual modelled sweeps, blocks, and sentiment estimates derived from option-chain data (no live trade tape). *(e.g. "Check unusual options flow")*`,
    `- 🛡️ **Portfolio & Risk Analysis**: Reconciled holdings, purchasing power, and dollar delta exposure. *(e.g. "What is my portfolio balance?", "Show my positions")*`,
    `- 🔬 **Market Data Fundamental Research**: P/E ratios, valuations, and analyst ratings without API credentials. *(e.g. "Valuation and P/E for MSFT")*`,
    ``,
    `#### ⚡ Execution & Automation Capabilities`,
    `- 📝 **Order Draft & Preview (Strict HITL)**: Drafts orders with Agent DID attestations requiring verbal or 1-click confirmation before broker execution. *(e.g. "Buy 10 shares of NVDA at market", "Limit order 5 AAPL at 220")*`,
    `- ⏰ **Persistent Background Timers**: Schedule background scans and reminders that survive restarts. *(e.g. "Remind me to check TSLA in ten minutes", "Schedule market screen every five minutes")*`,
    `- 💬 **Omnichannel Approvals**: Execute orders and receive alerts over Slack, Email, and Voice.`,
    ``,
    `*💡 Voice Desk Tips: Speak naturally to run any screen, request a quote, or preview a trade.*`,
  ].join("\n");

  return {
    spokenSummary,
    markdownOverview,
    workflows,
  };
}
