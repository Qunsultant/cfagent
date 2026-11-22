# Report-scope inventory — note for the programme (user-provided 2026-11-01)

Source: user-pasted inventory, v1 2026-10-31, branch fix/2577-options-report-scope, evidence base origin/main at 0e368866, code paths cited by file and line at that commit. No production run records were readable from that workstation, so failure classes are code paths + distinguishing run-record fields, not assertions about which one fired for a specific run.

## Counts — supersedes the earlier separate strategy-type counting
- 6 options report types: (1) contract screen, (2) opportunity scan, (3) strategy screen (strategies, best-trade, compare, llm_ideas, llm_evaluate — one type, one generator family), (4) strategy discovery, (5) options research run, (6) goal screen (options leg, self-contained renderer bypassing the unified pipeline).
- 5 generator families, 3 formats each = 18 artifact kinds; 7 channels = up to 126 format/channel combinations, with 7 hand-written channel formatters. That combinatorics is why the same run looks different in Slack, email, and Docs.
- NOT stored artifacts, and not to be counted as reports in the product map: Copilot structured options card (src/client/chat/OptionsStrategyCard.tsx) and client-side run export bundle (src/client/runExport.ts, JSON/CSV/ZIP) — views over the same run data.
- Channels: UI download, Docs & Reports (mas_reports), Slack file + Block Kit, email attachments, webhook, MCP/A2A, chat/copilot card.

## Failures F1–F8 (inventory numbering — reconcile with earlier parent F-labels before quoting)
- F1 auth guard, most common: options has no fallback (stock degrades to Yahoo); dead/expired E*TRADE token fails the run, AUTH_003, one alert per episode then quiet. Distinguisher: audit etrade.auth_blocked / options.scheduled_analysis_blocked_quiet.
- F2 assemble refuses to publish when nothing evaluable (sharded chain, shardExecutors.ts:409, :416): no artifact by design, report simply absent.
- F3 subrequest budget: ~12 chain fetches/symbol vs 35 budget = floor(35/12) = 2 symbols per invocation; above that auto-shards; wide expiry windows can still overrun a shard. Distinguisher: coverage.truncated, partial.topSkipReason, per-symbol skipped[].
- F4 PDF leg fatal to the whole generate stage (shardExecutors.ts:460, generatePdf throws when pdfStatus != "generated"), even though the pipeline contract is per-format non-fatal (#1278) and the strategy path honors it.
- F5 monolithic path treats evaluatedCount == 0 as failure — same policy as F2, different site; empty result and broken provider look alike unless the skip reason is read.
- F6 scope drift between sharded and monolithic paths (FIXED in this branch): sharded executor hardcoded maxPlannedLoss 1000, minRewardRisk 1.5 and dropped minDte/maxDte (shardExecutors.ts:354-356). Same schedule could disagree with itself depending on sharding.
- F7 long-horizon strategies can never be evaluated at the default band: fetch band thesis-gated (etapiConfig.ts dteWindows 14–60), catalog largest horizon 550 DTE (LEAPS minDte 365, searchMaxDte 550). Widening is a subrequest-budget decision, not a bug; made an explicit preset (all-chains).
- F8 options PDF truncates every line at 120 characters (optionsReportPdf.ts text(), str.slice(0, 120), no wrapping).

## "Only 3 strategies" — three distinct causes
1. allowedStrategies is the wanted filter; evaluateAllStrategies only lifts the thesis clause (strategyEngine.ts:986-987). A schedule carrying three ids evaluates exactly those three.
2. "Evaluated" in the report means "built a candidate" (opportunityScanner.ts:938, :1216; optionsReportMatrix.ts counts cell types). A strategy judged on a thin chain that built nothing is "not evaluated: built no candidate" — a labelling defect.
3. Ranked list truncated before rendering (recommendationKernel.ts:1324 slices to candidateLimit; strategyReport.ts renders ranked ∪ bestTrade). Distinguishers: requestSnapshot.template.allowedStrategies, evaluations[].status per strategy, candidateLimit + report row count.

## What the scope branch changes (§4) — check against main before duplicating
- config/options-reports.json declares every axis (theses, strategies "all" = 74 registry entries or list, chains symbols/universe/maxSymbols/dte, gates 1000/1.5/warn, formats, channels ui/slack/email/webhook/mcp/a2a, content coverage/candidate limit/row caps/PDF truncation). Presets: full, thesis (historical default), quick (3 strategies, PDF only), all-chains. Precedence: request > env (OPTIONS_REPORT_CONFIG / OPTIONS_REPORT_PRESET) > preset > built-in; bad values dropped with structured warnings, never fail a run.
- src/trading/optionsReportScope.ts: resolveOptionsReportScope (pure, injectable registry), thesisRunPlan (one execution per thesis), horizonLimited (strategies the band cannot reach, named before the run), describeReportScope (one ASCII line for audit/report/run records).
- strategyReport.ts coverage: PDF Scope line + Coverage n-of-m + up to 12 named not-reported strategies with reason; XLSX Coverage + Coverage Summary sheets; CSV column contract unchanged.
- Wiring: scheduledTasks.ts resolves scope once per run, passes wanted set + gates into sharded chain and monolithic scan, stamps describeReportScope() into options.sharded_chain_submitted; shardExecutors.ts forwards minDte/maxDte/maxPlannedLoss/minRewardRisk (F6); types.ts carries them on the chain options block.
- NOTE 2026-11-01 (parent): main 1a47761b already carries scope work under #2583 (feat(2583) options report scope, import through trading barrel, DTE band and risk gates forwarded, coverage stated). Verify §4 against #2583 on main before building it again — the runtime slice must consume the scope resolver, not invent a second scope model.

## Still open (§5) — sequenced next, each independently shippable
- P2 multi-thesis fan-out: execute thesisRunPlan per symbol and merge into one report with per-thesis sections. Currently scope names all four theses but executes the first; the report says so, honestly but not the ask. Maps to programme slice 4 (#2600, strategy coverage as user choice).
- P3 PDF leg non-fatal in the shard generate stage (per-format contract, #1278 parity). Maps to slice 3 (#2599, F4).
- P4 one options section model behind the three PDF renderers (optionsReportPdf, strategyReport, discoveryReportPdf), old exports kept as deprecated wrappers, no deletions (§22). Removes F8 and duplicated print machinery.
- P5 route discovery and goal-screen artifacts through unifiedReportPipeline. Maps to slice 5 (#2601, workflow consolidation).
- P6 channel matrix from scope.channels — one formatter, per-channel adapters. This is channel parity, after report parity.
- P7 rename the coverage vocabulary: "evaluated" = engine judged; "reported" = reached the page. Fixes cause 2 of the three-strategy confusion.
- Non-goals: no deletions (deprecate in place with named successor); no change to the thesis's role in scoring — thesis orients ranking, it does not decide inclusion in a report scope.
