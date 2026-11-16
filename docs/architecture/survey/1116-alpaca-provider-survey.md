# Alpaca provider slice — survey (epic #1116, add-provider slice 3)

**Survey base:** main `01badf8a` ("docs: add stock and options screening capability architecture and RSI enablement spec"), read 2026-10-24 via a detached worktree at `~/workspace/walpaca/wt`. **PR #1384 (nasdaq slice #1368) was still in CI at survey time — NOT merged.** Every claim below is verified against this base; the build agent must re-verify freshness at dispatch, and the build base must be post-#1384 main.

**Headline finding (read first):** unlike Yahoo (#1317) and Nasdaq (#1368), Alpaca has **no screen-path direct call sites to cut over**. The screener never fetches Alpaca in its screen paths, there is no "alpaca" screen mode, and no seeded route names alpaca for any capability. The slice is therefore **enablement-shaped** (verifier + binding + capture-ready construction + conformance + panel-no-change) — NOT a reroute — unless the owner directs a route change. That route decision is the one open question that reshapes the slice (see §9).

## 1. Alpaca adapter state

- **Exists.** `createAlpacaDataProvider` at `src/trading/dataProviders/adapters.ts:769` — a one-line wrapper over the shared FOSS factory: `createFossDataProvider("alpaca", "Alpaca Markets", provider, env, options)` (`adapters.ts:774`).
- **Id / name:** `"alpaca"` / `"Alpaca Markets"` (`adapters.ts:774`).
- **Declared capabilities:** `["quotes", "historicalBars", "fundamentals"]` (`adapters.ts:644`, shared FOSS return object; pinned in `tests/data_provider_platform_p1.test.ts:738`).
- **isConfigured:** delegates to the wrapped provider's `isConfigured(env)` (`adapters.ts:645` → `src/services/fossResearch.ts:2300` — true only when BOTH a key and a secret are present; see §6).
- **Fetcher:** injectable — the factory takes an `IFossMarketDataProvider` as its first argument (`adapters.ts:640-646`); production passes `new AlpacaMarketDataProvider(ctx.env)` (`src/agents/routes/dataProviders.ts:124`). The wrapped module is `AlpacaMarketDataProvider` in `src/services/fossResearch.ts:2284` (see §5).
- **Capture wiring: seam present, NOT wired in production.** The factory accepts `options.capture` (`FossDataProviderOptions`, `adapters.ts:632`) with recorder derived from `capture.sql` when capture is wired (`adapters.ts:648-651`), rawKind `"provider-result"`, blob failure → `capture_failed` marker via `recordCapture`, throwing fetch → `fetch_failed` via the decorator + identical rethrow (`adapters.ts:606-631` header comment states the semantics). But the **only production construction** (`src/agents/routes/dataProviders.ts:124`) passes NO options — no capture, no recorder. Test constructions (`tests/data_provider_platform_p1.test.ts:447,578,738,772,807`) likewise pass no capture. This is exactly the pre-slice state Yahoo/Nasdaq were in before their slices.
- **OutcomeRecorder: injection only, today.** Same factory option (`adapters.ts:643`); nothing passes one for alpaca in production. The routes verifier already derives a capture-store recorder from sql for OTHER providers (`src/agents/routes/dataProviders.ts:155-157`) — the alpaca binding reuses that.
- **Batch gap (capability note, not a conformance blocker):** the factory adds `getQuotesBatch` only when the wrapped provider offers `getQuotes` (`adapters.ts:699-713`). `AlpacaMarketDataProvider` has NO `getQuotes` method (method list `fossResearch.ts:2284-2710`: `getQuote`, `getFundamentals`, `getHistoricalBars`, `getMarketSnapshot`, plus trading methods) — `getQuotes` at `fossResearch.ts:1990` belongs to `YahooFinanceProvider` (class range `1829-2284`). The interface `IFossMarketDataProvider` (`src/patterns/interfaces.ts:127-136`) does not declare `getQuotes` at all. So the alpaca adapter exposes single-symbol `getQuote` only. The conformance kit checks `getQuote` for the quotes capability (`src/trading/dataProviders/conformance.ts:197-198`) — no batch requirement — so this does not block verification. It DOES mean any future batch-quotes consumer via alpaca must either use per-symbol `getQuote` or gain a `getQuotes` on the FOSS provider (new work in `fossResearch.ts`, out of this slice unless directed).

## 2. Seed + route state

- **Seed exists, configured/disabled.** `src/trading/dataProviders/providerConfigStore.ts:302-311`: id `"alpaca"`, adapterKind `"alpaca-market-data"`, `lifecycleState: "configured"`, `enabled: false`, `precedence: 5` (last in owner order), `credentialRef: "env:ALPACA_API_KEY"`, `config: { dataUrl: "https://data.alpaca.markets" }`.
- **Bootstrap deliberately does not enable it.** `bootstrapDataProviders` enables ONLY etrade; "yahoo/nasdaq/alpaca stay `configured`/disabled … until their own lifecycle acts" (`providerConfigStore.ts:557-560`).
- **No seeded route names alpaca — for ANY capability.** `DEFAULT_CAPABILITY_ROUTES` (`providerConfigStore.ts:523-529`):
  - `screenUniverse` ← nasdaq, gap-fill null
  - `historicalBars` ← yahoo, gap-fill null
  - `quotes` ← etrade primary + yahoo gap-fill
  - `optionsChains` ← etrade, gap-fill null
  - `fundamentals` ← yahoo, gap-fill null
  - All freemium. Alpaca appears in none, primary or gap-fill.
- **Consequence:** the slice changes NO seeded route unless the owner directs one (see §9). An operator CAN upsert a route naming alpaca after the slice (the E3 lifecycle API supports it), but the slice itself must not invent a composition role.

## 3. Verifier state

- **No `verifyAlpacaDataProvider` exists.** Grep over `src/` + `tests/` returns zero hits.
- **No binding exists.** `buildDataProviderVerifier` (`src/agents/routes/dataProviders.ts:151-171`) binds etrade (`:159`), public (`:163`), yahoo (`:168`) and returns `undefined` otherwise — alpaca hits the `noAdapterVerifier` honest failure (`:174-176`). The screener-agent verifier call site (`src/agents/screener-agent.ts:596`) binds yahoo only (inside the yahoo screen-mode block, `screener-agent.ts:591-610`).
- **Slice work (mirroring `verifyYahooDataProvider`, `adapters.ts:785-812`):** `verifyAlpacaDataProvider(env, { provider?, outcomeRecorder? })` — injectable provider for tests, production constructs the real `AlpacaMarketDataProvider` from env; `isConfigured` false → honest `ok: false` (NOT configured-by-construction: unlike nasdaq's public feed, alpaca requires deploy-time keys — see §6); then the P1 conformance kit over the adapter; kit failure → `ok: false` with the failure list, never a silent pass. Bind in BOTH `buildDataProviderVerifier` and any lifecycle verify path that needs it.
- **Pin-registration device (known in advance):** the P1/P1247 verifier-matrix test at current main reads "binds public (and binds yahoo; alpaca stays unbound)" (`tests/data_provider_public_p1247.test.ts:1231`). After this slice, NO provider among the five remains unbound — the matrix test must be adapted (unbound case moves to an unknown provider id returning `undefined`), disclosed as an additive pin registration in the same PR, intent unchanged.

## 4. Direct call sites to cut over

**None in any screen path.** Verified by grep, not assumed:

- `src/agents/screener-agent.ts`, `src/trading/screenerPipeline.ts`, `src/services/shardExecutors.ts`, `src/trading/etradeOptionsScreen.ts`, `src/services/screeningRuntime.ts`: **zero** `alpaca` references, and **zero** `FossResearchService` / `HybridFossProvider` references. The stock screener's FOSS leg is Yahoo-only (`YahooFinanceProvider` import at `screener-agent.ts:45`; `shardExecutors.ts:129`).
- `src/services/scheduledTasks.ts`: zero `alpaca` references (options_analysis universe resolution is nasdaq-listings, a #1378 item, not alpaca).
- String search for `"alpaca"` across `src/trading/`, `src/agents/screener-agent.ts`, `src/services/screeningRuntime.ts`, `src/services/screenerResearch.ts` finds only: the adapter factory (`adapters.ts:644,774`), the contract id list (`contract.ts:78`), the seed (`providerConfigStore.ts:302`), the trading-platform registry (`src/trading/index.ts:22`, `src/trading/interfaces.ts:25`, `src/trading/agent.ts:25`) — none of which is a screen-path fetch.

**Where Alpaca IS consumed today (all residuals — name, don't absorb):**

- `src/services/fossResearch.ts:2710` `HybridFossProvider` — merges Alpaca real-time L1/L2 quotes + NBBO spreads with Yahoo fundamentals; `FossResearchService` (`fossResearch.ts:2791`) holds all three providers, default `"hybrid"`. Consumers: NLQ, orchestrator, MCP `fossCommands`, research paths. No `getProvider("alpaca")` caller exists anywhere — alpaca's market data reaches users via hybrid composition, not direct selection.
- `src/agents/routes/alpaca.ts` — the `/trading/alpaca/*` (order/account/positions/orders) and `/foss/alpaca/*` route groups (trading + FOSS snapshot/account/positions/orders). These are trading + research routes, not screens.
- `src/services/marketStream.ts:123-133` — a DIRECT Alpaca REST fetch for real-time quotes (env keys, `ALPACA_DATA_URL || "https://data.alpaca.markets"`). Ticker/stream path, not a screen path — residual candidate, not this slice.
- `src/trading/alpaca/platform.ts` — `AlpacaTradingPlatform` (orders/account/positions, `ITradingPlatform`), registered in `TradingPlatformRegistry` (`src/trading/index.ts:22`). This is the TRADING platform, a different component from the market-data provider — the slice must not conflate them. Adjacent: CISO #930 (see §7) already owns a status bug in this class (`getStatus` self-reports `broker: "etrade"`, `platform.ts:30`).

## 5. Existing Alpaca modules (reuse-before-build)

- **Market data (the fetcher — REUSE, do not duplicate):** `AlpacaMarketDataProvider`, `src/services/fossResearch.ts:2284-2710`. Methods: `getQuote`, `getFundamentals`, `getHistoricalBars`, `getMarketSnapshot` (market-data surface) + `placeOrder`, `getAccount`, `getPositions`, `getOrders` (trading surface — the platform adapter exposes ONLY the market-data surface; the trading methods stay out of the adapter). The module stays as the adapter's fetcher; the slice wires capture/verifier/binding around it and cuts over NO call sites (there are none in scope — see §4).
- **Trading platform (NOT the slice's component):** `src/trading/alpaca/platform.ts` (`AlpacaTradingPlatform`, `ITradingPlatform`). Registered, and its `getStatus` bug is CISO #930's — leave it alone.
- **No new client, REST, or websocket module is needed.** The provider already speaks REST via fetch; no new transport code is in scope.

## 6. Credentials / config

- **Today (deploy-time Worker env, names only — no values recorded here, none observed):** `ALPACA_API_KEY` or `ALPACA_API_KEY_ID` for the key, `ALPACA_SECRET_KEY` or `ALPACA_API_SECRET_KEY` for the secret (`fossResearch.ts:2292,2297`). `isConfigured` = key AND secret both present (`fossResearch.ts:2300-2302`). Data URL: `ALPACA_DATA_URL || "https://data.alpaca.markets"` (`fossResearch.ts:2305`, matching the seed config). Trading URL: `ALPACA_BASE_URL || "https://paper-api.alpaca.markets"` (`fossResearch.ts:2309`) — **paper is the default**; `AlpacaTradingPlatform.getStatus` treats live as "base URL does not contain `paper-api`" (`platform.ts:28`). Paper-vs-live is therefore an env property, not a provider-config flag — the slice must not invent a paper/live toggle in the provider record.
- **Platform credential-REFERENCE model implication:** the seed already stores the reference `env:ALPACA_API_KEY` (never a value). The E3 lifecycle validates reference FORMS only (`env:NAME` / `sessionstore:…` / bare `NAME`; secret-shaped values rejected — `src/trading/dataProviders/lifecycle.ts:52-54,220-221`). The slice's verifier therefore resolves the env reference through the provider's own `isConfigured` + kit — it must never accept, store, or echo a key/secret value, and test fixtures needing key-shaped values must be fragment-assembled at runtime (Gitleaks scans the full PR range; see the issue draft's test plan).

## 7. Lane-claim check (read-only)

- **Open-issue search for an alpaca provider slice: none found.** Connector `search_issues` for "alpaca provider slice" (open) → 0 items; for "alpaca" (open) → 0 items via the connector. Public GitHub search API (`repo:OpenAIMP/cfagent + alpaca + state:open`) → 15 issues, NONE of which is an alpaca provider slice: #913 + CISO sub-issues (#923, #924, #927, #929, #930 — provenance programme), epic #1116 itself, #768 (secrets inventory), #798 (RSI-Data plan), #430 (coordination), #291, #319, #764, #1362, and PR #1384 (the nasdaq PR, which mentions alpaca only as queue context).
- **Epic #1116 comments: no alpaca claim.** All 12 comments read (public API, 2026-10-24). Alpaca appears only as: provider-set member #5 (`6358627401`), sequence list "then: add-provider slices for public, yahoo, nasdaq, alpaca, in the owner precedence order" (`6358677258` — the epic ANTICIPATES the slice, claims it to no lane), composition seeds (`6358714200`), and the #1317 filing note (`6382349469`). Newest comments are the #1317 filing (`6382349469`) and the #1368 filing (`6384525555`). No alpaca slice filed, no lane claim.
- **Adjacent, NOT overlapping:** #930 (`[#913 S12] Provenance labeling … Alpaca status …`, label `lane:ciso-bhdm`, open) — its alpaca lines concern `AlpacaTradingPlatform.getStatus` self-reporting `broker: "etrade"` and config-vs-code matching. That is the trading platform's status surface, not the market-data provider slice. The slice build must not touch it, and #930 landing first would not change the slice.

## 8. Panel

- **No panel change expected (to be pinned, as with #1317/#1368).** `src/client/DataProvidersPanel.tsx` renders generically: `providers.map((view) => …)` (`:204`), `data-provider-id={view.id}` (`:211`), health by capability (`:273`), routes (`:288`), actions (`:328`). Its only `alpaca` mention is a placeholder example (`:402`, `placeholder="e.g. alpaca"`).
- **GET already serves alpaca:** the routes registry registers the alpaca adapter today (`src/agents/routes/dataProviders.ts:124`), so GET returns the alpaca record (configured/disabled + health block) with no handler change — the slice's acceptance is that GET renders alpaca **enabled + health** after verify→enable, pinned, with zero panel edits.

## 9. The one decision that reshapes the slice

Because §4 finds no screen-path cutover, the slice as surveyed is:

1. characterization pins first (adapter shape, capture semantics on a capture-wired construction, verifier shapes);
2. `verifyAlpacaDataProvider` + binding in `buildDataProviderVerifier` (and the lifecycle verify path);
3. capture-ready construction: the production alpaca construction(s) gain capture deps where a fetch actually runs — at minimum the verifier probes gain outcome rows via the existing sql-derived recorder, and the adapter-level capture pins prove capture-wired constructions write rows;
4. conformance parity field-for-field over the injected provider;
5. lifecycle verify→enable via the routes API (session-gated 401 shape preserved);
6. panel renders alpaca enabled + health, no panel change (pinned);
7. tsc clean; exact A/B delta; Gitleaks-clean fixtures.

**What it is NOT, without an owner direction:** no seeded-route change (§2), no screen-path change (§4), no batch-quotes addition (§1), no paper/live toggle (§6), no trading-platform work (§4/#930), no #1378 residuals (screenLive threading, feed-shard route resolution, remaining listings sites — explicitly out of scope).

**If the owner directs a composition role for alpaca** (e.g. quotes gap-fill behind etrade, or an alternative bars/fundamentals source), THAT becomes the slice's cutover: a seeded-route change + a consumer binding (screener-agent block or equivalent) + per-element provenance pins for the gap-fill — scoped as an amendment to the issue, not silently absorbed. The build agent must not invent this role.

## Traceability

- Epic #1116; sequence comment `6358677258` (alpaca last in owner precedence order).
- Prior slices: P1 #1118, E1 #1133, E2 #1157, E3 #1170, E4 #1180, E5 #1202, E5b #1206, E6 #1235, E7 #1248, Public #1247, Yahoo #1317, Nasdaq #1368 (PR #1384, in CI at survey time).
- Follow-ups NOT folded in: #1378 (nasdaq residuals); #930 (CISO, adjacent only).
- Survey base: main `01badf8a`, 2026-10-24. Build base must be post-#1384 main; re-verify freshness at dispatch.
