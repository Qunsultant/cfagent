# S2 (#982) verify-first map — main @ 382dbed0 (2026-10-22T06:51Z, tip unchanged at build start)

## Service entry points / who persists today
- UnifiedOptionsService (src/trading/options/unifiedOptionsService.ts): execute(req) only.
  Actions screen/strategies/best_trade/opportunities/compare/llm_*. Constructs engines internally
  (DynamicOptionsScreener L302, OptionsAgentPipeline L342/536/601, OpportunityScanner L376).
  Persists ONLY opportunities, ONLY via injected ScanRunStore -> mas_opportunity_scans (NOT mas_reports),
  best-effort: store error -> result returns with persisted:false + console.error (L458-468).
  60s MEMORY_CACHE keyed on action/symbols/thesis/limit/... — filter fields NOT in key (existing service behaviour).
- REST options screen route (etradeOptions.ts ~1091): constructs DynamicOptionsScreener directly in the
  ROUTE, then the ROUTE persists canonical mas_reports (L1172): source "options_scanner",
  generationId `options_scanner:manual:<ts>`, body {generatedAt, filter, result, pdfKey, reportUrl}.
  => Division of labour: caller layer persists the canonical copy. NLQ must do the same at its layer.
- REST unified route (etradeOptions.ts:1232): service with SqlScanRunStore+SqlStrategyProfileStore;
  opportunities also get canonical mas_reports in the route (L1311, only on success + Slack flow).
- REST stock route (etradeBroker.ts /etrade/screen): ScreenerAgent DO runScreen (agent persists its own
  run record via persistRun) + ROUTE persists canonical via ctx.persistScreenerReportCanonical
  (orchestrator.ts:2220): source "screener", generationId `screener:<timestamp>`,
  title `Market screen — <universe> (<trigger>)`, body {..., trigger}. Provenance idiom: source=kind,
  body.trigger=entry point ("manual"/"scheduled"). NLQ -> trigger "nlq", generationId prefix
  `options_scanner:nlq:` for options screens (cf. REST's `options_scanner:manual:`).
- ScreenerAgent is DO-bound (ctx.storage locks, task ledger, this.sql): reachable only via orchestrator
  stub getScreenerAgent(userLogin). NLQ therefore needs an injected port — the #109 NLQSchedulingPort
  precedent (deps-threaded, orchestrator-bound, absent -> legacy behaviour in store-less contexts).

## Direct constructions found + disposition
- nlq/execution.ts:1665 options_screen — DynamicOptionsScreener -> UnifiedOptionsService.execute("screen") + executor-level canonical persist (source options_scanner, trigger nlq).
- nlq/execution.ts:1807 paid_scan — same routing (no persistence today, none added).
- nlqOptionsStrategy.ts:543 pipeline / :694 scanner -> new UnifiedOptionsService execution primitives
  (screenContracts / runStrategyPipeline / scanOpportunities statics; execute() rewired onto them).
  WHY NOT execute(): UnifiedOptionsRequest cannot express NLQ's StrategyRequest (contractLimit,
  candidateLimit, eventPolicy, minVolume...), execute() drops strategyFilter + alternatives:3,
  defaults targetPrice to 150/100 instead of NLQ's quote-derived assumed target, resolves profiles
  with different explicit-field semantics, and stamps a different requestSnapshot — all frozen-contract
  violations. NLQ keeps its assembly/persistence; the service layer owns engine construction/execution.
- premium.ts:134 options-scan — DynamicOptionsScreener -> UnifiedOptionsService.execute("screen");
  canonical persist in route UNCHANGED. premium.ts:246 YFinanceMarketScreener (stock-signals) = S3, untouched.
- mcp/agenticPaymentCommands.ts:148 PaidOptionsScreenerCommand — DynamicOptionsScreener (S1's
  "MCP composes through services" held for filter-field composition only, NOT execution) -> execute("screen").
- Out of scope, untouched: etradeOptions.ts REST routes (148/686/885/1015/1091), scheduledTasks.ts,
  fossResearch.ts (S3), flowService.ts (service internals).

## NLQ stock paths
- Async "screen" (execution.ts:1322): etrade.screenMarketsAsync = DynamicMarketScreener.screenLive
  (listings screener — NOT the REST service). New: deps.stockScreenPort when threaded (orchestrator
  binds ScreenerAgent.runScreen); executor persists canonical copy (source "screener", trigger "nlq").
  No port -> existing path unchanged (scanRunStore idiom: store-less contexts behave as before).
- Sync core "screen"/watchlist_save use etrade.screenStocks (synchronous; a DO port is async-only —
  same constraint that made scheduling async-only in #109). Untouched, disclosed.
- Async watchlist_save fallback (execution.ts:1746): screenMarketsAsync -> port when threaded
  (symbols from run.opportunities, maxItems 10 at the binding), else unchanged. No persistence (none today).

## Schedule update
- PUT /schedules/:id -> resolveScheduleUpdate (services/scheduleManagement.ts, pure): validates TIMING
  only; payload passes through unvalidated. Fix there (covers live + paused branches in one place):
  when body.payload is provided AND current.callback is a screening callback, validate via
  buildSchedulePayload(callback, criteria-minus-identity, identity-from-CURRENT-payload,
  {applyCreationDefaults:false}) -> S1 field-named errors ("Invalid schedule payload: <field>: ...")
  surface as the route's existing 400 {success:false, error}. Timing-only updates unvalidated
  (legacy payloads stay updatable); non-screening callbacks untouched.

## Lanes
- Open PRs: #984 (ci.yml only), #981 (Discovery #14 slice 1: etapiConfig.ts, trading/index.ts,
  +options/discoverySignals.ts, tests) — no overlap with S2 files except none. Dependabot otherwise.
- Main tip at build start == extraction base (382dbed0). No lane collisions on touched files.
