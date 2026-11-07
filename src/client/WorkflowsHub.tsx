import React, { useState, useMemo } from "react";
import "./workflowsHub.css";
import { Button, Card, PillGroup, Table, TextInput, PageShell, Tabs, Stack, Flex, Grid } from "./components/ui";
import { useUrlSyncedTabs } from "./useUrlSyncedTabs";
import { STRATEGY_LIBRARY } from "./options/strategyLibrary";
import {
  FAQ_QUESTIONS,
  WORKFLOW_IMPROVEMENTS,
  CAPABILITY_MATRIX,
  DECISIONING_SECTIONS,
  type FaqQuestionItem,
  type WorkflowImprovementItem,
  type CapabilityMatrixRow,
  type DecisioningSection,
  type DecisioningRule,
  type DecisioningMatrixRow,
  type ParameterBadge,
} from "./workflowsFaqData";

export interface WorkflowItem {
  id: string;
  codeId: string;
  number: number;
  track: "analysis" | "execution";
  trackLabel: string;
  title: string;
  category: "stocks" | "options" | "flows" | "brokerage" | "scheduled" | "nlq" | "payments" | "research" | "audit" | "risk";
  categoryLabel: string;
  badge: string;
  badgeColor: "green" | "blue" | "purple" | "orange" | "cyan";
  subtitle: string;
  overview: string;
  apiEndpoint: string;
  targetTab: string;
  keyParameters?: string;
  governingDecisionRuleId?: string;
  steps: Array<{
    step: string;
    title: string;
    description: string;
  }>;
  keyFeatures: string[];
  dataSources: string[];
  apiMetrics?: Array<{
    host: string;
    status2xx: number | string;
    status4xx: number | string;
    avgDuration: string;
    role: string;
    usageDetails: string;
    nuanceExplanation: string;
  }>;
  faq: {
    question: string;
    answer: string;
  };
  sampleQueryOrAction: string;
}

export const PLATFORM_WORKFLOWS: WorkflowItem[] = [
  // =========================================================================
  // ANALYSIS TRACK (A1 - A8)
  // =========================================================================
  {
    id: "stock-screener",
    codeId: "A1",
    number: 1,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Stock Screener & Multi-Exchange Equity Discovery",
    category: "stocks",
    categoryLabel: "Equities",
    badge: "Dual-Engine (Listings & Quotes)",
    badgeColor: "green",
    subtitle: "Screen 8,000+ US equities dynamically across NASDAQ, NYSE, and AMEX with technical indicators and auditable scan ledgers.",
    overview: "The Stock Screener allows filtering across all active US equities by price, market cap, exchange, 14-period daily RSI, MACD momentum, and daily gainers/losers. It queries official Nasdaq multi-exchange listings (api.nasdaq.com) across 8,000+ active tickers, with resilient automatic fallback to the externalized curated universe (src/config/curatedStockUniverse.json) or Yahoo Finance feeds if upstream APIs are rate-limited. Downstream workflows (including Options Flow) query this screener first as their primary dynamic market underlyings engine.",
    apiEndpoint: "POST /api/etrade/screen · POST /api/market-data/screen",
    targetTab: "trading",
    keyParameters: "exchange: ALL, minPrice: $3.00, marketCapTier: Large/Mid/Small, rsiPeriod: 14",
    governingDecisionRuleId: "stock-screener-logic",
    steps: [
      {
        step: "Step 1",
        title: "Filter Configuration",
        description: "User configures exchange (NASDAQ, NYSE, AMEX, or ALL), price boundaries, market capitalization, sector, and trend (Gainers, Losers, Most Active).",
      },
      {
        step: "Step 2",
        title: "Dynamic Exchange Ingestion & Fallback Decision",
        description: "The engine queries the official Nasdaq Screener API (api.nasdaq.com) across 8,000+ active tickers. If rate-limited, throttled, or unreachable, DynamicMarketScreener autonomously falls back to the curated universe or Yahoo market-data feeds.",
      },
      {
        step: "Step 3",
        title: "Indicator Computation",
        description: "Calculates 14-Period Daily RSI and MACD (12, 26, 9 EMA) exponential moving averages to categorize momentum into Overbought, Oversold Bounce, Bullish, or Range-Bound.",
      },
      {
        step: "Step 4",
        title: "Auditable Scan Ledger",
        description: "Compiles a complete audit ledger recording total evaluated tickers, passed candidates, and exact failure reasons for every rejected security.",
      },
    ],
    keyFeatures: [
      "Dynamic all-exchange discovery with live Nasdaq, NYSE, and AMEX support.",
      "Autonomous fallback decision tree: prioritizes remote Nasdaq/Yahoo listings before gracefully falling back to externalized curated universe.",
      "Single Source of Truth for Options Flow: Options Flow queries this screener first to resolve active, liquid market underlyings partitioned by market cap rather than defaulting to a static list.",
      "Dual provider flexibility: connected-broker mode or 100% zero-credential market-data mode.",
      "Auditable scan ledger detailing why each security matched or failed criteria.",
      "Sortable results by 1D change %, volume, market cap, and RSI momentum.",
    ],
    dataSources: [
      "Nasdaq Official Screener API (api.nasdaq.com/api/screener/stocks)",
      "Externalized Curated Stock Universe (src/config/curatedStockUniverse.json)",
      "Yahoo Finance Chart & Summary API (query1/query2.finance.yahoo.com)",
      "Yahoo Finance Cookie Crumb Handshake (fc.yahoo.com)",
      "E*TRADE Market Quote & Orders API (api.etrade.com/v1/market/quote)",
    ],
    apiMetrics: [
      {
        host: "api.nasdaq.com",
        status2xx: 33,
        status4xx: 0,
        avgDuration: "2.17s",
        role: "Nasdaq Official All-Exchange Screener",
        usageDetails: "Ingests dynamic listing tables across NASDAQ, NYSE, and AMEX (~8,500 active securities) in 5,000-row paginated batches.",
        nuanceExplanation: "33 total requests reflect 3 exchange partitions paginated across 5,000 rows. The 2.17s latency reflects Nasdaq enterprise database queries.",
      },
      {
        host: "query1.finance.yahoo.com",
        status2xx: 945,
        status4xx: 46,
        avgDuration: "257.6ms",
        role: "Yahoo Finance Chart, Indicators & Session Crumb",
        usageDetails: "Retrieves 1-month daily and intraday historical OHLCV chart bars (/v8/finance/chart/{symbol}) to compute 14-period RSI and MACD.",
        nuanceExplanation: "The 46 4xx responses represent unlisted OTC tickers or transient Yahoo rate throttles. Resilient fallback mechanisms handle retries seamlessly.",
      },
      {
        host: "query2.finance.yahoo.com",
        status2xx: 940,
        status4xx: 7,
        avgDuration: "70.9ms",
        role: "Yahoo Finance Quote Summary & Options Feed",
        usageDetails: "Secondary load-balanced endpoint querying detailed valuation metrics (/v10/finance/quoteSummary/{symbol}?modules=price,summaryDetail).",
        nuanceExplanation: "Extremely fast 70.9ms average latency. The 7 4xx responses reflect non-optionable ticker queries or invalid symbol symbols.",
      },
      {
        host: "fc.yahoo.com",
        status2xx: 0,
        status4xx: 70,
        avgDuration: "30.3ms",
        role: "Yahoo Finance Cookie Crumb Handshake",
        usageDetails: "Initial cookie handshake request for the open-source Yahoo Finance session protocol.",
        nuanceExplanation: "100% 4xx (HTTP 404/401) is expected by design: Yahoo intentionally responds with 4xx while setting the session cookie header.",
      },
    ],
    faq: {
      question: "Why does the screener not show penny stocks or low-liquidity OTC stocks?",
      answer: "The screener defaults to a minimum price floor of $3.00 and requires major exchange listing (NASDAQ/NYSE/AMEX) to ensure optionability and prevent illiquid OTC slippage.",
    },
    sampleQueryOrAction: "Screen NASDAQ stocks with price > $50, market cap > $10B, and RSI < 35",
  },

  {
    id: "options-discovery",
    codeId: "A2",
    number: 2,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Options Strategy Discovery, Greeks Modeling & EV Scoring",
    category: "options",
    categoryLabel: "Options",
    badge: `${STRATEGY_LIBRARY.length}-Strategy Catalog`,
    badgeColor: "blue",
    subtitle: `Calibrates synthetic option pricing, computes analytical Black-Scholes Greeks, POP, and EV across ${STRATEGY_LIBRARY.length} catalog structures.`,
    overview: "Evaluates multi-leg options structures (Iron Condors, Vertical Spreads, Butterflies, Calendars, Diagonals, Straddles, Strangles) against live calibrated option chains. Calculates Delta, Gamma, Theta, Vega, IV Rank, Probability of Profit (POP = N(d2)), and Expected Value (EV). Supports strict user budget and risk filtering (e.g. Max Loss <= $30, Max Profit > $0).",
    apiEndpoint: "POST /api/etrade/options/strategy · POST /api/trading/options/unified",
    targetTab: "trading",
    keyParameters: "symbol: NVDA, bias: 50 (Balanced EV), budget: $300, minRR: 1.0, maxLoss: $30",
    governingDecisionRuleId: "multivariate-scoring-criteria",
    steps: [
      {
        step: "Step 1",
        title: "Chain Ingestion & Synthetic Calibration",
        description: "Fetches live option chains from the connected broker or market-data feeds. Mid-market prices are calibrated to eliminate spread distortions.",
      },
      {
        step: "Step 2",
        title: "Combinatorial Strike Ladder Generation",
        description: `Generates candidate leg combinations across ${STRATEGY_LIBRARY.length} catalog strategies, shifting strikes dynamically based on Optimization Bias (0=Max Return, 50=Balanced, 100=Max Chance).`,
      },
      {
        step: "Step 3",
        title: "Analytical Black-Scholes Greeks & POP",
        description: "Computes Delta, Gamma, Theta, Vega, and Probability of Profit (N(d2)) for every candidate structure using continuous dividend and risk-free rates.",
      },
      {
        step: "Step 4",
        title: "Multivariate 6-Factor Composite Scoring",
        description: "Ranks setups using the institutional dot-product score: S = w_thesis*S_thesis + w_RR*S_RR + w_liq*S_liq + w_fresh*S_fresh + w_iv*S_iv + w_theta*S_theta.",
      },
    ],
    keyFeatures: [
      `${STRATEGY_LIBRARY.length} distinct options strategies spanning directional, neutral, volatility, and income plays.`,
      "Strict parameter filtering: max loss, max profit, min win rate, strike bounds, and expiration windows.",
      "Black-Scholes analytical Greeks engine with continuous dividend and risk-free rate calibration.",
      "Expected Value (EV) calculation: EV = (POP * MaxProfit) - ((1 - POP) * MaxLoss) / Collateral.",
      "Visual 2D interactive payoff curve with breakevens, max gain, and max capital at risk.",
    ],
    dataSources: [
      "E*TRADE Option Chains API (api.etrade.com/v1/market/optionchains)",
      "E*TRADE Option Expirations API (api.etrade.com/v1/market/optionexpiredate)",
      "Calibrated Synthetic Pricing Engine (src/trading/options/calibratedOptionChains.ts)",
    ],
    faq: {
      question: "How does the Optimization Bias slider affect strike selection?",
      answer: "Bias 0 shifts strikes +3 steps OTM for maximum percentage return multiple. Bias 50 centers strikes ATM for balanced EV. Bias 100 shifts strikes -3 steps ITM for maximum probability of profit (POP > 75%).",
    },
    sampleQueryOrAction: "Find bullish call spreads on NVDA with max loss <= $30 and max profit > $0",
  },

  {
    id: "options-raw-screener",
    codeId: "A3",
    number: 3,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Raw Options Contract Screener & Chain Filtering",
    category: "options",
    categoryLabel: "Options",
    badge: "15-Gate Contract Filter",
    badgeColor: "purple",
    subtitle: "Granular contract-level filtering of raw option strikes with moneyness bounds, Greek filters, and 15 rejection code gates.",
    overview: "Direct, granular contract-level filtering of raw option strikes across calls and puts. Applies 15 rejection code gates (e.g. SPREAD_TOO_WIDE, MIN_VOLUME_FAIL, OUTSIDE_DELTA_RANGE, STALE_QUOTE). Sanitization normalizes user inputs, clamps negative bounds, and computes auditable rejection ledgers detailing exactly why each non-qualifying contract was omitted.",
    apiEndpoint: "POST /api/trading/options/screen · POST /api/premium/options-scan",
    targetTab: "trading",
    keyParameters: "minVol: 500, minOI: 1000, maxSpreadPct: 5.0%, atmBandPct: 0.02, dte: 14-45d",
    governingDecisionRuleId: "options-screener-logic",
    steps: [
      {
        step: "Step 1",
        title: "Raw Chain Retrieval",
        description: "Retrieves complete strike ladder for the selected underlying across weekly and monthly expiration cycles.",
      },
      {
        step: "Step 2",
        title: "Boundary Sanitization & Clamping",
        description: "Validates bid/ask quotes, omits inverted quotes (bid > ask or bid <= 0), and verifies quote age under 60 seconds.",
      },
      {
        step: "Step 3",
        title: "15-Gate Exclusion Filter",
        description: "Applies volume floors, open interest depth, spread percentage ceilings, and Delta/Gamma/Theta/Vega tolerances.",
      },
      {
        step: "Step 4",
        title: "Heuristic Signal Tagging",
        description: "Tags passing contracts with market condition signals: Unusual Volume Spike (Vol/OI > 1.5x), High Delta Momentum, or High IV Expansion.",
      },
    ],
    keyFeatures: [
      "15 explicit rejection codes for 100% auditability.",
      "Bid-ask spread percentage filtering relative to midpoint to eliminate wide illiquid options.",
      "At-The-Money (ATM) ±2% moneyness band classification into ITM, ATM, and OTM.",
      "Support for x402 pay-per-query micropayments via external MCP tool integration.",
    ],
    dataSources: [
      "E*TRADE Option Chains API (api.etrade.com/v1/market/optionchains)",
      "Synthetic Midpoint & Spread Ratio Solvers",
    ],
    faq: {
      question: "What rejection code is triggered if a quote is stale or inverted?",
      answer: "Inverted quotes trigger INVALID_QUOTE. Quotes older than maxQuoteAgeSeconds (default 60s) trigger STALE_QUOTE and degrade confidence.",
    },
    sampleQueryOrAction: "Screen NVDA call contracts with volume > 500, spread < 4%, and DTE between 14 and 45 days",
  },

  {
    id: "options-flows",
    codeId: "A4",
    number: 4,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Options Flow Estimates & Institutional Activity Tracker (Modelled, Chain-Derived)",
    category: "flows",
    categoryLabel: "Market Flows",
    badge: "Institutional Smart Money",
    badgeColor: "blue",
    subtitle: "Tracks unusual options volume, modelled sweeps (≥$100k estimated premium, aggressive-at-ask positioning), blocks, splits, and dynamic sentiment leaderboards.",
    overview: "Derives modelled options-flow estimates from option-chain snapshots across the market — there is no live options trade-tape feed, so these are estimates, not executed prints. Filters by trade type (SWEEP, BLOCK, SPLIT), sentiment (BULLISH, BEARISH), moneyness (ITM, ATM, OTM), and minimum premium. Dynamically screens underlying equities using the Stock Screener first (with fallback to curated universe), computes Bull/Bear volume ratios, and aggregates top institutional ticker leaderboards.",
    apiEndpoint: "GET /api/options/flows/live · GET /api/options/flows/summary",
    targetTab: "options-flows",
    keyParameters: "minPremium: $100k, volOiRatio: > 1.5x, tradeType: SWEEP | BLOCK, aggression: ASK",
    governingDecisionRuleId: "stock-screener-logic",
    steps: [
      {
        step: "Step 1",
        title: "Dynamic Universe Resolution",
        description: "Queries DynamicMarketScreener to obtain active, liquid underlyings partitioned by mega/large/mid caps rather than using a static list.",
      },
      {
        step: "Step 2",
        title: "Flow Derivation & Normalization",
        description: "Derives estimated flow from option-chain snapshots (contract volume, open interest, last price), normalizing strikes, expirations, spot prices, and modelled premiums. Side and size are inferred — these are estimates, not executed prints.",
      },
      {
        step: "Step 3",
        title: "Anomaly & Sweep Classification",
        description: "Flags unusual estimated flow where Volume exceeds Open Interest (>1.5x) or modelled premium exceeds $100k+ with aggressive-at-ask positioning (Sweeps).",
      },
      {
        step: "Step 4",
        title: "Sentiment Aggregation & Leaderboards",
        description: "Computes net premium delta and ranks top bullish and bearish tickers in visual leaderboards.",
      },
    ],
    keyFeatures: [
      "Integrated directly with Stock Screener as single source of truth for dynamic underlyings.",
      "Sweep vs Block estimate discrimination with aggression tags (Above Ask, At Ask, Below Bid).",
      "Dynamic Bull/Bear sentiment ratios and institutional volume leaderboards.",
      "Audio/visual alert badges for large modelled flow items ($500k+ estimated premium).",
      "Integrated 🛡️ Risk Analysis modal on every flow item for instant defense playbooks.",
    ],
    dataSources: [
      "Stock Screener Dynamic Listings (api.nasdaq.com + Yahoo Finance)",
      "Option-Chain Snapshots (E*TRADE / Yahoo Finance) — modelled flow estimates; no trade-tape feed exists",
      "Historical Open Interest & Implied Volatility Surface",
    ],
    faq: {
      question: "What makes a flow estimate a 'Sweep'?",
      answer: "A Sweep estimate is a modelled item whose inferred positioning is aggressive at or above the ask with ≥$100,000 estimated premium, suggesting institutional urgency. It is derived from chain data, not observed on a trade tape.",
    },
    sampleQueryOrAction: "Show unusual bullish options sweeps over $100k premium today",
  },

  {
    id: "strategy-builder",
    codeId: "A5",
    number: 5,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Visual Multi-Leg Strategy Builder & Expiration Payoff",
    category: "options",
    categoryLabel: "Options",
    badge: "Interactive Payoff Modeler",
    badgeColor: "cyan",
    subtitle: "Construct custom 1-to-4 leg positions with real-time expiration & T+0 curves, breakevens, and LLM comparison.",
    overview: "Construct custom 1-to-4 leg options positions with real-time expiration and pre-expiration (T+0) payoff diagrams. Automatically computes upper and lower breakeven points, maximum theoretical profit, maximum capital at risk, return on risk (RoR), and aggregate portfolio Greeks. Includes LLM-powered multi-strategy comparison and idea generation.",
    apiEndpoint: "POST /api/trading/options/compare · POST /api/trading/options/llm-ideas",
    targetTab: "trading",
    keyParameters: "legs: 1-4, payoffModel: Expiration + T+0, breakevenSolver: true, targetPrice: spot*1.05",
    governingDecisionRuleId: "strategy-selection-rules",
    steps: [
      {
        step: "Step 1",
        title: "Leg Assembly",
        description: "Add up to 4 options or stock legs specifying action (BUY/SELL), type (CALL/PUT/STOCK), strike, quantity, and expiration.",
      },
      {
        step: "Step 2",
        title: "2D Payoff Curve Modeling",
        description: "Computes expiration curve PnL(S) = sum(leg_pnl(S)) across underlying prices from 0.5x to 1.5x spot, plus intermediate T+0 Black-Scholes curve.",
      },
      {
        step: "Step 3",
        title: "Boundary & Greeks Rollup",
        description: "Solves for upper and lower breakeven points, max gain, max loss, and rolls up aggregate Net Delta, Gamma, Theta, and Vega.",
      },
      {
        step: "Step 4",
        title: "Staged Execution & Risk Analysis",
        description: "One-click transition to 🛡️ Risk Analysis or broker order preview draft.",
      },
    ],
    keyFeatures: [
      "Dynamic payoff diagram rendering at expiration and pre-expiration (T+0).",
      "Automatic calculation of exact breakeven points and maximum theoretical drawdown.",
      "Multi-leg Greeks aggregation: Net Delta, Net Gamma, Net Theta, Net Vega.",
      "One-click transition from visual builder to broker order preview or Risk Modal.",
    ],
    dataSources: [
      "Live Option Chain Pricing (connected broker & market-data providers)",
      "Black-Scholes Analytical Pricing & Payoff Math Models",
      "Neural Strategy AI Engine (Llama 3.3 70B / Analytical Models)",
    ],
    faq: {
      question: "Can I simulate multi-expiration diagonal spreads in the builder?",
      answer: "Yes. Each leg supports independent expiration selection, allowing calendar and diagonal spread evaluation with time decay progression.",
    },
    sampleQueryOrAction: "Build an Iron Condor on SPY with 45 DTE and $5 wide wings",
  },

  {
    id: "institutional-risk",
    codeId: "A6",
    number: 6,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Institutional Risk Management, Defense Playbooks & Portfolio Exposure",
    category: "risk",
    categoryLabel: "Risk & Hedging",
    badge: "Institutional Risk Matrix",
    badgeColor: "orange",
    subtitle: "Anatomy of risk across all strategies and trades: NAV position sizing (2-5%), 50% profit-taking, 2x stop-loss, and multi-point stress testing.",
    overview: "Provides institutional-grade risk management and defense playbooks across all strategies, contracts, flows, and trades in the platform. Formulates risk anatomy (Capital at Risk, Dollar Delta, Gamma risk, Vega exposure, POP, Probability of Touch, Breakeven cushions, Dividend/Early assignment hazard, Stress tests) and defense playbooks (NAV sizing, 50% profit rule, 2x stop-loss, roll out in time, roll untested wing, invert spreads). Integrates universal '🛡️ Risk Analysis' buttons and 1-click dispatch to multi-agent chat.",
    apiEndpoint: "GET /api/etrade/positions · GET /api/etrade/accounts",
    targetTab: "trading",
    keyParameters: "capitalBudgetPct: 2-5%, profitTargetPct: 50%, stopLossMultiplier: 2.0x, stressTest: -20% to +20%",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Risk Anatomy Decomposition",
        description: "Decomposes candidate or active position into max loss, capital at risk, full Greeks matrix, directional drift sensitivity, and probability of touch.",
      },
      {
        step: "Step 2",
        title: "NAV Position Sizing Audit",
        description: "Calculates conservative (2%), standard (3%), and aggressive (5%) maximum contract sizing based on account NAV purchasing power.",
      },
      {
        step: "Step 3",
        title: "Defense Rule Playbook",
        description: "Formulates explicit exit rules: 50% profit rule for credit spreads, 75-100% for debits, and 2x credit received stop-loss preservation.",
      },
      {
        step: "Step 4",
        title: "Tactical Defensive Adjustments & AI Dispatch",
        description: "Recommends rolling out in time for credit, rolling untested wings closer to spot, inverting strikes, or delta-hedging with 1-click AI prompt handoff.",
      },
    ],
    keyFeatures: [
      "Universal '🛡️ Risk Analysis' button present on every strategy card, builder, screener, flow print, and order ticket.",
      "NAV-based capital budget calculations ensuring traders never over-allocate capital.",
      "Multi-point stress test scenario matrix simulating -20%, -10%, -5%, +5%, +10%, and +20% market shocks.",
      "Early assignment & dividend ex-date risk audit for short American options.",
    ],
    dataSources: [
      "E*TRADE Accounts & Positions API (api.etrade.com/v1/accounts/{accountIdKey}/portfolio)",
      "RiskManagementEngine (src/client/options/riskManagementEngine.ts)",
      "Normal Cumulative Distribution Function (CDF) and Black-Scholes Greeks Math",
    ],
    faq: {
      question: "What is the 50% profit rule for credit spreads?",
      answer: "Institutional traders routinely close credit spreads when 50% of maximum credit is captured. This dramatically increases win rate and frees capital from diminishing theta returns.",
    },
    sampleQueryOrAction: "Evaluate risk anatomy and defense rules for NVDA 120/115 Put Credit Spread",
  },

  {
    id: "market-data-research",
    codeId: "A7",
    number: 7,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Zero-Credential Market Data Equity & Crypto Research",
    category: "research",
    categoryLabel: "Market Data Research",
    badge: "Zero-Credential Market Data",
    badgeColor: "green",
    subtitle: "100% free fundamental ratios (P/E, PEG, EV/EBITDA), analyst consensus, historical OHLCV chart bars, and crypto NBBO quotes.",
    overview: "100% free, credential-less equity and cryptocurrency research powered by zero-credential public market-data endpoints and free provider data APIs. Ingests valuation metrics (P/E, forward P/E, PEG, Price-to-Book, EV/EBITDA), analyst consensus price targets, historical OHLCV chart bars (daily, hourly, 5-minute), and crypto Level 1 NBBO bid/ask quotes without requiring brokerage API keys.",
    apiEndpoint: "GET /api/market-data/quote · GET /api/market-data/fundamentals · GET /api/market-data/bars",
    targetTab: "research",
    keyParameters: "symbol: NVDA | BTC/USD, modules: price,summaryDetail, interval: 1d, range: 1mo",
    governingDecisionRuleId: "stock-screener-logic",
    steps: [
      {
        step: "Step 1",
        title: "Session Cookie Handshake",
        description: "Exchanges session handshake headers with fc.yahoo.com to obtain crumb authorization tokens autonomously.",
      },
      {
        step: "Step 2",
        title: "Fundamentals & Valuation Ingestion",
        description: "Queries quoteSummary modules for market cap, enterprise value, trailing/forward P/E, PEG, and analyst consensus.",
      },
      {
        step: "Step 3",
        title: "Historical OHLCV Chart Aggregation",
        description: "Retrieves 1-month daily or intraday candle bars to plot price action and compute moving averages.",
      },
      {
        step: "Step 4",
        title: "Crypto NBBO Tape Integration",
        description: "Ingests live cryptocurrency bid/ask quotes from Alpaca crypto market data feeds for digital asset pairs.",
      },
    ],
    keyFeatures: [
      "Zero API keys, zero authentication credentials required.",
      "Comprehensive valuation fundamentals: P/E, Forward P/E, PEG, Price/Book, EV/EBITDA.",
      "High-resolution historical chart bars with volume histogram.",
      "Seamless integration with broker order execution for trading.",
    ],
    dataSources: [
      "Yahoo Finance Quote Summary (query1.finance.yahoo.com/v10/finance/quoteSummary)",
      "Yahoo Finance Chart Bars (query1.finance.yahoo.com/v8/finance/chart)",
      "Alpaca Market Data API (data.alpaca.markets/v2/stocks & crypto)",
    ],
    faq: {
      question: "Can I use market-data research if I do not have a broker account?",
      answer: "Yes. market-data research is completely independent and operates with 100% free zero-credential public endpoints.",
    },
    sampleQueryOrAction: "Get fundamental valuation ratios and analyst consensus target for NVDA",
  },

  {
    id: "nlq-chat",
    codeId: "A8",
    number: 8,
    track: "analysis",
    trackLabel: "Analysis · Read-Only",
    title: "Conversational Financial Intelligence & NLQ Analytics",
    category: "nlq",
    categoryLabel: "NLQ & Chat",
    badge: "AI Decision & Knowledge Engine",
    badgeColor: "purple",
    subtitle: "Natural language query planner and AI decision router converting inquiries into parameter-bound scans, knowledge retrieval, and firm memory updates.",
    overview: "Natural Language Query (NLQ) engine converting user questions into parameter-bound queries, market scans, and options evaluations. Integrates the AI decision router to classify intents (search, trading, research, payments, tasks, memory) with confidence scoring. Backed by neural strategy intelligence models and enterprise semantic knowledge retrieval.",
    apiEndpoint: "POST /api/nlq · POST /api/chat · POST /nlq/webhook",
    targetTab: "chat",
    keyParameters: "model: glm-4.7-flash, judgeRouting: true, vectorSearch: true, memoryVault: Persistent Distributed Ledger",
    governingDecisionRuleId: "pickbesttrades-engine",
    steps: [
      {
        step: "Step 1",
        title: "Intent Classification & AI Decision Routing",
        description: "Classifies user query across 6 domains (search, trading, research, payments, tasks, memory) with confidence grading.",
      },
      {
        step: "Step 2",
        title: "Sub-Agent Tool Coordination",
        description: "Routes query to specialized sub-agents: options scanner, market-data equity research, institutional knowledge search, or payment intent drafter.",
      },
      {
        step: "Step 3",
        title: "Transactional Memory & Knowledge Retrieval",
        description: "Queries persistent firm records (messages, events, institutional memory) and semantic vector indexes for relevant facts.",
      },
      {
        step: "Step 4",
        title: "Streaming Synthesis & UI Action Cards",
        description: "Streams response via WebSocket, rendering interactive trade cards, payoff graphs, and 1-click execution tickets.",
      },
    ],
    keyFeatures: [
      `Natural language understanding mapped directly to ${STRATEGY_LIBRARY.length}-strategy catalog.`,
      "Dual-engine AI routing: Neural Strategy Models (glm-4.7-flash) with deterministic screener fallback.",
      "Persistent memory vault storing user preferences and facts across sessions.",
      "Omnichannel support: Web chat, Slack events, inbound email, and WebRTC voice.",
    ],
    dataSources: [
      "Neural Strategy AI Engine (glm-4.7-flash / Llama 3.3 70B)",
      "Enterprise Semantic Knowledge Index",
      "Persistent transactional record storage (messages, events, institutional memory)",
    ],
    faq: {
      question: "What happens if the primary neural AI model quota is reached?",
      answer: "The orchestrator automatically detects upstream rate constraints and engages deterministic rule-based screening fallbacks with full diagnostic remediation cards in chat.",
    },
    sampleQueryOrAction: "Find top scoring options opportunities on TSLA with balanced risk",
  },

  // =========================================================================
  // EXECUTION TRACK (E1 - E6)
  // =========================================================================
  {
    id: "etrade-trading",
    codeId: "E1",
    number: 9,
    track: "execution",
    trackLabel: "Execution · HITL Guarded",
    title: "Brokerage Order Preview & Human-in-the-Loop (HITL) Execution (E*TRADE)",
    category: "brokerage",
    categoryLabel: "Brokerage",
    badge: "DID-Attested HITL Guardrails",
    badgeColor: "orange",
    subtitle: "Safe order placement with mandatory two-phase commit: agent previews commissions and margins, signs with DID, and requires user approval.",
    overview: "Enforces strict safety guardrails for real-world trading. The AI agent NEVER places orders autonomously without explicit human authorization. Orders are first prepared as an order preview draft (signed with Decentralized Identifier did:agent:openaimp:trading), showing estimated total, commission, and margin impact. Execution only proceeds when the user explicitly approves the proposal in the UI or chat.",
    apiEndpoint: "POST /api/etrade/order/preview · POST /api/etrade/order/execute",
    targetTab: "trading",
    keyParameters: "previewId: required, didStamp: 'did:agent:openaimp:trading', humanConfirmation: true",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Order Proposal Drafting",
        description: "Agent or user drafts an order ticket with symbol, action (BUY/SELL), quantity, order type (LIMIT/MARKET), and price.",
      },
      {
        step: "Step 2",
        title: "E*TRADE Preview Handshake",
        description: "Calls E*TRADE Preview API to validate account buying power, calculate exact commissions/fees, and obtain a previewId.",
      },
      {
        step: "Step 3",
        title: "DID Attestation & Human Review",
        description: "Signs proposal with Agent DID and displays draft modal in UI. Requires user to review details and click 'Confirm & Execute'.",
      },
      {
        step: "Step 4",
        title: "Authorized Execution & Audit Logging",
        description: "Submits previewId to broker order execution gateway and commits transaction receipt to the persistent institutional order ledger.",
      },
    ],
    keyFeatures: [
      "Zero unconfirmed live executions: 100% Human-in-the-Loop guaranteed.",
      "Cryptographic proposal signing with W3C Decentralized Identifier (did:agent:openaimp:trading).",
      "Two-phase commit protocol: Preview Handshake -> Human Approval -> Place Execution.",
      "Automatic token renewal via background cron before midnight expiration.",
    ],
    dataSources: [
      "E*TRADE Order Preview API (api.etrade.com/v1/accounts/{accountIdKey}/orders/preview)",
      "E*TRADE Place Order API (api.etrade.com/v1/accounts/{accountIdKey}/orders/place)",
      "W3C DID Cryptographic Attestation Service (src/agents/did.ts)",
    ],
    faq: {
      question: "Can an AI agent place a live trade without me clicking Confirm?",
      answer: "No. The system enforces zero autonomous trading. Orders remain in 'preview' status until an authenticated human clicks Confirm or submits an approved approval token.",
    },
    sampleQueryOrAction: "Preview buy order for 1x NVDA 130 Call expiring next month",
  },

  {
    id: "alpaca-trading",
    codeId: "E2",
    number: 10,
    track: "execution",
    trackLabel: "Execution · HITL Guarded",
    title: "Direct Equities & Crypto Order Placement (Alpaca Broker API)",
    category: "brokerage",
    categoryLabel: "Brokerage",
    badge: "Direct Broker API",
    badgeColor: "blue",
    subtitle: "Places equity and cryptocurrency market, limit, and stop orders with fractional shares and extended-hours execution.",
    overview: "Places equity and cryptocurrency market, limit, and stop orders through Alpaca Securities. Supports fractional share buying, crypto trading pairs (BTC/USD, ETH/USD, SOL/USD), extended-hours session execution, and real-time buying power validation.",
    apiEndpoint: "POST /api/trading/alpaca/order · GET /api/trading/alpaca/orders",
    targetTab: "research",
    keyParameters: "side: buy|sell, type: limit|market, timeInForce: day|gtc, fractional: true",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Account & Buying Power Verification",
        description: "Checks Alpaca account status, available cash, and margin buying power before staging orders.",
      },
      {
        step: "Step 2",
        title: "Order Staging & Route Selection",
        description: "Configures fractional shares, limit prices, stop triggers, and extended-hours flags.",
      },
      {
        step: "Step 3",
        title: "Broker API Submission",
        description: "Submits order payload to Alpaca Trading API endpoint with client order identifier for idempotency.",
      },
      {
        step: "Step 4",
        title: "Fill Confirmation & Position Update",
        description: "Monitors execution fills and synchronizes new position quantities in the portfolio ledger.",
      },
    ],
    keyFeatures: [
      "Direct equity and cryptocurrency execution via Alpaca Securities.",
      "Fractional share support allowing dollar-based allocations.",
      "Extended-hours execution (pre-market and after-hours).",
      "Idempotent order placement preventing duplicate order submissions.",
    ],
    dataSources: [
      "Alpaca Orders API (api.alpaca.markets/v2/orders)",
      "Alpaca Account API (api.alpaca.markets/v2/account)",
      "Alpaca Positions API (api.alpaca.markets/v2/positions)",
    ],
    faq: {
      question: "Does Alpaca support fractional share orders?",
      answer: "Yes. Equity market orders support fractional shares by specifying notional dollar amounts (e.g. buy $50 of NVDA).",
    },
    sampleQueryOrAction: "Place market order to buy $100 of NVDA via Alpaca",
  },

  {
    id: "schedulers",
    codeId: "E3",
    number: 11,
    track: "execution",
    trackLabel: "Execution · Autonomous Daemon",
    title: "Autonomous Background Cron, Interval Alarms & Token Lifecycle",
    category: "scheduled",
    categoryLabel: "Automation",
    badge: "Autonomous State Alarms",
    badgeColor: "purple",
    subtitle: "24/7 background automation: auto-renews E*TRADE OAuth access tokens daily at 23:00 EDT / 22:00 EST, runs scans every 5 min, and broadcasts WebSocket alerts.",
    overview: "24/7 autonomous background automation with persistent state-machine alarms. Automatically renews E*TRADE OAuth access tokens daily at 23:00 EDT / 22:00 EST (03:00 UTC), always at least an hour ahead of the midnight-ET expiration, triggers market screening scans every 5 minutes (300 seconds), processes queued async jobs, and broadcasts live alerts over WebSockets.",
    apiEndpoint: "POST /api/schedules/trigger-renew · POST /api/schedules/trigger-screen",
    targetTab: "trading",
    keyParameters: "cron: '0 3 * * *' UTC (renew, 23:00 EDT / 22:00 EST), interval: 300s (screen), keepAliveWhile: active",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Alarm Registration",
        description: "Registers recurring persistent state-machine alarms using schedule() and scheduleEvery() lifecycle methods.",
      },
      {
        step: "Step 2",
        title: "OAuth Token Renewal Daemon",
        description: "Executes daily at 23:00 EDT / 22:00 EST (03:00 UTC) — always at least an hour before the midnight-ET expiration. Calls E*TRADE renew_access_token API to prevent session expiration at midnight.",
      },
      {
        step: "Step 3",
        title: "Autonomous Opportunity Scanner",
        description: "Fires every 5 minutes. Evaluates symbol baskets, filters by composite score threshold, and flags breakout candidates.",
      },
      {
        step: "Step 4",
        title: "WebSocket Broadcast & Async Job Ledger",
        description: "Pushes scan notifications over WebSockets and records execution results in mas_async_jobs.",
      },
    ],
    keyFeatures: [
      "Zero-downtime E*TRADE OAuth session maintenance without requiring re-login.",
      "Unattended market scanning across customizable ticker baskets.",
      "Fault-tolerant async job processing with automatic retry policies.",
      "Live WebSocket notifications pushed directly to active client sessions.",
    ],
    dataSources: [
      "E*TRADE OAuth Token Renewal (api.etrade.com/oauth/renew_access_token)",
      "Autonomous State-Machine Alarm Engine",
      "Durable Async Job Ledger (mas_async_jobs)",
    ],
    faq: {
      question: "What happens if the token renewal cron misses a cycle?",
      answer: "The scheduler logs an audit alert and falls back to a 15-minute retry loop. If the token expires past midnight, the UI prompts for a fresh PIN handshake.",
    },
    sampleQueryOrAction: "Trigger manual token renewal and run autonomous options analysis",
  },

  {
    id: "omnichannel-trading",
    codeId: "E4",
    number: 12,
    track: "execution",
    trackLabel: "Execution · Multi-Gateway",
    title: "Omnichannel Execution & One-Click Approvals (Slack, Email, Voice)",
    category: "brokerage",
    categoryLabel: "Omnichannel",
    badge: "Slack, Email & Voice",
    badgeColor: "green",
    subtitle: "Interact anywhere: Slack Block Kit buttons, inbound email with .xlsx workbooks, session-authenticated in-app approvals, and duplex WebSockets.",
    overview: "Multi-channel execution gateway allowing traders to interact with the platform from anywhere: Slack mentions with Block Kit visual cards, inbound email parsing with attached .xlsx workbooks, session-authenticated trade approval in the signed-in app (GET /trade/approve forwards to the same HITL execution path), and full-duplex WebRTC voice sessions.",
    apiEndpoint: "POST /slack/events · GET /trade/approve · POST /api/trading/reports/email",
    targetTab: "trading",
    keyParameters: "approvalAuth: app session / Slack signing secret, draftTtl: 900s, voiceProtocol: audio/pcm",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Channel Ingestion",
        description: "Ingests messages from Slack webhooks, inbound corporate email, or audio voice WebSockets.",
      },
      {
        step: "Step 2",
        title: "NLQ Intent Mapping",
        description: "The shared NLQ planner parses trade parameters and formats structured visual cards.",
      },
      {
        step: "Step 3",
        title: "Human Approval (HITL)",
        description: "The previewed draft awaits an authenticated human approval: an 'Approve Trade' click on the Slack card (verified against the Slack signing secret), an APPROVE reply to the preview email, or approval in the signed-in app. There are no bearer approval links; drafts expire unexecuted after 900 seconds.",
      },
      {
        step: "Step 4",
        title: "Omnichannel Execution & Receipt",
        description: "Once approved, the broker executes the previewed order exactly as drafted and dispatches confirmation back to the channel.",
      },
    ],
    keyFeatures: [
      "Slack Block Kit cards with interactive 'Approve Trade' buttons.",
      "Email quantitative workbooks in native .xlsx format.",
      "Session-authenticated approvals behind a strict HITL gate — only drafts still in 'previewed' state can execute, exactly as previewed; drafts expire after 15 minutes.",
      "Real-time voice trading over full-duplex WebSocket audio sessions.",
    ],
    dataSources: [
      "Slack Web API (chat.postMessage)",
      "Inbound Corporate Email Gateway",
      "Outbound HMAC-SHA256 Webhooks (OUTBOUND_WEBHOOK_URL)",
    ],
    faq: {
      question: "How are trade approvals protected against forged or replayed approvals?",
      answer: "There are no bearer approval links to forge or replay. Every approval is an authenticated human action — a Slack interaction verified against the Slack signing secret, an APPROVE reply to the preview email, or a click inside the signed-in app — and execution accepts only drafts still in 'previewed' state, with the executed parameters required to match the preview exactly. A draft can execute at most once and expires unexecuted after 900 seconds.",
    },
    sampleQueryOrAction: "Dispatch trade report with .xlsx attachment to analyst@example.com",
  },

  {
    id: "micropayments",
    codeId: "E5",
    number: 13,
    track: "execution",
    trackLabel: "Execution · Settlement",
    title: "Agentic Micropayments, Gateways & x402 Protocol Settlement",
    category: "payments",
    categoryLabel: "Payments",
    badge: "HTTP 402 & Gateways",
    badgeColor: "orange",
    subtitle: "Payment intent drafting across Stripe, PayPal, Lemon Squeezy, plus HTTP 402 pay-per-query access to compute-heavy MCP tools with on-chain receipts.",
    overview: "Multi-processor payment intent drafting and execution with human confirmation across traditional gateways (Stripe, PayPal, Lemon Squeezy) and next-generation HTTP 402 (x402) pay-per-use micropayments. Enables external MCP clients to access premium scanning tools by paying $0.05 USDC per query with verifiable cryptographic receipts.",
    apiEndpoint: "POST /api/payments/create · POST /mcp/scanner (x402)",
    targetTab: "payments",
    keyParameters: "amount: $0.05 USDC, protocol: x402, chains: Base|Ethereum|Solana",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Payment Intent Drafting",
        description: "Agent creates draft payment intent with amount, currency, and recipient. Never executes without human confirmation.",
      },
      {
        step: "Step 2",
        title: "x402 Challenge Generation",
        description: "For MCP tools, responds with HTTP 402 Payment Required containing destination wallet address and price.",
      },
      {
        step: "Step 3",
        title: "Cryptographic Proof Verification",
        description: "x402Verifier verifies transaction signature on Base, Ethereum, or Solana blockchains.",
      },
      {
        step: "Step 4",
        title: "Resource Settlement & Ledgering",
        description: "Grants access to premium query and writes receipt to immutable payment ledger.",
      },
    ],
    keyFeatures: [
      "Traditional payment gateway integration: Stripe, PayPal, Lemon Squeezy.",
      "HTTP 402 pay-per-query access to compute-heavy Model Context Protocol (MCP) tools.",
      "Cryptographic ledger recording receipts and verifiable payment proofs.",
      "Human confirmation required for all outgoing payment drafts.",
    ],
    dataSources: [
      "x402 Payment Protocol & Challenge Verifier Service",
      "Decentralized blockchain RPC nodes (Base, Ethereum, Solana)",
      "W3C Decentralized Identifier (DID) cryptographic registries",
    ],
    faq: {
      question: "Can I use the platform without crypto micropayments?",
      answer: "Yes. All standard screening, options discovery, research, and brokerage features include free tiers. The x402 protocol is reserved for premium external MCP tool calls.",
    },
    sampleQueryOrAction: "View active DID credentials and test HTTP 402 payment challenge",
  },

  {
    id: "observability-audit",
    codeId: "E6",
    number: 14,
    track: "execution",
    trackLabel: "Execution · Immutable Ledger",
    title: "Enterprise Observability & Cryptographic Audit Ledger Execution",
    category: "audit",
    categoryLabel: "Audit & Telemetry",
    badge: "Cryptographic Audit Ledger",
    badgeColor: "cyan",
    subtitle: "Records immutable audit events for every system action, judge evaluation, payment lifecycle transition, order preview, and execution to an append-only audit ledger.",
    overview: "Records immutable audit events for every system action: routing decisions, judge evaluations, payment lifecycle transitions, order previews, and executions. Publishes events to the institutional event store and streams telemetry to external observability collectors.",
    apiEndpoint: "GET /api/audit · POST /api/audit/event",
    targetTab: "audit",
    keyParameters: "storage: Immutable Audit Store, hashChain: SHA-256, retention: mas_messages pruned nightly (window default 90d via MAS_MESSAGES_RETENTION_DAYS); mas_events ledger append-only until cold-storage vault archival",
    governingDecisionRuleId: "additional-decisioning-gates",
    steps: [
      {
        step: "Step 1",
        title: "Event Interception",
        description: "Aspect-oriented logging aspects intercept function execution, recording timing, inputs, and outcomes.",
      },
      {
        step: "Step 2",
        title: "Cryptographic Hash Chaining",
        description: "Each event is hashed with SHA-256 and chained to previous event hashes to guarantee immutability.",
      },
      {
        step: "Step 3",
        title: "Immutable Ledger Commitment",
        description: "Writes event records to the persistent transactional audit ledger.",
      },
      {
        step: "Step 4",
        title: "Telemetry Stream & UI Ledger",
        description: "Streams events to UI audit viewer and external log telemetry endpoints in real time.",
      },
    ],
    keyFeatures: [
      "Cryptographically verifiable audit log of all agent routing decisions and order previews.",
      "Aspect-oriented error logging with externalized error codes and remediation guides.",
      "Real-time event streaming over WebSockets to client UI.",
      "Zero data loss with resilient transactional write-ahead logging.",
    ],
    dataSources: [
      "Transactional Audit Ledger Store",
      "Platform Execution Telemetry & Performance Metrics",
      "Aspect-Oriented Logging Engine (src/aspects/loggingAspect.ts)",
    ],
    faq: {
      question: "Are audit events preserved if the browser disconnects?",
      answer: "Yes. All audit events are stored persistently in the server-side transactional ledger and survive browser reloads.",
    },
    sampleQueryOrAction: "Inspect recent audit logs for order preview and judge routing events",
  },
];

export interface WorkflowsHubProps {
  onNavigateTab?: (tab: string) => void;
  onSendPrompt?: (prompt: string, sourceTab?: string) => void;
}

export type WorkflowsSubTab = "faq" | "workflows" | "decisioning" | "matrix" | "improvements";

export function isValidWorkflowsSubTab(tab: unknown): tab is WorkflowsSubTab {
  return (
    typeof tab === "string" &&
    (["faq", "workflows", "decisioning", "matrix", "improvements"] as readonly string[]).includes(tab)
  );
}

export function WorkflowsHub({ onNavigateTab, onSendPrompt }: WorkflowsHubProps) {
  // Primary navigation via the shared hook (S2, #2027): inner tabs live
  // in `?view=` (no legacy param — the subnav never had one). The subnav
  // itself becomes real Tabs (it was PillGroup pills with no tab
  // semantics). Panels stay conditional (no retention change).
  const { activeTab, handleTabChange } = useUrlSyncedTabs<WorkflowsSubTab>({
    param: "view",
    isValid: isValidWorkflowsSubTab,
    defaultTab: "faq",
  });

  // Workflows Tab State
  const [trackFilter, setTrackFilter] = useState<"all" | "analysis" | "execution">("all");
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState<string>("");
  const [expandedId, setExpandedId] = useState<string>("stock-screener");

  // FAQs Tab State
  const [faqCategory, setFaqCategory] = useState<string>("all");
  const [faqSearchQuery, setFaqSearchQuery] = useState<string>("");
  const [expandedFaqId, setExpandedFaqId] = useState<string>("best-opportunities");

  // Decisioning Logic Tab State
  const [decisioningSearchQuery, setDecisioningSearchQuery] = useState<string>("");
  const [expandedDecisioningId, setExpandedDecisioningId] = useState<string>("stock-screener-logic");

  // Capability Matrix Search
  const [matrixSearchQuery, setMatrixSearchQuery] = useState<string>("");

  const categories = [
    { id: "all", label: "All Categories" },
    { id: "stocks", label: "📈 Equities" },
    { id: "options", label: "🎯 Options" },
    { id: "flows", label: "🌊 Market Flows" },
    { id: "risk", label: "🛡️ Risk & Hedging" },
    { id: "research", label: "🔬 Market Data Research" },
    { id: "brokerage", label: "🤖 Brokerage" },
    { id: "scheduled", label: "⏰ Automation" },
    { id: "nlq", label: "💬 NLQ & Chat" },
    { id: "payments", label: "💳 Payments" },
    { id: "audit", label: "📋 Audit" },
  ];

  const faqCategories = [
    { id: "all", label: "All Questions (8)" },
    { id: "opportunities", label: "🏆 Opportunities" },
    { id: "budget-risk", label: "💰 Budget & Max Loss" },
    { id: "chance-return", label: "🎯 Chance vs Return" },
    { id: "combinations", label: "🦋 Combinations" },
    { id: "liquidity", label: "💧 Volatility & Liquidity" },
    { id: "directional", label: "🚀 Bullish & Bearish" },
    { id: "defined-risk", label: "🛡️ Defined Risk" },
    { id: "least-risk", label: "🔒 Least Risk" },
  ];

  const filteredWorkflows = useMemo(() => {
    return PLATFORM_WORKFLOWS.filter((wf) => {
      const matchesTrack = trackFilter === "all" || wf.track === trackFilter;
      const matchesCategory = selectedCategory === "all" || wf.category === selectedCategory;
      const q = searchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        wf.codeId.toLowerCase().includes(q) ||
        wf.title.toLowerCase().includes(q) ||
        wf.subtitle.toLowerCase().includes(q) ||
        wf.overview.toLowerCase().includes(q) ||
        (wf.keyParameters && wf.keyParameters.toLowerCase().includes(q)) ||
        wf.keyFeatures.some((f) => f.toLowerCase().includes(q)) ||
        wf.steps.some((s) => s.title.toLowerCase().includes(q) || s.description.toLowerCase().includes(q)) ||
        wf.faq.question.toLowerCase().includes(q) ||
        wf.faq.answer.toLowerCase().includes(q);

      return matchesTrack && matchesCategory && matchesSearch;
    });
  }, [trackFilter, selectedCategory, searchQuery]);

  const filteredFaqs = useMemo(() => {
    return FAQ_QUESTIONS.filter((faq) => {
      const matchesCategory = faqCategory === "all" || faq.category === faqCategory;
      const q = faqSearchQuery.toLowerCase().trim();
      const matchesSearch =
        !q ||
        faq.question.toLowerCase().includes(q) ||
        faq.summary.toLowerCase().includes(q) ||
        (faq.quickTakeaway && faq.quickTakeaway.toLowerCase().includes(q)) ||
        faq.theoreticalContext.toLowerCase().includes(q) ||
        faq.keyParameters.toLowerCase().includes(q) ||
        (faq.parameterBadges && faq.parameterBadges.some((p) => p.label.toLowerCase().includes(q) || p.value.toLowerCase().includes(q))) ||
        faq.methods.some((m) => m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));

      return matchesCategory && matchesSearch;
    });
  }, [faqCategory, faqSearchQuery]);

  const filteredDecisioning = useMemo(() => {
    return DECISIONING_SECTIONS.filter((sec) => {
      const q = decisioningSearchQuery.toLowerCase().trim();
      if (!q) return true;
      return (
        sec.title.toLowerCase().includes(q) ||
        sec.subtitle.toLowerCase().includes(q) ||
        sec.overview.toLowerCase().includes(q) ||
        (sec.governedWorkflows && sec.governedWorkflows.some((gw) => gw.toLowerCase().includes(q))) ||
        sec.rules.some(
          (r) =>
            r.name.toLowerCase().includes(q) ||
            r.description.toLowerCase().includes(q) ||
            (r.formulaOrCode && r.formulaOrCode.toLowerCase().includes(q)) ||
            (r.parametersOrGates && r.parametersOrGates.some((p) => p.toLowerCase().includes(q)))
        ) ||
        (sec.matrixOrWeights && sec.matrixOrWeights.some((m) => m.dimension.toLowerCase().includes(q) || m.details.toLowerCase().includes(q))) ||
        (sec.concreteExample && (sec.concreteExample.title.toLowerCase().includes(q) || sec.concreteExample.evaluation.toLowerCase().includes(q)))
      );
    });
  }, [decisioningSearchQuery]);

  const filteredMatrix = useMemo(() => {
    const q = matrixSearchQuery.toLowerCase().trim();
    if (!q) return CAPABILITY_MATRIX;
    return CAPABILITY_MATRIX.filter(
      (row) =>
        row.question.toLowerCase().includes(q) ||
        row.primaryWorkflow.toLowerCase().includes(q) ||
        row.secondaryWorkflow.toLowerCase().includes(q) ||
        row.keyInputParameter.toLowerCase().includes(q) ||
        row.optimalOutputStructure.toLowerCase().includes(q)
    );
  }, [matrixSearchQuery]);

  const toggleExpand = (id: string) => {
    setExpandedId((prev) => (prev === id ? "" : id));
  };

  const toggleExpandFaq = (id: string) => {
    setExpandedFaqId((prev) => (prev === id ? "" : id));
  };

  const toggleExpandDecisioning = (id: string) => {
    setExpandedDecisioningId((prev) => (prev === id ? "" : id));
  };

  const jumpToDecisionRule = (ruleId: string) => {
    handleTabChange("decisioning");
    setExpandedDecisioningId(ruleId);
  };

  return (
    <div className="workflows-hub-container">
      <PageShell
        title="Platform Workflows, Playbooks & Solutions Hub"
        scopeNote="Authoritative architectural specification of all 14 operational workflows (8 Analysis · 6 Execution), step-by-step playbooks for the 8 core quantitative scenarios, algorithmic decision rules, and capability lookup matrix."
      >

      {/* Quick Metrics Bar */}
      <div className="workflows-stats-bar">
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Core Workflows</span>
          <span className="workflows-stat-value">14 End-to-End</span>
          <span className="workflows-stat-desc">8 Analysis (A1–A8) · 6 Execution (E1–E6)</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Quantitative Playbooks</span>
          <span className="workflows-stat-value">8 Scenarios</span>
          <span className="workflows-stat-desc">24 Step-by-Step Multi-Path Solutions</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Decisioning Engines</span>
          <span className="workflows-stat-value">6 Deterministic Models</span>
          <span className="workflows-stat-desc">Mathematical formulations &amp; 15 rejection gates</span>
        </div>
        <div className="workflows-stat-card">
          <span className="workflows-stat-label">Execution Guardrails</span>
          <span className="workflows-stat-value">100% HITL Safe</span>
          <span className="workflows-stat-desc">W3C DID attestation &amp; mandatory confirmation</span>
        </div>
      </div>

      {/* Primary Sub-Navigation Tabs */}
      <div className="workflows-subnav-bar">
        <Tabs
          ariaLabel="Workflows sections"
          idBase="workflows"
          tabs={[
            { id: "faq", icon: "💡", label: "Quantitative Playbooks (8 Core FAQs)" },
            { id: "workflows", icon: "🧭", label: "Platform Workflows (14 Track A & E)" },
            { id: "decisioning", icon: "⚖️", label: "Algorithmic Decisioning Rules (6 Engines)" },
            { id: "matrix", icon: "📋", label: "Capability & Lookup Matrix" },
            { id: "improvements", icon: "🚀", label: "Optimization Roadmap (6 Enhancements)" },
          ]}
          value={activeTab}
          onChange={handleTabChange}
        />
      </div>

      {/* VIEW 1: QUANTITATIVE PLAYBOOKS & FAQS (THE 8 CORE QUESTIONS) */}
      {activeTab === "faq" && (
        <Stack gap="5" className="faq-section-container" role="tabpanel" id="workflows-panel-faq" aria-labelledby="workflows-tab-faq">
          {/* FAQ Search & Category Filter */}
          <div className="workflows-filter-strip">
            <div className="workflows-search-box">
              <span className="workflows-search-icon">🔍</span>
              <TextInput
                type="text"
                className="workflows-search-input"
                placeholder="Search scenarios, parameters, execution methods, formulas, or tickers…"
                value={faqSearchQuery}
                onChange={(e) => setFaqSearchQuery(e.target.value)}
              />
            </div>
            <div className="workflows-category-chips">
                            <PillGroup
                size="sm"
                options={faqCategories}
                value={faqCategory}
                onChange={setFaqCategory}
              />
            </div>
          </div>

          {/* Accordion List of the 8 Core Questions */}
          <div className="workflows-grid">
            {filteredFaqs.map((faq) => {
              const isOpen = expandedFaqId === faq.id;
              return (
                <div key={faq.id} className={`faq-accordion-card ${isOpen ? "open" : ""}`}>
                  <div className="faq-card-header" onClick={() => toggleExpandFaq(faq.id)}>
                    <div className="workflow-header-left">
                      <div className="workflow-number-badge">
                        Q0{faq.number}
                      </div>
                      <div className="workflow-header-titles">
                        <h3 className="workflow-title" style={{ fontSize: "var(--font-size-title-sm)" }}>
                          &ldquo;{faq.question}&rdquo;
                          <span className="workflow-tag-badge blue">{faq.categoryLabel}</span>
                        </h3>
                        <p className="workflow-subtitle">{faq.summary}</p>
                      </div>
                    </div>
                    <div className="workflow-header-right">
                      <span className="workflow-expand-caret">{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="faq-card-body">
                      {/* Quick Takeaway Banner */}
                      {faq.quickTakeaway && (
                        <div className="faq-quick-takeaway">
                          <span className="faq-quick-takeaway-label">
                            <span>⚡</span> Quick Solution &amp; Recommended Action (TL;DR)
                          </span>
                          <span className="faq-quick-takeaway-text">{faq.quickTakeaway}</span>
                        </div>
                      )}

                      {/* Key Parameter Badges Row */}
                      {faq.parameterBadges && faq.parameterBadges.length > 0 && (
                        <Stack gap="1-5">
                          <span className="faq-param-heading">
                            ⚙️ Key Input Parameters &amp; Filter Settings
                          </span>
                          <div className="faq-param-badges">
                            {faq.parameterBadges.map((badge, bIdx) => (
                              <div key={bIdx} className="faq-param-badge" title={badge.hint}>
                                <span className="faq-param-badge-label">{badge.label}:</span>
                                <span className="faq-param-badge-val">{badge.value}</span>
                              </div>
                            ))}
                          </div>
                        </Stack>
                      )}

                      {/* 3 Distinct Execution Methods */}
                      <div>
                        <h4 className="faq-methods-heading">
                          🚀 Multi-Method Execution Paths (3 Ways to Run)
                        </h4>
                        <div className="faq-methods-grid">
                          {faq.methods.map((method, mIdx) => (
                            <div key={mIdx} className="faq-method-card">
                              <div className="faq-method-header">
                                <span className="faq-method-title">{method.name}</span>
                                <span className={`workflow-tag-badge ${method.badgeColor}`}>{method.badge}</span>
                              </div>
                              <p className="faq-method-desc">{method.description}</p>
                              <ul className="faq-method-steps">
                                {method.actionSteps.map((step, sIdx) => (
                                  <li key={sIdx}>
                                    <span className="bullet">▸</span>
                                    <span>{step}</span>
                                  </li>
                                ))}
                              </ul>
                              {method.samplePayloadOrCommand && (
                                <div className="faq-method-code">
                                  {method.samplePayloadOrCommand}
                                </div>
                              )}
                              <div style={{ marginTop: "auto", paddingTop: "var(--space-2)", display: "flex", gap: "var(--space-1-5)" }}>
                                {method.targetTab && onNavigateTab && method.targetTab !== "chat" && (
                                  <Button
                                  variant="primary"
                                  size="sm"
                                    className="workflow-cta-btn"
                                    onClick={() => onNavigateTab(method.targetTab!)}
                                  >
                                    Open Tab →
                                  </Button>
                                )}
                                {onSendPrompt && (
                                  <Button
                                  variant="accent"
                                  tone="subtle"
                                  size="sm"
                                    className="workflow-cta-btn"
                                    onClick={() => onSendPrompt(method.samplePayloadOrCommand || faq.samplePrompt, faq.question)}
                                  >
                                    Ask Agent 💬
                                  </Button>
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Optimal Output Structure Callout */}
                      <div style={{ background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px", padding: "var(--space-3) var(--space-4)", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: "var(--space-3)" }}>
                        <div>
                          <div style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)", textTransform: "uppercase", letterSpacing: "0.05em", fontWeight: 700 }}>
                            🎯 Expected Visual Output Structure
                          </div>
                          <div style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-primary)", marginTop: "0.2rem" }}>
                            {faq.optimalOutputStructure}
                          </div>
                        </div>
                        {faq.relatedDecisionRuleId && (
                          <Button
                          variant="ghost"
                            className="workflow-rule-link"
                            onClick={() => jumpToDecisionRule(faq.relatedDecisionRuleId!)}
                          >
                            <span>⚖️</span> View Governing Decision Rule →
                          </Button>
                        )}
                      </div>

                      {/* Collapsible Theoretical & Mathematical Deep-Dive */}
                      <details className="faq-theory-accordion">
                        <summary className="faq-theory-summary">
                          <span>📐 Quantitative Theory &amp; Mathematical Formulation (Expand / Collapse)</span>
                          <span style={{ fontSize: "0.75rem", color: "var(--color-text-muted)" }}>▼</span>
                        </summary>
                        <div className="faq-theory-inner">
                          <div className="faq-theory-content">
                            {faq.theoreticalContext}
                          </div>
                          {faq.mathematicalBasis && (
                            <div className="faq-formula-badge">
                              Exact Formula: {faq.mathematicalBasis}
                            </div>
                          )}
                        </div>
                      </details>

                      {/* Action Footer */}
                      <div className="workflow-action-footer">
                        <Flex align="center" gap="3" wrap>
                          <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)" }}>Primary Workflow:</span>
                          <span className="workflow-tag-badge green">{faq.primaryWorkflow}</span>
                          <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)" }}>Secondary:</span>
                          <span className="workflow-tag-badge blue">{faq.secondaryWorkflow}</span>
                        </Flex>

                        <Flex gap="2">
                          <Button
                          variant="primary"
                            className="workflow-cta-btn"
                            onClick={() => {
                              if (onNavigateTab) {
                                onNavigateTab(faq.targetTab);
                              }
                            }}
                          >
                            Open in Platform →
                          </Button>

                          {onSendPrompt && (
                            <Button
                            variant="accent"
                            tone="subtle"
                              className="workflow-cta-btn"
                              onClick={() => {
                                onSendPrompt(faq.samplePrompt, faq.question);
                              }}
                              title="Ask AI Agent in chat"
                            >
                              Ask AI Agent 💬
                            </Button>
                          )}
                        </Flex>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Stack>
      )}

      {/* VIEW 2: PLATFORM WORKFLOWS (ALL 14 ANALYSIS & EXECUTION WORKFLOWS) */}
      {activeTab === "workflows" && (
        <Stack gap="5" role="tabpanel" id="workflows-panel-workflows" aria-labelledby="workflows-tab-workflows">
          {/* Operational process guides (#3464): taxonomy + index. */}
          <Card id="operational-process-guides">
            <Stack gap="3">
              <h3 className="workflow-title">Operational process guides</h3>
              <p className="workflow-subtitle">
                The taxonomy and index are the single entry point for operational processes — how each
                process is classified, who owns it, and where its guide lives. Future answers link
                here instead of re-explaining a process.
              </p>
              <Flex gap="4">
                <a
                  href="https://github.com/Qunsultant/cfagent/blob/main/docs/operations/process-index.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  Process index
                </a>
                <a
                  href="https://github.com/Qunsultant/cfagent/blob/main/docs/operations/process-taxonomy.md"
                  target="_blank"
                  rel="noreferrer"
                >
                  Taxonomy
                </a>
              </Flex>
            </Stack>
          </Card>
          {/* Track Filter Tabs */}
          <div className="workflow-track-tabs">
            <span style={{ fontSize: "var(--font-size-body-sm)", color: "var(--color-text-muted)", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", marginRight: "0.3rem" }}>
              Operational Track:
            </span>
            <PillGroup
              options={[
                { id: "all", label: "All Workflows (14)" },
                { id: "analysis", label: "📊 Analysis Track (A1–A8)" },
                { id: "execution", label: "⚡ Execution Track (E1–E6)" },
              ]}
              value={trackFilter}
              onChange={setTrackFilter}
            />
          </div>

          {/* Search & Category Filter Strip */}
          <div className="workflows-filter-strip">
            <div className="workflows-search-box">
              <span className="workflows-search-icon">🔍</span>
              <TextInput
                type="text"
                className="workflows-search-input"
                placeholder="Search workflows by code (A1..E6), name, APIs, endpoints, or parameters…"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
              />
            </div>

            <div className="workflows-category-chips">
                            <PillGroup
                size="sm"
                options={categories}
                value={selectedCategory}
                onChange={setSelectedCategory}
              />
            </div>
          </div>

          {/* Workflow Accordion List */}
          <div className="workflows-grid">
            {filteredWorkflows.map((wf) => {
              const isOpen = expandedId === wf.id;

              return (
                <div key={wf.id} className={`workflow-card ${isOpen ? "open" : ""}`}>
                  {/* Card Header (Click to toggle) */}
                  <div className="workflow-card-header" onClick={() => toggleExpand(wf.id)}>
                    <div className="workflow-header-left">
                      <div className={`workflow-code-badge ${wf.track}`}>
                        {wf.codeId}
                      </div>
                      <div className="workflow-header-titles">
                        <h3 className="workflow-title">
                          {wf.title}
                          <span className={`workflow-track-pill ${wf.track}`}>{wf.trackLabel}</span>
                          <span className={`workflow-tag-badge ${wf.badgeColor}`}>{wf.badge}</span>
                        </h3>
                        <p className="workflow-subtitle">{wf.subtitle}</p>
                      </div>
                    </div>

                    <div className="workflow-header-right">
                      <span className="workflow-expand-caret">{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  {/* Card Body (Expanded view) */}
                  {isOpen && (
                    <div className="workflow-card-body">
                      {/* Overview text */}
                      <p style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-secondary)", lineHeight: 1.5, margin: 0 }}>
                        {wf.overview}
                      </p>

                      {/* Key Parameters Banner */}
                      {wf.keyParameters && (
                        <div style={{ background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "6px", padding: "var(--space-2-5) var(--space-4)", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--space-2)" }}>
                          <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)" }}>
                            ⚙️ <strong style={{ color: "var(--color-accent)" }}>Primary Parameters:</strong> <code style={{ color: "var(--color-text-primary)" }}>{wf.keyParameters}</code>
                          </span>
                          {wf.governingDecisionRuleId && (
                            <Button
                            variant="ghost"
                              className="workflow-rule-link"
                              onClick={() => jumpToDecisionRule(wf.governingDecisionRuleId!)}
                            >
                              <span>⚖️</span> Governing Decision Rule →
                            </Button>
                          )}
                        </div>
                      )}

                      {/* Flowchart Timeline */}
                      <div>
                        <h4 style={{ fontSize: "var(--font-size-body-sm)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-accent)", margin: "0 0 0.75rem 0" }}>
                          ⚡ Step-by-Step Execution Pipeline
                        </h4>
                        <div className="workflow-timeline">
                          {wf.steps.map((step, idx) => (
                            <div key={idx} className="workflow-step-node">
                              <span className="workflow-step-num">{step.step}</span>
                              <span className="workflow-step-title">{step.title}</span>
                              <p className="workflow-step-desc">{step.description}</p>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Details Grid: Features & Data Sources */}
                      <div className="workflow-details-grid">
                        <div className="workflow-subpanel">
                          <h5 className="workflow-subpanel-title">
                            <span>✨</span> Architectural Highlights
                          </h5>
                          <ul className="workflow-feature-list">
                            {wf.keyFeatures.map((feat, idx) => (
                              <li key={idx}>
                                <span className="workflow-feature-bullet">▸</span>
                                <span>{feat}</span>
                              </li>
                            ))}
                          </ul>
                        </div>

                        <div className="workflow-subpanel">
                          <h5 className="workflow-subpanel-title">
                            <span>🌐</span> Upstream Sites &amp; APIs Queried
                          </h5>
                          <ul className="workflow-feature-list">
                            {wf.dataSources.map((ds, idx) => (
                              <li key={idx}>
                                <span className="workflow-feature-bullet">🔗</span>
                                <span>{ds}</span>
                              </li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      {/* Upstream APIs & Execution Metrics Breakdown */}
                      {wf.apiMetrics && wf.apiMetrics.length > 0 && (
                        <div className="workflow-api-metrics-panel" style={{ marginTop: "0.5rem", background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px", padding: "var(--space-4)" }}>
                          <h5 style={{ margin: "0 0 0.75rem", color: "var(--color-accent)", fontSize: "var(--font-size-body)", textTransform: "uppercase", letterSpacing: "0.05em", display: "flex", alignItems: "center", gap: "var(--space-2)" }}>
                            <span>📊</span> Upstream Subrequests &amp; Edge Execution Metrics
                          </h5>
                          <div style={{ overflowX: "auto" }}>
                                                        <Table
                              columns={[
                                { key: "host", header: "Host / Endpoint", render: (row) => (<span style={{ color: "var(--color-accent)", fontWeight: 600 }}>{row.host}</span>) },
                                { key: "2xx", header: "2xx", render: (row) => (<span style={{ color: "var(--color-success)", fontWeight: 600 }}>{row.status2xx}</span>) },
                                { key: "4xx", header: "4xx", render: (row) => (<span style={{ color: row.status4xx ? "var(--color-danger)" : "var(--color-text-muted)" }}>{row.status4xx}</span>) },
                                { key: "latency", header: "Latency", render: (row) => (<span style={{ color: "var(--color-text-secondary)" }}>{row.avgDuration}</span>) },
                                { key: "role", header: "Role & How It Is Used", render: (row) => (<><div style={{ fontWeight: 600, color: "var(--color-text-primary)", marginBottom: "0.2rem" }}>{row.role}</div><div style={{ color: "var(--color-text-muted)", fontSize: "var(--font-size-caption)", lineHeight: 1.4 }}>{row.usageDetails}</div><div style={{ color: "var(--color-warning)", fontSize: "var(--font-size-caption)", marginTop: "0.25rem", fontStyle: "italic" }}>💡 {row.nuanceExplanation}</div></>) },
                              ]}
                              rows={wf.apiMetrics.map((metric, mIdx) => ({ ...metric, __rowKey: `${metric.host}-${mIdx}` }))}
                              rowKey={(row) => row.__rowKey}
                            />
                          </div>
                        </div>
                      )}

                      {/* FAQ & Gotchas Callout Box */}
                      <div className="workflow-faq-box">
                        <div className="workflow-faq-question">💡 Key Nuance: {wf.faq.question}</div>
                        <p className="workflow-faq-answer">{wf.faq.answer}</p>
                      </div>

                      {/* Action Footer */}
                      <div className="workflow-action-footer">
                        <div className="workflow-api-path">
                          API: <code>{wf.apiEndpoint}</code>
                        </div>

                        <Flex gap="2">
                          <Button
                          variant="primary"
                            className="workflow-cta-btn"
                            onClick={() => {
                              if (onNavigateTab) {
                                onNavigateTab(wf.targetTab);
                              }
                            }}
                          >
                            Open in Platform →
                          </Button>

                          {onSendPrompt && (
                            <Button
                            variant="accent"
                            tone="subtle"
                              className="workflow-cta-btn"
                              onClick={() => {
                                onSendPrompt(wf.sampleQueryOrAction, wf.title);
                              }}
                              title="Send sample query to AI agent in chat"
                            >
                              Ask AI Agent 💬
                            </Button>
                          )}
                        </Flex>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {filteredWorkflows.length === 0 && (
              <div style={{ textAlign: "center", padding: "calc(var(--space-6) * 2) var(--space-4)", color: "var(--color-text-dim)" }}>
                <p style={{ fontSize: "var(--font-size-title)", margin: "0 0 0.5rem 0" }}>🔍 No workflows match your search query.</p>
                <p style={{ fontSize: "var(--font-size-body)", margin: 0 }}>Try clearing filters or search for terms like &quot;A1&quot;, &quot;E1&quot;, &quot;options&quot;, &quot;screener&quot;, &quot;hitl&quot;, or &quot;nasdaq&quot;.</p>
              </div>
            )}
          </div>
        </Stack>
      )}

      {/* VIEW 3: ALGORITHMIC DECISIONING RULES (6 ENGINES) */}
      {activeTab === "decisioning" && (
        <Stack gap="5" role="tabpanel" id="workflows-panel-decisioning" aria-labelledby="workflows-tab-decisioning">
          {/* Decisioning Hero Note */}
          <div style={{ background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "10px", padding: "var(--space-5) var(--space-6)" }}>
            <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-accent)", fontSize: "var(--font-size-title-sm)" }}>
              📐 Deterministic Decision Logic, Scoring Equations &amp; Selection Gates (6 Engines)
            </h4>
            <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)", lineHeight: 1.55 }}>
              Comprehensive documentation of the mathematical formulas, boundary constraints, sorting comparators, and automated safety gates powering the Stock Screener (A1), Options Screener (A3), Strategy Engine (A2), Recommendation Agent (<code>pickBestTrades</code>), and live Brokerage Handshake (E1).
            </p>
          </div>

          {/* Search Strip */}
          <div className="workflows-filter-strip">
            <div className="workflows-search-box">
              <span className="workflows-search-icon">🔍</span>
              <TextInput
                type="text"
                className="workflows-search-input"
                placeholder="Search decision rules, scoring weights, formulas, or rejection codes…"
                value={decisioningSearchQuery}
                onChange={(e) => setDecisioningSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {/* Decisioning Sections Grid */}
          <div className="workflows-grid">
            {filteredDecisioning.map((sec) => {
              const isOpen = expandedDecisioningId === sec.id;
              return (
                <div key={sec.id} className={`workflow-card ${isOpen ? "open" : ""}`}>
                  <div className="workflow-card-header" onClick={() => toggleExpandDecisioning(sec.id)}>
                    <div className="workflow-header-left">
                      <div className="workflow-number-badge">
                        0{sec.number}
                      </div>
                      <div className="workflow-header-titles">
                        <h3 className="workflow-title">
                          {sec.title}
                          <span className={`workflow-tag-badge ${sec.badgeColor}`}>{sec.badge}</span>
                          {sec.governedWorkflows && (
                            <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-accent)", background: "var(--color-accent-subtle)", padding: "var(--space-0-5) var(--space-2)", borderRadius: "4px" }}>
                              Governs: {sec.governedWorkflows.join(", ")}
                            </span>
                          )}
                        </h3>
                        <p className="workflow-subtitle">{sec.subtitle}</p>
                      </div>
                    </div>
                    <div className="workflow-header-right">
                      <span className="workflow-expand-caret">{isOpen ? "▲" : "▼"}</span>
                    </div>
                  </div>

                  {isOpen && (
                    <div className="workflow-card-body">
                      {/* Overview Box */}
                      <p style={{ fontSize: "var(--font-size-body)", color: "var(--color-text-secondary)", lineHeight: 1.55, margin: 0 }}>
                        {sec.overview}
                      </p>

                      {/* Rules Grid */}
                      <div>
                        <h4 style={{ fontSize: "var(--font-size-body-sm)", textTransform: "uppercase", letterSpacing: "0.05em", color: "var(--color-accent)", margin: "0 0 0.75rem 0" }}>
                          ⚙️ Mathematical Rules, Constraints &amp; Algorithmic Gates
                        </h4>
                        <div className="decisioning-rules-grid">
                          {sec.rules.map((rule, rIdx) => (
                            <div key={rIdx} className="decisioning-rule-card">
                              <div className="decisioning-rule-title">
                                <span>⚡</span> {rule.name}
                              </div>
                              <p className="decisioning-rule-desc">{rule.description}</p>
                              
                              {rule.formulaOrCode && (
                                <div className="decisioning-code-block">
                                  {rule.formulaOrCode}
                                </div>
                              )}

                              {rule.parametersOrGates && rule.parametersOrGates.length > 0 && (
                                <div className="decisioning-param-list">
                                  {rule.parametersOrGates.map((param, pIdx) => (
                                    <div key={pIdx} className="decisioning-param-item">
                                      <span style={{ color: "var(--color-accent)" }}>▸</span>
                                      <span>{param}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Matrix / Weights Table (if present) */}
                      {sec.matrixOrWeights && sec.matrixOrWeights.length > 0 && (
                        <div style={{ background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "8px", padding: "var(--space-4)" }}>
                          <h4 style={{ margin: "0 0 0.6rem", color: "var(--color-accent)", fontSize: "var(--font-size-body-sm)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
                            📊 Dimension Weightings &amp; Profile Matrix
                          </h4>
                          <div style={{ overflowX: "auto" }}>
                                                        <Table
                              columns={[
                                { key: "dimension", header: "Profile / Dimension", render: (row) => (<span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>{row.dimension}</span>) },
                                { key: "weight", header: "Weight Distribution / Formula", render: (row) => (<span style={{ color: "var(--color-accent)" }}>{row.weightOrValue}</span>) },
                                { key: "behavior", header: "Strategic Behavior & Tradeoff", render: (row) => (<span style={{ color: "var(--color-text-secondary)" }}>{row.details}</span>) },
                              ]}
                              rows={sec.matrixOrWeights.map((row, mIdx) => ({ ...row, __rowKey: `${row.dimension}-${mIdx}` }))}
                              rowKey={(row) => row.__rowKey}
                            />
                          </div>
                        </div>
                      )}

                      {/* Concrete Example Box */}
                      {sec.concreteExample && (
                        <div className="decisioning-example-box">
                          <div className="decisioning-example-header">
                            <span>🧪</span> Real Production Example: {sec.concreteExample.title}
                          </div>
                          <div className="decisioning-example-step">
                            <span className="label">📥 Input:</span>
                            <span className="val">{sec.concreteExample.input}</span>
                          </div>
                          <div className="decisioning-example-step">
                            <span className="label">⚙️ Engine:</span>
                            <span className="val">{sec.concreteExample.evaluation}</span>
                          </div>
                          <div className="decisioning-example-step">
                            <span className="label" style={{ color: "var(--color-success)" }}>🎯 Verdict:</span>
                            <span className="val" style={{ color: "var(--color-success)", fontWeight: 600 }}>{sec.concreteExample.verdict}</span>
                          </div>
                        </div>
                      )}

                      {/* Action Footer */}
                      <div className="workflow-action-footer">
                        <div className="workflow-api-path">
                          Architecture: <code>src/trading/options/ · src/client/options/</code>
                        </div>

                        <Flex gap="2">
                          {onSendPrompt && (
                            <Button
                            variant="accent"
                            tone="subtle"
                              className="workflow-cta-btn"
                              onClick={() => {
                                onSendPrompt(`Explain the decision logic and scoring for ${sec.title}`, sec.title);
                              }}
                            >
                              Ask AI Agent 💬
                            </Button>
                          )}
                        </Flex>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Stack>
      )}

      {/* VIEW 4: CAPABILITY & LOOKUP MATRIX */}
      {activeTab === "matrix" && (
        <Stack gap="5" role="tabpanel" id="workflows-panel-matrix" aria-labelledby="workflows-tab-matrix">
          {/* Matrix Header Callout */}
          <div style={{ background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "10px", padding: "var(--space-5) var(--space-6)" }}>
            <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-accent)", fontSize: "var(--font-size-title-sm)" }}>
              📊 Interactive Capability &amp; Lookup Matrix
            </h4>
            <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)", lineHeight: 1.55 }}>
              Quick architectural reference showing which platform workflow is best suited to answer each question, key input parameters, and ideal visual output structures. Click &quot;Try Now&quot; to jump directly into the target platform tab.
            </p>
          </div>

          {/* Matrix Search */}
          <div className="workflows-filter-strip">
            <div className="workflows-search-box">
              <span className="workflows-search-icon">🔍</span>
              <TextInput
                type="text"
                className="workflows-search-input"
                placeholder="Search capability matrix by question, workflow, or parameter…"
                value={matrixSearchQuery}
                onChange={(e) => setMatrixSearchQuery(e.target.value)}
              />
            </div>
          </div>

          {/* Matrix Table */}
          <div className="faq-matrix-container" style={{ marginTop: 0 }}>
            <div style={{ overflowX: "auto" }}>
                            <Table
                columns={[
                  { key: "question", header: "User Question / Scenario", render: (row) => (<span style={{ fontWeight: 600, color: "var(--color-text-primary)" }}>“{row.question}”</span>) },
                  { key: "primary", header: "Primary Workflow", render: (row) => (<span className="workflow-tag-badge green">{row.primaryWorkflow}</span>) },
                  { key: "secondary", header: "Secondary Workflow", render: (row) => (<span className="workflow-tag-badge blue">{row.secondaryWorkflow}</span>) },
                  { key: "param", header: "Key Input Parameter", render: (row) => (<span style={{ color: "var(--color-accent)", fontSize: "var(--font-size-caption)" }}>{row.keyInputParameter}</span>) },
                  { key: "output", header: "Optimal Output Structure", render: (row) => (<span style={{ color: "var(--color-text-secondary)" }}>{row.optimalOutputStructure}</span>) },
                  { key: "action", header: "Action", render: (row) => (<Button variant="primary" size="sm" className="workflow-cta-btn" onClick={() => { if (onNavigateTab) { onNavigateTab(row.targetTab); } }}>Try Now →</Button>) },
                ]}
                rows={filteredMatrix.map((row, rIdx) => ({ ...row, __rowKey: `${row.question}-${rIdx}` }))}
                rowKey={(row) => row.__rowKey}
              />
            </div>
          </div>
        </Stack>
      )}

      {/* VIEW 5: WORKFLOW IMPROVEMENTS & ARCHITECTURAL ROADMAP */}
      {activeTab === "improvements" && (
        <Stack gap="5" role="tabpanel" id="workflows-panel-improvements" aria-labelledby="workflows-tab-improvements">
          {/* Architectural Analysis Hero Note */}
          <div style={{ background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "10px", padding: "var(--space-5) var(--space-6)" }}>
            <h4 style={{ margin: "0 0 0.5rem", color: "var(--color-accent)", fontSize: "var(--font-size-title-sm)" }}>
              🏗️ Architectural Optimization Roadmap (Pure Analysis &amp; Design)
            </h4>
            <p style={{ margin: 0, color: "var(--color-text-secondary)", fontSize: "var(--font-size-body)", lineHeight: 1.55 }}>
              To elevate the platform from a single-symbol screener to an institutional-grade algorithmic execution system that answers complex multi-constraint questions optimally, the following 6 architectural enhancements have been formulated. These recommendations analyze cross-sectional batching, Pareto multi-objective optimization, declarative constraint solvers, and volatility surface modeling.
            </p>
          </div>

          {/* Styled Architecture Flowchart Diagram */}
          <div style={{ background: "var(--color-surface-sunken)", border: "1px solid var(--color-border-subtle)", borderRadius: "10px", padding: "var(--space-5)", display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
            <div style={{ fontSize: "var(--font-size-caption)", fontWeight: 700, color: "var(--color-accent)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              📐 System Optimization Flowchart
            </div>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: "var(--space-3)", padding: "var(--space-2) 0" }}>
              <div style={{ background: "var(--color-card)", padding: "var(--space-2-5) var(--space-4)", borderRadius: "8px", border: "1px solid var(--color-border-medium)", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-primary)" }}>
                1. Natural Language / Multi-Constraint Query
              </div>
              <span style={{ color: "var(--color-accent)", fontSize: "var(--font-size-title)" }}>➔</span>
              <div style={{ background: "var(--color-card)", padding: "var(--space-2-5) var(--space-4)", borderRadius: "8px", border: "1px solid var(--color-border-medium)", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-primary)" }}>
                2. Cross-Sectional Constraint Compiler
              </div>
              <span style={{ color: "var(--color-accent)", fontSize: "var(--font-size-title)" }}>➔</span>
              <div style={{ background: "var(--color-card)", padding: "var(--space-2-5) var(--space-4)", borderRadius: "8px", border: "1px solid var(--color-border-medium)", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-primary)" }}>
                3. High-Performance Pricing &amp; SVI Vol Engine
              </div>
              <span style={{ color: "var(--color-accent)", fontSize: "var(--font-size-title)" }}>➔</span>
              <div style={{ background: "var(--color-card)", padding: "var(--space-2-5) var(--space-4)", borderRadius: "8px", border: "1px solid var(--color-border-medium)", fontSize: "var(--font-size-body-sm)", color: "var(--color-text-primary)" }}>
                4. Multi-Objective Pareto Frontier Solver
              </div>
              <span style={{ color: "var(--color-accent)", fontSize: "var(--font-size-title)" }}>➔</span>
              <div style={{ background: "var(--color-accent-subtle)", padding: "var(--space-2-5) var(--space-4)", borderRadius: "8px", border: "1px solid var(--color-border-focus)", fontSize: "var(--font-size-body-sm)", color: "var(--color-accent)", fontWeight: 700 }}>
                5. Interactive 2D Payoff &amp; Order Staging
              </div>
            </div>
          </div>

          {/* The 6 Improvement Cards */}
          <Grid autoFit minColumnWidth="lg" gap="5">
            {WORKFLOW_IMPROVEMENTS.map((imp) => (
              <div key={imp.id} className="improvement-card">
                <div className="improvement-header">
                  <div className="improvement-title">
                    <span className="improvement-num">0{imp.number}</span>
                    <span>{imp.title}</span>
                  </div>
                </div>

                <div className="improvement-block">
                  <span className="improvement-block-label limitation">⚠️ Current System Limitation:</span>
                  <p className="improvement-block-desc">{imp.currentLimitation}</p>
                </div>

                <div className="improvement-block">
                  <span className="improvement-block-label enhancement">💡 Proposed Architectural Enhancement:</span>
                  <p className="improvement-block-desc">{imp.proposedEnhancement}</p>
                </div>

                <div className="improvement-block">
                  <span className="improvement-block-label impact">🚀 Expected Impact:</span>
                  <p className="improvement-block-desc" style={{ color: "var(--color-success)" }}>{imp.impact}</p>
                </div>

                <div style={{ marginTop: "0.35rem", display: "flex", gap: "var(--space-1-5)", flexWrap: "wrap", alignItems: "center" }}>
                  <span style={{ fontSize: "var(--font-size-caption)", color: "var(--color-text-muted)" }}>Target Components:</span>
                  {imp.targetComponents.map((comp, cIdx) => (
                    <span key={cIdx} style={{ fontSize: "var(--font-size-caption)", background: "var(--color-accent-subtle)", color: "var(--color-accent)", padding: "var(--space-0-5) var(--space-1-5)", borderRadius: "4px" }}>
                      {comp}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </Grid>
        </Stack>
      )}
    </PageShell>
    </div>
  );
}
