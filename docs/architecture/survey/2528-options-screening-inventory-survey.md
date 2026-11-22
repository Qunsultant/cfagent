# Options-screening inventory — Qunsultant/cfagent (code only, main @ 97ae8a39, 2026-10-31)

Scope note: this is a code inventory. It cannot count live production PDFs/runs.
No production DB, R2 bucket, or Docs panel session was accessed. Live row
attribution (e.g. the bare-UUID row in the user's screenshot) is marked
UNVERIFIED where code alone cannot prove it. The Google Doc linked as a
starting point returned only a "browser version no longer supported" page
via text fetch, so its contents are NOT used here.

## 1. The strategy universe, and the one filter that explains "few strategies"

- Catalog: `src/trading/options/strategies/catalog.ts` — 75
  `createTemplateStrategy` definitions, each with `theses` drawn from
  `["bullish","bearish","range_bound","large_move"]` (line: `ALL_THESES`).
  `defaultRegistry` (catalog.ts:123), `ALL_STRATEGY_TYPES =
  defaultRegistry.ids()` (strategyEngine.ts:366).
- Viewed engine filter — `src/trading/options/strategyEngine.ts:987`:
  `selectedDefs = registry.list().filter(def => wanted.has(def.id) &&
  (request.evaluateAllStrategies === true || def.theses.includes(request.thesis)))`
  and again at :1043–1044, where a non-matching strategy is recorded as
  `Skipped: <label> conflicts with the selected <thesis> thesis`.
  Default (no `evaluateAllStrategies`): a run evaluates ONLY the
  thesis-matching subset of the catalog, never all 75.
- Scanner filter — `src/trading/options/opportunityScanner.ts:1125-1131`:
  same, over `scanTheses` = request thesis + per-symbol override theses.
- No-view engine — strategyEngine.ts:1216ff `recommendNoViewStrategies`:
  explicitly "no thesis filter", every selected definition eligible.
- Further truncation, in order: `allowedStrategies` allowlist
  (default `["all"]` in unifiedOptionsService.ts:690ff, :722);
  DTE window + per-strategy `dataHorizonDte`; closest-strikes-per-side
  (`maxStrikesPerSide`, strategyEngine.ts:1027ff); per-strategy
  combination cap `DEFAULT_MAX_COMBINATIONS` = config `maxCombinations`
  (5000, environment.config.json:31 / etapiConfig.ts:342, iron_condor
  separately capped by `maxIronCondors`); acceptance rules
  (maxPlannedLoss default 1000, minRewardRisk default 1.5,
  unifiedOptionsService.ts:690ff); fit gate for scans
  (environment.config.json opportunityScanner.fitGate: minCompositeScore
  55, minProbabilityOfProfit 0.35, requireFresh true,
  minConfidence MEDIUM); then ranking: `rank()` returns all accepted
  candidates, but `pickBestTrade` keeps best + ≤3 alternatives
  (recommendationAgent.ts:110,152); scanner `opportunities` is
  per-symbol best picks only, sliced top-10
  (opportunityScanner.ts:615,1325: `slice(0, mode==="per_name_best" ?
  options.limit ?? 10 : 10)`; `strategy_fit` mode instead returns full
  `fits` list, paginated by limit/offset).
- Sharded scheduled path is the exception: scheduledTasks.ts chain
  options set `evaluateAllStrategies: true` with the comment
  "scheduled runs judge the chain against every wanted strategy, not
  only the thesis-matching ones" — and shardExecutors.ts:358-359
  forwards it. The monolithic scheduled path does NOT set it, so it
  stays thesis-filtered.

## 2. Channel inventory

| # | Channel / workflow (file) | Trigger | Inputs | What screening actually runs (strategies?) | Outputs |
|---|---|---|---|---|---|
| A | Manual options CONTRACT screen — `POST\|GET /trading/options/screen`, `src/agents/routes/etradeOptions.ts:834` → `executeOptionsScreen`, `src/agents/routes/etradeOptionsScreen.ts:49` | Manual UI (also async-job/triggered when `ctx.asyncJobId` set, delivery deferred) | Contract filter: underlyingSymbols/universe, sector, contractType, delta/gamma/theta/IV ranges, volume/OI, spread%, quote age, min/max DTE, moneyness, limit; pushToSlack, slackChannel, emailTo | NO strategies at all. `DynamicOptionsScreener.screenOptions` returns matched contracts only. | In-app JSON; unified report pipeline PDF (type options, trigger manual); XLSX/CSV via ScreenerAgent options generators; Slack A2A with PDF/XLSX/CSV attachments if pushToSlack; email if emailTo; canonical row source `options_scanner`, generationId `options_scanner:<ts>:<thesis\|mixed>`; outcome `options-unified:<generationId>` (etradeOptionsScreen.ts, canonical/outcome block). |
| B | Manual unified options — `POST\|GET /trading/options/unified`, `src/agents/routes/etradeOptions.ts:908` → `executeUnifiedOptions`, `src/agents/routes/etradeOptionsScreen.ts:336` | Manual UI / agentic caller (channel ui/slack/email/webhook/voice) | `action`: screen, opportunities, strategies, best_trade, compare, llm_ideas, llm_evaluate; symbol(s), thesis, targetPrice, targetDate (+30d default), riskProfile, maxPlannedLoss, minRewardRisk, allowedStrategies, perSymbol, statedTarget, min/max DTE, profile | Per action: opportunities = scanner (thesis-filtered, per-symbol best, top-10); strategies/best_trade = panel pipeline (thesis-filtered, ranked, best+≤3 alt); compare/llm_* = same panel/AI result. evaluateAll NOT set by this route, so thesis filter applies unless the caller body carries `evaluateAllStrategies:true`. | Channel-formatted JSON (Slack/email/voice/webhook variants); for opportunities: options_scanner canonical + outcome as in A; for strategies/best_trade/compare/llm_*: strategy report artifacts (see C) + canonical source `options_strategy`, generationId `options_strategy:<action>:<symbol>:<ts>`; failed runs: Slack failure notice only, no record. |
| C | Manual strategy screener panel — `POST /trading/options/strategies` and `/best-trade`, `src/agents/routes/etradeOptions.ts:730` | Manual UI (Strategy Discovery panel) | Single symbol (default SPY if absent), thesis (default bullish), targetPrice (bearish→100 else 150 default), targetDate (+30d), expectedIvDirection, maxPlannedLoss, minRewardRisk, allowedStrategies (default ["all"]), strategyFilter, riskProfile (balanced), alternatives | Panel pipeline via RecommendationService.discoverPanel. Thesis-filtered ranked list; best-trade mode returns `bestTrade` (best + ≤3 alternatives) plus the same ranked list in the response. StrategyReportInput built from ranked+bestTrade+screenedOut, then `generateAndStoreStrategyReport`. | In-app JSON incl. artifactLinks; strategy PDF/XLSX/CSV under keys `options:pdf:strategy:<8-char id>` etc. (screener-agent.ts:1649ff); canonical row via `recordStrategyScreenRun` (optionsServeRecord.ts:140ff) with generationId `options_strategy:<mode>:<symbol>:<createdAt>` — this is the exact shape of the user's 01:13 AM NVDA row `options_strategy:best-trade:NVDA:2026-10-31T05:13:01.178Z`, trigger hard-coded "manual" in the route; outcome id = asyncJobId ?? generationId, origin `options-strategy-screener`. Report rows = best + ranked + alternatives, deduplicated by candidate id (strategyReport.ts:89ff) — i.e. accepted, thesis-filtered candidates only, NOT all 75. |
| D | Manual/scheduled STOCK screener — `ScreenerAgent.runScreen`, `src/agents/screener-agent.ts:629,664` | Manual, scheduled, Trigger-Now, workflow shard (all share one lock, screener-agent.ts:629ff) | Universe (default TECH; NASDAQ100/SP100/SP500/RUSSELL2000/ETF/ALL), sector (default ALL), symbols, provider etrade|yahoo, environment, maxSymbols (universe defaultMaxSymbols, e.g. NASDAQ100 100, screenerConfig.ts), maxItems (defaultMaxItems 5) | Stock screen only (DynamicMarketScreener). No options strategies. Symbols sliced to maxSymbols (screener-agent.ts:819ff). | Stock PDF via unified pipeline + XLSX + CSV, all per-run keys, `persistRun` (screener-agent.ts:1737ff); DO latest/history (historyLimit 20); canonical report via OrchestratorAgent; Slack/email/webhook delivery per follow-up pipeline. |
| E1 | Scheduled autonomous options, MONOLITHIC — `ScheduledTasksService.autonomousOptionsAnalysis`, `src/services/scheduledTasks.ts:1910ff` | User schedule / Schedules panel / queue `options_analysis` / Trigger-Now via `/schedules/trigger-options-analysis` (schedules.ts:711, trigger forced "manual" in that route's buildSchedulePayload) | Universe (default NASDAQ100) or explicit symbols, thesis (default bullish), targetDate (+30d), riskProfile (balanced), allowedStrategies, maxItems, emailTo/slackChannel/webhookUrl, stageChain | `UnifiedOptionsService.execute({action:"opportunities"})`, thesis-filtered (no evaluateAll set on this path), per-symbol best picks, top-10 in `opportunities`. Monolithic only when scheduled symbols ≤ floor(35/12)=2 (scheduledTasks.ts, SCHEDULED_OPTIONS_MONOLITHIC_SYMBOL_LIMIT comment: 1 expire-dates + ~11 chain fetches per symbol). | Unified pipeline PDF + options XLSX + CSV, each in its own try/catch (never fatal, scheduledTasks.ts:2240ff); canonical row source `options_scanner`, generationId `options_scanner:<ts>:<thesis>` (reportRunId), owner-scoped (userLogin); Slack (PDF+XLSX attached, CSV via link only in the payload construction — email attachments are PDF+XLSX only, scheduledTasks.ts email block), email, webhook; below-floor partials get degraded notice only, no PDF/files broadcast, but the record still persists. Auth guard: `guardScheduledAuth` blocks on E*TRADE token cliff, quietly (no repeat alert) if already alerted — no record in that branch. Duplicate scheduled claim: `claimScheduledExecution(jobKey)` returns skipped:true with no canonical record. |
| E2 | Scheduled autonomous options, SHARDED — same entry point, `sharded:true` or auto-shard when symbols > 2 | Scheduled (same triggers as E1) | As E1, plus chainId, staggerMs 1000, per-symbol paced jobs | Per-symbol feed shards (shardExecutors.ts:340ff: allowedStrategies default ["all"], evaluateAllStrategies forwarded ONLY if chain set it — scheduled chain sets true, scheduledTasks.ts chain options), assemble, then generate/store/serve/deliver stages (shardJobs.ts:11ff,86ff). | Per-format canonical rows `options:<chainId>:<pdf\|xlsx\|csv>` at generate stage (shardExecutors.ts:541ff, source options_scanner); the UNIFIED Docs row `options:<timestamp>` is written ONLY at serve stage, by asyncJobs followup.report adoption → `recordOptionsServeReport` (asyncJobs.ts:908ff; optionsServeRecord.ts:230ff, idempotent canonical row + DO history row). If the chain stalls before serve, blobs exist but the unified row does not. The user's `options:2026-10-31T09:20:56.666Z` row matches this unified-row shape (09:20 UTC = 05:20 EDT, matching the 05:21 AM panel row) — consistent with a sharded scheduled serve, but live attribution is UNVERIFIED from code alone. |
| F | Daily research tick — NOT an options analysis — `src/server.ts:4104ff` (`*/30` cron) → `POST /research/scheduled-tick`, `src/agents/routes/screenerResearch.ts:493` | Cloudflare cron `*/30 * * * *` (wrangler.jsonc:153ff); the 21:00 UTC weekday daily research run is deliberately NOT a fifth cron (Workers Free 5-trigger ceiling, error 10072) and rides this tick; guard `shouldFireResearchTick` (researchScheduleGuard.ts) fires once per weekday at/after 21:00 UTC, last-fired date in mas_settings, failed run retries at 21:30 | Service-user login (skipped entirely if service user unprovisioned, server.ts:4104ff); screening pause flag | Research run + evaluations + advisory discovery + strategy-bank re-selection proposals + weights-v2 (all best-effort, never fail the tick). This is research/discovery, NOT `autonomousOptionsAnalysis`. A user expecting a 21:00 UTC options PDF from this tick is looking at the wrong scheduler. | Research reports via researchPublish (separate family, filtered out of Docs panel's four families, docsAndReports.ts:14ff); discovery rows source `discovery` when persisted. |
| G | Triggered / queue / ScheduledAgent — `src/server.ts` queue handler `options_analysis` → `/schedules/trigger-options-analysis`; ScheduledAgent `onCron` on `*/30` (goals, server.ts:4104ff); Schedules panel user schedules | Triggered by queue message, by a user schedule, or by a ScheduledAgent goal; on-demand Trigger-Now | Queue payload / schedule payload (symbols/universe/thesis/channels as in E), payload owner or SERVICE_USER_LOGIN (dropped, not retried, if unprovisioned or shared-orchestrator, server.ts queue handler) | Same as E1/E2 (autonomousOptionsAnalysis). The 09:20 UTC scheduled row cannot be assigned to F (wrong time, wrong job); from code it must be a user schedule, queue trigger, or ScheduledAgent goal — the scheduleId lives in live schedule data, not in code, so this is an open live-data question, not a code gap. | As E1/E2. |
| H | Screener workflow — `ScreenerScreenWorkflow`, `src/workflows/screenerWorkflow.ts` → `screenerWorkflowFlow.ts` (parent/shard fan-out, runParentFlow/runShardFlow) | Workflow invocation (chat turn mesh screen door since #2488 is separate: `src/agents/orchestrator/meshScreenDoor.ts`, no direct-ScreenerAgent fallback; NLQ stock-screen port still serves async nlq.execute/A2A/chat fallback) | WorkflowJobCommand: userLogin, trigger, universe/symbols, provider, filters, maxItems/maxSymbols, goalScreen flag + scenario (goal path) | `runScreen` (stock, D) or `runGoalScreen` (goal, I) per shard; storeReport via market door (`recordWorkflowScreenReport`, orchestrator.ts:1559) or goal door (`recordWorkflowGoalScreenReport`, orchestrator.ts:1605). | Shard rows + canonical report via the door; Docs row only if the door write lands (see §3). |
| I | Goal screen — `autonomousGoalScreen` (scheduledTasks.ts:1230ff) and `ScreenerAgent.runGoalScreen` (screener-agent.ts:1159ff) | Scheduled goal, manual goal, workflow goal command (goalScreenDispatch) | Goal scenario (goalKind, direction, scenarioId or built scenario), assetClasses stocks|options, symbols, provider, environment; monetization gate (#2186 slice 10) can skip uncovered paid scheduled screens fail-closed | Scenario-driven screen; the options leg uses DynamicOptionsScreener + goal universe deps (screener-agent.ts:1159ff). This is a goal-scenario screen, not a full options-strategy catalogue run: strategies are those the scenario's options leg evaluates, and the goal canonical report (source `goal_screen`) is the record, not an options_scanner row. | Goal canonical report (goalScreenReports.ts) + goal delivery seam (channels/emailTo on the command); Docs family "goal", served via `/api/screening/goal-screen/report.*` (workflowRuns.ts:550ff, runSummaries.ts xlsx/csv URL maps). |
| J | Agentic / NLQ / chat / voice / Slack / email — `UnifiedOptionsService.execute` via `src/trading/voice/agent.ts:446`, `slack/agent.ts:837`, `email/agent.ts:835` (actions options_screen, options_strategies, options_best_trade, options_opportunities), MAS/NLQ | Chat turn, voice, Slack, email, MCP tool call | Same UnifiedOptionsRequest fields as B, channel ui|slack|email|webhook|voice | Same engines as B (thesis-filtered unless the caller sets evaluateAllStrategies). Channel NLQ screens do NOT run the screener workflow (registry.ts:1418 note: they take the NLQ listings branch). | Channel-formatted output; recording depends on the entry route: routes through `/trading/options/*` record as in B/C; a direct `execute()` call with no route wrapper records nothing — there is no record step inside `UnifiedOptionsService.execute` itself. This is a real recording gap for any future direct caller. |
| K | Strategy discovery — scheduled + panel — `autonomousStrategyDiscovery*` (scheduledTasks.ts:2747ff): saved-request, profile-derived, no-view (issue #534) | Scheduled discovery (saved requests, capped MAX_SAVED_REQUESTS_PER_RUN; no view invented if none saved), panel discovery, tick-advisory discovery (F) | Saved discovery requests (symbol + view) / profile / no-view constraintSets; symbols; trigger manual|scheduled | Saved/profile: panel pipeline per request (thesis/view-filtered). No-view: `recommendNoViewStrategies` + `rankNoView`/`pickBestNoViewTrade` (scheduledTasks.ts:3929ff) — every selected definition, no thesis filter, target-free score model. | Discovery canonical row source `discovery`, title `Strategy discovery — <inputModel>`; discovery outcome sink (recordDiscoveryOutcome, #1333); Docs family "strategy" (`/api/discovery/report.*`); Slack/email/webhook discovery notifications. No strategy-report PDF/XLSX/CSV per se unless the discovery bridge's generate/serve stages produce them (chain mode, scheduledTasks.ts:2976ff: failed runs do NOT bridge/deliver). |
| L | Thesis (terminology) | — | — | There is NO standalone "thesis report" generator in code. "Thesis" in options code is the view field: bullish|bearish|range_bound|large_move (strategyEngine.ts:41, catalog ALL_THESES). Options scanner reports are titled `Options scanner — <thesis>` (optionsServeRecord.ts:250, scheduledTasks.ts title). The separate research-report "thesis" (trade-card narrative thesis/evidence/falsification, researchReportData.ts:10,28,47) belongs to research reports, not options screens. If the user expects a "thesis report", clarify which of these two they mean before counting. |

## 3. RCA — why reports are not produced (code-level, ranked)

1. **No record = no Docs row (highest-probability, and the code's own history).**
   Docs & Reports renders ONLY `/api/runs?kind=all&limit=100`
   (DocsAndReportsPanel.tsx:167), which merges canonical `mas_reports`
   rows (runSummaries.ts) + discovery scan runs (reports.ts:746ff).
   `toDocumentRows` (docsAndReports.ts:125ff) shows "—" for any
   artifact the row did not record, and drops rows whose family is not
   stock/options/goal/strategy. Known precedents written in the code:
   #2091 sharded blobs existed but unlisted until the serve record was
   added; an ownerless canonical row (userLogin missing) is stored
   under `default` and invisible to the owner-scoped read
   (optionsServeRecord.ts:55ff); the strategy route recorded nothing
   before `recordStrategyScreenRun`. Every record helper is
   best-effort / never-throws (optionsServeRecord.ts:55ff,140ff,230ff),
   so a failed write logs a warning and the run looks "not produced"
   in the UI while the screen itself succeeded.
2. **Per-format failure is non-fatal by design (#1278, #1023).**
   PDF, XLSX and CSV each have their own try/catch and status
   (`generated`|`failed`); a failed leg records `pdfStatus:"failed"`
   + `pdfError` and the run continues, with NO direct-generator
   fallback (screener-agent.ts:1820ff, scheduledTasks.ts:2240ff).
   The only regeneration path in code is `regenerateLatestReport`
   for the STOCK screener (screener-agent.ts:1885ff) — there is no
   equivalent re-generation for a failed options leg, so a transient
   blob failure is a permanently blank column until the run is
   re-executed.
3. **Sharded chain must reach SERVE to get its unified row.**
   Generate-stage rows are per-format (`options:<chainId>:<format>`,
   shardExecutors.ts:541ff); the unified `options:<timestamp>` row
   is written only by the serve-stage adoption (asyncJobs.ts:908ff).
   A chain stalled/failed before serve, a skipped serve, or a serve
   whose record helper warned-and-returned-false leaves blobs with
   no unified Docs row (or only fragmented per-format rows).
4. **Duplicate suppression produces a "run" with no artifacts.**
   Scheduled options: `claimScheduledExecution(jobKey)` (scheduled
   mode, scheduledTasks.ts:1986ff) returns skipped:true and records
   nothing on a duplicate minute/slot; stock scheduled: duplicate
   returns `skippedDuplicate:true` (screener-agent.ts:740ff). If the
   first attempt's record failed, the duplicate suppression then
   hides the second attempt too.
5. **Auth / service-user / token guards silently (or quietly) abort.**
   Scheduled tick skipped entirely if the service user is
   unprovisioned (server.ts:4104ff); queue options_analysis messages
   dropped (not retried) under the same condition; E*TRADE token
   cliff guard blocks scheduled options and stays quiet if already
   alerted (scheduledTasks.ts:1910ff auth-guard block). None of
   these write a Docs row.
6. **Wrong scheduler expectation.**
   The 21:00 UTC weekday tick is research, not options analysis (§F).
   A 09:20 UTC "Scheduled Options" row must come from a user
   schedule / queue / goal (§G) — if no such schedule exists in
   live data, the row's existence itself needs live schedule data
   to explain, and its absence on other days is expected, not a bug.
7. **Docs display truncation, not generation truncation.**
   `/api/runs` clamps limit to 100 (reports.ts:746ff), but
   `listScheduledReports` caps its own limit at 25
   (scheduledReports.ts:1050: `min(limit, 25)`). The panel's "100
   runs" is the merged, client-sorted (newest-first, docsAndReports.ts)
   union of the reports store (≤25) + scan runs — older canonical
   runs beyond that per-store cap are invisible in the panel even
   though they were generated. Also: a row with no recorded trigger
   renders Run Type "—" (docsAndReports.ts documentRunType), never a
   guessed "scheduled" — so the bare-UUID row's "—" Run Type/Run
   Source in the screenshot is consistent with a record that
   carried no trigger/family, and its Run ID shape matches no
   canonical generationId pattern in code (all are
   `options:*`/`options_strategy:*`/`options_scanner:*`/chain-id
   prefixed); the most consistent code source is an async-job twin
   id passed through as outcome id (recordStrategyScreenRun:
   `id: asyncJobId ?? generationId`; etradeOptionsScreen unified
   outcome: `id: ctx.asyncJobId ?? generationId`) — but that
   attribution is UNVERIFIED without live job/outcome rows.
8. **"Few strategies" is, for most channels, by design — not a
   renderer bug.** The strategy PDF/XLSX/CSV render exactly
   `strategyReportCandidates` = best + ranked + alternatives,
   deduplicated (strategyReport.ts:89ff). `ranked` itself is already
   thesis-filtered + acceptance-gated + fit-gated (see §1). So a
   best-trade NVDA report showing a handful of strategies means
   only a handful survived those filters for that symbol/thesis/
   DTE window — unless the caller expected `evaluateAllStrategies`,
   which only the sharded scheduled chain and no-view discovery
   set. If the expectation is "all 75 in every report", that is a
   product-definition change (set evaluateAllStrategies on the
   panel/scheduled routes, and accept the scoring/ordering
   consequences: thesisAlignment becomes descriptive, not
   exclusive — strategyEngine.ts:65ff), not a fix to the report
   generators, which faithfully render their input.

## 4. How many options PDFs are generated? (answer: not countable from code)

There is no counter, no single generationId namespace, and no
"options PDF" aggregate in code. Each successful pipeline run
generates at most one PDF per report set, under distinct key
families: `options:pdf:*` (unified pipeline), `options:pdf:strategy:*`
(strategy reports), plus per-format sharded rows and research PDFs
(a different family). A live count requires counting R2/DO blobs
with prefix `options:pdf:` plus canonical rows with pdfStatus
"generated" over a chosen window — that is a production-data
query, not a code fact, and it is NOT estimated here.

## 5. What to check live (in order) before changing code

1. For the two blank 05:21 rows: mas_job_outcomes rows for
   `options:2026-10-31T09:20:56.666Z` and for the bare UUID, and
   their mas_reports canonical rows — do the outcomes exist with
   null keys (generation failed) or are they absent (record failed
   / chain never reached serve / duplicate-suppressed)?
2. For the bare-UUID row: mas_async_jobs row with that id — is it
   an async-job twin, and what is its capability/payload trigger?
3. Live schedules: which scheduleId/goal fires options analysis at
   ~09:20 UTC, and is it still enabled?
4. Worker logs around 09:20 UTC for `optionsServeRecord`,
   `recordOptionsServeReport`, and per-format `pdfError/xlsxError/
   csvError` on that run — the per-format error fields are the
   only place a failed leg is named.
5. If the expectation is all-strategies: confirm the product
   decision (evaluateAllStrategies on panel routes) before
   touching the engine — the current thesis filter is deliberate
   and documented in strategyEngine.ts:65ff.
