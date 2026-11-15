# Enterprise Architectural Blueprint — Blueprint-01

**Status:** Approved Architectural Specification
**Document ID:** `docs/architecture/blueprint/blueprint-01.md`
**Authority:** Cloudflare Agent Platform Architecture Board
**Baseline Commit:** `e6d80a0` (main)

---

## 1. System Topology & Agent Infrastructure Map

The Cloudflare Agent Platform (`cfagent`) operates as a distributed system of edge Workers and single-instance Durable Objects (DOs). Each tenant isolated DO hosts state machines for coordination, research, screening, and ledger verification.

```
                     +-----------------------------------+
                     |      Cloudflare Worker / Router    |
                     |         (Edge Gateway/API)        |
                     +-----------------+-----------------+
                                       |
                   +-------------------+-------------------+
                   |                                       |
        +----------v----------+                 +----------v----------+
        |  OrchestratorAgent   |                 |  OptionsScannerMCP  |
        |  (Coordinator DO)   |                 |    (MCP Server)     |
        +----------+----------+                 +---------------------+
                   |
     +-------------+-------------+-----------------------+
     |                           |                       |
+----v-----------------+   +-----v-----------------+ +---v------------------+
|    ResearchAgent     |   |    ScreenerAgent      | |    PaymentsAgent     |
|   (Domain Sub-Agent) |   | (Deterministic DO)    | | (x402 Ledger DO)   |
+----------+-----------+   +-----------------------+ +----------------------+
           |
+----------v-----------+
|  ResearchTaskLedger  |
|  (DO SQLite Store)   |
+----------------------+
```

---

## 2. Core Components & Runtime Boundaries

### 2.1 Worker & Agent Class Inventory (`src/server.ts`)

| Export Name | Class Type | Primary Function | State & Persistence |
|---|---|---|---|
| `OrchestratorAgent` | `AIChatAgent` | Chat interface, task orchestration, plan decomposition | SQLite (`mas_messages`, `mas_memory`) |
| `ResearchAgent` | `ThinkAgent` | Autonomous options research & evaluation | SQLite (`research_task_store`, `research_reports`) |
| `ScreenerAgent` | `Agent` | Stock/options screening wrapper | In-memory / Scanner service bridge |
| `PaymentsAgent` | `Agent` | Payment ledger, x402 verification & spending caps | DO Storage (`payments_ledger`) |
| `SessionStore` | `DurableObject` | OAuth token cache & IAAA session lifecycle | DO Storage (`etrade:token:*`) |
| `OptionsScannerMCP` | `McpAgent` | MCP Server exposing financial screening capabilities | MCP JSON-RPC Standard |
| `BrowserAgent` | `AIChatAgent` | Browser channel integration adapter | Ephemeral isolate |
| `SlackAgent` | `AIChatAgent` | Slack event webhook adapter | Ephemeral isolate |
| `ScheduledAgent` | `Agent` | Autonomous cron trigger tick receiver | Scheduled alarm dispatch |

### 2.2 Client SPA page shell (S5, #1804)

The single-page client shares one page shell: the URL is the source of
truth for navigation, driven by a single route table
(`src/client/routes.ts`, 26 ids) from which nav items, breadcrumbs, and
the content switch are derived, and every left-nav page except `chat`
renders inside the `PageShell` primitive (title + scope note +
sections, with primitive loading/empty/error states). The trading pages
share one outlet shell in `ETradeTradingHub` whose title follows the
active page via the route table. The shell standard itself lives in
`docs/archive/design-system-01.md` (§2–§3); conformance is
pinned by `tests/shell_conformance_1804.json` (25 of 26 — `chat`
deferred by product decision, ADR-0021). Tab mechanisms are still two
(the `Tabs` primitive vs hub bespoke tablists); reconciling them into
one mechanism is S2, still open.

---

## 3. Communication Protocols & Dispatch Contracts

### 3.1 Delegated RPC Contract (Coordinator -> Delegate)

Delegation between `OrchestratorAgent` and `ResearchAgent` occurs via direct RPC calls over Durable Object bindings:

```typescript
export interface DelegateResearchTaskRequest {
  trigger: 'manual' | 'scheduled' | 'event';
  userLogin: string;
  previousRunId?: string;
  parameters?: Record<string, unknown>;
}

export interface DelegateResearchTaskResponse {
  taskId: string;
  runId: string;
  executionPath: 'think' | 'fallback';
  status: 'completed' | 'failed' | 'escalated';
  summary: string;
  ideasCount: number;
  rejectedCount: number;
}
```

### 3.2 Model Context Protocol (MCP) Integration

`OptionsScannerMCP` exposes standardized tools to external or internal agent runtimes:

* **`scan_options`**: Takes `ticker`, `minDTE`, `maxDTE`, `minDelta`, `maxDelta`; returns structured option chain candidates.
* **`get_screener_rules`**: Exposes active screening thresholds (`docs/architecture/business/current-state-rules.md`).

---

## 4. State Storage & Data Layer Specification

1. **DO SQLite Embedded Databases:**
   * `mas_messages`: Conversation turn history (retained per policy).
   * `mas_memory`: Durable user facts and preference vectors.
   * `research_task_store`: Task lifecycle states, transitions, heartbeats, and deterministic evaluation results.
   * `mas_reports`: Immutable options research reports indexed by `runId`.

2. **Cloudflare D1 Relational Schema:**
   * Global audit logging, system settings, cross-tenant telemetry aggregations.

3. **Cloudflare KV Session Store:**
   * High-speed key-value cache: `etrade:token:<ENV>:<userLogin>` with strict TTL expiration and rotation locks.

---

## 5. Security, Identity, & IAAA Blueprint

1. **Identity (I):** Derived Stable Identities (`usr_<sha256(sub)>`) bound to all worker requests and DO instantiations.
2. **Authentication (A):** OAuth 2.0 / PKCE flow with E*TRADE API using encrypted session storage in `SessionStore`.
3. **Authorization (A):** Scoped access controls where agents cannot perform payments or order executions without explicit human token authorization.
4. **Accountability (A):** Immutable audit trailing for every task transition in `research_task_store` and payment debit in `PaymentsAgent`.

---

## 6. Runtime Observability & Telemetry

* **Task Ledger Transitions:** Every step (`queued` -> `claimed` -> `running` -> `completed`/`failed`/`escalated`) emits structured JSON log events.
* **Execution Path Tagging:** Telemetry explicitly records whether a request completed via primary model inference (`think`) or deterministic `fallback`.
* **Health & Heartbeat Checks:** Active running tasks record `heartbeatAt` timestamps, enabling background observability of stalled tasks.
