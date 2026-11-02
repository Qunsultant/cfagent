# Trading Surface Compliance Review

Standalone compliance review of the in-repo trading capability (`src/trading/`).
Produced for assessment P2 item 9, issue #290 (owner verdict 2026-10-18: do
NOT extract trading to a worker; enforce the boundary in-repo instead).
All statements below are sourced from the code as of main `0af55d4`;
file paths are given so every claim is checkable. No secret VALUES appear
in this document — names only.

## 1. What the trading surface does

`src/trading/` is the platform's trading capability microservice
(`src/trading/index.ts` docstring: "Pluggable Trading Capability
Microservice"). Its public surface, re-exported through
`src/trading/index.ts` (the sole import boundary for non-trading code,
enforced by `tests/trading-boundary.test.ts`), covers:

- **Broker platforms** (`src/trading/etrade/`, `src/trading/alpaca/`): E*TRADE
  and Alpaca integrations behind a strategy/registry pattern
  (`src/trading/registry.ts`, `TradingPlatformRegistry`; platforms registered
  in `src/trading/index.ts`).
- **Screeners** (`src/trading/screener.ts`, `src/trading/screenerPipeline.ts`,
  `src/trading/yfinanceScreener.ts`, `src/trading/yahooHistory.ts`,
  `src/trading/universes.ts`, `src/trading/screenerConfig.ts`,
  `src/trading/screenerReportPdf.ts`): equity/options market screening,
  technical batch fetch, universe definitions, PDF report generation
  (`generateScreenerPdf`, `screenerPdfFileName`).
- **Options engine** (`src/trading/options/`): strategy catalog/registry/ledger
  (`options/strategies/`), strategy engine (`strategyEngine.ts`), risk agent
  (`strategyRiskAgent.ts`), recommendation agent (`recommendationAgent.ts`),
  opportunity scanner (`opportunityScanner.ts`), scan-run store
  (`scanRunStore.ts`, SQL-backed: `SqlScanRunStore`), IV history
  (`ivHistoryStore.ts`, `ivCollector.ts`), calibrated/synthetic option chains,
  live flow items (`options/flows/`), unified options service
  (`unifiedOptionsService.ts`), options data agent (`optionsDataAgent.ts`).
- **Omnichannel trading agents** (`src/trading/email/agent.ts`,
  `src/trading/slack/agent.ts`, `src/trading/voice/agent.ts`): E*TRADE trading
  via email / Slack / voice channels. `src/trading/slack/agent.ts` also
  re-exports `verifySlackSignature` from `src/security/webhookSecurity.ts`
  (inbound Slack auth lives with the security code, trading re-exports it).

## 2. External services called

| Service | Hosts (from code) | Used for |
|---|---|---|
| E*TRADE API | `https://api.etrade.com` (live), `https://apisb.etrade.com` (sandbox) | quotes, accounts, positions, order placement/preview |
| Alpaca | `https://paper-api.alpaca.markets` (default; `ALPACA_BASE_URL`) | market data, paper trading |
| Yahoo Finance | `https://query1/2.finance.yahoo.com`, `https://finance.yahoo.com` | technicals/history (public market data) |
| Operator-configured MCP | `ETRADE_MCP_SERVER_URL` (env) | remote MCP trading server (optional path) |

Order placement goes through the broker platform clients
(`src/trading/etrade/client.ts`, `src/trading/alpaca/platform.ts`).

## 3. Secret inventory (names only)

**ET_\*-namespaced (compliant; the reserved trading namespace):**
`ET_API_KEY`, `ET_API_SECRET`, `ET_PROD_API_KEY`, `ET_PROD_API_SECRET`,
`ET_SANDBOX_API_KEY`, `ET_SANDBOX_API_SECRET`, `ET_BASE_URL`.
Resolved centrally in `src/config/environment.ts` (`resolveEnvironmentConfig`,
lines ~99–145); consumed by `src/trading/etrade/*` and `src/services/etrade.ts`.

**Trading-related names WITHOUT the ET_ prefix — rename candidates for CICD
(documented here, NOT renamed: a rename without the matching CICD secret
breaks production):**
- `ETRADE_CONSUMER_KEY`, `ETRADE_CONSUMER_SECRET`, `ETRADE_OAUTH_TOKEN`,
  `ETRADE_OAUTH_TOKEN_SECRET` — E*TRADE OAuth 1.0a credentials
  (`src/types.ts` ~48–53); read in `src/config/environment.ts` (~117–131)
  and presence-checked in `src/agents/orchestrator.ts:3651`.
- `ETRADE_ACCOUNT_ID_KEY` — account identifier (`src/trading/etrade/client.ts`
  and others; read in `src/agents/slackAgent.ts` paths only for routing).
- `ETRADE_ENVIRONMENT` — `"sandbox" | "live"` selector; read outside trading
  in `src/agents/orchestrator.ts:3712`, `src/agents/slackAgent.ts:123,342,380`.
- `ETRADE_MCP_SERVER_URL`, `ETRADE_KV`, `ETAPI_CONFIG` — URL / KV binding /
  config blob names (not credential material).
- `ALPACA_API_KEY`, `ALPACA_API_KEY_ID`, `ALPACA_SECRET_KEY`,
  `ALPACA_API_SECRET_KEY`, `ALPACA_BASE_URL` — Alpaca credentials
  (`src/trading/alpaca/platform.ts:23–36`). Real secrets, non-ET_ names.

Non-trading secrets present in the same env (out of trading scope but listed
for completeness): `SLACK_BOT_TOKEN`, `OUTBOUND_WEBHOOK_SECRET`.

## 4. Human-in-the-loop / approval control points

- **Trade execution**: order placement flows through the trading platform
  layer with HITL confirmation surfaces; payment/trade drafts use the
  confirmation pattern (`src/client/confirmationCard.ts`, `confirmDraft`).
- **Recommendation report dispatch** (`POST /trading/reports/email|webhook`):
  ships autonomously by owner decision; the opt-in HITL setting from issue
  #277 is now merged (commit `8f5edef`) — when enabled in Settings, dispatch
  requires the same confirmation pattern before sending.
- **Scheduled runs**: scheduled screenings/reports run via the scheduler
  (`src/services/scheduledTasks.ts`); issue #278 is merged (commit `0af55d4`):
  scheduled-run reports persist durably so the NextGenTP agent can surface
  them later.

## 5. Data stores touched

- **D1/SQLite via the shared ORM** (`src/orm/index.ts`): `mas_iv_history`,
  `mas_iv_history_symbol_date`, `mas_opportunity_scans`,
  `mas_opportunity_scans_generated_at`, `mas_policy_verdicts`,
  `mas_strategy_profiles`, `mas_strategy_profiles_user_name` (tables referenced
  from `src/trading/`). `mas_trades` / `mas_transactions` are read by NLQ
  under the table allowlist (`tests/nlq.sql-injection.test.ts`) and written
  via the ORM from agent code.
- **Event ledger**: `mas_events` rows are written for trading-relevant events
  (webhook deliveries, NLQ executions); append-only until R2 archival exists.
- **KV**: `ETRADE_KV` (fallback `SESSIONS`) binding read in `src/server.ts:903`.
- **Retention**: `mas_messages` pruned nightly (default 90d; issue #255). No
  trading-specific TTL beyond the shared retention pass.

## 6. Boundary posture (issue #290)

All non-trading code imports trading capabilities only through
`src/trading/index.ts` (36 `export *` statements covering the options engine,
etrade/alpaca platforms, channel agents, screeners, stores, and reports, plus
the platform-registry named exports); deep-path imports were re-pointed
mechanically (69 static + 2 dynamic import sites across 14 files, zero logic
changes). One pinned disambiguation:
`MAX_SCAN_SYMBOLS` exists in both `optionsScreener.ts` and
`options/opportunityScanner.ts` with different values; the index explicitly
re-exports the options binding external code used. Enforced by
`tests/trading-boundary.test.ts` (fails on any new deep-path import).

## 7. Open compliance questions (owner)

Status refreshed 2026-11-02 against current main (Qunsultant/cfagent#2927,
#764 P0 remainder slice). §§1–6 are unchanged by that slice; only this
section's status lines changed. Nothing below is answered by the lane —
each item is carried as an owner decision with its reason.

1. **Rename items (§3)**: approve renaming the `ETRADE_*`/`ALPACA_*` names to
   the `ET_*` namespace (or an `ALPACA_*`-exclusive equivalent) with matching
   CICD secret updates, or accept the current names permanently.
   Status: STILL OPEN (owner decision; a code rename without the matching
   CICD secret updates breaks production).
2. **`.agents/mcp_config.json`**: Alpaca-key-shaped values are committed in
   this file — owner to confirm real vs placeholder (rotate + move to env if
   real; scoped gitleaks allowlist if placeholder).
   Status: RESOLVED 2026-10-25 — the placeholder classification failed
   verification (high-entropy credential-shaped strings fed as env to a
   real Alpaca MCP server process, a live-credential usage path), so the
   values were treated as exposed and the owner revoked and rotated them
   (recorded in `docs/architecture/security/secrets-inventory-and-rotation-policy.md`
   §4). What remains open is the SEPARATE history-purge decision for the
   pre-#1486 git history carrying those values — purge is about history
   hygiene, not about killing a live credential, and #768 stays closed
   (it is not reopened by this slice).
3. **Investment-advice posture**: recommendation reports are generated and
   dispatched autonomously by default (owner decision, #277); confirm this
   matches the product's legal posture (same open question as the cfpay
   Autopilot legal review).
   Status: STILL OPEN (owner decision; the lane does not set the product's
   legal posture).
4. **Retention**: `mas_events` (the audit ledger backing the new
   `/api/audit` endpoints, #270) is append-only until R2 archival exists —
   confirm the intended retention/archival policy.
   Status: STILL OPEN (owner decision). Note the current enforcement
   state, which narrows but does not answer the question: `mas_events`
   is pruned nightly at 365d by the shared retention pass
   (`src/security/storageRetention.ts`, issue #786), while R2
   archival-before-delete remains a follow-on (no bucket exists yet).
5. **Future direction**: platform end-state is one agent per competency/
   capability (issue #291 tracker) — sequencing is the owner's call; this
   boundary is the seam future extractions will cut along.
   Status: STILL OPEN (owner sequencing call).
