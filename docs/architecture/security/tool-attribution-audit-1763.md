# Tool-attribution audit (#1763, parent #1717)

Parent program: #1717. Slice issue: #1763. Scan rows: F-26
(`/mcp/scanner` intentionally unauthenticated — x402 payment is the
gate, so abuse analysis starts from payment records; any tool whose
calls cannot be attributed to a session/key is a gap, not an
acceptable default), F-25 (A2A invocation auth, verified separately
in this slice — see `docs/architecture/security/mcp-security.md` §4
and `tests/a2a_entrypoint_auth_1763.test.ts`).

## Method and scope

- Inventory source: `src/permissions/mcpPermissionPorts.ts`
  `MCP_TOOL_SCOPES` (82 tools: 73 canonical + 9 deprecated #1906
  aliases, completeness-pinned against the live
  factory registry in both directions by #1843's tests) plus the
  scanner surface (`src/services/cloudflareWalletsScanner.ts`) and
  the A2A trading operations (`src/agents/trading-agent.ts`
  `TRADING_SERVICE_REGISTRY`, surfaced on agent cards).
- "Attributable" in this audit means: at call time, the caller
  identity is resolved from a verified credential (session login or
  API-key owner login) or from a payment record, AND that identity
  is available to the gate/audit path. It does NOT mean "a uniform
  per-call audit row exists" — that distinction is gap G-AUD-1 below.
- Every tool below is either attributable or NAMED as a gap. Nothing
  is defaulted acceptable.
- Consumed, not rebuilt: #1843 (merged, PR #1843) provides the scope
  gate and the principal vocabulary (`system`, `session`, `api-key`,
  `agent-turn` hold all scopes by default; `scanner-payment` holds
  only `mcp:payments`; `unknown` holds nothing and is always
  denied). This audit consumes those principals and scopes; it does
  not re-declare scopes or change #1843's defaults.

## Attribution paths (the three call doors)

1. **`/mcp` JSON-RPC / REST bridge / queued path.** Worker edge
   (`src/server.ts` `/mcp` + `/api/mcp` branch) requires an app
   session OR a valid API key (401 otherwise, before any DO
   access), resolves `userLogin` (session's `githubLogin`, or the
   key owner's login via `verifyApiKey`), addresses the caller's
   own `SEARCH_AGENT` DO instance by that login, and forwards
   `x-user-login` + `x-principal-kind` (`session` | `api-key`).
   The gate resolves the principal from those headers
   (`resolveMcpPrincipalFromHeaders`); a missing login resolves to
   `unknown` and is denied, never defaulted to `system`. Result:
   **login-attributable** for every tool called through this door.
   Denials are audited as `mcp.permission_denied` with the login.
2. **Agent-turn path.** `McpAgentToolAdapter` gates model-driven
   calls, but the orchestrator turn hardcodes the principal as
   `{ kind: "agent-turn", login: null }`
   (`src/agents/orchestrator/chatTurnHelpers.ts`); the instance
   boundary is the identity boundary (the turn runs inside the
   owner's own agent instance). Result: **instance-attributable
   only** — see gap G-AUD-2.
3. **System path (in-process platform callers).** REST bridge and
   job executor call with the `system` principal (login null).
   Result: **route-attributable only** — the route layer that
   authenticated the request is the identity, not the tool call
   itself. See gap G-AUD-3.

## The 82 factory tools — verdict per tool

Verdict key: **L** = login-attributable via door 1 (session /
API-key); **I** = instance-attributable only via door 2 (gap
G-AUD-2 applies); **R** = route-attributable only via door 3 (gap
G-AUD-3 applies). A tool reachable through several doors carries
the verdict of the door used; the table lists the strongest
attribution available (door 1) and the gaps that apply on the
other doors. Scope column is #1843's declaration, consumed here.

### mcp:read (40)

| Tool | Scope | /mcp verdict |
|---|---|---|
| `knowledge_search` | mcp:read | L (I / R on other doors) |
| `query_platform_knowledge` | mcp:read | L (I / R on other doors) |
| `get_async_job` | mcp:read | L (I / R on other doors) |
| `list_async_jobs` | mcp:read | L (I / R on other doors) |
| `etrade_get_quote` | mcp:read | L (I / R on other doors) |
| `etrade_get_positions` | mcp:read | L (I / R on other doors) |
| `etrade_auth_status` | mcp:read | L (I / R on other doors) |
| `etrade_account_discovery` | mcp:read | L (I / R on other doors) |
| `etrade_market_scan` | mcp:read | L (I / R on other doors) |
| `market_data_get_quote` | mcp:read | L (I / R on other doors) |
| `foss_get_quote` (deprecated #1906 alias of `market_data_get_quote`, same scope) | mcp:read | L (I / R on other doors) |
| `market_data_company_fundamentals` | mcp:read | L (I / R on other doors) |
| `foss_company_fundamentals` (deprecated #1906 alias of `market_data_company_fundamentals`, same scope) | mcp:read | L (I / R on other doors) |
| `market_data_historical_bars` | mcp:read | L (I / R on other doors) |
| `foss_historical_bars` (deprecated #1906 alias of `market_data_historical_bars`, same scope) | mcp:read | L (I / R on other doors) |
| `market_data_research` | mcp:read | L (I / R on other doors) |
| `foss_market_research` (deprecated #1906 alias of `market_data_research`, same scope) | mcp:read | L (I / R on other doors) |
| `alpaca_snapshot` | mcp:read | L (I / R on other doors) |
| `foss_alpaca_snapshot` (deprecated #1906 alias of `alpaca_snapshot`, same scope) | mcp:read | L (I / R on other doors) |
| `alpaca_account` | mcp:read | L (I / R on other doors) |
| `foss_alpaca_account` (deprecated #1906 alias of `alpaca_account`, same scope) | mcp:read | L (I / R on other doors) |
| `alpaca_positions` | mcp:read | L (I / R on other doors) |
| `foss_alpaca_positions` (deprecated #1906 alias of `alpaca_positions`, same scope) | mcp:read | L (I / R on other doors) |
| `alpaca_orders` | mcp:read | L (I / R on other doors) |
| `foss_alpaca_orders` (deprecated #1906 alias of `alpaca_orders`, same scope) | mcp:read | L (I / R on other doors) |
| `browser_inspect_page` | mcp:read | L (I / R on other doors) |
| `ai_search_financial_docs` | mcp:read | L (I / R on other doors) |
| `ai_search_agent_search` | mcp:read | L (I / R on other doors) |
| `agentdb.chain.status` | mcp:read | L (I / R on other doors) |
| `agentdb.jobs.history` | mcp:read | L (I / R on other doors) |
| `agentdb.audit.history` | mcp:read | L (I / R on other doors) |
| `agentdb.reports.list` | mcp:read | L (I / R on other doors) |
| `agentdb.trace.get` | mcp:read | L (I / R on other doors) — the #2428 mesh-trace read surface: assembles one trace's recorded hops; the tenant is IAAA-resolved, never an argument, and hops under another tenant are excluded |
| `list_scheduled_goals` | mcp:read | L via door 2 only — acting identity required (#2341); refused on doors 1/3 (no acting-identity carrier there) |
| `get_trading_accounts` | mcp:read | L via door 2 only — acting identity required (#2349); refused on doors 1/3 (no acting-identity carrier there) |
| `get_trading_positions` | mcp:read | L via door 2 only — acting identity required (#2349); refused on doors 1/3 (no acting-identity carrier there) |
| `get_trading_quote` | mcp:read | L via door 2 only — acting identity required (#2349); refused on doors 1/3 (no acting-identity carrier there) |
| `list_report_assets` | mcp:read | L via door 2 only — acting identity required (#2349); refused on doors 1/3 (no acting-identity carrier there) |
| `get_report_asset` | mcp:read | L via door 2 only — acting identity required (#2349); refused on doors 1/3 (no acting-identity carrier there) |
| `browser_scrape_tables` | mcp:read | L via door 2 only — acting identity required (#2351); refused on doors 1/3 (no acting-identity carrier there) |
| `get_trade_approval_status` | mcp:read | L via door 2 only — acting identity required (#2375); refused on doors 1/3 (no acting-identity carrier there). Read-only: the TradingTradeWorkflow binding's own status surface |

### mcp:write (11)

| Tool | Scope | /mcp verdict |
|---|---|---|
| `manage_categories` | mcp:write | L (I / R on other doors) |
| `manage_referrals` | mcp:write | L (I / R on other doors) |
| `manage_external_ads` | mcp:write | L (I / R on other doors) |
| `manage_session_memory` | mcp:write | L (I / R on other doors) |
| `goal.compile` | mcp:write | L (I / R on other doors) |
| `goal.schedule` | mcp:write | L (I / R on other doors) |
| `trigger_scheduled_goal` | mcp:write | L via door 2 only — acting identity required (#2341); refused on doors 1/3 (no acting-identity carrier there) |
| `browser_snap_transaction` | mcp:write | L via door 2 only — acting identity required (#2351); refused on doors 1/3 (no acting-identity carrier there) |
| `browser_capture_page` | mcp:write | L via door 2 only — acting identity required (#2351); refused on doors 1/3 (no acting-identity carrier there) |
| `slack_dispatch_transaction_snap` | mcp:write | L via door 2 only — acting identity required (#2351); refused on doors 1/3 (no acting-identity carrier there) |
| `run_stock_screen` | mcp:write | L via door 2 only — acting identity required (#2488); refused on doors 1/3 (no acting-identity carrier there) |
| `run_options_strategy_screen` | mcp:write | L via door 2 only — acting identity required (#2581); refused on doors 1/3 (no acting-identity carrier there) |

### mcp:execute (7)

| Tool | Scope | /mcp verdict |
|---|---|---|
| `execute_nlq` | mcp:execute | L (I / R on other doors) |
| `chain.run` | mcp:execute | L (I / R on other doors) |
| `run_sandbox_command` | mcp:execute | L (I / R on other doors) |
| `run_quant_backtest` | mcp:execute | L (I / R on other doors) |
| `dispatch_trading_webhook` | mcp:execute | L (I / R on other doors) |
| `think_trade_validation` | mcp:execute | L (I / R on other doors) |
| `browser_screenshot` | mcp:execute | L (I / R on other doors) |

### mcp:payments (9)

| Tool | Scope | /mcp verdict |
|---|---|---|
| `draft_payment` | mcp:payments | L (I / R on other doors) |
| `confirm_payment_draft` | mcp:payments | L (I / R on other doors) |
| `get_transactions` | mcp:payments | L (I / R on other doors) |
| `get_payment_gateways` | mcp:payments | L (I / R on other doors) |
| `paid_options_screener` | mcp:payments | L (I / R on other doors) |
| `paid_market_research` | mcp:payments | L (I / R on other doors) |
| `agentic_wallet_status` | mcp:payments | L (I / R on other doors) |
| `check_payment_budget` | mcp:payments | L via door 2 only — acting identity required (#2341); refused on doors 1/3 (no acting-identity carrier there) |
| `get_payments_overview` | mcp:payments | L via door 2 only — acting identity required (#2341); refused on doors 1/3 (no acting-identity carrier there) |

### mcp:trade (10)

| Tool | Scope | /mcp verdict |
|---|---|---|
| `etrade_preview_order` | mcp:trade | L (I / R on other doors) |
| `etrade_execute_order` | mcp:trade | L (I / R on other doors) |
| `alpaca_place_order` | mcp:trade | L (I / R on other doors) |
| `foss_alpaca_place_order` (deprecated #1906 alias of `alpaca_place_order`, same scope) | mcp:trade | L (I / R on other doors) |
| `execute_durable_twap` | mcp:trade | L (I / R on other doors) |
| `propose_stock_trade` | mcp:trade | L via door 2 only — acting identity required (#2349); refused on doors 1/3 (no acting-identity carrier there). Preview only: the result is a pending-approval proposal; no order is placed |
| `propose_options_trade` | mcp:trade | L via door 2 only — acting identity required (#2349); refused on doors 1/3 (no acting-identity carrier there). Preview only: the result is a pending-approval proposal; no order is placed |
| `slack_send_pre_trade_approval` | mcp:trade | L via door 2 only — acting identity required (#2351); refused on doors 1/3 (no acting-identity carrier there). Ticket only: posts the HITL approval gate card; it approves and executes nothing |
| `start_trade_approval` | mcp:trade | L via door 2 only — acting identity required (#2375); refused on doors 1/3 (no acting-identity carrier there). Submission only: starts the TradingTradeWorkflow approval run for an existing proposal; places nothing without an approved decision |
| `decide_trade_approval` | mcp:trade | L via door 2 only — acting identity required (#2375); refused on doors 1/3 (no acting-identity carrier there). The authorizer DID is derived server-side from the acting identity; an approved decision is what authorizes the run's settle |

### mcp:admin (4)

| Tool | Scope | /mcp verdict |
|---|---|---|
| `get_audit_events` | mcp:admin | L (I / R on other doors) |
| `list_database_tables` | mcp:admin | L (I / R on other doors) |
| `query_table_data` | mcp:admin | L (I / R on other doors) |
| `get_revenue_summary` | mcp:admin | L (I / R on other doors) |

Note on the sensitive tools: `etrade_execute_order`,
`alpaca_place_order` (and its deprecated #1906 alias
`foss_alpaca_place_order`), and `execute_durable_twap` are
additionally HITL-gated at the execution layer (approval workflow);
the scope gate and HITL compose — neither replaces the other. Their
attribution verdict is the same L as above; HITL approval records
carry their own approver attribution.

## Scanner surface — intentionally unauthenticated, by design

`/mcp/scanner` is intentionally unauthenticated (see
`mcp-security.md` §3). Its access control is the x402 payment
mechanism, not identity. This audit records that design explicitly
and does NOT "fix" it by adding auth — adding identity auth would
break the paid public scanner's design, and the task for this slice
forbids it.

| Scanner tool | Gate | Attribution |
|---|---|---|
| `screen_options` | x402 paid tool ($0.05 USDC per call, Cloudflare Wallets) | Payment-record-attributable: the payer wallet / payment signature is the identity for abuse analysis. No session/key identity exists, by design. |
| `scanner_status` | Free (no payment required) | NOT attributable to a person/session/key. Attributable only to the scanner-session affinity value (`x-scanner-session`, self-asserted, not identity) and the shared/default `public_scanner` instance. Read-only status; see gap G-AUD-4. |
| `get_scan_job` | Free, requires the jobId returned by `screen_options` | JobId-holder-attributable only: possession of the UUID jobId is the capability, not an identity. A paid job's payer is recoverable from the payment record for that job. |
| `list_scan_jobs` | Free | Affinity-attributable only (same as `scanner_status`). See gap G-AUD-5 for the shared-instance consequence. |

## A2A trading operations — fleet-attributable, not per-caller

The A2A edge (`POST /a2a/*`) authenticates with a single shared
`A2A_API_TOKEN` bearer token (timing-safe, fail-closed 503 when
unset, 401 before agent resolution — verified from the entrypoint
in this slice). That token identifies the fleet/host caller, not a
user. Inside the TradingAgent DO, the instance name
(`trading` / `trading:<login>`) gives per-instance attribution for
execution, but a `userLogin` arriving in the A2A body is untrusted
input, not a verified identity. Operations
`trading.screen_stocks`, `trading.screen_options`,
`trading.trade_stock`, `trading.trade_options` are therefore
**fleet-attributable (shared token) + instance-attributable**,
not per-caller-attributable. See gap G-AUD-6. Per-caller A2A
identity is IAAA work (#945), not rebuilt here.

## Named gaps (not silent, not defaulted acceptable)

- **G-AUD-1 — No uniform allowed-call audit row.** The factory
  gate audits denials (`mcp.permission_denied`, with login) and
  streams denial events, but an ALLOWED tool call emits no uniform
  "tool X called by Y" audit event. Allowed-call attribution
  therefore relies on the DO instance name plus each tool's own
  downstream records (payments ledger, job records, audit events
  tool output). A future slice should emit one allowed-call audit
  event per tools/call (tool, scope, principal kind + login,
  session ref) through the existing audit channel; until then,
  "attributable" for allowed calls means identity-resolvable, not
  audit-queryable.
- **G-AUD-2 — Agent-turn principal carries no login.** The
  orchestrator turn principal is hardcoded `{ kind: "agent-turn",
  login: null }`, so denial audits for agent-turn calls carry
  login null and allowed agent-turn calls are attributable only to
  the agent instance. Follow-up (the #1843 follow-up, restated
  here): thread the turn's `userLogin` into the principal. This
  gap is about attribution threading, NOT about authorization:
  it does not by itself require role-differentiated scope
  assignment (see the determination below). Narrowing note
  (#2341): the mesh-door commands carry the turn's acting login
  through a separate `actingLogin` context carrier (stamped into
  queued jobs server-side at queue time) and audit it per call,
  so those four tools are login-attributable on door 2; the
  principal itself is unchanged and this gap remains open for
  the principal and for all other tools.
- **G-AUD-3 — System principal carries no login.** In-process
  callers (REST bridge, job executor) run as `system` with login
  null; their attribution is the authenticating route layer, not
  the tool call. Job records carry capability + toolName, which
  partially compensates for queued calls; sync in-process calls
  have no equivalent record. Same follow-up class as G-AUD-2
  (thread the route's authenticated login through), not a scope
  change.
- **G-AUD-4 — Scanner free tools are not person-attributable.**
  `scanner_status` (and job reads without a payment link) cannot
  be attributed to a person, session, or key. Bounded by design:
  status/job reads only, no money movement, no state change. If
  abuse of the free tools is observed, the response is rate
  limiting / affinity isolation, not retrofitted identity auth
  (which would change the scanner's public design).
- **G-AUD-5 — Shared `public_scanner` instance leaks job
  visibility across unauthenticated callers.** With neither
  `x-scanner-session` nor the deprecated `x-user-id` header,
  traffic shares the `public_scanner` instance, so `list_scan_jobs`
  on that instance lists jobs from unrelated callers. A future
  slice should consider per-payment-instance isolation for job
  listings; this slice records it and does not change scanner
  routing.
- **G-AUD-6 — A2A calls are not per-caller-attributable.** Shared
  `A2A_API_TOKEN` + untrusted body `userLogin` (see above).
  Per-caller A2A identity belongs to IAAA (#945) and to #1024's
  API-layer design; it is not rebuilt in this slice.

## Determination: role-differentiated assignment is NOT built here

#1843 explicitly left role-differentiated assignment (login →
IAAA role bindings at the DO tool path) as a CISO follow-up, and
this slice's task allowed building it only if the attribution
audit proves it is required for attributability. It does not:
attribution on the `/mcp` door already resolves login + kind, and
the gaps found (G-AUD-2, G-AUD-3) are login-threading gaps, not
scope-assignment gaps — threading a login into an existing
principal does not require, and is not the same work as, resolving
IAAA roles into scopes. Role-differentiated assignment is
therefore carried as a named follow-up (for the IAAA lane, #945),
not built in this slice, and #1843's defaults are unchanged.

#CISO-bhdm
