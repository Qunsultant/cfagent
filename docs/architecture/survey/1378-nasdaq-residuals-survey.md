# #1378 Survey — Nasdaq residuals (READ-ONLY, 2026-10-26)

Survey base: main `80e19d4b` (the #1169 S2 merge). Issue state: OPEN, zero comments, no lane claims, no owner activity since filing (2026-10-24). Scope exactly as filed.

Ground change since filing: `ee15dc75` (fix #1554, parent #913) made `fetchAllUsStockListings` itself THROW on live failure and on empty (`src/services/nasdaqListings.ts` ~:136-141). This changes the *harm* of every residual (no more silent curated substitution) but resolves NONE of them: every site still bypasses route resolution, capture, outcome recording, and provenance.

S2 overlap: NONE (S2 touched mas.ts, knowledgeCorpus route/service, errorCodes, aiSearch, types, thin_router_inventory — no #1378 site).

## Per-residual verdicts (verified firsthand on 80e19d4b)

- (a) screenLive dep-less default — REAL. `src/trading/screenerPipeline.ts:1386`: `opts.universeDeps?.fetchListings() ?? fetchAllUsStockListings()`. `screenLive` (`src/trading/screener.ts:541`, call :566-569) passes no `universeDeps` — `acquireUniverse({ mode: "all-listings", exchange })`. All four callers dep-less: `src/services/etrade.ts:140`, `src/services/screeningRuntime.ts:101/105`, `src/trading/etrade/platform.ts:224`, `src/trading/options/flows/flowService.ts:1717`. Today a dep-less failure surfaces honestly (acquireUniverse catch → empty result + "no static universe was substituted") but with zero capture/outcome/provenance.
- (b) feedNasdaq direct bind — REAL. `src/services/shardExecutors.ts:95`: `deps.fetchListings ?? (await import("./nasdaqListings")).fetchAllUsStockListings` — the direct import is the production default, not just the test seam (comment claims otherwise). Route reader already exists: `nasdaqUniverseProviderFromRoute` (`src/trading/screenerPipeline.ts:357`, from #1368) — feedNasdaq never calls it. Precedent: feedEtrade already route-resolves quotes (#1356).
- (c1) researchProviders listings cache — REAL, widest threading. `src/services/researchProviders.ts:159`: private `listings()` with lifetime `listingsCache`, consumed by `getUniverseSymbols` + `etfMap`. Consumers reach it through the `ResearchDataProvider` interface (`src/services/researchDiscovery.ts:614`, `src/services/researchPipeline.ts:740`). Constructor takes `(env, userLogin, historyDeps?)` — no sql, no capture deps — so threading means interface + constructor + construction-site changes.
- (c2) liveScreener technology helper — REAL, entangled with (a). `src/trading/liveScreener.ts:56`: `fetchTechnologySymbols()` (name-heuristic filter over full listings). Worse than filed: it is the DEFAULT symbol source inside the pipeline itself — live-quotes mode (`src/trading/screenerPipeline.ts:887`) and etrade-only mode (`:1175`) call it when `opts.symbols` is absent, while both modes already REQUIRE `quoteDeps` (throw otherwise). Quote leg platform-bound, universe leg not, in the same call.
- (c3) optionsScreener discovery — REAL. `src/trading/optionsScreener.ts:315`: `testListingsFixture ?? await fetchAllUsStockListings()` in `resolveUnderlyings`. 10 construction sites to thread: `src/agents/routes/etradeOptions.ts` (×5), `etradeOptionsEvaluate.ts:172`, `src/agents/screener-agent.ts:1071`, `src/services/comparisonNlqRunner.ts:54`, `src/services/discoveryService.ts:353`, `src/services/scheduledTasks.ts:2272`.
- (c4) scheduledTasks options_analysis — REAL, most feasible. `src/services/scheduledTasks.ts:1515` (filed :1148-1152): dynamic import + direct call inside the failure boundary, so failures already reach the scheduled-failure notification path, and empty symbols already throw honestly. `ScheduledTasksService` holds optional `platformDeps?: ETradeCaptureDeps` (`:414` uses its `blobStorage`) — capture threading plausible; build must confirm `platformDeps.sql` is present at this call site.
- (c5) flowService dead import — MOOT (deletion only). `src/trading/options/flows/flowService.ts:24`: import only, zero calls in the file. Delete the line; tsc confirms.
- Adapter seam — NOT a residual. `src/trading/dataProviders/adapters.ts:883`: default `fetchListings` param is the adapter's own fetcher seam, explicitly allowed by the acceptance criterion. Docs mentions (`src/client/workflowsFaqData.ts:754`, `curatedStockUniverse.ts:52` comment) are prose, not code paths — optional doc touch-up (see D4).

Already-checked, NOT resolving: #1556 fetcher throw (harm only); #1356 quote seam (quotes, not listings); #1331 history migration; #1527/#1571 Yahoo fallbacks (different provider); #925 demo-regime rule (honesty, not routing).

## Scoped build plan (in order)

1. Characterization pins first, per site (routed-vs-direct behavior, failure surfaces, behavior contracts).
2. (a) screenLive threading — `screenLive` gains optional `universeDeps` (or run-context) param; four callers thread `nasdaqUniverseProviderFromRoute` + `bindNasdaqUniverseDeps` (`screenerPipeline.ts:338`); then DELETE the `:1386` dep-less default. No legitimate dep-less production path remains (test fixtures already have their own `getTestListingsFixture` path) — do not "pin it as tests-only"; remove it.
3. (b) feedNasdaq route resolution — resolve via `nasdaqUniverseProviderFromRoute` after bootstrap; preserve `{ listings }` contract, `withRetry` policy/bucket/label, `chain.chainId` as run id exactly.
4. (c4) scheduledTasks — thread `platformDeps` capture into the options_analysis universe fetch; preserve failure-boundary notification path and empty-symbols throw.
5. (c2) pipeline symbol leg — live-quotes/etrade-only modes require the universe seam when `opts.symbols` is absent (mirror the existing `quoteDeps` throw pattern); thread from the (a) callers.
6. (c3) optionsScreener — constructor threading (or a `resolveUnderlyings` deps param) across all 10 sites; preserve discovery determinism (sorted, capped at `maxUnderlyings`).
7. (c1) researchProviders — last (widest): interface + constructor + construction sites; decide the cache question (D3) before cutting.
8. (c5) dead-import deletion (any time, trivial).
9. Acceptance grep: zero `fetchAllUsStockListings` references outside the adapter seam + docs; tsc clean; full suite with exact A/B delta.

## Consumer pins required

screenLive routed fetch + route-unservable behavior via each of the four callers; feed shard `{ listings }` contract + retry/label unchanged; scheduled options_analysis failure → notification path (not silent empty); options discovery determinism under routed fetch; research `getUniverseSymbols`/`etfMap` parity; pipeline live-quotes/etrade-only empty-universe behavior preserved.

## Decisions needed before a build (D1–D4)

- D1 — route-unservable behavior per site. The route reader throws explicitly. For screenLive, resolution inside `acquireUniverse` would convert it to the existing error-result shape; resolution at the caller lets it propagate. Pick one and pin it — do not let each site improvise.
- D2 — run-id policy for run-less sites. Capture tolerates a missing run id (captureStore generates one, `:235/243`), but acceptance demands rows "under their run ids." For the research cache and technology helper: thread run ids from callers, or accept generated-run-id capture and record the exception. Must be decided, not discovered mid-build.
- D3 — researchProviders cache. Keep it (cache the adapter result) or drop it (the fetcher already caches 5 min in memory, #411)? Lifetime-cache → 5-min-cache changes freshness; pin the chosen behavior.
- D4 — docs mentions. Update the FAQ/curated comments to the fail-explicit reality, or leave them? Small; decide to avoid scope creep either way.

## Risks

- Other-lane run paths: `flowService` screenLive and scheduled options_analysis are live run paths — regressions surface as failed runs/notifications, not test failures. Consumer pins + post-merge check + /health discipline are the mitigation.
- Interface ripple (c1): `ResearchDataProvider` changes propagate to research-agent construction sites; enumerate them in the build brief before cutting.
- Cache freshness (D3): dropping the lifetime cache changes what repeat research calls see; a pin must lock the behavior either way.
- False "done": the fetcher throw makes dep-less paths LOOK fixed (honest failures). The build must not claim completion from the throw alone — routing + capture is the actual acceptance.

## Agentic-SaaS lens (per residual, applied)

- Exception handling: typed, explicit everywhere — reuse the route reader's explicit throws and the fetcher's fail-explicit throws; no new silent substitution, no new default. New routing failures are `Error`s with route/provider named (#1368 precedent for internal routing throws; the externalized-catalog idiom applies to user-facing route messages, which these are not).
- Logging: structured logs via existing idioms; the pipeline's `safeQuoteFailure` redaction pattern (`screenerPipeline.ts:1180-1190`) is the template — listings fetching needs no credentials, and no log line may carry tokens or PII.
- Codes/messages externalized: internal routing throws stay explicit `Error`s per #1368 precedent; any new user-facing message goes in the existing catalog idiom, not an inline literal.
- Configurable: the route table decides the primary — callers must never hardcode "nasdaq" as primary; `nasdaqUniverseProviderFromRoute` already enforces route-named primary + enabled config + registered capability.
- Security: no new credential surface (listings fetch is unauthenticated); session gates unchanged (none of these sites serve a route directly).
- Transaction management: N/A for all residuals — every site is a single read-only fetch; capture writes follow the E1 pattern (best-effort markers that never fail the fetch), so there is no multi-write to make atomic. Stated explicitly, not assumed.
- Cloud-agnostic/native: existing seams only — registry + route table + capture store + R2 blob seam; no new provider API surface, no D1 `AGENT_DB` involvement (governance projection, not this path).

## Files

- To touch (only): `src/trading/screenerPipeline.ts`, `src/trading/screener.ts`, `src/services/etrade.ts`, `src/services/screeningRuntime.ts`, `src/trading/etrade/platform.ts`, `src/trading/options/flows/flowService.ts` (dead import + caller threading), `src/services/shardExecutors.ts`, `src/services/researchProviders.ts` + its interface/construction sites, `src/trading/liveScreener.ts`, `src/trading/optionsScreener.ts` + its 10 construction sites, `src/services/scheduledTasks.ts`, `CHANGELOG.md`, and the new pin test file.
- FORBIDDEN: all #1169 S2 files, `src/services/nasdaqListings.ts` (already fixed — do not rework the fetcher), `src/config/curatedStockUniverse.ts`, and anything outside the residuals above.
- Survey scratch: `~/workspace/w1378survey/wt` (worktree at main `80e19d4b`, read-only use; no branches created, no GitHub writes made).
