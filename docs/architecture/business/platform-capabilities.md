# Multi-Agent Studio — Comprehensive Platform Capabilities Architecture Specification

This document provides the exhaustive architectural specification for all **Research Capabilities**, **Discovery Capabilities**, **Reporting Capabilities**, **Algorithmic Platform Engines**, **Operational Workflows**, and the **Inter-System Relationship Topology** of the Multi-Agent Studio platform.

---

## 1. Research Capabilities

The platform's research architecture provides autonomous, multi-provider market data ingestion, quantitative financial modeling, rigorous falsification governance, and historical performance tracking across stocks, options, and cryptocurrencies.

### 1.1 Multi-Provider Market Data Research Fabric
- **Zero-Credential & Premium Ingestion**: Combines public, zero-credential data sources (Yahoo Finance, public Nasdaq feeds) with authenticated brokerage APIs (E*TRADE REST/OAuth 2.0, Alpaca Broker API) and Cloudflare Workers AI Search.
- **Provider Federation**: Unified abstraction layer (`MarketDataResearchService`, `ResearchProviders`) normalizes raw quotes, historical OHLCV chart bars (5-minute, hourly, daily), fundamental financial ratios (P/E, Forward P/E, PEG, EV/EBITDA, Debt-to-Equity), analyst target prices, and real-time options chains.
- **Data Provenance & Circuit Breakers**: Automatic fallback hierarchy (Nasdaq Screener API $\to$ Yahoo Finance $\to$ Curated Stock Universe offline safety net) with quote freshness classification (`FRESH`, `STALE`, `UNKNOWN`) and circuit breaker trip protection.

### 1.2 Autonomous Options Research Pipeline
- **Continuous Scan & Pipeline Execution**: Governed options research pipeline (`researchPipeline.ts`, `research-agent.ts`) that runs autonomously on scheduled ticks (`*/30`) or on-demand via NLQ chat and REST APIs.
- **Scenario Grids & Research Economics**: Evaluates trades across multi-variable scenario grids (underlying price targets $\pm 20\%$, implied volatility expansion/crush, DTE decay) priced strictly through the central research economics core (`researchEconomics.ts`).
- **Research Task Ledger**: Append-only task ledger (`researchTaskLedger.ts`) recording run states, sub-task heartbeats, error boundaries, and execution durations.

### 1.3 Research Falsification Gates & Quality Governance
- **Mandatory Falsification Criteria**: Every research candidate and recommendation must define explicit, measurable falsification triggers (e.g., "Invalidated if underlying breaches $115.00 before 14 DTE" or "Falsified if IV drops > 15% within 3 days").
- **Unqualified Status Enforcement**: Candidates lacking falsification criteria are automatically assigned an `Unqualified` status with confidence capped at `LOW`.
- **Falsification Monitor**: Continuous background verification against live feeds to flag broken thesis conditions in real time.

### 1.4 Research Track Record & Outcome Tracking
- **Append-Only Outcome Ledger**: Persists every approved recommendation and research run to expiry in `mas_outcomes` without data fabrication.
- **Honesty Contract**: Missing or unverified expiration outcomes are explicitly recorded as `Unverified` rather than assumed profitable or fabricated.
- **Evaluation Datasets**: Frozen out-of-sample benchmark datasets (`researchEvaluationDatasets.ts`) used to validate strategy enhancements, weights updates, and model prompt adjustments.

---

## 2. Discovery Capabilities

The discovery layer enables bidirectional opportunity hunting—answering both *"What options strategies fit this ticker/thesis?"* and *"Which tickers fit this options strategy across the market?"*—while supporting dynamic leg composition and strategy re-selection.

### 2.1 Server-Backed Strategy Discovery
- **Live Chain Evaluation**: Server-backed discovery (`serverDiscovery.ts` $\to$ `OptionsAgentPipeline`) evaluates live contract chains from the selected broker against the 72-strategy catalog.
- **Deterministic Ranking**: Filters and ranks strategy candidates deterministically using multivariate factor criteria rather than speculative client-side heuristic loops.
- **Interactive Modeling Engine**: Pure display layer in the UI connected to `strategyDiscoveryEngine.ts` for interactive leg edits, payoff matrix visualization, strike ladders, and Greeks sensitivity adjustments.

### 2.2 Bidirectional Research Discovery
- **Name-to-Strategy Scanning**: Ingests a ticker symbol and directional/volatility thesis, returning ranked catalog setups alongside dynamically composed multi-leg structures.
- **Strategy-to-Universe Scanning**: Ingests a target options strategy (e.g., "Find all liquid tickers fitting a 30-Delta Bull Put Spread with POP > 80%") and scans the broader equity universe for qualified underlying assets.
- **NLQ Integration**: Directly accessible via natural language prompts (e.g., *"Find me diagonal call spreads on NVDA"* or *"Which tech stocks support high-POP credit spreads?"*).

### 2.3 Strategy Composition Algebra
- **Leg-Graph Model**: Algorithmic composition engine (`strategyComposition.ts`) that overlays, combines, transforms, rolls, and repairs multi-leg options positions.
- **Novel Structure Generation**: Composes advanced custom structures not explicitly pre-defined in the catalog (e.g., combining a Condor with a Butterfly or converting a Debit Vertical into a Risk Reversal).
- **Defined-Risk Enforcement**: Default composition rules strictly require defined risk (capped losses) unless explicitly overridden by authorized margin policies.

### 2.4 Strategy Bank Re-Selection & Discovery Alerts
- **Nightly Re-Selection Loop**: Durable background job (`strategyBankReselection.ts`) running on nightly ticks to evaluate candidate proposals against historical market regimes.
- **Proposal-Only Guardrail**: All automatically discovered setup proposals are stored in `proposal_only_not_promoted` status; zero setups self-activate without human confirmation.
- **Discovery Alerts**: Pushes real-time alerts (`discoveryAlerts.ts`) across WebSocket and channel gateways when market opportunity scores exceed predefined thresholds ($\ge 80$).

---

## 3. Reporting Capabilities

The reporting architecture transforms complex quantitative research and screening runs into decision-grade, multi-format artifacts delivered seamlessly across user interfaces and external channels.

### 3.1 Unified Report Pipeline (Generate $\to$ Store $\to$ Serve $\to$ Deliver)
- **4-Stage Pipeline Lifecycle**: Standardized pipeline (`unifiedReportPipeline.ts`) that handles:
  1. **Generate**: Computes screening, options research, or strategy evaluations.
  2. **Store**: Persists binary report artifacts and structured JSON metadata.
  3. **Serve**: Exposes secure REST endpoints for downloading or streaming reports.
  4. **Deliver**: Dispatches reports to configured external channels (Slack, Email, Webhooks).

### 3.2 Multi-Format Artifact Generation
- **PDF Reports**: Executive PDF documents (`optionsReportPdf.ts`, `screenerReportPdf.ts`) generated via `report-asset-agent.ts` containing payoff charts, Greeks tables, scenario breakdowns, and risk disclosures.
- **XLSX Workbooks**: Quantitative Excel workbooks (`optionsReportXlsx.ts`, `screenerReportXlsx.ts`) with formulaic sheets for payoff matrices, contract chains, and factor rankings.
- **CSV Spreadsheets**: Lightweight raw CSV exports (`screenerReportCsv.ts`, `researchReportCsv.ts`) for developer integration and external analysis.

### 3.3 Recommendation Bundles & Decision Cards
- **Holistic Recommendation Format**: Every output is formatted as a decision-grade **Recommendation Bundle** (`recommendationBundle.ts`):
  - **Trade Ticket**: Exact multi-leg orders with limit prices and contracts.
  - **Falsification Criteria**: Explicit conditions under which the thesis is invalidated.
  - **Post-Trade Portfolio Risk**: Impact on total portfolio Delta, Gamma, Theta, Vega, and VaR.
  - **CVaR Optimizer Verdict**: Risk-adjusted score penalty based on tail risk.
  - **Defense & Repair Plans**: Pre-scripted tactical adjustments (Roll Out, Invert, Delta Hedge).
  - **Explicit No-Trade Option**: Evaluates no-trade as a first-class alternative when risk/reward is unfavorable.
- **Interactive UI Cards**: Rendered visually in the web client (`PortfolioRiskPanel`, `Chat`) and as Block Kit cards in Slack.

### 3.4 Report Storage, Blob Store & Semantic Indexing
- **Canonical Report Store**: Centralized record keeping in DO SQLite table `mas_reports` with binary payload storage in Cloudflare R2 / KV blob stores (`reportBlobStore.ts`).
- **Semantic Indexing**: Full-text and vector indexing of report content (`reportSemanticIndex.ts`) enabling RAG search over historical report summaries.

### 3.5 Omnichannel Delivery Gateway
- **Slack Gateway**: Uploads PDF/XLSX attachments, formats visual Block Kit messages, and processes interactive button callbacks.
- **Email Gateway**: Sends structured HTML email digests with attached `.xlsx` workbooks via Cloudflare Email bindings.
- **Signed External Webhooks**: Posts HMAC-SHA256 signed JSON payloads containing complete report objects to configured external endpoints (`OUTBOUND_WEBHOOK_URL`).
- **Voice Gateway**: Full-duplex WebSocket audio channel capable of dictating report summaries and taking verbal screening commands.

---

## 4. Algorithmic Platform Engines

The platform relies on 10 specialized algorithmic engines to execute classification, quantitative scoring, risk management, and settlement.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                             PLATFORM ENGINES (10)                                │
├───────────────────────────────┬──────────────────────────────────────────────────┤
│ 1. LLM Judge Router           │ Intent classification, routing & response eval   │
│ 2. Read-Only NLQ Engine       │ NLQ-to-SQLite translation & planner execution    │
│ 3. Multivariate Composite     │ 6-factor strategy scoring (0-100 score)          │
│ 4. Recommendation Kernel      │ CVaR optimization, trade sizing & bundle drafting│
│ 5. Black-Scholes Calibration  │ Greeks (Δ,Γ,Θ,Vega) & N(d2) POP calculation      │
│ 6. Goal & Scenario Engine     │ 9-goal taxonomy & grid-based price scenarioing   │
│ 7. Champion/Challenger v2     │ Out-of-sample gate & regime-conditioned weights  │
│ 8. Institutional Risk Engine  │ Position sizing, defense playbooks & stress test │
│ 9. RAG & Vector Memory Engine │ Vectorize embeddings & Durable SQLite fact vault │
│ 10. x402 Micropayment Engine  │ HTTP 402 micropayments ($0.05/query) & x402 keys │
└───────────────────────────────┴──────────────────────────────────────────────────┘
```

### 4.1 LLM Judge Router & Evaluator
- **Intent Classification**: Evaluates user prompts to route queries into 5 primary domains: `search`, `payments`, `tasks`, `memory`, or `general` (trading/screening).
- **Confidence Scoring & Safety**: Generates real-time confidence scores and evaluates LLM response safety, hallucination bounds, and output quality prior to rendering.

### 4.2 Read-Only Natural Language Query (NLQ) Engine
- **Planner & Executor**: Translates user natural language questions (`NLQPlanner`) into parameter-bound, safe SQLite queries (`NLQExecutor`).
- **Transcript Analytics**: Performs read-only analytics over conversation history (`mas_messages`), audit events (`mas_events`), and strategy execution records.

### 4.3 Multivariate 6-Factor Composite Scoring Engine
Evaluates options setups across 6 weighted factor criteria:
$$S_{\text{composite}} = 0.30 S_{\text{thesis}} + 0.20 S_{\text{RR}} + 0.20 S_{\text{liq}} + 0.15 S_{\text{fresh}} + 0.10 S_{\text{IV}} + 0.05 S_{\theta}$$
1. **Thesis Alignment (30%)**: Expected payoff at target price projection.
2. **Target Reward/Risk (20%)**: Payoff multiple relative to minimum threshold.
3. **Execution Liquidity (20%)**: Bid-ask spread percentage and contract volume/open interest depth.
4. **Quote Freshness (15%)**: Real-time tick latency (< 60s = 100, stale = 25).
5. **Volatility Alignment (10%)**: Directional Vega match against implied volatility rank/skew.
6. **Theta Decay Burden (5%)**: Net daily theta yield relative to total margin/collateral.

### 4.4 Recommendation Kernel & CVaR Optimizer
- **Conditional Value-at-Risk (CVaR)**: Applies tail-risk penalties (`cvarOptimizer.ts`) to penalize trades with extreme negative skew or fat-tail loss distributions.
- **Trade Sizing & Optimization**: Dynamically adjusts position sizing based on portfolio NAV (2–5% cap per setup) and net portfolio Greeks exposure.

### 4.5 Black-Scholes & Greeks Calibration Engine
- **Analytical Pricing & Greeks**: Computes theoretical option prices, Delta ($\Delta$), Gamma ($\Gamma$), Theta ($\Theta$), and Vega ($\text{Vega}$) using Black-Scholes formulations (`blackScholes.ts`).
- **Calibrated Probability of Profit**: Calculates exact model-implied probability of profit ($\text{POP} = N(d_2)$) over calibrated volatility chains (`calibratedOptionChains.ts`).

### 4.6 Goal & Scenario Engine
- **9-Goal Taxonomy**: Classifies trader objectives across 9 distinct goals (e.g., *Income Generation*, *Capital Preservation*, *Leveraged Upside*, *Tail Risk Hedging*, *Earnings Volatility Play*).
- **Scenario Grids**: Generates multi-variable price and volatility shock matrices priced strictly through `researchEconomics.ts`.

### 4.7 Champion/Challenger & Weights v2 Engine
- **Regime-Conditioned Weights**: Dynamically adjusts strategy factor weights (`strategyWeightsV2.ts`) based on market regime detection (Bull Volatile, Neutral Low-Vol, Bear Panic).
- **Out-of-Sample Gate**: Evaluates challenger models against frozen evaluation sets; requires both outperforming statistical threshold AND explicit human approval for promotion.

### 4.8 Institutional Risk Management & Defense Engine
- **Stress Test Scenarios**: Simulates market crash/squeeze scenarios (-20% to +20%) across individual positions and total portfolio accounts.
- **Defensive Playbook Rules**: Pre-scripted profit taking (50% max profit for credit spreads), stop loss (2x credit rule), and adjustment mechanics (Roll Out, Invert, Delta Hedge).

### 4.9 RAG & Vector Memory Engine
- **Vectorize Retrieval**: Uses Cloudflare Vectorize and Workers AI embeddings to perform semantic retrieval over knowledge corpora (`platformKnowledge.ts`).
- **Durable Key-Value Fact Vault**: SQLite-backed durable memory (`mas_memory`) persisted natively inside Durable Objects across user sessions.

### 4.10 x402 Micropayment & Settlement Engine
- **Pay-Per-Use Protocol**: Implements HTTP 402 (x402) micropayments ($0.05 USDC per query) for external MCP tools (`x402Verifier.ts`).
- **Cryptographic Proofs**: Issues verifiable cryptographic payment receipts and manages multi-processor payment drafts (Stripe, PayPal, x402 Wallets).

---

## 5. Operational Workflows

The platform operates **14 distinct workflows** divided into **8 Analysis Workflows (A1–A8)** and **6 Execution Workflows (E1–E6)**, supplemented by Cloudflare Workflows step-DAG orchestrations.

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                            OPERATIONAL WORKFLOWS (14)                            │
├────────────────────────────────────────┬─────────────────────────────────────────┤
│ ANALYSIS TRACK (A1-A8) [Read-Only]     │ EXECUTION TRACK (E1-E6) [Side-Effecting]│
│ • A1: Stock Screener & Equity Momentum │ • E1: E*TRADE Order Preview & HITL Exec │
│ • A2: Options Strategy & EV Scoring    │ • E2: Alpaca Equities & Crypto Execution│
│ • A3: Raw Options Contracts Screener   │ • E3: Autonomous Cron & Token Lifecycle │
│ • A4: Options Flow & Smart Money Track │ • E4: Omnichannel Gateway (Slack/Email) │
│ • A5: Visual Strategy Builder & Payoff │ • E5: Micropayments & x402 Settlement   │
│ • A6: Institutional Risk & Defense     │ • E6: Observability Audit Ledger        │
│ • A7: Zero-Credential Market Data Res. │                                         │
│ • A8: Conversational NLQ & RAG Chat    │                                         │
└────────────────────────────────────────┴─────────────────────────────────────────┘
```

### 5.1 Analysis Workflows (Read-Only)
- **A1: Multi-Exchange Stock Screener & Equity Momentum**: Screens 8,000+ US equities across NASDAQ, NYSE, and AMEX by price, market cap, RSI (14), and MACD momentum.
- **A2: Options Strategy Discovery & EV Scoring**: Evaluates the 72-strategy catalog against live option chains using Black-Scholes pricing and the 6-Factor composite model.
- **A3: Raw Options Contract Screener**: Direct contract-level filtering enforcing 15 rejection code gates (`SPREAD_TOO_WIDE`, `MIN_VOLUME_FAIL`, `OUTSIDE_DELTA_RANGE`, etc.).
- **A4: Real-Time Options Flow & Smart Money Tracking**: Tracks institutional sweeps ($\ge \$100\text{k}$), blocks, volume/OI surges ($>1.5\text{x}$), and bullish/bearish sentiment leaderboards.
- **A5: Visual Multi-Leg Strategy Builder & Expiration Payoff**: Constructs custom 1-to-4 leg setups with $T+0$ expiration payoff diagrams and breakeven calculations.
- **A6: Institutional Risk Management & Exposure**: Computes portfolio Greeks, multi-point stress tests, position sizing, and defensive adjustment rules.
- **A7: Zero-Credential Market Data Research**: Ingests fundamental ratios, analyst targets, and historical OHLCV chart bars without key requirements.
- **A8: Conversational Financial Intelligence & NLQ**: Transforms natural language queries into parameter-bound SQLite analytics queries with LLM Judge routing.

### 5.2 Execution Workflows (Side-Effecting & HITL Guarded)
- **E1: Brokerage Order Preview & HITL Execution (E*TRADE)**: Drafts preview tickets signed with W3C Decentralized Identifiers (`did:agent:openaimp:trading`); requires explicit human-in-the-loop confirmation before order routing.
- **E2: Direct Equities & Crypto Order Placement (Alpaca)**: Places limit, market, stop, and fractional orders via Alpaca Securities API.
- **E3: Autonomous Background Cron & Token Lifecycle**: Manages 24/7 background tasks via Durable Object Alarms (E*TRADE OAuth token renewal at 23:00 ET, 5-minute market scans, async job processing).
- **E4: Omnichannel Execution Gateway**: Processes Slack mention commands, email workbook requests, voice sessions, and HMAC-signed one-click approval links (`/trade/approve`).
- **E5: Agentic Micropayments & x402 Settlement**: Drafts payment intents and verifies $0.05 USDC x402 micropayment proofs for API consumers.
- **E6: Observability & Cryptographic Audit Ledger**: Records immutable audit events for all system routing, payment, and trade actions into DO SQLite WAL logs (`mas_events`).

### 5.3 Durable Workflow Step-DAGs & Stage-Layered Execution
- **Cloudflare Workflows Engine**: Native workflow step-DAGs (`screenerWorkflow.ts`, `paymentWorkflow.ts`) enforcing durable execution, retries, and state persistence across worker failures.
- **Stage-Layered Execution Pipelines**: Decouples job execution into isolated, schedulable stages (`stageChain.ts`):
  $$\text{Feed Snapshot} \longrightarrow \text{Generate Artifact} \longrightarrow \text{Store Blob} \longrightarrow \text{Serve REST} \longrightarrow \text{Deliver Channels}$$

---

## 6. Inter-System Relationship Topology

The relationship model below illustrates how Research, Discovery, Reporting, Engines, and Workflows interlock across the platform's data lifecycle.

```
─────────────────────────────────────────────────────────────────────────────────────────────────
                                     DATA INGESTION LAYER
  [External APIS: E*TRADE, Yahoo Finance, Alpaca, Nasdaq, Cloudflare Workers AI Search]
                                               │
                                               ▼
                                   RESEARCH CAPABILITIES (1)
             ┌─────────────────────────────────┴─────────────────────────────────┐
             │ Multi-Provider Market Data Fabric | Autonomous Research Pipeline  │
             │ Scenario Grids & Economics Core   | Falsification & Outcome Ledger│
             └─────────────────────────────────┬─────────────────────────────────┘
                                               │
───────────────────────────────────────────────┼─────────────────────────────────────────────────
                                               ▼
                                   DISCOVERY CAPABILITIES (2)
             ┌─────────────────────────────────┴─────────────────────────────────┐
             │ Server-Backed Options Discovery | Bidirectional Research Scanning │
             │ Strategy Composition Algebra    | Re-Selection & Discovery Alerts │
             └─────────────────────────────────┬─────────────────────────────────┘
                                               │
───────────────────────────────────────────────┼─────────────────────────────────────────────────
                                               ▼
                                    PLATFORM ENGINES (4)
 ┌─────────────────────────────────────────────┴──────────────────────────────────────────────┐
 │ • LLM Judge Router                      • Black-Scholes Calibration Engine                 │
 │ • Read-Only NLQ Engine                  • Goal & Scenario Engine                           │
 │ • Multivariate 6-Factor Composite Model • Champion/Challenger v2 Engine                    │
 │ • Recommendation Kernel & CVaR Opt.     • Institutional Risk & Defense Engine              │
 │ • RAG & Vector Memory Engine            • x402 Micropayment & Settlement Engine            │
 └─────────────────────────────────────────────┬──────────────────────────────────────────────┘
                                               │
───────────────────────────────────────────────┼─────────────────────────────────────────────────
                                               ▼
                                   OPERATIONAL WORKFLOWS (5)
 ┌─────────────────────────────────────────────┴──────────────────────────────────────────────┐
 │ Analysis Workflows (A1-A8)                  Execution Workflows (E1-E6)                   │
 │ [Stock/Options/Flows/Payoffs/NLQ]           [E*TRADE/Alpaca/Cron/x402/Audit]               │
 │                                             │                                              │
 │                                             ▼                                              │
 │                               ┌───────────────────────────┐                                │
 │                               │ MANDATORY HITL GUARDRAILS │                                │
 │                               │ • W3C DID Attestations    │                                │
 │                               │ • Two-Phase Commit Ticket │                                │
 │                               │ • Draft-Only Channels     │                                │
 │                               └─────────────┬─────────────┘                                │
 └─────────────────────────────────────────────┼──────────────────────────────────────────────┘
                                               │
───────────────────────────────────────────────┼─────────────────────────────────────────────────
                                               ▼
                                   REPORTING CAPABILITIES (3)
             ┌─────────────────────────────────┴─────────────────────────────────┐
             │ Unified Report Pipeline (Generate -> Store -> Serve -> Deliver)   │
             │ Multi-Format Artifacts (PDF, XLSX, CSV) | Recommendation Bundles │
             │ R2/KV Blob Store & Semantic Indexing    | Omnichannel Delivery    │
             └─────────────────────────────────┬─────────────────────────────────┘
                                               │
───────────────────────────────────────────────┼─────────────────────────────────────────────────
                                               ▼
                                   GOVERNED FEEDBACK LOOP
             ┌─────────────────────────────────┴─────────────────────────────────┐
             │ Expiry Outcome Tracking (mas_outcomes) -> Weights v2 Calibration  │
             │ Out-of-Sample Frozen Evaluation        -> Champion/Challenger Gate │
             └───────────────────────────────────────────────────────────────────┘
─────────────────────────────────────────────────────────────────────────────────────────────────
```

### 6.1 Lifecycle Summary & Control Flow
1. **Ingestion $\to$ Research**: Raw market data enters through the Multi-Provider Data Fabric into Research Capabilities, where scenario grids and falsification criteria are attached.
2. **Research $\to$ Discovery**: Research outputs feed Discovery Capabilities, which run bidirectional scans and apply composition algebra to form multi-leg candidates.
3. **Discovery $\to$ Engines**: Discovery setups pass through the 10 Platform Engines for Black-Scholes calibration, 6-factor composite scoring, CVaR tail-risk optimization, and goal classification.
4. **Engines $\to$ Workflows**: Workflows manage execution context—Analysis Workflows (A1–A8) handle read-only modeling while Execution Workflows (E1–E6) enforce W3C DID attestations, two-phase commits, and human-in-the-loop (HITL) approval gates.
5. **Workflows $\to$ Reporting**: Finalized setup packages enter the Unified Report Pipeline, generating PDF/XLSX/CSV artifacts and Recommendation Bundles stored in R2/KV and delivered across Slack, Email, Webhooks, and Voice.
6. **Reporting $\to$ Governed Feedback Loop**: Position outcomes are monitored to expiry in the append-only outcome ledger, feeding back into Weights v2 and Champion/Challenger evaluation gates to continuously improve future recommendations.
