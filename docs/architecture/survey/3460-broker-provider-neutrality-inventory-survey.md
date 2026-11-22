# Platform-wide broker/provider neutrality inventory — Qunsultant/cfagent

- **Main head:** `4839f9e660d74da363c01b7610aa34e959cc131f`
- **Head date:** 2026-11-07 17:21:51 +0000 — `docs: archive completion reports for issues 3401 through 3673 #clo-arsi`
- **Clone:** fresh read-only clone under `/tmp/cfagent-inventory` (depth 1). No GitHub writes, no PRs, no file changes in the repo.
- **Method:** case-insensitive `etrade` grep over `src/` (`.ts`/`.tsx`) and `tests/`; file lists exclude test files by path (`*.test.*`, `*.spec.*`, `__tests__/`), not by content. #3231 and #3460 read live via the GitHub connector (`issue_read`, method `get`).

## Scale (current main)

| Layer | Files w/ etrade | Occurrences |
|---|---|---|
| src/agents | 74 | 922 |
| src/client | 50 | 520 |
| src/trading | 39 | 648 |
| src/services | 56 | 492 |
| src/security | 14 | 170 |
| src/config | 12 | 173 |
| src/mcps | 12 | 199 |
| src/workflows | 15 | 46 |
| src/data | 22 | 174 |
| src/server | 7 | 44 |
| src/events / src/outcomes | 1 / 2 | 12 / 2 |
| **src non-test total** | **315** | **3,548** |
| tests/ | 502 | 4,495 |

- `new ETradeService`: 63 sites (includes class-1 adapters/routes). `ETradeRestClient` mentions: 29 files. `etrade.client` uses: **23** (same count as #3460 cited — see §3).
- `src/types.ts` alone: 65 etrade lines (mostly the `ETrade*` aliases at :2885–2901).

## Classification

- **Class 1 — broker-specific by design, keep the name:** `src/trading/etrade/**` (client.ts:188, platform.ts:42), `src/security/etradeOAuth.ts` (108), `src/agents/routes/etradeBroker*.ts` / `etradeOptions*.ts` route modules, `src/mcps/openaimp/etradeCommands.ts` (106), `src/services/etrade.ts` (83), `src/services/etradeAuthPreflight.ts`, `src/services/etradeExecutionGate.ts`, `src/config/etradeModes.ts`, `src/server/routes/auth.ts` E*TRADE OAuth branches (:170–366), `src/trading/etrade/platform.ts` adapter messages (:62,308,389,449,468,485,509–510).
- **Class 2 — shared path naming one broker (defect).**
- **Class 3 — broker-conditional UI/policy, must become selection-driven.**

## Inventory table (violations only; DONE surfaces listed separately)

| # | Surface | File:line evidence | Type | In #3231? | Fixed? |
|---|---|---|---|---|---|
| V1 | Order page (?tab=order) — E*TRADE-only connect/quote/preview copy | `src/client/OrderTicketPanel.tsx:381,398,451,492,500,502,818` — "🔒 Connect your E*TRADE account to fetch authenticated live market quotes." / "Connect E*TRADE →" | Class 3 UI copy | Yes (class 3, hub/panels) | No — in flight under #3669, do not redo |
| V2 | Trading hub is E*TRADE-named yet renders for every broker | `src/client/ETradeTradingHub.tsx` (69 etrade lines, 37× "E*TRADE"); `src/client/Chat.tsx:1907` renders it whenever `isBrokerId(tenantProviders.brokerId)`; `ErrorBoundary label="E*TRADE Hub"` | Class 3 shell | Yes (named) | Partly — hub's own order fetches now use neutral `/api/broker/*` (:1114,1474,1514,1558), but the component/name is still E*TRADE-only |
| V3 | Per-broker panels switched, not one selection-driven surface | `src/client/brokerSectionNav.ts:12,50,53` — `selectedBroker === "etrade" ? AccountPanels : AlpacaBrokerPanel`; `src/client/AccountPanels.tsx` (16), `src/client/AlpacaBrokerPanel.tsx` | Class 3 UI | Yes (#3460 §1 too) | No |
| V4 | Dynamic menu defaults broker to etrade; mode label hard-codes Alpaca→Paper / other→Sandbox | `src/client/ETradeDynamicMenu.tsx:442` `selectedBrokerId = tenantProviders.brokerId ?? "etrade"`; `:668` label `isLive ? "Live" : (alpaca ? "Paper" : "Sandbox")` | Class 2 default / Class 3 | Yes (class 3) | No |
| V5 | Channel-desk source-based refusal: non-E*TRADE broker refused before any channel service is built | `src/agents/routes/tradingIntegrations.ts:167-168` — `if (selectedBroker !== "etrade") return channelBrokerRefusal(selectedBroker)` (comment cites #3429) | Class 3 policy | No (newer than #3231; named in #3460 §4) | No — still present, verbatim |
| V6 | Broker gate fails open for unconfigured tenants | `src/agents/routes/brokerGate.ts` — `read.status === "unconfigured"` → `return null` (pass through to E*TRADE surface); comment: "The S7 menu retires this default" | Class 2 fail-open | No (named in #3460 §4 as fail-OPEN; now partial) | Partly — store-failure now fails CLOSED with 503 `brokerStoreUnavailableResponse()`; unconfigured still passes through |
| V7 | Tenant broker default is etrade everywhere resolution can fail | `src/services/tenantProviders.ts:80` `isBrokerId(...) ? ... : "etrade"`; `src/data/commercialPorts.ts:161-164` `DEFAULT_TENANT_PROVIDERS = { dataProviderId: "etrade", brokerId: "etrade" }`; `tenantProviders.ts:65-66,73` fall back to it on missing adapter / any error | Class 2 default | Yes (defaults class) | No |
| V8 | Run records default broker+provider to etrade when unset (provenance mislabel) | `src/services/optionsServeRecord.ts:614-615` `dataProviderId: input.dataProviderId ?? "etrade", brokerId: input.brokerId ?? "etrade"` | Class 2 default | No | No |
| V9 | Stock-screen planner defaults provider to etrade | `src/workflows/stockScreenPlanner.ts:65` `input.provider ?? "etrade"` | Class 2 default | Yes (table) | No |
| V10 | Scheduled stock screen auth-guard keys off etrade default | `src/services/scheduledTasks.ts:1380` `if ((options.provider ?? "etrade") === "etrade")` (+ :1133 comment: default "etrade") | Class 2 default | Yes | No |
| V11 | Quote source label defaults to etrade | `src/services/researchProviders.ts:237` `source: quote.source ?? "etrade"` | Class 2 default | No | No |
| V12 | Manual-screen provenance stamped fail-open (etrade/etrade) | `src/agents/routes/etradeOptionsScreen.ts:311-315` — comment: "resolved fail-open (etrade/etrade)" | Class 2 default | No | No |
| V13 | Scheduled options runs hard-wire E*TRADE client (the 10/31 incident class) | `src/services/scheduledTasks.ts:3605,4223,4566,4870` — `new DynamicOptionsScreener(etrade.client, …)` in `autonomousStrategyDiscovery` (:3487), `autonomousStrategyDiscoveryDerived` (:4059), `autonomousStrategyDiscoveryNoView` (:4425), `collectDailyIvHistory` (:4842); factory `createETradeService` :473-476 | Class 3 hard-wire | Yes; #3460 §3 | No |
| V14 | Feed snapshot job hard-wires E*TRADE client | `src/services/feedSnapshotJob.ts:79,81` — `deps.createETradeService(...)` → `new DynamicOptionsScreener(etrade.client as never)` | Class 3 hard-wire | Yes; #3460 §3 | No |
| V15 | Options flow discovery fetches E*TRADE directly, no selection, silent catch | `src/trading/options/flows/flowService.ts:2179` `const etrade = new ETradeService(env)` + comment "Query broker client (E*TRADE)"; errors swallowed (`catch {}`) | Class 3 hard-wire | No (named in prior reconciliation as the flowService gap) | No |
| V16 | Panel options routes hand the pipeline an E*TRADE client (5 sites) | `src/agents/routes/etradeOptions.ts:195,516,578,712` + `:856` `chainSource ?? etrade.client` (fail-open fallback when neutral chain source is null) | Class 3 hard-wire + fail-open | Yes; #3460 §3/§4 | No |
| V17 | Options evaluate route is entirely E*TRADE (6 sites) | `src/agents/routes/etradeOptionsEvaluate.ts:62,65,91,122,136,180` — incl. `:136` error "E*TRADE returned no option contracts for ${symbol} in PROD environment" | Class 3 hard-wire + copy | Yes; #3460 §3 | No |
| V18 | No-view options route hard-wires E*TRADE client | `src/agents/routes/etradeOptionsNoView.ts:80-81` | Class 3 hard-wire | Yes; #3460 §3 | No |
| V19 | Goal-leg screener still has an etrade.client branch | `src/agents/screener-agent.ts:1883` `? new DynamicOptionsScreener(etrade.client, undefined, goalUniverseDeps)` (ternary; other branch not pinned in this pass) | Class 3 hard-wire (unpinned) | Yes; #3460 §4 cited old :1837-1839 fallback | Unclear — #3272 S3 comment (~:1850) claims non-E*TRADE selections now run neutral engines; the :1883 branch needs pinning at slice time |
| V20 | NLQ strategy paths build on E*TRADE client | `src/agents/nlqOptionsStrategy.ts:897,1325` `createStrategyScreenAgents(etrade.client)` | Class 3 hard-wire | Yes; #3460 §3 | No |
| V21 | NLQ comparison runner built from E*TRADE client | `src/agents/nlq/execution.ts:1960` `createComparisonRunner({ client: etrade.client, … })` (comment: "built from the session's E*TRADE client") | Class 3 hard-wire | Yes; #3460 §3 | No |
| V22 | Voice/Slack/Email channel agents construct ETradeService unconditionally and speak E*TRADE copy; zero selection reads | `src/trading/voice/agent.ts:182-183,284,287,773,1035` ("Order Executed on E*TRADE", "E*TRADE Voice Trading Desk"); `src/trading/slack/agent.ts:265,981,326,696,702,779,1148,1199,1210,1674,1800` ("✅ ORDER EXECUTED ON E*TRADE"); `src/trading/email/agent.ts:131-132,178`; grep `brokerId\|resolveTenantBroker\|selectedBroker` = 0 in all three | Class 3 hard-wire + copy | Yes (table) | No |
| V23 | Think harness / webhooks / MCP index construct ETradeService unconditionally | `src/services/thinkHarness.ts:65`; `src/services/tradingWebhooks.ts:181`; `src/mcps/openaimp/index.ts:400`; `src/mcps/openaimp/cloudflareAgentCommands.ts:455` | Class 3 hard-wire | Yes (table) | No |
| V24 | Broker-options route bypasses the one pipeline | `src/agents/routes/brokerOptions.ts:91` `screenOptionsWithSource(source, …)` — screens via `platformChainSource` directly, never through the one pipeline (header :22 imports `screenOptionsWithSource`, no pipeline/composer reference) | Class 3 architecture | No (named in #3460 §5) | No — still present; note it IS selection-driven (resolves tenant broker, 501 `unsupportedResponse` :36-41 naming the broker) |
| V25 | Shared contract types are E*TRADE-named (now aliases to neutral types) | `src/types.ts:2885-2901` `ETradeQuote = BrokerQuote`, `ETradeOrderDraft`, `ETradeOrderExecutionResult`, `ETradePosition`, `ETradeAccount`, `ETradePositionLot`, `ETradeBrokerStatus`; used :2163,2182,2185; `src/agents/routes/brokerOrders.ts:52` `BrokerOrderRouteContext = EtradeBrokerRouteContext` | Class 2 vocabulary | Yes (named explicitly) | Partly — neutral `Broker*` types exist and aliases point at them; the `ETrade*` names and the context alias remain |
| V26 | `TradingPlatformId` lists "sandbox" (an environment) beside brokers | `src/trading/interfaces.ts:41` `export type TradingPlatformId = BrokerId \| "sandbox"` (also noted in `src/trading/brokerCatalog.ts:7`) | Class 2 vocabulary | Yes (named explicitly) | No |
| V27 | Outcome catalog: E*TRADE-named failure codes + E*TRADE user-visible messages | `src/outcomes/outcomeCatalog.json`: `FAILURE_ETRADE_ACCOUNTS_UNAVAILABLE`, `FAILURE_ETRADE_ALERTS_UNAVAILABLE`, `FAILURE_ETRADE_ORDERS_UNAVAILABLE`, `FAILURE_ETRADE_TRANSACTIONS_UNAVAILABLE`, `FAILURE_ETRADE_UPSTREAM`, `FAILURE_ETRADE_WATCHLISTS_UNAVAILABLE`, `FAILURE_ETRADE_OAUTH_START_FAILED`, `FAILURE_ETRADE_OAUTH_REQUEST_TOKEN_FAILED`, `FAILURE_ETRADE_OAUTH_EXCHANGE_FAILED`, `FAILURE_ETRADE_OAUTH_RENEW_FAILED` (businessMessages name "E*TRADE account"); `FAILURE_AUTH_NO_SESSION` ("No E*TRADE session is stored…"), `FAILURE_AUTH_TOKEN_EXPIRED` ("E*TRADE connection expired…") | Class 2 vocabulary + copy | No (catalog not in #3231 body) | No |
| V28 | Quote provider resolution requires etrade as primary | `src/trading/screenerPipeline.ts:761-782` `etradeQuoteProviderFromRoute` — throws unless `route.primaryProviderId === "etrade"` and an enabled etrade config exists; `:1320` `provider: "etrade"` label; `:1592-1848` E*TRADE error strings ("E*TRADE returned no quote…", "E*TRADE batch quote omitted…") | Class 2 provider default + copy | Yes (table) | No |
| V29 | Options panels name E*TRADE in user-visible copy | `src/client/options/RawContractsScreener.tsx:461` "Live E*TRADE Chains", `:667` "stream live contracts from E*TRADE"; `StrategyDiscoveryPanel.tsx:1657` "E*TRADE supports up to four legs in one order."; `OptionsDataDownloadDropdown.tsx:65,112,139` "Raw E*TRADE Options Data"; `LlmStrategyEvalModal.tsx:159,292,419,421`; `LlmOptionsIdeasPanel.tsx:132,326` "Referenced E*TRADE contracts:"; `OptionsResearchPanel.tsx:1100,1284` source "E*TRADE · Auto Options Research"; `serverDiscovery.ts:6` | Class 3 UI copy | Yes (class 3) | No |
| V30 | Scheduled-jobs descriptions name E*TRADE feed | `src/client/scheduledOptionsManager/systemJobs.ts:6,11,17` — "Screens … with E*TRADE quotes", "against the live E*TRADE chain" | Class 3 UI copy | No | No |
| V31 | Order-preview/commission copy names E*TRADE | `src/client/tradeExecutionPreview.ts:121-122,126` "Commission … $0.00 (E*TRADE Online)", "see the E*TRADE account disclosure"; `src/client/workflowsFaqData.ts:1084` "submitting orders to E*TRADE" | Class 3 UI copy | No | No |
| V32 | Account surfaces are E*TRADE-only client calls | `src/client/accountApi.ts:89-152` `/api/etrade/alerts|transactions|watchlists|positions|watchlist/*`; `src/client/brokerPortfolio.ts:7` comment "E*TRADE GET /api/etrade/positions" | Class 3 API | Yes (table) | No |
| V33 | Scanner/discovery storage APIs are E*TRADE-namespaced | `src/client/scannerApi.ts:161,234` `/api/etrade/options/profiles|scans` (comment :46: panel "never sees E*TRADE profiles or scan history" via the neutral path); `src/client/discoveryApi.ts:40` `/api/etrade/options/discovery-runs` | Class 3 API | Yes (table) | No |
| V34 | Portfolio risk/hedge/repair/think calls hard-code /api/etrade/* | `src/client/portfolioRiskApi.ts:62,158,250,437` `/api/etrade/hedge/analyze`, `/api/etrade/portfolio-repair/analyze`, `/api/etrade/portfolio-risk/bundle`, `/api/etrade/think/evaluate` (comment :35-36: "E*TRADE keeps its own routes here on purpose"); contrast :42 which IS selection-driven (`broker === "etrade" ? /api/etrade : /api/broker`) | Class 3 API | Yes (table) | No |
| V35 | Legacy /api/etrade/* endpoint constants still the call path in places | `src/client/brokerEndpoints.ts:19-27` `LEGACY_*_ENDPOINT = "/api/etrade/…"`; `src/client/mcpEndpointsData.ts:764-837` endpoint paths + sample curls (`/api/etrade/status|screen|quote|order/*|positions|orders`) and category "Trading & E*TRADE" (:28,251,269,300,314,762…); `src/client/iaaaEndpointCatalog.ts:150-214` `/api/etrade/oauth/*`, `/api/etrade/diagnostics` | Class 3 API/docs | Yes (table) | No |
| V36 | Capability/knowledge docs shown to agents/users name E*TRADE + /api/etrade/* routes | `src/services/platformKnowledge.ts` (28 E*TRADE mentions; :62,69,97-98,128,154,157,169-170 — incl. portfolio overview naming `GET /api/etrade/portfolio-risk`, `POST /api/etrade/hedge/analyze`); `src/trading/screenerReportPdf.ts:307` "E*TRADE unavailable — no market data."; `src/trading/screener.ts:1180`, `src/trading/quotePolicies.ts:71` error strings | Class 3 prompts/copy | No (knowledge surface not in #3231 body) | No |
| V37 | Feed job is hard-coded to the E*TRADE feed | `src/services/feedPipelineJobs.ts:111-115` `jobId: "etrade-nasdaq100-quotes"`, `sourceId: "etrade"`, `label: "E*TRADE quotes — Nasdaq-100"` | Class 3 job | No | No |
| V38 | First-run wizard defaults non-E*TRADE to Alpaca and offers E*TRADE OAuth | `src/client/FirstRunScreen.tsx:151` `knownBrokerId = … === "etrade" ? "etrade" : "alpaca"`; `:22-24,138-140,376,385` "Connect E*TRADE" → `/api/etrade/oauth/start?mode=redirect`; `src/client/firstRunApi.ts:376,385` same | Class 3 UI | Yes (table) | No |
| V39 | Export headers name E*TRADE | `src/client/runExport.ts:1126` "E*TRADE Contract Symbol"; `:1219` "Complete retrieved E*TRADE JSON" | Class 3 copy | No | No |
| V40 | Workflow Runs / run surfacing carries no broker+mode | `src/services/workflowRuns.ts` — grep `broker` finds only `brokerstart: "Broker start — execution branch"` (:301); no brokerId/mode fields surfaced. (Docs/delivery labelling likewise not found in this pass.) | Class 3 surfacing gap | No (#3460 §6/acceptance) | No |
| V41 | Data-provider construction defaults to the E*TRADE adapter in shared paths | `src/trading/dataProviders/adapters.ts:580` `createETradeDataProviderFromEnv` (used by `src/agents/routes/dataProviders.ts:249,498` and `src/services/feedProviderWiring.ts:84`); `src/services/optionsProviderContext.ts:112,162` `showEtradeBrokerSurface` / `brokerSurfaceUnavailable` — surfaces exist only when `brokerId === "etrade"` | Class 2/3 wiring | Yes (table) | No |

Also counted but not individually classified (counts from the per-file table; spot-check at slice time): `src/client/DataProvidersPanel.tsx` (16), `src/client/ProviderConnectivityDashboard.tsx` (17), `src/client/PlatformAdminPanel.tsx` (18), `src/client/stockCopilotApi.ts:168` (`etrade: "E*TRADE"` label map — selection display, by design), `src/client/tenantProviders.ts:37,45` (selection lists, by design), `src/agents/routes/etradeBrokerModes.ts` (19), `src/agents/routes/brokerCodedError.ts` (19), `src/trading/brokerCatalog.ts` (13 — the etrade catalog row itself is class 1), `src/services/etradeExecutionGate.ts` (20), `src/agents/orchestrator/routeRequest.ts` (27), `src/agents/orchestrator/meshDoors.ts` (27).

## DONE — surfaces that already read the selection (not violations)

- **Dynamic menu broker-aware status:** `src/client/ETradeDynamicMenu.tsx:474-475` `isConnected` branches on `selectedBrokerId === "alpaca"`; `:454` `/api/broker/connect/alpaca?environment=…`; `:587` diagnostics send `x-environment`; `:592,604,607` messages use `selectedBrokerLabel`; `:797` mode word via `brokerPresentation(selectedBrokerId)`.
- **Neutral `/api/broker/*` seam:** `src/client/brokerEndpoints.ts:18-28` `NEUTRAL_*_ENDPOINT`; server `src/agents/routes/brokerOptions.ts`, `brokerOrders.ts`, `brokerReads.ts`; client `accountApi.ts:167` (`/api/broker/order/cancel`), `AutopilotControlCenter.tsx:505`, `TradingApprovalsQueue.tsx:125,156`, hub order calls.
- **Broker panel contract + catalog:** `src/trading/brokerPanels.ts`, `src/trading/brokerCatalog.ts`, `src/trading/brokerPresentation.ts`, `src/client/BrokerSurfaceGate.tsx` (used by `AlpacaBrokerPanel.tsx:343,359,379`).
- **Broker gate fails closed on store failure:** `src/agents/routes/brokerGate.ts` + `src/services/tenantProviders.ts` `brokerStoreUnavailableResponse()` (503) and `brokerUnavailableResponse()` (409 `FAILURE_BROKER_UNAVAILABLE`).
- **Manual screen reads the selection:** `src/trading/options/unifiedOptionsService.ts:693-…` `resolveEngineClient()` — presence-aware `readTenantBrokerSelection`, refuses unconfigured/store-failure with a named error, non-etrade → `TradingPlatformRegistry.getPlatform` + `platformChainSource`, no-options-plane → named `provider_unsupported` error (no silent fallback). Used by `src/agents/routes/etradeOptionsScreen.ts:195`.
- **Broker route fails closed per capability:** `src/agents/routes/brokerOptions.ts:36-41` `unsupportedResponse` (501 naming the broker).
- **Neutral types exist:** `src/types.ts:2885-2901` `BrokerQuote/BrokerOrderDraft/…` (ETrade* are aliases to them).
- **Mode resolution exists server-side:** `src/agents/copilotTradingMode.ts:100-160` — stored setting TEST/PROD wins; else `STOCK_COPILOT_MODE`, else `ALPACA_TRADING_TYPE`, else settings; unset defaults to Alpaca Paper (TEST). `src/services/providerConnections.ts:292` `tradingTypeFor(brokerId, environment)`. Menu env toggle UI exists (`ETradeDynamicMenu.tsx:803-812`, `onSwitchEnv("TEST"|"PROD")`).
- **Alpaca protocol misreport (named in #3231) appears fixed:** `src/trading/alpaca/platform.ts:366` comments "It used to report `protocol: \"etrade_oauth_rest\"`"; `src/trading/brokerCatalog.ts:10` documents the old defect. (Live `getStatus()` return not independently re-verified in this pass.)
- **#3231's "hub has zero references to the selected broker" is stale:** `ETradeTradingHub.tsx` now has 17 `selectedBroker|brokerId|getBroker` references.

## #3231 cross-check

- **#3231 state:** OPEN. Its body is the proposal + measurement only (`created_at` == `updated_at` 2026-11-05T04:53:36Z) — no delivered per-file classification table in the body. The S0 inventory it promises does not exist in the issue body. (Comments were not read in this pass; if a classification was posted as a comment, this report's table still stands as the fresh-main inventory.)
- **Measurement comparison** (case-insensitive "etrade", #3231 on main @ `b6db335e` vs this pass on `4839f9e6`; methods may differ slightly — treat deltas as approximate):

| Layer | #3231 (b6db335e) | Now (4839f9e6) | Delta |
|---|---|---|---|
| Agent routes | 834 | 922 | +88 |
| Client UI | 457 | 520 | +63 |
| Trading adapters | 659 | 648 | −11 |
| Services / security | 644 | 662 | +18 |
| Config + shared types | 235 | 238 | +3 |
| MCP commands | 189 | 199 | +10 |
| Tests | 3,878 (398 files) | 4,495 (502 files) | +617 |

- **#3231 named defects — status now:** `ETrade*` types still present (now aliases — partly addressed, V25); `BrokerOrderRouteContext = EtradeBrokerRouteContext` still present (V25); `TradingPlatformId` still lists `"sandbox"` (V26); Alpaca `protocol: "etrade_oauth_rest"` appears fixed (see DONE); hub zero-broker-refs claim stale (17 refs now, V2).
- **Already inventoried in #3231 (do not duplicate — referenced by its classification):** V1, V2, V3, V4, V7, V9, V10, V13–V23, V25, V26, V28, V29, V32–V35, V38, V41 (all fall under its layer table / class 2 / class 3; its body names only the examples in §Problem, the rest by layer counts).
- **New since #3231's measurement:** V5 (channel refusal, #3429-era), V6 (gate fail-open now partial), V8, V11, V12, V15, V24 (pipeline bypass — #3460-era), V27 (outcome catalog), V30, V31, V36, V37, V39, V40.
- **Fixed since #3231 (do not re-file):** store-failure fail-closed (V6 partial), `resolveEngineClient` selection-driven manual entry, broker-route 501s, neutral `Broker*` types, Alpaca protocol label, hub broker refs.

## #3460 mapping (problem list → status)

1. Front-end broker-switched, not neutral → still true (V2, V3, V4).
2. Manual screen E*TRADE-only → **partly fixed**: one entry now serves both brokers via `resolveEngineClient()`; no separate Alpaca route exists, but the entry is selection-driven. Residual: route/module still etrade-named; etrade branch still direct client (V16-adjacent).
3. 23 `etrade.client` hardwire sites in 9 files → **still 23** (recount on this main: nlq/execution 1, nlqOptionsStrategy 2, etradeOptions 5, etradeOptionsEvaluate 6, etradeOptionsNoView 1, screener-agent 1, feedSnapshotJob 1, scheduledTasks 4, unifiedOptionsService 2). Note: the two in `resolveEngineClient` now sit inside the etrade branch of a selection read — the count is unchanged, the manual-entry context changed.
4. Source-based refusal / fail-open / goal-leg fallback → refusal **still present** (V5); gate fail-open **partly fixed** (store failure closed, unconfigured open, V6); goal-leg fallback unpinned (V19); `chainSource ?? etrade.client` fail-open **still present** (V16 :856).
5. Any-broker route bypasses the pipeline → **still present** (V24).
6. Mode threaded, selected nowhere → **partly**: toggle UI + server resolution exist, but no single selection governs every run and run records default to etrade (V8, V40).

## Sequenced slices (one issue = one branch = one PR, Merge Queue only)

Order page (#3669) is slice S1 and already in flight — not re-scoped here.

| Slice | Name / surfaces | Programme / parent | Depends on | Reuses | Flags |
|---|---|---|---|---|---|
| S1 | **Order page** (#3669, in flight) — `OrderTicketPanel.tsx` + order connection UI | #3460 / #2528 | — | Neutral `/api/broker/*` seam, `BrokerSurfaceGate` | — |
| S2 | **Mode-toggle correctness** (#3668) — verify/fix `isLive` persistence: `ETradeDynamicMenu.tsx:403,440,803-812` (`effectiveEnv`, `onSwitchEnv`), `copilotTradingMode.ts`, `brokerEnvironment` route/settings, `ALPACA_TRADING_TYPE` / `STOCK_COPILOT_MODE` precedence | #3460 | — (first, before any slice that displays mode) | Existing toggle UI + `tradingTypeFor` | Needs live check; possible user decision on default mode (see D2) |
| S3 | **Fail-open → fail-closed policy + defaults removal** — V6, V7, V8, V9, V10, V11, V12, V16-:856: `DEFAULT_TENANT_PROVIDERS`, `resolveTenantBroker`, `optionsServeRecord`, `stockScreenPlanner`, `scheduledTasks:1380`, `researchProviders`, `brokerGate` unconfigured branch, provenance fail-open | #3460 | S2 (mode default is part of the policy) | `brokerStoreUnavailableResponse` / `brokerUnavailableResponse` (409/503 pattern) | **USER DECISION first (D1, D2)** — do not implement before the decision |
| S4 | **Channel desk + channel agents selection-driven** — V5 (remove `channelBrokerRefusal`), V22, V23 (slack/voice/email/thinkHarness/webhooks/MCP index read selection or refuse with a named error) | #3460 §4 | S3 (what replaces the refusal) | `resolveTenantBroker`, `readTenantBrokerSelection`, `BrokerSurfaceGate` pattern | No workflow files |
| S5 | **Scheduled + feed + flow jobs selection-driven** — V13, V14, V15: `scheduledTasks` 4 sites + `createETradeService`, `feedSnapshotJob`, `flowService:2179` | #3460 §3 | S3 (fail-closed policy) | `resolveEngineClient` pattern, `platformChainSource`, registry | The 10/31 incident class; may touch `src/workflows/*` helpers — flag #1894 if any `.github/workflows` or workflow-file change is needed |
| S6 | **Shared vocabulary** — V25, V26, V27, V28: `ETrade*` → `Broker*` primary (aliases deprecated in place, no deletions), `BrokerOrderRouteContext`, `TradingPlatformId` "sandbox", outcome-catalog codes/messages, `etradeQuoteProviderFromRoute` + screener error strings | #3216 (vocabulary) / #3460 | S3 (catalog message policy) | Existing `Broker*` types, `legacyAliases` (stored rows never rewritten) | Catalog rename needs the D4 decision; no deletions per gitops §22 |
| S7 | **One dynamic broker/mode surface** — V2, V3, V4: merge `ETradeTradingHub` / `ETradeDynamicMenu` / `AccountPanels` / `AlpacaBrokerPanel` switching (`brokerSectionNav.ts`) into one selection-driven surface; rename components (deprecate in place) | #3460 §1 | S2 (mode correctness), S3 (defaults) | `brokerPanels.ts` contract, `BROKER_CATALOG`, `brokerPresentation`, `BrokerSurfaceGate` | Largest UI slice; keep both panels rendering until cutover is flagship-flagged |
| S8 | **Options entries through the one pipeline** — V16, V17, V18, V19, V20, V21, V24: `etradeOptions*` routes, `etradeOptionsEvaluate`, NLQ paths, `brokerOptions` via the pipeline composer | #3460 §2/§3/§5 | S5, S6 | One pipeline (#3186 composer — verified neutral), `platformChainSource`, `resolveEngineClient` | **Flag #1894** if it touches `src/workflows/*` flow files or `.github/workflows/*`; do not change screen semantics |
| S9 | **Client API namespace migration** — V32, V33, V34, V35: `/api/etrade/options/*`, `accountApi` `/api/etrade/*`, `portfolioRiskApi` hard-coded routes, endpoint docs (`mcpEndpointsData`, `iaaaEndpointCatalog`) → neutral `/api/broker/*` | #3216 | S7 (surfaces that call them) | `NEUTRAL_*_ENDPOINT` constants, existing `/api/broker/*` routes | Legacy `/api/etrade/*` routes stay as aliases (no deletions); D3 decision on sunset |
| S10 | **User-visible copy sweep** — V29, V30, V31, V36, V37, V39 (+ V38 FirstRun): options panels, system-jobs descriptions, preview/commission copy, `platformKnowledge`, PDF/quote error strings, export headers, first-run wizard | #3525 (messages corpus) + #3216 | S6 (vocabulary) | Neutral terms from S6; `brokerPresentation` labels | #3525 owns the corpus-first method — coordinate, don't duplicate |
| S11 | **Run-record broker+mode surfacing** — V40: Workflow Runs + Docs + delivery carry broker+mode (provenance already stamped in `optionsServeRecord`; `workflowRuns.ts` has no broker fields today) | #3460 §6/acceptance | S2, S3 | `recordStrategyScreenRun` provenance, `withProviderProvenance` | Needs the S3 default decision so unset runs aren't mislabelled |

## Open decisions needed from the user

- **D1 — Fail-open vs fail-closed for an unconfigured tenant.** `brokerGate` still passes unconfigured tenants through to the E*TRADE surface; `DEFAULT_TENANT_PROVIDERS` and `resolveTenantBroker` default to etrade/etrade. #3460 §4 says fail closed, never degrade. Confirm: unconfigured tenant = refuse with a named error (and which surface, if any, may still serve E*TRADE before selection)?
- **D2 — Default broker + mode when nothing is stored.** Broker default today is etrade; mode resolution defaults to Alpaca Paper (TEST) when unset (`copilotTradingMode.ts`). Confirm the intended defaults (broker? live vs paper?) — S2/S3 cannot be written without this.
- **D3 — `/api/etrade/*` legacy routes: permanent aliases or a sunset?** S9 keeps them as aliases (no deletions); confirm whether a sunset date is wanted.
- **D4 — Outcome-catalog rename scope.** Rename `FAILURE_ETRADE_*` codes (via `legacyAliases`, stored rows untouched) or only reword the user-visible `businessMessage` to name the selected broker? (V27.)
- **D5 — #3668 mode toggle root cause.** Is `isLive` stuck true because the UI toggle doesn't persist, or because a deployment pin (`ALPACA_TRADING_TYPE` / `STOCK_COPILOT_MODE`) overrides the stored setting? Needs a live check; S2's fix depends on the answer.
- **D6 — Alpaca as a data provider?** Alpaca is a broker, not a data provider (user correction 2026-11-07). Confirm no Alpaca-feed slice is wanted: options chains for Alpaca tenants come via `platformChainSource`, and the E*TRADE quote-primary rule (V28) is replaced by the selected data provider, not by Alpaca.

## Could NOT verify

- Live app state (whether the order page / toggle / hub behave as the code reads; #3668's stuck-`isLive` claim; whether `AlpacaTradingPlatform.getStatus()` still returns the old protocol live).
- Production / deployment env pins (`ALPACA_TRADING_TYPE`, `STOCK_COPILOT_MODE`, `TENANT_BROKER_ID`, `BROKER_ID`) and flagship-flag state.
- Whether `platformKnowledge.ts` capability text is actually seen by end users (agent prompt vs user-facing docs).
- #3231 comments (only the issue body was read — `updated_at` == `created_at`, so the body contains no delivered inventory); #3669 body (not read — taken as given from the task that it is the order-page slice).
- Exact counting methodology behind #3231's layer table (deltas in §#3231 cross-check are approximate).
- The `screener-agent.ts:1883` goal-leg ternary's other branch (which condition selects the neutral engine) — needs pinning at S8 time.
