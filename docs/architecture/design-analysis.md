> **Recovered report — written in PR #1828 (2026-10-26), recovered in #3461 (2026-11-06).**
>
> This analysis was reviewed in PR #1828 and never reached `main`. It is recovered here rather than
> re-written, with the verification recorded below.
>
> **Authority rule:** where this document and the code disagree, the code, the tests and the ADRs under
> [`adr/`](adr/) are current. This is a dated snapshot, not a specification.
>
> **Verified on recovery (2026-11-06):** every agent class named here exists on `main` except
> `SearchAgent` — corrected in place, because `src/agents/search.ts` no longer exists and search lives
> in `src/agents/aiSearchAgent.ts`. The Durable Object count is corrected to the classes actually bound
> in `wrangler.jsonc`.
# Full Design Analysis Report

## Executive Summary

This document presents a comprehensive design analysis of **cfagent** (NextGenTP / OpenAIMP), an enterprise multi-agent studio and financial options research assistant deployed on Cloudflare Workers and Durable Objects. The analysis covers the system topology, agent orchestrations, domain-driven design (DDD) patterns, storage partitioning, frontend design token architecture, cross-cutting Aspect-Oriented Programming (AOP) mechanisms, and omnichannel integration interfaces.

---

## 1. System Topology & Multi-Agent Architecture

### 1.1 Edge Runtime Topology
The application leverages Cloudflare Workers (`src/server.ts`) as a low-latency edge gateway connected to 18 Durable Object (DO) classes bound in `wrangler.jsonc` (counted 2026-11-06), executing with stateful isolation and embedded SQLite storage.

```
                     ┌─────────────────────────────────────────────────────────┐
                     │                 Cloudflare Edge Worker                  │
                     │  - Ingress Routing & Static Asset Bypass (/dist)        │
                     │  - CORS & Cross-Site WebSocket Hijacking (CSWSH) Gate   │
                     │  - Rate Limiting & HMAC Signature Verification          │
                     └────────────────────────────┬────────────────────────────┘
                                                  │
         ┌────────────────────────────────────────┼────────────────────────────────────────┐
         │                                        │                                        │
┌────────▼────────┐                      ┌────────▼────────┐                      ┌────────▼────────┐
│OrchestratorAgent│                      │   SearchAgent   │                      │  ScreenerAgent  │
│(Master DO)      │                      │(RAG Retrieval)  │                      │(E*TRADE Screen) │
│- Intent Router  │                      └─────────────────┘                      └─────────────────┘
│- LLM Judge      │                               │                                        │
│- Chat & NLQ     │                      ┌────────┴────────┐                      ┌────────┴────────┐
└────────┬────────┘                      │  TradingAgent   │                      │ ResearchAgent   │
         │                               │(Order Execution)│                      │(Options Pipeline│
┌────────┴────────┐                      └─────────────────┘                      └─────────────────┘
│ ScheduledAgent  │                               │                                        │
│(Autonomous Cron)│                      ┌────────┴────────┐                      ┌────────┴────────┐
└─────────────────┘                      │ PaymentsAgent   │                      │ReportAssetAgent │
                                         │(x402 Micropay)  │                      │(PDF Generation) │
                                         └─────────────────┘                      └─────────────────┘
```

### 1.2 Specialized Sub-Agent Classes
1. **OrchestratorAgent (`src/agents/orchestrator.ts`)**: Master DO co-ordinating session state, chat history (`mas_messages`), event logs (`mas_events`), and tool routing.
2. **AiSearchAgent (`src/agents/aiSearchAgent.ts`)**: RAG retrieval agent integrating Cloudflare AI Search with hybrid graph context expansion over D1. The `SEARCH_AGENT` binding resolves to `OrchestratorAgent`, not to a separate `SearchAgent` class.
3. **ScheduledAgent (`src/agents/scheduled-agent.ts`)**: Autonomous cron engine executing goal ticks, weekly reflection passes, and strategy adjustments.
4. **ScreenerAgent (`src/agents/screener-agent.ts`)**: Single-tenant screening DO. Equity and options scans now compose on the selected broker's chains (`platformChainSource`, #3272/#3388) rather than being E*TRADE-only.
5. **ResearchAgent (`src/agents/research-agent.ts`)**: Multiphase options research pipeline (FEAT-101 through FEAT-107) producing strategy cards and track-record evaluations.
6. **TradingAgent (`src/agents/trading-agent.ts`)**: Provider-neutral trading execution engine managing preview, preview-then-approve HITL states, and order status.
7. **PaymentsAgent (`src/agents/payments-agent.ts`)**: Ledger DO managing x402 payment intents, budget guards, and micropayment claims.
8. **ReportAssetAgent (`src/agents/report-asset-agent.ts`)**: Report compilation DO storing PDF metadata pointers and offloading binary blobs to Cloudflare R2.
9. **SessionStore (`src/security/sessionStore.ts`)**: High-throughput DO key-value store replacing Cloudflare KV for session tokens and E*TRADE OAuth credentials.
10. **OptionsScannerMCP (`src/services/cloudflareWalletsScanner.ts`)**: Pay-per-use Model Context Protocol (MCP) tool DO accepting x402 $0.05 USDC payments via Cloudflare Wallets.

---

## 2. Domain-Driven Design & State Partitioning

### 2.1 Authoritative vs. Projection Storage Tiering
The storage architecture strictly separates **authoritative execution state** from **query projections**:

| Storage Layer | Binding | Primary Domain Purpose | Scalability & Latency Characteristics |
|---|---|---|---|
| **Durable Object SQLite** | Internal DO Storage | Authoritative execution state (messages, active orders, user memory, goal states) | Single-thread consistency per DO instance; zero network hop to DO memory; unlimited write transactions |
| **Cloudflare D1 (AgentDB)** | `AGENT_DB` | Shared cross-agent query projections (Audit logs, chain status, report catalog, telemetry decisions) | Distributed relational query layer over SQLite; optimized for multi-agent analytical reads |
| **Cloudflare R2** | `REPORTS_BUCKET` | Binary report artifacts (generated `.pdf` and `.xlsx` research workbooks) | Object storage; offloads large binary blobs from DO memory limits |
| **Cloudflare Vectorize** | `VECTOR_MEMORY` | Semantic vector memory index (`vector-memory`) | 1536-dim embedding index for long-term similarity search |
| **Durable Object SessionStore** | `SESSION_STORE` | User sessions and E*TRADE OAuth tokens | Eliminates Cloudflare KV daily write quotas and eventual consistency lag |

---

## 3. Aspect-Oriented Programming (AOP) & Cross-Cutting Concerns

Cross-cutting concerns across the 655 TypeScript source files are managed via aspect wrappers (`src/aspects/`, `src/breakers/`, `src/telemetry/`):

1. **Circuit Breakers (`src/breakers/`)**: External service calls (Yahoo Finance, Alpaca, E*TRADE) wrap in circuit breakers that trip on consecutive failures and serve fallback data gracefully without unhandled exceptions.
2. **Telemetry & Calibration (`src/telemetry/`)**: Captures 5-dimensional decision metrics (prompt, actor, thesis, model, latency) projected to AgentDB.
3. **Structured Audit Logging (`src/data/auditReportRoute.ts`)**: Every state-changing operation records immutable audit events in DO SQLite and D1 `mas_audit_history`.
4. **Resilience & Retry Interceptors**: Retries external network requests with exponential backoff and jitter (`src/trading/options/flows/newsSentiment.ts`).

---

## 4. Frontend Design System & Token Architecture

### 4.1 3-Layer Semantic Token Pipeline
The user interface (`src/client/`) adheres strictly to `DESIGN.md` guidelines, enforcing a 3-layer token system generated via `scripts/gen-design-tokens.mjs`:

```
Layer 1: Primitives (Fixed values: typography, spacing, radii)
   │
   ▼
Layer 2: Semantic Tokens (Theme-dependent roles: --color-surface, --color-card, --color-primary)
   │
   ▼
Layer 3: Utility Classes & Primitives (src/client/components/ui/: Button, Modal, Card, Table)
```

### 4.2 Frontend Architecture Highlights
- **React 19 + Vite**: Modern functional component architecture with fast HMR and optimized chunking.
- **Glassmorphic Surface Design**: Subdued surface colors (`--color-surface`, `--color-card`) with subtle borders and crisp typography complying with WCAG 2.1 AA (minimum 4.5:1 contrast).
- **Zero-FOUC Pre-Hydration**: Blocking inline head script evaluates saved theme (`dark`, `light`, `system`) and density (`compact`, `comfortable`) preferences prior to rendering.
- **Composable UI Primitives**: 13 reusable UI components in `src/client/components/ui/` verified by inventory tests (`tests/ui_primitives_inventory.test.ts`).

---

## 5. API Patterns & Omnichannel Interfaces

### 5.1 Protocol Support Matrix
```
                             ┌──────────────────────────────┐
                             │    Inbound Omnichannel       │
                             └──────────────┬───────────────┘
                                            │
       ┌──────────────────┬─────────────────┼──────────────────┬──────────────────┐
       │                  │                 │                  │                  │
┌──────▼──────┐    ┌──────▼──────┐   ┌──────▼──────┐    ┌──────▼──────┐    ┌──────▼──────┐
│  REST APIs  │    │ WebSockets  │   │ Slack Bot   │    │ Voice Agent │    │  MCP Server │
│(/api/...,   │    │(Chat & Quote│   │(/slack/...) │    │(/voice/...) │    │(/mcp, JSON- │
│ /auth/...)  │    │ Streams)    │   └─────────────┘    └─────────────┘    │ RPC 2.0)    │
└─────────────┘    └─────────────┘                                         └─────────────┘
```

- **REST APIs**: Standard HTTP API endpoints for session management, options screening, memory queries, and telemetry.
- **Streaming WebSockets**: Streaming transport for real-time orchestrator responses and tick-by-tick quote feeds.
- **Slack Agent (`src/agents/slackAgent.ts`)**: Interactive cards, slash commands (`/trade`, `/screen`), and DM approval flows.
- **Voice Agent (`src/trading/voice/`)**: Real-time voice turn processor over WebSockets with speech-to-text pipeline forwarding.
- **Inbound/Outbound Email (`src/trading/email/`)**: Worker email handler parsing incoming orders and dispatching signed report summaries.
- **MCP Protocol (`src/mcp/`)**: JSON-RPC 2.0 transport over HTTP Bearer auth supporting programmatic LLM client integration.

---

## 6. Architectural Evaluation & Recommendations

### Strengths
- **Decoupled Edge Compute**: Cloudflare Workers + Durable Objects deliver globally distributed, sub-50ms execution with localized state persistence.
- **Resilient Multi-Store Architecture**: Authoritative state in DO SQLite + analytical projections in D1 prevents database lock contention.
- **Strict Design System**: Tokenized styling prevents dark islands and ensures consistent UX accessibility.

### Design Recommendations
1. **Formalize Event-Driven Queue Consumers**: Complete the dead-letter queue (DLQ) wiring for `screener-events` producers to ensure no job messages are dropped during transient downstream failures.
2. **Frontend Chunk Splitting**: Further modularize large vendor chunks (e.g. `xlsx-BGhuli8m.js` 500 KB and `index-CKrPdUx9.js` 2.6 MB) via dynamic `import()` boundaries for heavier tabs (e.g. Research reports, Options Flows).
