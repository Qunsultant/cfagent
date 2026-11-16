# E2 SURVEY — Screening cutover to the data-provider platform (epic #1116)

Read-only survey of `OpenAIMP/cfagent` main @ **4698c6f48d09a3ff1198c64eccf39b973dfb602d**
(2026-10-23, fetched fresh before reading). All line numbers are against that SHA.
No code was changed and nothing was written to GitHub.

Headline: **nothing in production constructs the platform.** `createETradeDataProvider`,
`DataProviderRegistry`, and `seedProviderConfigs` are referenced only from
`tests/data_provider_platform_p1.test.ts` and `tests/data_provider_capture_e1.test.ts` —
zero call sites under `src/` outside `src/trading/dataProviders/` itself.

---

## 1. OPTIONS SCREENING PATH — UnifiedOptionsService

File: `src/trading/options/unifiedOptionsService.ts`

- `unifiedOptionsService.ts:243` — constructor is `(env, userLogin = "default_trader", overrideEnv?, orm?, scanRunStore?, profileStore?, discoverySql?)`. No ETradeService and no platform/storage deps are injected; the service holds only `env`, an optional `DatabaseORM`, and the three optional stores.
- `unifiedOptionsService.ts:435-437` — inside `execute()`, on every non-cached call, the service constructs ETradeService itself: `new ETradeService(this.orm, this.env, this.userLogin, this.overrideEnv)` (env-first overload when no ORM). It then passes only `etrade.client` (the `ETradeRestClient`) onward — the engines never see the service.
- `unifiedOptionsService.ts:271-290` — the three engine primitives are statics taking that raw client: `screenContracts(client, filter)` → `new DynamicOptionsScreener(client).screenOptions(filter)`; `runStrategyPipeline(client, …)` → `OptionsAgentPipeline(new DynamicOptionsScreener(client))`; `scanOpportunities(client, …)` → `OpportunityScanner` over the same screener. Call sites in `execute()`: lines 445 (screen), 540/732/796 (pipeline), 574 (opportunities).
- `src/trading/optionsScreener.ts:234,240` — `DynamicOptionsScreener` takes the client in its constructor (`constructor(client?: ETradeRestClient, …)`, stored as `this.client`).
- `src/trading/optionsScreener.ts:304` — chain acquisition is `client.getOptionExpireDates(symbol)` then `client.getOptionChains({ symbol })` (lines 328, 351). **No separate underlying-quote fetch exists in the options screening path** — chains (which carry the underlying price) are the only provider data fetched.
- `src/trading/options/opportunityScanner.ts:756-758` — `OpportunityScanner` wraps the same screener via `OptionsDataAgent`, so all three actions funnel through the one client's `getOptionChains`/`getOptionExpireDates`.

Who constructs UnifiedOptionsService (all `new`, no factory):

- `src/agents/routes/etradeOptionsScreen.ts:176` — the REST unified route; the **only** construction site that also passes storage-backed stores: `new SqlScanRunStore(ctx.agentCtx.storage.sql)`, `new SqlStrategyProfileStore(ctx.agentCtx.storage.sql)`, and `ctx.agentCtx.storage.sql` as discoverySql.
- `src/agents/routes/premium.ts:161` — premium/x402 route: `(ctx.env, userLogin, reqEnvLocal, ctx.getOrm())` only.
- `src/agents/trading-agent.ts:214` — `(ctx.env, ctx.userLogin)` only.
- `src/agents/nlq/execution.ts:73` — `nlqUnifiedOptionsService()` helper: `(env ?? {}, userLogin, undefined, orm)`.
- `src/mcp/agenticPaymentCommands.ts:149` — `(context.env, sessionId, undefined, context.orm)`.
- `src/services/scheduledTasks.ts:724-730` — scheduled options: `(this.env, userLogin, options.environment, this.orm, this.scanRunStore)`; the scanRunStore is injected into ScheduledTasksService by its orchestrator-side constructors as `new SqlScanRunStore(this.ctx.storage.sql)` (e.g. `src/agents/orchestrator.ts:628`, `src/agents/orchestrator/scheduledCallbacks.ts:71`).

Run/report identifier at scan time:

- `unifiedOptionsService.ts:660-661` — the scan-run id is created **after** the scan completes: `scanRunStore.save(scanResult, …)` returns `saved.id`, surfaced as `scanRunId`. The store is `src/trading/options/scanRunStore.ts:133,188` (`SqlScanRunStore`, table `mas_opportunity_scans` in DO SQLite). **There is no run id in existence while chains are being fetched** — a capture at fetch time cannot link to it unless the id is minted before the scan.
- `src/agents/nlq/execution.ts:78-110` — NLQ screens additionally persist a canonical copy to `mas_reports` via `orm.storeCanonicalReport({ runId: generationId, … })` with `generationId = "options_scanner:nlq:<generatedAt>"` — also minted at persist time, after execution.
- Only the `opportunities` action persists a scan run at all, and only when a scanRunStore was injected (premium/trading-agent/NLQ constructions pass none).

## 2. STOCK SCREENER PATH

Pipeline module: `src/trading/screenerPipeline.ts` — `acquireUniverse(opts)` at line 203, with four modes. Entry point is `ScreenerAgent` (`src/agents/screener-agent.ts:174`, a Durable Object Agent; `runScreen` at :346), reached from the REST screen routes, the NLQ stock-screen port (`src/agents/orchestrator/nlqPorts.ts:75`), and the autonomous scheduled callback. `DynamicMarketScreener.screenLive` (`src/trading/screener.ts:566`) also calls `acquireUniverse({mode:"all-listings"})`, but that path is explicitly unwired (`src/agents/routes/etradeBroker.ts:280` — "The Nasdaq-listings screenLive path is kept in the repo, unwired").

Provider calls, in order, per mode (`screenerPipeline.ts`):

- **etrade-only** (the production default for E*TRADE runs): symbols come from the caller (listings directory = membership only); quotes at :434 via injected `liveDeps.fetchETradeQuotes(chunk)` in batches (issue #495), then a bounded per-symbol retry pass at :484 via `liveDeps.fetchETradeQuote(symbol)`. No Nasdaq/Yahoo fallback inside this mode — partial results are qualified (`PartialQuoteQualification`, :171-186), never substituted.
- **live-quotes** (:268-287): `fetchTechnologySymbols()` (Nasdaq listings) → `fetchLiveQuotes` in `src/trading/liveScreener.ts:76` — E*TRADE-primary per-symbol with Nasdaq listing data as fallback (:103-114, `source: "Nasdaq (E*TRADE failed)"`).
- **yahoo** (:213-266): `fetchYahooQuotes` from `src/trading/yahooDataSource.ts` over caller symbols or `yahooUniverseListings()`; honest failure, no E*TRADE fallback.
- **all-listings** (:583+): `fetchAllUsStockListings()` from `src/services/nasdaqListings.ts`; quotes are derived from the listing rows themselves (no quote call).

Where the deps are bound to real providers — `src/agents/screener-agent.ts`:

- `screener-agent.ts:477-483` — `const etrade = provider === "etrade" ? new ETradeService(this.getOrm(), this.env, userLogin, req.environment) : null` — constructed inside the run, only for E*TRADE-provider runs.
- `screener-agent.ts:523,527` — `liveDeps = { fetchETradeQuote: (sym) => etrade.fetchQuoteRemote(sym), fetchETradeQuotes: (syms) => etrade.fetchQuotesRemote(syms, quoteTrace) }` — **the batch path is `ETradeService.fetchQuotesRemote`, the exact path with no raw hook (Q6).**
- `screener-agent.ts:510-518` — yahoo mode binds `yahooDepsFromProvider(new YahooFinanceProvider(this.env))`.
- `screener-agent.ts:535-544` — after acquisition: `screenUniverse(...)`, then `fetchTechnicalsBatch(...)` from `src/trading/yahooHistory.ts:173` — Yahoo historical bars/technicals fetched for every quoted symbol as a complement in **both** provider modes (this is the historicalBars/fundamentals-shaped composition the seeds describe, happening outside acquireUniverse).

Run identifier:

- `src/agents/screener-agent.ts:92-104` — `ScreenerRunResult` carries `timestamp`, `trigger`, `provider`, `universe` — **no run id field**. Runs are stored in DO storage history (`getLatestRun`/`getRunHistory`, :668-673) keyed by position, not id; the canonical `mas_reports` copy and its `report_id` are created later by orchestrator report dispatch (`src/agents/orchestrator/reportDispatch.ts:138`).
- `screener-agent.ts:~505` — one run-scoped object *does* exist at acquisition time: `QuoteTrace` (issue #816), already plumbed into `fetchQuotesRemote(syms, quoteTrace)`. It is a diagnostics trace, not an id, but it proves a per-run carrier can reach the batch call.
- Scheduled runs additionally have a task-ledger id (`beginScreenerTask(id)`, :271) minted by the caller before the run.

## 3. OTHER SCREENING ENTRY POINTS

- **Scheduled options manager** — `src/services/scheduledTasks.ts:724` constructs UnifiedOptionsService and executes `action:"opportunities"`; universes are resolved from listings/watchlists in the same file. No provider fetch outside Q1's path. (The `ScheduledOptionsManager` files under `src/client/` are UI only.)
- **NLQ options strategies** — VERIFIED post-#958: `src/agents/nlqOptionsStrategy.ts:585,814` calls the UnifiedOptionsService statics (`runStrategyPipeline`/`scanOpportunities`) with `etrade.client`, where `etrade` is an ETradeService constructed by the NLQ executor (`src/agents/nlq/execution.ts:465,1503`). Two direct fetches remain in that module outside the engines: `etrade.fetchQuoteRemote(symbol)` (:565, single-name quote for the strategy action) and `etrade.screenMarketsAsync(...)` / `etrade.getWatchlists()` (:735,751, universe/scope resolution).
- **NLQ screens (unified)** — `src/agents/nlq/execution.ts:73` → UnifiedOptionsService (Q1 path); canonical copy to `mas_reports` as above.
- **MCP / premium** — `src/mcp/agenticPaymentCommands.ts:149` and `src/agents/routes/premium.ts:161` → UnifiedOptionsService (Q1 path). No separate fetches.
- **Discovery (epic #14 pipeline)** — does NOT go through UnifiedOptionsService execution: the service's `discovery` action delegates to `createDiscoveryService({…, sql: this.discoverySql})` (`unifiedOptionsService.ts:~478-490`, dynamic import of `src/services/discoveryService.ts`). That service constructs **its own** ETradeService (`src/services/discoveryService.ts:337-338`), builds `new DynamicOptionsScreener(etrade.client)` (:349), and composes two non-E*TRADE fetches directly: `fetchBars: (symbol) => fetchYahooDailyHistory(symbol)` (Yahoo bars) and `flowFor: (symbol) => fetchRealMarketFlowsForSymbol(symbol)` (:350-352). So discovery fetches chains through the same client seam but assembles its providers itself.
- **FOSS/Yahoo stock screen** — `src/agents/routes/fossResearch.ts:~207-212` executes through ScreenerAgent with provider `"yahoo"` (Q2 yahoo mode) and stores a canonical mas_reports report. `FossResearchService` itself (status surface) fetches no screening data.
- **IV history collector** — `src/trading/options/ivCollector.ts:199` takes an injected `fetchChain(symbol)` dep; it fetches chains outside both paths above, through whatever its wiring supplies.
- **Direct chain reads (not screening, noted for completeness)** — `src/agents/routes/etradeOptions.ts:243` reads a single chain via `TradingPlatformRegistry.getPlatform("etrade", …).getOptionChains(...)` — note this is the *trading-platform* registry (#291), a different registry from the data-provider platform; also `src/agents/routes/etradeOptionsEvaluate.ts:57,83` and `src/services/hedgeProposals.ts:346` call `getOptionChains` directly.

## 4. PLATFORM SURFACE AS IT EXISTS NOW

- `src/trading/dataProviders/registry.ts:141-162` — `resolveRoute(capability, configs: readonly ProviderConfigRecord[], routes: readonly CapabilityRouteRecord[]): CapabilityAssignment` where `CapabilityAssignment = { capability, primary: DataProvider, gapFill?: DataProvider }` (:66). With a route row it returns the route's primary (+ gapFill only if the gap-fill is itself servable); without one it falls back to precedence `resolve()`. Servability (`registry.ts:104-114`): config row exists AND `lifecycleState === "enabled"` AND `enabled === true` AND adapter registered AND capability declared — otherwise the provider is invisible; an unservable primary throws `DataProviderNotFoundError` (gap-fill is never promoted).
- `src/trading/dataProviders/contract.ts:175-207` — the `DataProvider` interface methods: `getQuote`, `getOptionsChain`, `getScreenUniverse`, `getHistoricalBars`, `getFundamentals`, `getNews`, each returning `DataResult<T>` (`:142-146` — `{ providerId, capability, result }`) and each taking an optional trailing `DataRunContext`. **There is no batch-quotes method anywhere in the contract.**
- `src/trading/dataProviders/contract.ts:158-162` — `DataRunContext = { runId?: string; tenantId?: string; userLogin?: string }`, all optional; `captureStore.resolveRunContext` fills a missing runId with a generated `collection-<uuid>` id and a missing tenant with `"default"`.
- `src/trading/dataProviders/adapters.ts:138` — etrade factory: `createETradeDataProvider(service: ETradeDataSurface, options?: { capture?: ETradeCaptureDeps })`. The adapter declares capabilities `["quotes","optionsChains"]` only (:146) and implements exactly `getQuote` and `getOptionsChain`. Its wrapped surface is `Pick<ETradeService, "getQuoteAsync" | "getOptionChains" | "getStatus">` (:71-74) — **`fetchQuotes`/`fetchQuotesRemote` are not on the surface at all.** The capturing `getQuote` calls `service.getQuoteAsync(symbol, { includeRawResponse: true })` (adapters.ts:152; service hook at `src/services/etrade.ts:145-149`).
- Capture deps a call site must supply (`adapters.ts:83-88`): `ETradeCaptureDeps = { sql: SqlStorage; blobStorage: CaptureBlobStorage; env: CaptureBlobEnv; retentionClass? }`, where `CaptureBlobStorage` is a DO-storage-shaped `{ get, put }` and `CaptureBlobEnv = { REPORTS_BUCKET?: R2Bucket }` (`captureStore.ts:140-148`). `SqlStorage` is the interface at `src/orm/index.ts:29` — the same shape as `ctx.storage.sql` in a Durable Object.
- What the E1 tests supply vs. what call sites have: tests build deps from `MockSqlStorage` + an in-memory fake blob storage + `env: {}` (`tests/data_provider_capture_e1.test.ts:213-221`). Production call sites:
  - ScreenerAgent (Q2) has everything: `this.env`, `this.ctx.storage` (DO storage, incl. `.sql` used at `screener-agent.ts:181`) — full capture deps are suppliable today.
  - The unified options REST route (`etradeOptionsScreen.ts:176`) has `ctx.env` + `ctx.agentCtx.storage.sql` + `ctx.agentCtx.storage` — full deps suppliable.
  - UnifiedOptionsService's other constructors (premium, trading-agent, NLQ, MCP, scheduledTasks) pass only env/orm (+scanRunStore for scheduled) into the service — the service's constructor has **no storage parameter at all**, so capture deps cannot reach the ETradeService it builds internally without a constructor change.
  - The platform config/capture tables (`mas_data_providers`, `mas_data_provider_routes`, `mas_data_captures`) all live in whichever DO's SQLite the caller passes — there is no D1 and no global instance; each DO that seeds gets its own config/capture universe.

## 5. ENABLEMENT STATE

- `src/trading/dataProviders/providerConfigStore.ts:240-290` — `DEFAULT_PROVIDER_SEEDS`: etrade/yahoo/nasdaq/alpaca are `lifecycleState: "configured"`, public is `"registered"`, and **every seed has `enabled: false`** (:245,256,265,274,283). The module states the rule at :234-238: "NOTHING is seeded enabled: enablement is a deliberate lifecycle act (P4), never a seed default."
- `providerConfigStore.ts:434-440` — `DEFAULT_CAPABILITY_ROUTES` does seed the composition (screenUniverse←nasdaq, historicalBars←yahoo, quotes←etrade + yahoo gap-fill, optionsChains←etrade, fundamentals←yahoo), and `seedProviderConfigs(sql)` (:299-308) inserts seeds + routes idempotently — **but only when something calls it with a SqlStorage handle, and nothing in `src/` does** (Q4 headline).
- Therefore `resolveRoute("quotes", …)` in production today returns nothing: there are no config rows (no store has been seeded), no adapter is registered anywhere, and even after seeding, resolution throws `DataProviderNotFoundError` until a runtime lifecycle act writes etrade's row to `lifecycleState: "enabled"` with `enabled: true` (via `setProviderLifecycleState`/`setProviderEnabled`, providerConfigStore.ts:203-231) — in the same DO SQLite instance the caller reads configs from. E3 (provisioning lifecycle) is the planned owner of that act; E2 must either depend on it or include a minimal enablement step of its own.

## 6. BATCH RAW HOOK

- `src/services/etrade.ts:468-479` — `ETradeService.fetchQuotesRemote(symbols, trace?)`: live-only (returns `[]` in sandbox), delegates verbatim to `this.client.fetchQuotes(clean, { trace })`. There is **no** non-remote `ETradeService.fetchQuotes`; the batch entry points are `fetchQuotesRemote` (service) → `ETradeRestClient.fetchQuotes` (client).
- `src/trading/etrade/client.ts:338` — `fetchQuotes(symbols, options?: { overrideSymbolCount?: boolean; trace?: QuoteTrace })`. Internally it sub-batches at 10 symbols per HTTP request (:383-388), does `const data = await res.json()` per sub-batch (:423), reads `data.QuoteResponse.QuoteData` (:424), maps each item to a normalized `ETradeQuote` (:433+), and **discards the parsed payload** — no `raw` is attached anywhere and the return type is `Promise<ETradeQuote[]>`, so the wire response is unrecoverable by any caller today.
- What a hook needs, mirroring the single-quote path: `fetchQuoteDetailed(symbol, { includeRawResponse })` (client.ts:156) attaches the whole parsed `res.json()` object as `ETradeQuote.raw` (type field exists, `src/types.ts`, added by E1; service forwarding at `src/services/etrade.ts:145-149` via `getQuoteAsync`/`fetchQuoteRemote`). The batch mirror is an `includeRawResponse` option on client `fetchQuotes` + forwarding through `fetchQuotesRemote`, attaching raw per quote — with one design wrinkle the single path doesn't have: the wire payload is **per sub-batch of 10**, not per symbol, so per-quote `raw` either duplicates the whole sub-batch payload onto each of its ≤10 quotes or carries only that symbol's `QuoteData` item (which loses wire-only siblings/wrapper fields — the very thing E1's fixture proves capture must keep). The adapter side additionally needs the batch method added to the contract (`DataProvider` has no batch method), to `ETradeDataSurface`, and a capture call per batch in the adapter.

---

## E2 SCOPE IMPLICATIONS

**Minimal call sites E2 must touch**

1. **Options:** `UnifiedOptionsService.execute()` (`unifiedOptionsService.ts:435-437`) — the single construction point for all six entry points. Route the client (or the engines) through the platform here and every options entry point inherits it. But capture deps can only be supplied where the constructor grows a storage seam; today only the REST route construction (`etradeOptionsScreen.ts:176`) and the scheduled path (via orchestrator-constructed stores) have a DO storage handle to give. The other four constructors (premium, trading-agent, NLQ, MCP) would run the platform uncaptured unless their callers are also touched.
2. **Stocks:** `ScreenerAgent.runScreenInner` (`screener-agent.ts:477-527`) — the single place `liveDeps`/`yahooDeps` are bound. This is also where capture deps are fully available (`this.ctx.storage`, `this.env`). The platform seam is the deps-binding, not `acquireUniverse` itself (which is provider-mode-driven and shared with tests).
3. **Discovery** (`discoveryService.ts:337-352`) — optional for E2's core scope, but it is a third independent ETradeService construction composing E*TRADE chains + Yahoo bars itself; leaving it out means "all screening through the platform" is not literally true.

**What the platform still lacks for those call sites**

- **A batch quotes capability end-to-end**: contract method, `ETradeDataSurface` member, adapter implementation, and the client wire hook (Q6). Without it, routing the stock screener through the platform forces either per-symbol quotes (regressing the #495 subrequest/rate-limit fix — the failure mode is documented at `screenerPipeline.ts:425-432`) or an uncaptured batch side-channel.
- **Provider coverage for the stock composition**: the nasdaq adapter exposes listings (`getScreenUniverse`) and the yahoo adapter bars/fundamentals/quotes via the FOSS surface, but the screener's actual Yahoo use is per-symbol **technicals from history** (`fetchTechnicalsBatch`, yahooHistory.ts:173) and gap-fill **quotes** — the routing seeds describe this composition, but no adapter method reproduces `fetchTechnicalsBatch`'s output shape (`StockTechnicals`), and `acquireUniverse`'s partial-qualification semantics (#462) have no counterpart in `DataResult`.
- **Enablement**: no seeded store, no enabled provider, no production registry construction (Q5). E2 cannot resolve a single route in production until seeding + enablement happen somewhere.
- **A run id at fetch time**: both paths mint their run/report ids only at persistence (Q1, Q2). Captures from a cutover scan would land under generated `collection-<uuid>` ids unless E2 mints a run id before acquisition and threads it through `DataRunContext` into both the persistence layer and the adapter — in the options path that also means generating the scan-run id before, not inside, `scanRunStore.save`.
- **A home for the config/capture tables**: they live per-DO SQLite. ScreenerAgent and the orchestrator DO are different objects with different `storage.sql`; E2 must pick which DO('s) own provider config and captures, or captures fragment across DOs.

**Decisions the parent must make before building**

1. **Enablement ownership**: does E2 ship a minimal seed+enable step for etrade (pulling part of E3 forward), or does E2 land dark (routing code present, resolution still throwing until E3 enables)? This decides whether E2 is verifiable end-to-end in production.
2. **Batch raw shape**: per-quote `raw` = whole sub-batch wire payload (faithful, ~10× duplication) vs. per-symbol `QuoteData` item (compact, loses wrapper/wire-only fields and weakens E1's byte-faithfulness claim).
3. **Which DO owns platform state** (config + captures): orchestrator DO, ScreenerAgent DO, or both-with-fragmentation accepted.
4. **Cutover shape for options**: platform supplies the *client* the engines already consume (adapter wraps ETradeService; engines unchanged) vs. engines rewritten to consume `DataProvider` methods (the engines need expiry dates + chains; the contract has no expiry-dates method — `getOptionChains` is the only chain-shaped method, and `DynamicOptionsScreener` also calls `getOptionExpireDates`, which has no platform counterpart).
5. **Scope line**: discovery service and the IV collector in or out of E2; both fetch provider data outside the two main paths.
