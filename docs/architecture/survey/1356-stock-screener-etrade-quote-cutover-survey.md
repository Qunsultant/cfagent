# Survey — Issue #1356: stock-screener liveDeps E*TRADE quote cutover (epic #1116)

Survey base: main `9cb6b129` ("docs(1276): gitops §9 sizing reconciliation"), read 2026-10-25 via
detached read-only worktree `~/workspace/w1356/wt`. Every claim below carries a file:line or a
GitHub reference. No code was changed, no branch created, no issue filed, no message sent.

## 0. Headline — the issue's premise needs one correction before the build starts

**E2 already platform-routed the screener-agent etrade leg and the feed shard.** The thing left
to cut over is not a direct broker fetch — it is the **broker-shaped seam itself**:

- `bindETradeScreenerDeps` (`src/trading/dataProviders/adapters.ts:588`, E2 #1157) already binds
  the platform etrade adapter (`createETradeDataProvider(service, { capture, trace })`) and
  returns `fetchETradeQuote` → `provider.getQuote` and `fetchETradeQuotes` →
  `provider.getQuotesBatch`, both carrying the run's `DataRunContext`, "so every quote the run
  acquires is captured under the run's id" (adapters.ts:571-593, doc comment).
- Its only production consumers are the screener-agent etrade block
  (`src/agents/screener-agent.ts:601-615`) and the feed shard
  (`src/services/shardExecutors.ts:121-133`).
- So #1356 is **a seam replacement, not a fetch reroute**: replace the `LiveScreenerDeps`
  option (`src/trading/screenerPipeline.ts:162`) with a route-resolved platform quote binding
  (the #1317 shape: route-table reader + bind helper + pipeline deps option), and delete the
  broker-shaped seam. The build must not "discover" a direct fetch that is not there, and must
  not claim capture as new where E2 already provides it — the new value is **route resolution +
  gap-fill composition + seam deletion**, with capture/outcome/provenance preserved and
  extended to the gap-fill leg.

## 1. Issue + lane-claim check

- **Issue #1356** — "feat(providers): Route stock screener E*TRADE quote leg through the
  platform (liveDeps cutover, epic #1116)", state **open**, label `lane:cdo-mha7`, body signed
  `#CDO-mha7`. Scope per the body: characterization pins first; reroute `acquireUniverse`
  live-quotes/etrade-only legs through the platform (bootstrap + bind, E2/#1317 pattern);
  delete the `liveDeps` seam and its direct ETradeService construction in the screen path;
  capture + outcome + per-element provenance; conformance parity field-for-field.
  Acceptance: identical quotes via the platform; capture + outcome rows with per-element
  provenance; `liveDeps` deleted, zero direct ETradeService constructions in the stock screen
  path, tsc clean, exact A/B delta; **etrade-only still refuses fallback**.
- **Issue comments: none.** Zero comments on #1356 at survey time — no lane claim, no owner
  direction, no scope amendment in comments.
- **Epic #1116 comments: 13 total, none mentions #1356.** The last three are the add-provider
  filings (#1317 comment 6382349469, #1368 comment 6384525555, #1385 comment 6385322036).
  No #1356 claim on the epic.
- **Open-issue search for `liveDeps` (title/body): 3 hits, no competing slice** — #1356 itself
  (open), #1165 (closed, the E2 PR issue), #1157 (closed, E2). No duplicate or overlapping
  open issue.
- **Verdict: no lane claim found. #1356 is CDO's, uncontested.**

## 2. The liveDeps seam, precisely

### Definition

- `LiveScreenerDeps` — `src/trading/liveScreener.ts:16-26`: broker-shaped deps,
  `fetchETradeQuote: (symbol) => Promise<ETradeQuote>` (throws on failure, required) and
  optional `fetchETradeQuotes?: (symbols) => Promise<ETradeQuote[]>` (#495 batch, one
  authenticated request per symbol list; callers diff the request against the result to find
  missing symbols).
- Pipeline option — `src/trading/screenerPipeline.ts:162`: `liveDeps?: LiveScreenerDeps`,
  documented "live-quotes / etrade-only: E*TRADE fetcher (required for these modes)".
- E2 binding — `src/trading/dataProviders/adapters.ts:588-610`: `bindETradeScreenerDeps(
  service: ETradeDataSurface, capture: ETradeCaptureDeps, runContext: DataRunContext,
  trace?: QuoteTrace)`. Doc comment states the binding lives in adapters.ts (not
  screener-agent.ts) because screener-agent.ts extends the real `agents` Durable Object base
  and cannot be imported under vitest (native `cloudflare:` scheme) — "the binding must stay
  unit-pinnable" (adapters.ts:581-586). **The #1356 replacement binding must live in the same
  pinnable location, not in screener-agent.ts.**

### Construction (what credentials/env)

- Screener-agent etrade block — `src/agents/screener-agent.ts:525-533`: the ETradeService is
  constructed **only for E*TRADE-provider runs** (`provider === "etrade" ? new ETradeService(
  this.getOrm(), this.env, userLogin, req.environment) : null`), with the #1007 comment:
  "A Yahoo-provider run never touches the broker (no credentials read, no token lookup) and
  never falls back to it."
- The service is then wrapped with capture deps — `src/agents/screener-agent.ts:601-615`:
  `bootstrapDataProviders(this.ctx.storage.sql)`, `platformRunId ??= crypto.randomUUID()`,
  `bindETradeScreenerDeps(etrade, { sql: this.ctx.storage.sql, blobStorage: this.ctx.storage,
  env: this.env }, { runId: platformRunId, userLogin }, quoteTrace)`. The run id is minted
  BEFORE fetch (here or by the earlier nasdaq block via `??=`), and capture + QuoteTrace ride
  along through the adapter options.
- Feed shard — `src/services/shardExecutors.ts:121-133`: `bindETradeScreenerDeps` bound the
  same way (bootstrap + capture + chain-id-as-run-id per the #1355 pattern); throws
  "Feed shard etrade blocked: nasdaq shard has no completed listings result" when the sibling
  listings result is absent (sibling contract, pinned in #1368).

### Consumers (all of them)

| Consumer | Site | Mode / path | Already platform-routed? |
|---|---|---|---|
| Screener-agent `runScreenInner` | `src/agents/screener-agent.ts:661-673` (`acquireUniverse({ mode: "etrade-only", liveDeps: platformLiveDeps! })`) | etrade-only (the live production stock leg; scheduled stock screens delegate here, `src/services/scheduledTasks.ts:621-624`) | **Yes — E2 binding + capture** |
| Feed shard `feedEtrade` | `src/services/shardExecutors.ts:121-133` | sharded scheduled stock runs | **Yes — E2 binding + capture** |
| Pipeline `live-quotes` branch | `src/trading/screenerPipeline.ts:642-668` | `mode: "live-quotes"` via `fetchLiveQuotes(symbols, opts.liveDeps, maxSymbols)` (`src/trading/liveScreener.ts:83`) | No live caller in production src (see §3) |
| Tests only | `tests/screener_pipeline.test.ts:205,222` (live-quotes), `:233-378` (etrade-only) | fixtures | n/a |

- **No other production constructor of `LiveScreenerDeps` exists.** The only
  `fetchETradeQuote:` object-literal definition in src is the E2 binding itself
  (`adapters.ts:596`); the other hit is the interface declaration (`liveScreener.ts:18`).
- `screenLive` (`src/trading/screener.ts:566`) does **not** consume liveDeps — it calls
  `acquireUniverse({ mode: "all-listings" })` only. `screeningRuntime.ts:99-103` wraps
  `screenLive` (all-listings, no quotes). Neither is a #1356 consumer.
- Stale comment to fix in the build: `acquireUniverse`'s doc comment
  (`src/trading/screenerPipeline.ts:573-576`) still says "Manual uses all-listings; the
  scheduled job uses live-quotes." The scheduled job now delegates to ScreenerAgent
  etrade-only (`scheduledTasks.ts:621-624`). The build should correct this comment when it
  rewrites the legs.

## 3. Quote shapes, partial qualification, honest failure — per consumer

### Quote shape

- `ETradeQuote` — `src/types.ts:403-445`: `symbol`, `companyName`, `lastPrice`,
  `price?`, `change`, `changePercent`, `bid`, `ask`, `bidSize?`, `askSize?`, `volume`,
  `averageVolume?`, `open`, `high`, `low`, `previousClose?`, `peRatio?`, `marketCap?`,
  `week52High?`/`week52Low?`, `high52?`/`low52?`, `rsi?`, `macdSignal?` (Yahoo-adapter data
  field only; snapshot providers leave it unset), `sector?`, `listingExchange?`, `source?`,
  `quoteStatus?`, `dateTime?`, `timestamp` (required), `raw?` (capture-only wire payload,
  stripped before the quote travels further — present only on the explicit
  `fetchQuoteDetailed`/`includeRawResponse` path).
- Batch vs single: `getQuotesBatch(symbols)` → `ETradeQuote[]` (#495: one authenticated
  request per symbol list); `getQuote(symbol)` → single `ETradeQuote`. The pipeline uses
  batch first when `fetchETradeQuotes` exists, per-symbol for stragglers/omissions.

### etrade-only leg (`screenerPipeline.ts:748-953`)

- Truncation: `limited = maxSymbols > 0 ? symbols.slice(0, maxSymbols) : symbols`
  (`maxSymbols ?? cfg.acquisition.defaultMaxSymbols`); empty `limited` throws
  "The selected live universe contains no listings; no static symbols were substituted."
- Acceptance (`acceptQuote`): rejects null or `lastPrice <= 0`; stamps `source: "E*TRADE
  live"`, `quoteStatus: "LIVE"`, `companyName`/`sector` enriched from the listing row
  (`resolveStockSector`).
- Batch pass: chunked by `quoteBatchSize`, `withRetries` per chunk ("E*TRADE batch quote"),
  500 ms pacing between chunks; batch omissions and zero-price results recorded per symbol
  in `quoteErrors`.
- Per-symbol pass: missing symbols only, bounded by `maxIndividualQuoteRetries`, concurrency
  `min(quoteConcurrency, 5)`, 500 ms pacing; null vs zero-price distinguished
  (`null-response` vs `zero-price(lastPrice=…)`).
- Partial qualification: failed symbols → `PartialQuoteQualification { quotedCount,
  requestedCount, failedSymbols, failureReasons, failureSamples }`; reasons categorized by
  `categorizeQuoteFailure` (`rate-limited` / `request-budget` / `auth` / `api-empty-response`
  / `api-zero-price`); samples capped at 3, scrubbed by `safeQuoteFailure` (OAuth/token
  material redacted, ≤180 chars). Partial message ends "Screen ran on the quoted subset
  only; no fallback data substituted."
- Honest failure: **zero quotes + any failures → throw.** Auth failures present →
  `BusinessError("AUTH_002", { failedCount, authFailures })` (#902/#907). Otherwise
  `Error("E*TRADE unavailable: no live quotes returned (…of… symbols quoted…).
  No fallback data substituted.")` (#462). A partial set returns qualified results; it does
  not fail.

### live-quotes leg (`screenerPipeline.ts:642-668` + `liveScreener.ts:83-140`)

- **Currently uncalled in production src.** The only `mode: "live-quotes"` references outside
  the pipeline branch itself are the two tests (`tests/screener_pipeline.test.ts:205,222`).
- Behavior (must be pinned before any change): `fetchLiveQuotes` slices to `maxSymbols`
  (default 50), concurrency 10, per-symbol `withRetries` ("E*TRADE", 3 attempts); on
  per-symbol failure it falls back **per symbol to the already-fetched Nasdaq listing row**
  (`lastPrice`/`change`/`changePercent` from the listing, `bid: 0, ask: 0, volume: 0`,
  `source: "Nasdaq (E*TRADE failed)"`, `quoteStatus: "DELAYED"`). It never throws for
  missing quotes — the mode's discovery message says "E*TRADE-primary live quotes with
  Nasdaq fallback".
- **This fallback is stale listing data, not a provider gap-fill.** Replacing it with the
  seeded route's yahoo gap-fill is a deliberate fallback-semantics change (see §5), not a
  transparent reroute. The build must pin the current DELAYED-listing behavior first, then
  pin the new behavior explicitly — and confirm with the issue whether the Nasdaq-listing
  fallback survives as a last resort or is replaced outright (see decision gate D1).

### yahoo leg (for contrast — already platform-routed, #1317)

- `screenerPipeline.ts:584-640`: Yahoo returns no live quote → the run FAILS (no fallback to
  E*TRADE, no fabricated row); a partial set is qualified exactly like the E*TRADE path's
  partial (#462); failures categorized `yahoo-unavailable` with up-to-3 samples. Provider
  recorded as `"yahoo"`; quotes adapted by `yahooQuoteToPipelineQuote` (returns null unless
  `provenance === "live"` and `price > 0`).

## 4. The etrade-only invariant — proof and what the cutover must pin

### Proof from code (E*TRADE-or-nothing today)

1. **Mode comment** — `screenerPipeline.ts:676-678` (#261): "etrade-only mode — market data
   comes from E*TRADE or nothing. No Nasdaq fallback, no zero-filled substitute rows."
2. **Acceptance gate** — `acceptQuote` rejects null and zero-price quotes; nothing else is
   admitted into `quotes`.
3. **Zero-quote failure** — §3 above: 0 quotes + failures → `AUTH_002` or "E*TRADE
   unavailable… No fallback data substituted." No other provider is consulted anywhere in
   the leg; the leg's only fetcher is `opts.liveDeps`.
4. **Provider scoping at the agent** — `screener-agent.ts:525-533` (#1007): the broker
   service is constructed only for etrade-provider runs; a Yahoo-provider run "never touches
   the broker (no credentials read, no token lookup) and never falls back to it." The
   mirror invariant for etrade-only is: an etrade-only run never touches the yahoo adapter
   and never falls back to it.
5. **Acquisition comment** — `screener-agent.ts:~660` (#261, #1007): "quotes come from the
   named provider or nothing."
6. **Route table does not override the mode** — the seeded quotes route
   (`providerConfigStore.ts:526`: `quotes ← etrade primary, yahoo gap-fill, freemium`) is a
   routing declaration, not a mode override. Nothing in the pipeline today reads the route
   table for the etrade-only leg at all — the leg is hard-wired to the etrade binding. The
   invariant therefore holds today by **absence of any gap-fill consultation**, and the
   cutover must preserve that absence deliberately, not accidentally.

### How the cutover must express it in code (required shape)

- **The route table must NOT change.** `quotes ← etrade primary + yahoo gap-fill` stays as
  seeded. The mode, not the table, decides whether gap-fill is consulted.
- **Two resolvers, mirroring the two existing helpers** (do not invent a third mechanism):
  - Primary-only resolver for etrade-only (mirror `nasdaqUniverseProviderFromRoute`,
    `screenerPipeline.ts:341+`: route must name etrade as primary, etrade config enabled
    state+flag, registry holds a quotes-capable etrade adapter; anything else throws — no
    silent substitution, no fallback to another provider).
  - Primary+gap-fill resolver for live-quotes (mirror `yahooQuoteProviderFromRoute`,
    `screenerPipeline.ts:388-413`: reads the same route table directly — see §5 for why
    `resolveRoute` alone is insufficient).
- **Pins that prove the invariant (mandatory, not optional):**
  - etrade-only with etrade unservable → honest throw **even when yahoo is servable and
    enabled** (the gap-fill must not rescue the run).
  - etrade-only with both servable → **zero yahoo fetches** (prove with a counting stub
    on the yahoo adapter: fetch count == 0).
  - etrade-only partial/zero-quote behavior unchanged (§3 pins, green on pristine + new).
  - The new quoteDeps binding for etrade-only must not accept a gap-fill provider in its
    constructor/options at all (type-level exclusion beats a runtime flag).

## 5. The yahoo gap-fill question for live-quotes mode

### What the seeded route says

- `providerConfigStore.ts:516,526`: `quotes ← etrade primary, yahoo DECLARED gap-fill`,
  freemium. Per the route semantics (below), gap-fill serves **elements the primary lacks**,
  provenance-marked per element — it is supplementary, never a wholesale substitution.

### Why `resolveRoute` alone is insufficient (the #1317 precedent, verified)

- Registry semantics — `src/trading/dataProviders/registry.ts:185+`:
  - A routed PRIMARY that is not servable fails EXPLICITLY (`DataProviderNotFoundError`).
    "The gap-fill is never silently promoted, and no precedence winner is substituted — a
    run that cannot get its routed primary must say so, not quietly change composition."
  - An unservable GAP-FILL is simply omitted (`gapFill: undefined`), never fatal, never
    replaced.
  - With NO route, precedence order is the default (highest-precedence servable declarer
    becomes primary, no gap-fill — gap-fill exists only where a route declares it).
- The #1317 precedent (`screenerPipeline.ts:380-387`, comment): `resolveRoute("quotes")`
  throws when the etrade primary is unservable, "and a Yahoo-provider run must never
  construct the broker service (#1007). So this helper reads the same route table directly."
  `yahooQuoteProviderFromRoute` requires: route names yahoo as gap-fill, yahoo config
  enabled (state + flag), registry holds a quotes-capable yahoo adapter — anything else
  throws.
- **Yes, the liveDeps cutover needs the same shape, twice over:**
  - For etrade-only: a primary-only direct route-table reader (etrade primary, enabled,
    quotes-capable; else throw) — gap-fill never read.
  - For live-quotes: a primary+gap-fill direct route-table reader — because when the etrade
    primary is unservable, `resolveRoute` throws instead of serving yahoo, and live-quotes
    is precisely the mode that must serve from gap-fill in that case.
- **Per-element composition is new work, not a free route property.** Neither adapter's
  `getQuote`/`getQuotesBatch` composes across providers today. The new quoteDeps binding (or
  a small composer beside it, in the pinnable adapters location) must implement: etrade
  batch first; for elements etrade omits or fails, yahoo batch for exactly those elements;
  per-element provenance (`source: "E*TRADE live"` vs `YAHOO_QUOTE_SOURCE = "Yahoo
  Finance"`, `screenerPipeline.ts:252`); yahoo quotes adapted via the existing
  `yahooQuoteToPipelineQuote` (null unless live + positive price — skipped, not fabricated).
  Pin per element: etrade-served, yahoo-gap-filled, both-failed → failedSymbols with
  categorized reasons. **Do not claim the route table "provides" gap-fill composition — the
  binding implements it.**

### What SHOULD happen per the seeded route (live-quotes mode)

- Etrade primary serves what it can; yahoo gap-fill serves the elements etrade lacks,
  provenance-marked per element; elements neither serves land in `failedSymbols` with
  categorized reasons; zero served → honest failure (same shape as etrade-only's
  zero-quote throw, naming both providers); partial → qualified subset, no fabricated rows.
- Open decision (D1, §8): whether the current Nasdaq-listing DELAYED fallback survives as a
  last resort after yahoo gap-fill, or is replaced outright. The issue text ("E*TRADE primary,
  Yahoo gap-fill, per the seeded route") reads as replacement; the build must pin the
  current behavior first and get the parent's confirmation if it keeps the listing fallback.

## 6. Deletion scope — exact, with shared items flagged

### Delete (the seam)

| Item | Location | Notes |
|---|---|---|
| `LiveScreenerDeps` interface | `src/trading/liveScreener.ts:16-26` | Only after all consumers migrate; see shared items below |
| `liveDeps?` pipeline option | `src/trading/screenerPipeline.ts:162` + doc | Plus the `liveDeps` import (`:35`) if unused after |
| live-quotes branch's liveDeps consumption | `src/trading/screenerPipeline.ts:642-668` (rewritten to quoteDeps) | `fetchLiveQuotes` call at `:650` goes with the branch rewrite unless D1 keeps it |
| etrade-only branch's liveDeps consumption | `src/trading/screenerPipeline.ts:748-953` (rewritten to quoteDeps) | Batch (`:803-809`) + per-symbol (`:859`) call sites |
| `bindETradeScreenerDeps` | `src/trading/dataProviders/adapters.ts:588-610` | Only after agent + shard migrate; its E2 test describe (`tests/data_provider_cutover_e2.test.ts:606-631`) migrates or retires with disclosure |
| Agent `platformLiveDeps` block | `src/agents/screener-agent.ts:596-615` | Replaced by the route-resolved quote binding block (same position, same run-id minting) |
| Shard `liveDeps` binding | `src/services/shardExecutors.ts:121-133` | Replaced by the same route-resolved binding (chain-id-as-run-id preserved) |
| E2 test binding describe | `tests/data_provider_cutover_e2.test.ts:606-631` | Migrate to the new binding's pins, or retire with justification in the PR body — never silently delete |

### Do NOT delete (shared or out-of-scope)

| Item | Location | Why it stays |
|---|---|---|
| `withRetries` | `src/trading/liveScreener.ts:41-66` | Used by the etrade-only leg's batch/per-symbol passes (via pipeline) and by `fetchTechnologySymbols`; shared resilience helper, not seam-specific |
| `fetchTechnologySymbols` | `src/trading/liveScreener.ts:71-82` | Universe discovery for both modes (tech-keyword filter over listings); used by the pipeline legs regardless of quote binding |
| `liveScreener.ts` module itself | — | Delete only if `withRetries` + `fetchTechnologySymbols` are re-homed first; otherwise the module stays with the seam type removed |
| `ETradeService` construction, screener-agent | `src/agents/screener-agent.ts:529` | **Decision point (D2):** under the #1317-shaped construction the agent still constructs the service as the etrade adapter's fetcher (exactly as the yahoo block constructs `YahooFinanceProvider`, `screener-agent.ts:~640`). It stops being a "direct" construction only if the build instead constructs the adapter from env/session (cf. `createETradeDataProviderFromEnv`, `adapters.ts:520-529`, which builds `new ETradeService(env, undefined, userLogin \|\| "default_trader")` — note: no ORM, default-trader fallback, different from the agent's session-scoped construction). The build must pick one shape and state it; do not delete `:529` blindly and break the adapter's fetcher |
| `ETradeService` construction, goal screen | `src/agents/screener-agent.ts:848` | Goal-screen/options path (`DynamicOptionsScreener`, `runProductionGoalScreen`) — not the stock screen path |
| All `etradeBroker.ts` / `etradeOptions.ts` / `watchlists.ts` / NLQ / orchestrator constructions | — | Broker routes, options flows, NLQ — not the stock screen path |
| `routes/dataProviders.ts` registry construction | `src/agents/routes/dataProviders.ts:121-130` | Servability probes only, no capture (`createETradeDataProviderFromEnv`, `createYahooDataProvider`, etc. without capture deps). The screener-agent constructs capture-wired adapters directly; the routes registry is not the screen path and must not gain capture deps as a side effect |
| `YahooScreenerDeps` / `bindYahooScreenerDeps` / `yahooQuoteProviderFromRoute` | `screenerPipeline.ts:256-314, 388-413` | The yahoo leg's existing shape — the model for the new binding, not a deletion target |

## 7. Test surface

### Existing regression surface (the build must keep green)

| File | Coverage relevant to #1356 |
|---|---|
| `tests/screener_pipeline.test.ts` | live-quotes fixtures + tests (`:197-222`), etrade-only tests (`:233,246,274,310,333,351,374` — batch + per-symbol fixtures, partial + failure pins). **This is the primary regression surface.** |
| `tests/data_provider_cutover_e2.test.ts` | `bindETradeScreenerDeps` describe (`:606-631`: batch + single pins). Migrates or retires with disclosure (see §6). |
| `tests/foss_convergence_s3.test.ts:130` | `liveDeps` fixture (convergence assertion — will need the new seam's fixture or a disclosed adaptation). |
| `tests/sharded_jobs_p1355.test.ts` + `tests/data_provider_nasdaq_p1368.test.ts` | Shard feed pins (feedEtrade sibling contract, retry policy/bucket/label — the shard binding rewrite must keep these green). |
| `tests/data_provider_yahoo_p1317.test.ts`, `tests/data_provider_nasdaq_p1368.test.ts`, `tests/data_provider_alpaca_p1385.test.ts` | Pattern references for route-reader + bind + capture + panel pins (not regression surface, but the shape to copy). |

### New pin file (suggested name)

- `tests/data_provider_livequotes_p1356.test.ts`: characterization pins first (see
  BUILD-BRIEF-NOTES.md for the pin list), run against a pristine control worktree for honest
  Red before implementing.

## 8. Sequencing hazards — #1331 overlap

- **#1331 is still OPEN** (not merged): "Migrate yahooHistory runtime consumers to platform
  historicalBars (follow-up to #1317)". Its issue body lists 4 call sites; at current main
  they are: `src/agents/screener-agent.ts:684` (`fetchTechnicalsBatch`, inside
  `runScreenInner` directly below the `acquireUniverse` call #1356 rewrites),
  `src/services/screeningRuntime.ts:345` (`fetchYahooDailyHistory`),
  `src/services/discoveryService.ts:348` (`fetchBars` seam),
  `src/services/researchProviders.ts:308,345` (`fetchTechnicalsBatch`).
  `fetchTechnicalsBatch` itself is defined at `src/trading/yahooHistory.ts:207`.
- **No #1331 worktree exists on disk** (`~/workspace/` has no `w1331/` directory) — #1331's
  build state cannot be verified from disk; only its open issue state is known. The parent
  should confirm whether a #1331 build is in flight elsewhere before dispatching #1356.
- **Shared files (HIGH overlap — do not build concurrently on separate bases):**
  - `src/agents/screener-agent.ts` — #1331 edits the `fetchTechnicalsBatch` call at `:684`
    (and its import at `:37`); #1356 rewrites the etrade/yahoo blocks at `~:525-680` and
    the `acquireUniverse` call at `:661-673`. Same function (`runScreenInner`), adjacent
    hunks — a concurrent build on a stale base risks a fork-point wholesale revert.
  - `src/trading/screenerPipeline.ts` — #1356 rewrites the liveDeps legs (`:642-668`,
    `:748-953`); #1331 must re-home the `YahooTechnicals` type import (`:55`, from
    `yahooHistory`) when it deletes that module, and may touch the technicals attachment
    path. Same file, different regions — still a three-way-merge candidate.
  - `src/services/screeningRuntime.ts` — #1331 only (`:345`), unless #1356 touches
    scheduled paths (it should not need to: scheduled stock screens delegate to
    `runScreenInner`, `scheduledTasks.ts:621-624`). No overlap if #1356 stays in scope.
  - `src/services/discoveryService.ts`, `src/services/researchProviders.ts`,
    `src/trading/yahooHistory.ts` — #1331 only. No #1356 overlap.
- **Sequencing recommendation:** build #1331 and #1356 strictly sequentially (second build
  bases on the first's merge), or, if parallel is forced, the second build must three-way
  merge `screener-agent.ts` + `screenerPipeline.ts` against current main at ship time with
  both sides' markers verified — never a stale-file push. The parent's existing fork-point
  rule already covers this; the point here is that these two slices are the highest-overlap
  pair in the current queue.

## 9. Decision gates (for the parent — nothing invented here)

- **D1 — live-quotes fallback semantics:** does the Nasdaq-listing DELAYED fallback
  (`liveScreener.ts:83-140`) survive as a last resort after yahoo gap-fill, or is it
  replaced outright by the seeded route's yahoo gap-fill? Issue text reads as replacement.
  The build must pin current behavior first either way.
- **D2 — ETradeService construction shape:** does the agent keep constructing the service
  at `screener-agent.ts:529` as the etrade adapter's fetcher (#1317 shape), or does the
  build introduce a capture-wired from-env constructor? Note `createETradeDataProviderFromEnv`
  uses no ORM and a `"default_trader"` fallback — not equivalent to the agent's
  session-scoped construction. Do not delete `:529` without answering this.
- **D3 — live-quotes mode's production status:** the mode is currently uncalled in
  production src (only tests). Confirm it stays a supported mode (rebuilt on the new seam)
  rather than deleted as dead code — the issue's acceptance ("live-quotes and etrade-only
  modes produce identical quotes via the platform") implies it stays.

## 10. What would block or reshape the slice

- **Blocker: none found.** No lane claim, no missing prerequisite beyond the #1331
  sequencing question (§8) and decisions D1–D3 (§9).
- **Reshaper: one.** If the parent answers D1 as "keep the Nasdaq-listing fallback," the
  live-quotes binding gains a third fallback tier (etrade → yahoo gap-fill → listing rows),
  with its own provenance pin (`source: "Nasdaq (E*TRADE failed)"`, `quoteStatus:
  "DELAYED"` preserved). If D1 is "replace," the binding is two-tier and `fetchLiveQuotes`
  becomes deletable (with `withRetries`/`fetchTechnologySymbols` re-homed or kept — §6).
