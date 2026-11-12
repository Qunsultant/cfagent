# MCP Server Inventory

> **Scope note.** This is an inventory of the MCP servers shipped in this
> repository, as of **2026-11-08**, verified against a fresh `main` tarball
> (head `990ce0fd34c91357720371f43fc86e97ec6a505a`). It records what exists
> today; it makes no implementation claims and no decisions about follow-up
> work. The live deployment may lag `main`.
>
> Follow-up work lives in
> [Qunsultant/cfagent#3748](https://github.com/Qunsultant/cfagent/issues/3748)
> ("MCP server: scoping, security, tool gaps, resource inventory, scanner
> rationalization, latest-protocol conformance, sync/async parity", parent
> #3114 agentic-security program) and its child
> [Qunsultant/cfagent#3749](https://github.com/Qunsultant/cfagent/issues/3749)
> ("MCP: support for other protocols — discussion needed"). Related, not
> duplicates: #3496 (completeness contract), #3743 (REST-vs-MCP execution
> contract), #3702 (MCP server as one product), #3703 (MCP client).

## 1. The `openaimp` server

| Field | Value |
| --- | --- |
| Server name | `openaimp` (`OPENAIMP_MCP_SERVER_NAME`, `src/mcps/openaimp/index.ts`) |
| Title | Multi-Agent Studio Enterprise MCP Server |
| Version | `1.0.0` |
| Declared protocol version | `2024-11-05` (`MCP_SERVER_INFO`, `src/mcps/openaimp/index.ts:87-99`) |
| Transport | JSON-RPC 2.0 over Streamable HTTP (`WebStandardStreamableHTTPServerTransport`, `src/mcps/openaimp/handler.ts:442`) |
| Public URL | `https://agent.openaimp.com/mcp` (custom domain, `wrangler.jsonc:7`) |
| Alias | `/api/mcp` (same handler, `src/server/routes/platform.ts:331`) |
| Internal loopback | `https://agent.internal/mcp` (`OPENAIMP_MCP_URL`, `src/agents/orchestrator/meshMcpClient.ts:136`) |
| Auth | App session or per-user API key; 401 without a credential, before any Durable Object access (`src/server/routes/platform.ts:331`) |
| Execution context | Tools run in the caller's own OrchestratorAgent Durable Object instance |
| SDK | `@modelcontextprotocol/sdk` 1.32.2, `@modelcontextprotocol/server` 2.4.0 (`package.json:31-32`) |

## 2. Tools — 134 in `tools/list`

One factory, `McpToolFactory` (`src/mcps/openaimp/commands.ts`, static
registration block): **134 `this.registerTool(...)` calls**, reconciled
against **134 entries** in the scope table `MCP_TOOL_SCOPES`
(`src/mcps/openaimp/mcpPermissionPorts.ts:155`, completeness-pinned by test
against the live factory registry). Of the 134, **125 are canonical** and
**9 are deprecated `foss_*` aliases** (#1906; removal is a follow-up, not
part of this inventory).

### 2.1 Tools by domain

| Domain | Count | Tools |
| --- | --- | --- |
| Platform / knowledge / async job / admin | 13 | `knowledge_search`, `query_platform_knowledge`, `execute_nlq`, `get_async_job`, `list_async_jobs`, `list_database_tables`, `query_table_data`, `manage_categories`, `manage_referrals`, `manage_external_ads`, `get_revenue_summary`, `manage_session_memory`, `get_audit_events` |
| Payments | 7 | `draft_payment`, `confirm_payment_draft`, `get_payment_gateways`, `get_transactions`, `check_payment_budget`, `get_payments_overview`, `get_payment_budget` |
| E\*TRADE | 7 | `etrade_market_scan`, `etrade_get_quote`, `etrade_preview_order`, `etrade_execute_order`, `etrade_get_positions`, `etrade_auth_status`, `etrade_account_discovery` |
| Market data & Alpaca | 18 | `market_data_get_quote`, `market_data_company_fundamentals`, `market_data_historical_bars`, `market_data_research`, `alpaca_snapshot`, `alpaca_account`, `alpaca_positions`, `alpaca_orders`, `alpaca_place_order`, `alpaca_place_bracket_ladder`, `alpaca_cancel_bracket_ladder`, `alpaca_get_quote`, `alpaca_get_option_chain`, `alpaca_preview_order`, `alpaca_execute_order`, `alpaca_cancel_order`, `alpaca_cancel_ticker`, `alpaca_cancel_all` |
| Public.com (#3990, #4048) | 6 | `public_get_quote`, `public_account`, `public_preview_order`, `public_place_order`, `public_orders`, `public_cancel_order` |
| Deprecated `foss_*` aliases (#1906) | 9 | `foss_get_quote`, `foss_company_fundamentals`, `foss_historical_bars`, `foss_market_research`, `foss_alpaca_snapshot`, `foss_alpaca_account`, `foss_alpaca_positions`, `foss_alpaca_orders`, `foss_alpaca_place_order` |
| Agentic payments (x402 / MPP) | 3 | `paid_options_screener`, `paid_market_research`, `agentic_wallet_status` |
| Cloudflare Agents advanced | 9 | `browser_inspect_page`, `browser_screenshot`, `dispatch_trading_webhook`, `run_sandbox_command`, `run_quant_backtest`, `think_trade_validation`, `ai_search_financial_docs`, `ai_search_agent_search`, `execute_durable_twap` |
| Goals & chains | 3 | `goal.compile`, `goal.schedule`, `chain.run` (dotted names) |
| AgentDB reads | 5 | `agentdb.chain.status`, `agentdb.jobs.history`, `agentdb.audit.history`, `agentdb.reports.list`, `agentdb.trace.get` (dotted names) |
| Web | 2 | `web_search`, `web_fetch` |
| Job pipeline (#3533) | 26 | `run_feed_job`, `get_feed_job_status`, `list_feed_jobs`, `manage_feed_job`, `get_feed_job_schedule`, `set_feed_job_schedule`, `run_enrich_job`, `get_enrich_job_status`, `list_enrich_jobs`, `manage_enrich_job`, `run_analyze_job`, `get_analyze_job_status`, `list_analyze_jobs`, `manage_analyze_job`, `run_generate_job`, `get_generate_job_status`, `list_generate_jobs`, `manage_generate_job`, `run_deliver_job`, `get_deliver_job_status`, `list_deliver_jobs`, `manage_deliver_job`, `run_pipeline_chain`, `get_pipeline_chain_status`, `list_pipeline_chains`, `manage_pipeline_chain` |
| Mesh scheduled goals | 2 | `list_scheduled_goals`, `trigger_scheduled_goal` |
| Trading proposals & report assets | 7 | `propose_stock_trade`, `propose_options_trade`, `get_trading_accounts`, `get_trading_positions`, `get_trading_quote`, `list_report_assets`, `get_report_asset` |
| Trade approval (HITL) | 3 | `start_trade_approval`, `decide_trade_approval`, `get_trade_approval_status` |
| Browser & Slack mesh | 5 | `browser_snap_transaction`, `browser_capture_page`, `browser_scrape_tables`, `slack_send_pre_trade_approval`, `slack_dispatch_transaction_snap` |
| Screens | 2 | `run_stock_screen`, `run_options_strategy_screen` |
| Trading limits (#3888) | 1 | `trading_limits` |
| Stock Copilot | 6 | `stock_copilot_status`, `stock_copilot_control`, `stock_copilot_introspect`, `stock_copilot_learnings`, `stock_copilot_evaluate`, `stock_copilot_remediate_gaps` |
| Options Copilot (#4066) | 1 | `options_copilot_stage_control` |
| **Total** | **135** | |

Note: `execute_nlq` is grouped above by domain (platform/knowledge) but
carries the `mcp:execute` scope (§2.2), not `mcp:read`.

### 2.2 Scopes — 6 scopes, 135 tools

Every tool declares exactly one scope in `MCP_TOOL_SCOPES`; execution
passes through the permission gate (`executeWithPermissionGate`) before
execution. Scope totals: 65 `mcp:read`, 28 `mcp:write`, 7 `mcp:execute`,
21 `mcp:trade`, 10 `mcp:payments`, 4 `mcp:admin` (135 total).

| Scope | Count | Tools |
| --- | --- | --- |
| `mcp:read` | 65 | All read tools, including `knowledge_search`, `web_search`, `web_fetch`, `get_async_job`, `list_async_jobs`, the E\*TRADE/market-data/Alpaca reads, the Public.com reads (`public_get_quote`, `public_account`, `public_orders`), the `foss_*` read aliases, the AgentDB reads, the job-pipeline `get_*`/`list_*` status tools, `get_trading_accounts`, `get_trading_positions`, `get_trading_quote`, `list_report_assets`, `get_report_asset`, `get_trade_approval_status`, `browser_scrape_tables`, `stock_copilot_status`, `stock_copilot_introspect`, `stock_copilot_learnings`, `stock_copilot_evaluate` |
| `mcp:write` | 28 | `manage_categories`, `manage_referrals`, `manage_external_ads`, `manage_session_memory`, `goal.compile`, `goal.schedule`, `trigger_scheduled_goal`, the job-pipeline `run_*`/`manage_*` tools and `set_feed_job_schedule`, `browser_snap_transaction`, `browser_capture_page`, `slack_dispatch_transaction_snap`, `run_stock_screen`, `run_options_strategy_screen`, `options_copilot_stage_control`, `stock_copilot_control`, `stock_copilot_remediate_gaps` |
| `mcp:execute` | 7 | `execute_nlq`, `chain.run`, `run_sandbox_command`, `run_quant_backtest`, `dispatch_trading_webhook`, `think_trade_validation`, `browser_screenshot` |
| `mcp:trade` | 21 | `alpaca_cancel_all`, `alpaca_cancel_bracket_ladder`, `alpaca_cancel_order`, `alpaca_cancel_ticker`, `alpaca_execute_order`, `alpaca_place_bracket_ladder`, `alpaca_place_order`, `alpaca_preview_order`, `decide_trade_approval`, `etrade_execute_order`, `etrade_preview_order`, `execute_durable_twap`, `foss_alpaca_place_order` (deprecated #1906 alias), `propose_options_trade`, `propose_stock_trade`, `public_cancel_order`, `public_place_order`, `public_preview_order`, `slack_send_pre_trade_approval`, `start_trade_approval`, `trading_limits` |
| `mcp:payments` | 10 | `agentic_wallet_status`, `check_payment_budget`, `confirm_payment_draft`, `draft_payment`, `get_payment_budget`, `get_payment_gateways`, `get_payments_overview`, `get_transactions`, `paid_market_research`, `paid_options_screener` |
| `mcp:admin` | 4 | `get_audit_events`, `get_revenue_summary`, `list_database_tables`, `query_table_data` |

### 2.3 Synchronous vs queued — 87 synchronous, 47 queued

**87 tools are synchronous** (`SYNCHRONOUS_MCP_TOOLS`, plus the
`LEGACY_BROKER_TOOL_PREFIX` arm of `isSynchronousMcpTool`,
`src/config/asyncJobModes.ts`): the status reads, job retrieval, the broker
read and trade paths, browser and web tools, and (from #4048) the Public
account read, so a balance question is answered in the turn it is asked; and (from #4102) the five Public copilot tools, so a quote or an order action answers in the turn instead of returning a queue receipt.

The other **47 tools are queued** and return
`{ jobId, status: "queued" }` — a queue receipt, not a result. Results are
retrieved via `get_async_job` / `list_async_jobs`.

## 3. Resources — 14

`MCP_RESOURCES` (`src/mcps/openaimp/index.ts:110-191`).

> **Correction.** An earlier inventory answer said the server exposes 10
> resources. The verified count on fresh `main` is **14**: 7 `sqlite://`,
> 1 `etrade://`, 3 `market-data://`, and 3 deprecated `foss://` aliases.

### 3.1 `sqlite://` — 7

| URI | Name |
| --- | --- |
| `sqlite://schema/tables` | Database Tables & Schema |
| `sqlite://revenue/summary` | Platform Revenue Summary |
| `sqlite://categories/list` | Referral Categories Taxonomy |
| `sqlite://external-ads/inventory` | External Ad Network Inventory |
| `sqlite://memory/facts` | Persistent Session Facts |
| `sqlite://audit/recent` | Observability Audit Stream |
| `sqlite://trading/orders` | E\*TRADE Order Ledger |

### 3.2 `etrade://` — 1

| URI | Name |
| --- | --- |
| `etrade://portfolio/positions` | E\*TRADE Account Positions & Holdings |

### 3.3 `market-data://` — 3

| URI | Name |
| --- | --- |
| `market-data://market/quote/NVDA` | Market Data Quote (Yahoo Finance & Alpaca) |
| `market-data://research/fundamentals/NVDA` | Market Data Company Fundamentals & Valuations |
| `market-data://providers/status` | Market Data Providers Health |

### 3.4 `foss://` — 3, deprecated (#1906)

Same handlers as the `market-data://` resources above; the requested URI is
echoed back. Removal is a follow-up slice.

| URI | Name |
| --- | --- |
| `foss://market/quote/NVDA` | Market Data Quote (Yahoo Finance & Alpaca) — deprecated alias for `market-data://market/quote/NVDA` |
| `foss://research/fundamentals/NVDA` | Market Data Company Fundamentals & Valuations — deprecated alias for `market-data://research/fundamentals/NVDA` |
| `foss://providers/status` | Market Data Providers Health — deprecated alias for `market-data://providers/status` |

## 4. Prompts — 5

`MCP_PROMPTS` (`src/mcps/openaimp/index.ts:201-233`).

| Name | Arguments |
| --- | --- |
| `audit_security_review` | `draftId` (required) |
| `revenue_performance_analysis` | — |
| `nlq_schema_exploration` | — |
| `market_data_equity_research_report` | `symbol` (required) |
| `foss_equity_research_report` | `symbol` (required) — deprecated #1906 alias for `market_data_equity_research_report` |

## 5. Second server: `/mcp/scanner`

A separate MCP server for the pay-per-use options scanner
(`src/mcps/scanner/cloudflareWalletsScanner.ts`, 311 lines), served by the
`OPTIONS_SCANNER_MCP` Durable Object (`src/server/routes/platform.ts:370-402`).

| Field | Value |
| --- | --- |
| Server name | `cfagent-options-scanner` |
| Version | `1.0.0` |
| Route | `/mcp/scanner` (public URL `https://agent.openaimp.com/mcp/scanner`) |
| Auth | No session auth — payment is the access control (x402 paidTool) |
| Session affinity | `x-scanner-session` header (deprecated alias `x-user-id`); without either, traffic shares the `public_scanner` instance |
| Resources | None |
| Prompts | None |

Tools (4):

| Tool | Cost |
| --- | --- |
| `screen_options` | Paid — $0.05 USDC per call via x402 / Cloudflare Wallets (`SCANNER_PRICE_USD = 0.05`) |
| `scanner_status` | Free |
| `get_scan_job` | Free |
| `list_scan_jobs` | Free |

Whether the scanner stays a second server or is rationalized into one
server is follow-up work in #3748, not a decision recorded here.

## 6. Protocol-version status

| | Version | Notes |
| --- | --- | --- |
| Declared by this server | `2024-11-05` | `MCP_SERVER_INFO.protocolVersion` |
| Current stable spec | `2025-11-25` | Adds tasks, extensions, OIDC Discovery |
| Revisions since declared | 3 | `2025-03-26` (OAuth 2.1, Streamable HTTP), `2025-06-18` (structured output, elicitation), `2025-11-25` |
| Next-gen "modern" era | `2026-07-28` | Stateless, `server/discover` instead of `initialize`; the TypeScript SDK speaks both eras |

The server is **three revisions behind current stable** (`2025-11-25`).
Conformance scope is `2025-11-25` now, with the `2026-07-28` modern era
as a tracked decision in #3748 — this inventory does not assert a
`2026-07-28` deadline, because the spec has not set one.

## 7. Verification method

Counts in this document were verified on a fresh `main` tarball by
counting `this.registerTool(...)` calls in
`src/mcps/openaimp/commands.ts` (135), entries in `MCP_TOOL_SCOPES`
(135, per-scope totals 65/28/7/21/10/4), entries in `MCP_RESOURCES` (14)
and `MCP_PROMPTS` (5) in `src/mcps/openaimp/index.ts`, entries in
`SYNCHRONOUS_MCP_TOOLS` (7) in `src/config/asyncJobModes.ts`, and the
`screen_options` / `scanner_status` / `get_scan_job` / `list_scan_jobs`
registrations in `src/mcps/scanner/cloudflareWalletsScanner.ts` (4).
Re-verify against `main` before relying on any count here: slices land
while this document is being written.
