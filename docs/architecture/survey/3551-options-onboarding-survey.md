# Survey — onboard OptionsScreenerWorkflow to the J1–J7 stack (#3551)

- Parent: **#3551** "[One engine] Options screens — stages onto the one engine + uniform stage control" (OPEN, sub-issue of #3549, Agent field #CAIO-quns). Verified 2026-11-11: **zero formal sub-issues** (`has_children: false`).
- Tree: fresh main fetched **2026-11-11 08:33 UTC** (`~/workspace/verify-options-onboarding/cfagent-main/`).
- Template: the stock sibling #3550's six sub-issues #3940–#3946 (bodies read in full 2026-11-11; all filed by OpenAIMP 2026-11-10, all `lane:cto-mbshr`). Stock gains/losses analysis: #3550 comment `6761599459` (2026-11-10), saved at `~/workspace/verify-options-onboarding/stock-3550-comments.md`.
- Survey-only: no issues created, no code changed.
- #clo-arsi

## 0. Headline findings

1. **The options workflow is real and single.** `runOptionsScreenWorkflow` (`src/workflows/optionsScreenWorkflow.ts:135`) iterates 8 stages — plan, chainFetch, enrich, screen, risk, persistCanonicalResults, shapeReport, deliver (`src/workflows/stageRuntimeIds.ts:87-96`) — built by #3186 (CLOSED via PR #3453). It is a thin composer; stage logic lives behind ports (`src/workflows/optionsScreenPorts.ts:201`).
2. **It keeps its own bespoke stage machine.** It does NOT use the shared stage contract (`stageRunnerPorts.ts`, `StageRunnerPlan`, `StageCheckpointStore`); it has its own port interface, its own idempotency claims, and its own failure semantics (`src/workflows/optionsScreenWorkflow.ts:52-70,139-260`). The old seam `src/workflows/optionsStageSeam.ts` is retired (#3186 step 3d). This is the exact 0%-reuse shape #3842 measured for stock.
3. **The engine's canonical leg is now wired — the stock picture is stale.** #3940 is CLOSED (PR #4029 merged 2026-11-11T06:19:43Z). On this tree `canonicalReportStore` is the tenant-aware leg in BOTH residencies (`src/workflows/jobPipelineWorkflow.ts:95-113`, `src/agents/scheduledTasksPipeline.ts:312-324`). But **none of the engine's feed/store/deliver machinery applies to options runs**: no options feed job, no options generate job, no options run is dispatched through `JobPipelineWorkflow`.
4. **The options feed is a live pull, not a feed job.** Chains are fetched live inside `chainFetch` (`DynamicOptionsScreener.fetchChains`, `src/trading/optionsScreener.ts:769-830`); there is no options-chains feed job, no capture wiring, no persisted chain dataset. `FEED_JOB_NOT_CONFIGURED` never applies to options — it is a J-engine refusal only.
5. **Options delivery has no (runId, destination) suppression.** The only caller of the suppressor is the stock `followup.deliver` executor. The options manual deliver has no claim check; the J deliver stage dedups by a different key (`(reportKind, channel)` per generated artifact) that does not apply to options.
6. **9 direct call sites, 0 through the engine, plus live bypasses.** Every `runOptionsScreenWorkflow` call site invokes the function directly. And several options-screen paths bypass even the workflow (`POST /broker/options/screen`, `UnifiedOptionsService.execute()` screen/opportunities cases, `runPanelPipeline`) — so #3186's acceptance ("No options screen executes outside the workflow after this lands") does **not** hold on this tree.
7. **There is no Options Copilot agent.** "Options Copilot" is a client-side registration only (`src/client/chat/copilotRegistry.ts:141`). Chat screening runs via NLQ options actions and the `run_options_strategy_screen` mesh door. There is no options agentic loop/cycle (stock has one; options has only the `autonomousOptionsAnalysis` report schedule).
8. **Two stock topics have NO options analogue and must not be duplicated:** #3944 (retire — fully generic engine work) and #3945's engine extension itself (fully generic; the options slice is vocabulary coverage only).
9. **#3072 is the unresolved predecessor.** OPEN, parent #3069 (CLOSED), `lane:cfo-qunso`, never updated since 2026-11-04, blank §15. It uses the 6 catalog stages; #3186 pins 8 options stages. Whether #3072 was superseded by #3186/#3551 is not stated anywhere.

## (a) Workflow map — the options pipeline today

Stages in pipeline order (`OPTIONS_PIPELINE_STAGES`, `src/workflows/stageRuntimeIds.ts:87-96`). One Block per stage in `src/workflows/blocks/optionsBlocks.ts` (ids `options-<stageId>`); production ports in `src/workflows/optionsScreenPorts.ts:201` (`createOptionsScreenPorts`). Every stage persists via the same generic function to OptionsStageStorage under key `options:<runId>:<stageId>` (`src/workflows/optionsScreenPorts.ts:55-57,208-214`) — DO storage (`ctx.agentCtx.storage`, manual entry `src/agents/routes/etradeOptionsScreen.ts:88`) or in-memory (`memoryStageStorage()`, `src/workflows/optionsScreenWorkflow.ts:114-124`). Only `persistCanonicalResults` writes `mas_reports`.

| # | Stage | Input → output | Persisted where |
|---|---|---|---|
| 1 | `plan` | runId + request → plan object + artifactKeys (`planner.plan`, `src/workflows/optionsScreenPorts.ts:217-224`) | `options:<runId>:plan` |
| 2 | `chainFetch` | plan keys + underlyings → chains array (`screener.fetchChains`, `:225-237`); terminal "partial" on fetchErrors/deferredSymbols | `options:<runId>:chainFetch` |
| 3 | `enrich` | chain keys → enriched array (`evaluateContracts`, `:239-259`) | `options:<runId>:enrich` |
| 4 | `screen` | enriched keys → contracts array (`aggregateScreenResult`, `:261-329`); throws (fails run) if fetchErrors and zero chains fetched, per #1963 (`:273-281`); terminal "no_contracts" when matchedCount is 0 | `options:<runId>:screen` |
| 5 | `risk` | candidate keys → riskReports (`assessSagaTradeRisk`, `:331-359`); no tradeIntent → "unassessed", never blocks; violation → terminal "violation" → failed run `risk_violation` (`src/workflows/optionsScreenWorkflow.ts:197-210`) | `options:<runId>:risk` |
| 6 | `persistCanonicalResults` | screened keys → runId + artifactKeys; builds `UnifiedOptionsRunRecord` (default title "Options screen", source "options-screen-workflow") and calls `recordUnifiedOptionsRun` (`:361-399`). **Only stage that writes the canonical store.** | `options:<runId>:persistCanonicalResults` + the `mas_reports` row |
| 7 | `shapeReport` | canonical + screen keys → report object (caller-supplied `deps.shapeReport`, `:401-419`); manual entry generates PDF + XLSX + CSV and re-records the SAME canonical row (same generationId) with report keys/statuses (`src/workflows/manualOptionsScreen.ts:126`) | `options:<runId>:shapeReport`; report blobs in ScreenerAgent DO blob storage |
| 8 | `deliver` | report keys → deliveryState string (caller-supplied `deps.deliver`, `:421-437`) | `options:<runId>:deliver`; outcome recorded by the deliver fn itself |

### Canonical store — there is NO options-specific store

Options reuses `mas_reports`, the same canonical table as stock. Write path: `recordUnifiedOptionsRun` → `storeOptionsCanonicalReport` (`src/services/optionsServeRecord.ts:150-175`) → `orm.storeCanonicalReport` (`:78-100`) → `storeReportAtGeneration` (`src/services/scheduledReports.ts:773`), the one writer with generation-id idempotency (`src/data/canonicalReportStorePorts.ts:8-14`). The canonical store is OPTIONAL in the ports: a leg inside a composed run may omit it, and then `persistCanonicalResults` records `created:false / reportId:null` and writes NO `mas_reports` row (`src/workflows/optionsScreenPorts.ts:88-102,391-396`) — the goal leg omits it for exactly this reason. The canonical write never fails the run (`recordUnifiedOptionsRun` returns null when the ORM is absent, `src/workflows/optionsScreenPorts.ts:28-31`).

**Stale comment (flag, do not trust):** `src/workflows/stageRuntimeIds.ts:84` says `persistCanonicalResults` pins to a "canonical mas_opportunity_scans write". That contradicts the code above. `mas_opportunity_scans` is a DIFFERENT store — the scan-run store (`TABLE = "mas_opportunity_scans"`, `src/data/doSqliteScanRunAdapter.ts:40`), used by the scanner/strategy leg (`src/workflows/strategyScreenPorts.ts:389`), not by the 8-stage options workflow. No write to `mas_opportunity_scans` exists in `optionsScreenWorkflow.ts` or `optionsScreenPorts.ts`. The same comment block also maps `shapeReport → runPanelPipeline` and `deliver → deliverScreenerToSlackA2A`, which describe legacy mappings, not the current caller-supplied deps. The whole block needs correction (carried into draft sub-issue 6).

### Catalog display vs execution vocabulary

The workflow catalog partitions the 8 execution stages under 4 display stages (`src/workflows/workflowCatalog.ts:201-242`): feed covers plan/chainFetch/enrich/screen/risk; store covers persistCanonicalResults; serve covers shapeReport; deliver covers deliver. Catalog entry: `id: "options-screener"`, `runPath: "?tab=options-screener"` (`src/workflows/workflowCatalog.ts:209,216`). The shared stage contract's order is the 6 catalog stages (`RUNNER_STAGE_ORDER = ["feed", "gather", "analysis", "store", "serve", "deliver"]`, `src/workflows/stageRunnerPorts.ts:45-52`) — note "gather"/"analysis" vs the catalog's "feed" grouping; the options display mapping does not use "gather" or "analysis" at all.

### The J engine on this tree (what the onboarding targets)

- Step registry: `createPipelineStepRegistry` (`src/services/enrichPipelineJobs.ts:404-420`) composes feed (`feed.pull`, `feed.universe`), enrich (`enrich.apply`), analyze (`analyze.apply`), generate (`generate.apply`), deliver (`deliver.apply`). Step ids: `src/services/feedPipelineJobs.ts:65-66`, `src/services/enrichPipelineJobs.ts:71`, `src/services/analyzePipelineJobs.ts:58`, `src/services/generatePipelineJobs.ts:61`, `src/services/deliverPipelineJobs.ts:64`.
- Control plane: `JobPipelineControl` (`src/services/jobPipelineEngine.ts:378`) implements the seven operations on **job stages** addressed by `(jobId, nodePath)` — `runStage` (:757), `rerunStage` (:805), `stopStage` (:863), `resumeStage` (:932), `cancelStage` (:975), `scheduleStage` (:1062), `rescheduleStage` (:1117). No "vocabulary" in `jobPipelineEngine.ts`; plans are single-family (vocabulary OR job stages, never mixed).
- Canonical leg (wired by #3940, verified on this tree): workflow residency `src/workflows/jobPipelineWorkflow.ts:95-113` (`generateStepDepsForWorkflow`, `createTenantAwareCanonicalReportStore` via the orchestrator door `recordPipelineGenerateReport`; header comment `:82-94`: the copy "writes through the orchestrator door into the report-owning tenant's Orchestrator DO, never into a store this residency owns"; a job with no resolvable tenant records `not_wired` with its coded reason). Host residency: `src/agents/scheduledTasksPipeline.ts:312-324`, identical leg. The NULL case is now only a type-level fallback (`GenerateStepDeps.canonicalReportStore?`, `src/services/generatePipelineJobs.ts:254,322`); `not_wired` is a per-report fallback (`src/services/generateJobs.ts:839-857`, `GENERATE_GAP_CODES.canonicalNotWired` `:111`). The seam "never writes mas_reports directly — it calls the report-owning tenant's Orchestrator DO door" (`src/services/generateJobs.ts:249-252`).
- Engine feed in workflow residency: `providerFor: () => undefined` (`src/workflows/jobPipelineWorkflow.ts:181`); comment `:148-157` states capture-wired providers need a DO host's storage, so a feed pull dispatched there refuses `FEED_JOB_NOT_CONFIGURED` rather than fetching uncaptured. Host residency wires a real provider via `createCaptureWiredFeedProvider` (`src/agents/scheduledTasksPipeline.ts:180-230`).
- Engine deliver: `deliver.apply` consumes persisted generated-dataset artifacts, dedups by `deliverPairKey(reportKind, channel)` = `<reportKind>:<channel>` (`src/services/deliverJobs.ts:583-585`), marks already-delivered pairs `"already_delivered"` without calling the sender (`:781,812-824`). Channel senders from env (`createDeliverChannelSenders`, `src/services/deliverJobs.ts:244-262`); unconfigured transports record `not_configured` per report, never a fake delivery.

## (b) Per-topic gap table — stock topic vs options evidence

### 1. Canonical store leg (stock #3940, CLOSED via PR #4029)

| | Stock | Options |
|---|---|---|
| Gap was | Engine leg `canonicalReportStore: null`; generate recorded `not_wired` in both residencies | Same engine leg, now WIRED by #3940 — but options never uses it |
| Options evidence | Options canonical rows are written by a different path: `recordUnifiedOptionsRun` → `storeOptionsCanonicalReport` → the route's ORM (`src/services/optionsServeRecord.ts:154-159,76-100`; manual entry wires `canonical: { storeCanonicalReport: (input, env) => ctx.getOrm().storeCanonicalReport(input, env) }`, `src/agents/routes/etradeOptionsScreen.ts:86-92`). The engine leg writes pipeline-generate reports with generationId `pipeline-generate:<jobId>:<inputArtifactId>` (`src/services/generateJobs.ts:869-873`) through `GenerateStepDeps` / `runGenerateJob`. No options generate job exists in the generate registry; no options run is dispatched through `JobPipelineWorkflow`. | |
| Verdict | **ANALOGUE EXISTS — file it.** When `persistCanonicalResults` is re-expressed as an engine stage, its canonical write must go through the engine's tenant-aware leg (or be proven to land identically), with the `UnifiedOptionsRunRecord` shape carried through and the leg recording "wired" (never `not_wired`) in both residencies. Design work, not a move: the record builder (`createManualOptionsRecordBuilder`, `src/workflows/manualOptionsScreen.ts:97`) and generation-id scheme must map onto the leg's input. Also decide the goal leg's omitted-canonical case (`created:false`, no row) under the engine. | |
| Fix belongs | **Engine** (added TO the engine per #3551's rule) — the leg is generic; the options mapping is the slice. | |
| Draft | Sub-issue 1 in §(e). | |

### 2. Feed parity (stock #3941, OPEN)

| | Stock | Options |
|---|---|---|
| Gap was | `providerFor` unwired in workflow residency; feed pulls refuse `FEED_JOB_NOT_CONFIGURED`; pulls execute only on the ScheduledAgent host residency | **No options feed job exists at all.** The feed-job registry (`src/services/feedJobs.ts`, `buildFeedJobRegistry`) registers only quotes / fundamentals / technicals / sentiment jobs over stored index universes (sourceIds yahoo, alpaca, etrade, public). A grep for "option" in `feedJobs.ts` / `feedPipelineJobs.ts` returns only a comment (`feedJobs.ts:329-330`: "Public's legs allow quotes + optionsChains per its adapter, so its quotes job is in scope") — no optionsChains dataset or job is registered. |
| Options evidence | The options feed is a DIRECT LIVE CALL inside `chainFetch`: `screener.fetchChains(filter)` (`src/workflows/optionsScreenPorts.ts:230`) → `DynamicOptionsScreener.fetchChains` (`src/trading/optionsScreener.ts:769-830`) → per-symbol `fetchChainsForSymbol` (`:539-543`) → injected `OptionChainSource.getOptionExpireDates` / `getOptionChains` (`src/trading/optionChainSource.ts:46-60`). Provider resolved per tenant broker at the entry by `UnifiedOptionsService.resolveEngineClient` (`src/trading/options/unifiedOptionsService.ts:695`): etrade → raw `ETradeRestClient` (`:733-743`); otherwise `platformChainSource(platform)` (`src/trading/optionChainSource.ts:81-100`); no options data plane → `provider_unsupported: broker "<broker>" does not provide an options chain source (no getOptionChains/getOptionExpireDates); no other broker's data is used in its place.` (`:712-725`). No silent fallback to E*TRADE data. With no source configured, a symbol returns fetchError "No option chain source configured for live chain fetch." (`src/trading/optionsScreener.ts:546-552`) — a per-symbol error, not a run refusal. No feed dataset is persisted: chains live only in the `chainFetch` checkpoint artifact (`options:<runId>:chainFetch`) and the `mas_reports` row's body. | |
| `FEED_JOB_NOT_CONFIGURED` | J-engine only, never applies to options. Definition `src/services/feedPipelineJobs.ts:328-332`; guards `:370-373` (missing dataset store / universe store / capture-wired provider). | |
| Verdict | **ANALOGUE EXISTS — but the work is different in kind.** #3941's acceptance shape ("the same feed job runs to completion in both residencies with identical dataset output and provenance") cannot be met for options without first giving chains a persisted dataset. The slice must DECIDE then implement: (a) register options-chains as a feed job with capture wiring + a persisted dataset in the #3530 feed-dataset store, so `chainFetch` consumes a persisted dataset like the stock feed; or (b) keep the live pull in `chainFetch` and pin it to host residency, with the decision recorded and an honest coded refusal where it cannot run. **Not established from the tree:** whether the injected chain source (a live client object resolved at the entry) can execute in workflow residency at all — the slice must establish this (e.g. by running `chainFetch` in workflow residency in a test, or proving the source needs host storage). The #3990 taxonomy (which brokers/providers serve `optionsChains`; Alpaca via the repo's own read path, Yahoo deliberately not wired) is the provider input to this decision. | |
| Fix belongs | **Engine** if (a) (a new feed dataset + job, added TO the engine); **decision + family pin** if (b). | |
| Draft | Sub-issue 2 in §(e). | |

### 3. Delivery suppression (stock #3943, OPEN — "blocks safe re-run/replay")

| | Stock | Options |
|---|---|---|
| Gap was | Screener delivers via orchestrator `followup.deliver` with `(runId, destination)` suppression (`mas_delivery_claims`); J deliver uses its own dataset ports + senders | Options has NO suppression at all, and the J deliver's dedup does not cover it |
| Options evidence | Suppressor: `src/workflows/screenDeliverySuppression.ts` — key `<runId>::<destination>` (`:70-72`), `tryClaim`/`wasClaimed`/`release` (`:85-113`), destinations `slack \| email \| webhook`, email distinguished by recipient (`:76-83`); durable store `mas_delivery_claims` in DO SQLite, wired in `src/agents/orchestrator.ts:719`. Repo-wide grep for `createDeliverySuppressor` / `tryClaim` / `deliverySuppression` finds ONLY `src/agents/orchestrator.ts:123,719` and `src/agents/orchestrator/asyncJobs.ts:77,2086-2089` (the stock `followup.deliver` executor: on `tryClaim` false it audits `followup.delivery_suppressed` and completes the job as skipped, `:2078-2095`; on send failure it releases the claim, `:2115-2125`). Neither `manualOptionsScreen.ts`, `goalOptionsLeg.ts`, nor the J deliver service references the suppressor. Options manual deliver (`createManualOptionsScreenDelivery`, `src/workflows/manualOptionsScreen.ts:126`): Slack via the follow-up bridge (`screenerOutcomeFromRunResult("options", …)`) or direct Slack A2A (`deliverGatedSlack`, PDF/XLSX/CSV re-fetched by key), gated by `screenPushToSlack !== false` and `!deferDelivery`; email (#1336) via `sendOptionsRunEmail` (cfpay A2A or `ETradeEmailTradingService`), recipient via `resolveOptionsRunEmailRecipient`; job-outcome record `options-manual:<runId>` when the bridge did not take the run; "a sink failure must not fail the run". NO webhook channel in the options manual deliver. Goal leg (`src/workflows/goalOptionsLeg.ts:2-14,40-43`): does NOT deliver itself; deliver returns `"deferred-to-goal-run"` — "The goal run's delivery is the delivery." The options manual deliver's only duplicate guard is the composer's per-stage idempotency claim (a re-run with the SAME runId skips the already-claimed deliver stage, `src/workflows/optionsScreenWorkflow.ts:155-160`) — a fresh runId re-sends. The J deliver dedups by `(reportKind, channel)` per generated artifact (`deliverPairKey`, `src/services/deliverJobs.ts:583-585,781,812-824`) — per-generated-copy dedup, not per-run/per-destination, and options never produces a generated-dataset artifact. | |
| Verdict | **ANALOGUE EXISTS — file it.** Re-home/extend duplicate-delivery protection onto the options deliver stage with reconciled keying: options run ids (`options_scanner:manual:<iso>`, `options_scanner:unified:<iso>:<thesis>`, `nlq-panel:<uuid>`, `nlq-scan:<uuid>`, `goal-screen:<key>:options`, `shard-scan:<chainId>:<symbol>`, `options-manual:<runId>`) against `<runId>::<destination>`; the `deferred-to-goal-run` case must not double-deliver when the goal run delivers; the J `(reportKind, channel)` dedup must be reconciled or explicitly chosen, not silently added as a second suppressor. | |
| Fix belongs | **Engine** (the J deliver stage consults the same suppressor module — one module, injected store, no second suppressor, per #3943). | |
| Draft | Sub-issue 3 in §(e). | |

### 4. Retire operation (stock #3944, OPEN, non-blocking)

| | Stock | Options |
|---|---|---|
| Gap was | Zero "retire" in `stageRunnerPorts.ts`, `jobPipelineEngine.ts`, `workflowLifecycle.ts` | Same — the gap is engine-level, not family-level |
| Verdict | **NO OPTIONS ANALOGUE — do not file.** #3944 is fully generic: "add a retire operation to the engine's uniform stage operations with pinned semantics (a retired stage never re-runs; downstream never silently proceeds)". Once it lands in the engine, retire is available to options stages under the same addressing — provided the options stage vocabulary is addressable, which is draft sub-issue 4's job. Track #3944 as a dependency of #3551, not as an options sub-issue. The only family-specific note in #3944 (pause is schedules-only on the screener; the engine's stop is the pause-equivalent) needs an options-side equivalent in the communication: options today has no per-stage pause/stop at all, so the semantic change lands the same way. | |
| Draft | None. | |

### 5. Control plane to (runId, stageId) (stock #3945, OPEN — "the headline gain needs it")

| | Stock | Options |
|---|---|---|
| Gap was | `JobPipelineControl` ops take `(jobId, nodePath)`; #3549 promises `(runId, stageId)`; no "vocabulary" in `jobPipelineEngine.ts`; plans single-family | Identical for options — and the options vocabulary is a second vocabulary the plane must know |
| Verdict | **NO duplicate engine issue — file the options APPLICATION only.** #3945's engine extension is fully generic; filing a second control-plane issue would fork the plane (forbidden by #3551's body). What options needs is its own slice: register the options stage vocabulary with the extended plane and prove the seven operations work addressed by `(runId, stageId)` on an options run. Two options-specific facts shape it: (a) options already HAS 8 discrete execution stages — there is no #3217 analogue needed for options (the 13-discrete-stages question is stock-specific); (b) the addressable vocabulary must be the 8 execution stages, NOT the 4 catalog display stages (feed/store/serve/deliver) — per-stage control at display granularity would be coarser than the pipeline itself. Depends on: #3945 (engine extension) + draft sub-issue 6 (vocabulary decision). | |
| Fix belongs | **Engine** for #3945 (shared); **engine registration + verification** for the options slice. | |
| Draft | Sub-issue 4 in §(e). | |

### 6. Run recorder decision (stock #3946, OPEN — "decide before the onboarding, so run history is not stranded")

| | Stock | Options |
|---|---|---|
| Gap was | Screener records `mas_reports` + `mas_async_jobs` stage rows + D1 projection rows; J records D1 AgentDB job instances + `D1JobRunRecordStore`; run-record side undecided | Same decision shape, different ledgers — and options has extra wrinkles |
| Options evidence | Options runs record in MORE places than stock: (i) `mas_reports` canonical rows (only when the canonical store is wired — the goal leg omits it, `created:false`); (ii) OptionsStageStorage checkpoints `options:<runId>:<stageId>` — in DO storage at the manual entry but **in-memory at most call sites** (only site 1 uses durable SQL claims; sites 4, 5, 8, 9 confirmed in-memory in the survey, sites 2, 3, 6, 7 not individually verified) (`memoryStageClaims()` / `memoryStageStorage()`, `src/workflows/optionsScreenWorkflow.ts:118-135`), i.e. checkpoints that do not survive the process at most entries; (iii) `mas_async_jobs` stage rows (the contract anticipates vocabulary stages checkpointing onto them via the production checkpoint adapter — per #3946); (iv) per-leg D1 stage rows for goal options legs (#3186 / #2038: "Per-leg D1 stage rows for goal options legs ride this workflow's stage record … and surface in Workflow Runs through the #2786 surface"); (v) the scan-run store `mas_opportunity_scans` for the scanner/strategy leg (`src/workflows/strategyScreenPorts.ts:389`); (vi) job-outcome records `options-manual:<runId>` (manual deliver tail). Read surfaces: Workflow Runs page, ReportsPanel, RunDetailView (per #3946) — plus the per-leg D1 rows' surfacing. | |
| Verdict | **ANALOGUE EXISTS — file it.** Decide one ledger vs two ledgers with read-surface migration for options runs, with the acceptance that every options run record readable today stays readable from exactly the surfaces the decision names, with no orphan or duplicate rows and no silent loss of run history. The decision must explicitly cover: the in-memory checkpoints (durability — do they become durable, and where?), the goal leg's omitted canonical row, the per-leg D1 stage rows, and the `mas_opportunity_scans` scan-run rows. | |
| Fix belongs | **Decision first, then engine + read surfaces** (same shape as #3946). | |
| Draft | Sub-issue 5 in §(e). | |

### 7. Stage vocabulary reconciliation + #3072 disposition (no stock analogue — options-specific)

- **The mismatch:** #3072 (OPEN, parent #3069 CLOSED, `lane:cfo-qunso`, created 2026-11-04, never updated, blank §15, 0 comments) uses the 6 catalog stages (feed/gather/analysis/store/serve/deliver) with per-format legs preserved ("per-format generate/store legs are legitimately partial — a failed format does not stop the chain — and delivery is the serve+deliver group"). #3186 (CLOSED) pins 8 options stages (plan, chainFetch, enrich, screen/strategize, risk, persistCanonicalResults, shapeReport, deliver). The catalog on this tree partitions the 8 execution stages under 4 display stages. Three vocabularies describe one pipeline, and #3072's status is unrecorded: superseded by #3186/#3551, or still live work? #3551 says it "absorbs its family's share of #3069" — that share IS #3072 — but no issue body states the disposition.
- **Also:** #3072 excludes "the control operations and the catalog UI" and "any change to the #2530 non-deterministic gate or the deterministic default" — those exclusions still bound what the vocabulary slice may touch. And the catalog comment (`src/workflows/workflowCatalog.ts:201-242`) says "The legacy #3191 phases are retired (their only publisher was the #3072 emitter, called only by the manual handler)" — i.e. #3072's emitter is already retired in code while #3072 itself stays open.
- **Verdict: file it.** Pin one addressable vocabulary (the 8 execution stages), preserve the per-format-leg rule, correct the stale `stageRuntimeIds.ts:82-86` comment block, and record #3072's disposition (close as superseded by #3551 with a comment, or keep — with the reason). This gates draft sub-issue 4 (control-plane coverage) and the onboarding itself.
- **Fix belongs:** decision + catalog + comments (family + engine vocabulary registration).
- **Draft:** sub-issue 6 in §(e).

### 8. Entry-point routing (no stock analogue filed — options follow-up)

- Stock's Loss 6 (comment `6761599459`): direct `runScreen` call sites bypass the engine; "onboarding the workflow alone does not unify screening" — outside #3550's stated scope. The same is true for options, worse: 9 direct call sites (§(c)) plus live bypasses that skip even the workflow. #3186's acceptance ("No options screen executes outside the workflow after this lands") does not hold on this tree — the bypasses in §(c) are live code.
- **Verdict: file it as a follow-up sub-issue of #3551** (per #3551's body: "Exceptions and follow-ups are filed as sub-issues of this issue, never left as comments"), sequenced AFTER the workflow is on the engine. Scope: route the 9 direct call sites through the engine-routed workflow; route the bypasses through the workflow or retire them by rename (never delete, repo rule, per #3186's own acceptance); verify "no options screen executes outside the workflow" on fresh main.
- **Draft:** sub-issue 7 in §(e).

## (c) Entry-point inventory — every path that screens options today

All 9 `runOptionsScreenWorkflow` call sites call the function directly; none goes through the J engine / job pipeline (a case-insensitive grep for `option` in `src/workflows/jobPipelineWorkflow.ts` and `src/workflows/cfWorkflowAdapter.ts` returns no matches; no call site references `jobPipelineWorkflow`, `cfWorkflowAdapter`, or a chain/job-pipeline runner). The workflow is a plain function (`src/workflows/optionsScreenWorkflow.ts:135`), not a class — there is no `OptionsScreenerWorkflow` / `OptionsScreenWorkflow` class. Header: "THIN composer. Ordered stage Blocks, nothing else… The composer never calls an engine directly." (`src/workflows/optionsScreenWorkflow.ts:1-21`).

### The 9 direct call sites

| # | Call site | Caller | Run-id shape | Notes |
|---|---|---|---|---|
| 1 | `src/agents/routes/etradeOptionsScreen.ts:104` | `executeOptionsScreen()` (`:61`), the manual screen handler. Route `POST`/`GET /trading/options/screen` (`src/agents/routes/etradeOptions.ts:802` → `:858`). | `options_scanner:manual:<iso>` | Ports `createOptionsScreenPorts` + `createManualOptionsScreenDelivery` + `createManualOptionsRecordBuilder`; durable SQL claims (`createSqlStageClaimStore`); queue `SCREENER_EVENTS`. The only site with durable claims/storage. |
| 2 | `src/agents/routes/etradeOptionsScreen.ts:197` | `runUnifiedOpportunitiesViaPipeline()` (`:171`), called only by `executeUnifiedOptions()` when `reqData.action === "opportunities"` (`:302`, dispatch `:355-359`). Route `POST`/`GET /trading/options/unified` (`src/agents/routes/etradeOptions.ts:893` → `:922`). Regenerate reuses it (`src/agents/routes/optionsRegenerate.ts:72`). | `options_scanner:unified:<iso>:<thesis>` | |
| 3 | `src/workflows/manualPanelScreen.ts:66` | `runManualPanelViaPipeline()` (`:58`). Routes `POST /trading/options/strategies` or `/best-trade` (`src/agents/routes/etradeOptions.ts:687` → `:719`); compare `POST /trading/options/compare` (`:493` → `:512` → `runComparePanelViaPipeline` → `manualPanelScreen.ts:129` → site 3). | — | Ports `createStrategyScreenPorts` over OptionsDataAgent + StrategyRiskAgent + RecommendationAgent. |
| 4 | `src/trading/options/unifiedOptionsService.ts:538` | `UnifiedOptionsService.runStrategyPipeline()` (static, `:516`). "The seam all three execute() panel cases (strategies / best_trade, compare, llm_ideas) ride" (`:521-531`). | — | In-memory storage/claims; `queue: null`. |
| 5 | `src/agents/nlqOptionsStrategy.ts:879` | `runOptionsStrategyAction()` (`:785`) — single-name panel leg (actions `options_strategies` / `options_best_trade`). Dispatched from `src/agents/nlq/execution.ts:1948-1949`. | `nlq-panel:<uuid>` | Ports `createStrategyScreenPorts`; in-memory claims/storage unless `deps.pipelineStorage`/`pipelineQueue` supplied. |
| 6 | `src/agents/nlqOptionsStrategy.ts:1278` | `runOpportunityScan()` (`:1188`) — multi-symbol NLQ scan leg (action `options_opportunities`). | `nlq-scan:<uuid>` | Ports `createScannerScreenPorts` (+ `scanRunStore` when present). |
| 7 | `src/services/goalDrivenScreen.ts:141` | `runGoalOptionsLegViaWorkflow()` (`:119`), the goal-screen options leg. Fails closed without `userLogin` (`:122-127`). Reached via `ScreenerAgent.runGoalScreen()` (`src/agents/screener-agent.ts:1799`, options leg deps `:2134`) → `runProductionGoalScreen()` (`src/services/screeningRuntime.ts:200`) → `runGoalDrivenScreenWithLedger()` (`:241`). | `goal-screen:<idempotencyKey>:options` | Omits the canonical store (`created:false`, no `mas_reports` row); deliver returns `"deferred-to-goal-run"`. |
| 8 | `src/services/scheduledTasks.ts:2920` | `ScheduledTasksService.autonomousOptionsAnalysis()` (`:2484`) — monolithic (non-sharded) branch only. Wrapper `OrchestratorAgent.autonomousOptionsAnalysis()` (`src/agents/orchestrator.ts:1463`, service call `:1505`); callback name in `src/agents/orchestrator/scheduleCallbacks.ts:20,29`; cron arming via `ctx.strategyScanCron` (`src/agents/orchestrator/scheduleMaintenance.ts:192`); manual trigger `src/agents/routes/schedules.ts:988-992`. | — | In-memory storage/claims; engine client from `unifiedService.resolveEngineClient()` (`:2894`). |
| 9 | `src/services/shardExecutors.ts:515` | `executeOptionsSymbol()` (`:481`) — per-symbol shard scan, wrapped in `withRetry` with the feed retry policy. Reached from the sharded branch of site 8 (`planOptionsFeedShards` + `shardSubmit`, `src/services/scheduledTasks.ts:2760`) via `executeShardJob()` (`src/services/shardExecutors.ts:846`), dispatched from `src/agents/orchestrator/asyncJobs.ts:2202` (and `src/agentic/chainExecutor.ts:249`). | `shard-scan:<chainId>:<symbol>` | In-memory storage/claims. |

`src/workflows/manualOptionsScreen.ts` is NOT a call site — it only supplies ports consumed by site 1 (`createManualOptionsRecordBuilder()` `:97`, `createManualOptionsScreenDelivery()` `:126`).

### Paths that bypass even the workflow (live on this tree)

- `POST /broker/options/screen` (`src/agents/routes/brokerOptions.ts:66,91`) → `screenOptionsWithSource()` (`src/trading/options/optionChainSource.ts:97`, engine call `:103`) → `DynamicOptionsScreener.screenOptions()` directly. No workflow.
- `UnifiedOptionsService.execute()` (`src/trading/options/unifiedOptionsService.ts:811`): `case "screen"` (`:840`) calls `screenContracts()` (`:511-514`, `new DynamicOptionsScreener(client).screenOptions(filter)`) directly — no workflow. `case "opportunities"` (`:997`) calls `scanOpportunities()` (`:584`, direct `OpportunityScanner` scan) directly — no workflow (the unified *route* diverts opportunities to site 2 before `execute()` is reached). Panel cases (`strategies`/`best_trade` `:964`, `compare` `:1175`, further panel case `:1246`) call `runStrategyPipeline()` → site 4 (workflow). The `:1246` case label was not verified in the grep output (presumed `llm_ideas` from surrounding code — not asserted).
- `src/agents/routes/etradeOptionsEvaluate.ts:180` — calls `runPanelPipeline()` directly (not the workflow).
- `src/services/discoveryService.ts:483` — `runPipeline: (request) => runPanelPipeline(screener, request)` (discovery expression path), not the workflow.
- `src/services/comparisonNlqRunner.ts` and `src/trading/options/panelPipeline.ts:123` (`runPanelPipeline`) are the direct panel pipeline; the workflow's panel legs replace them only at the call sites above.
- The old stage seam `src/workflows/optionsStageSeam.ts:1-9` is explicitly "RETIRED (#3186 step 3d): no live caller remains."

### MCP tools that screen options

Two distinct tools share the name `screen_options` — different surfaces, different paths.

| Tool | Defining file | Price / gate | Workflow today? |
|---|---|---|---|
| `screen_options` (paid scanner MCP) | `src/mcps/scanner/cloudflareWalletsScanner.ts:75` (`paidTool` in `OptionsScannerMCP.init()` `:72-75`); `SCANNER_PRICE_USD = 0.05` (`:44`) | **$0.05 USDC** per call, x402 via Cloudflare Wallets (`:72`, `:121` forwards `POST /api/trading/options/screen`). Handler (`:118-134`) requires the orchestrator to accept it as a background job (`jobId`, `status: "queued"`); result via `get_scan_job` (`:199`). Free companions: `scanner_status` (`:185`), `get_scan_job` (`:197`), `list_scan_jobs` (`:211`). | **Yes, indirectly** — the forwarded `POST /api/trading/options/screen` is the manual screen route → site 1 (async, queued). |
| `paid_options_screener` | `src/mcps/openaimp/agenticPaymentCommands.ts:79` (`PaidOptionsScreenerCommand`, name `:97`); registered `src/mcps/openaimp/commands.ts:1820` | **$0.05 USDC**, `TRADING_PAID_SERVICES.OPTIONS_SCREENER` (`src/services/agenticPayments.ts:123-130`: `priceUSD: 0.05`, `resource: "/api/premium/options-scan"`, `rateLimitPerMin: 60`). No `paymentSignature` → 402 challenge (`:185`); after verification calls `UnifiedOptionsService.execute({ action: "screen", channel: "mcp", … })` (`:251-253`). Scope `mcp:payments` (`src/mcps/openaimp/mcpPermissionPorts.ts:334`). | **No** — `execute()`'s screen case calls `screenContracts()` directly (bypass). Paid REST twin `POST/GET /premium/options-scan` (`src/agents/routes/premium.ts:296`, fulfills via `execute()` `:379-381`) — also the direct screen case, not the workflow. |
| `screen_options` (TradingAgent service) | `src/agents/trading-agent.ts:264` (`optionsScreeningService`, `toolName: "screen_options"` `:266`, `a2aOperation: "trading.screen_options"` `:267`); `TRADING_SERVICE_REGISTRY` (`:415`); A2A in `src/agents/registry.ts:1449`, `src/a2a/agent-cards.ts:76` | Read-only options screen via `UnifiedOptionsService.execute({ action: "screen", … })` (`:290-310`). E*TRADE-only: non-`etrade` providers throw `provider_unsupported` ("Options screening runs on the unified options pipeline, which is E*TRADE-backed today"). No price stated in code. | **No** — same direct screen case. |
| `run_options_strategy_screen` | `src/mcps/openaimp/meshDoorCommands.ts:1300` (`RunOptionsStrategyScreenCommand`, name `:1300`); registered `src/mcps/openaimp/commands.ts:1984`; permission `mcp:write` (`src/mcps/openaimp/mcpPermissionPorts.ts:316`) | Screens options *strategies* over a named universe (default NASDAQ100) by structured constraints (strategy catalog id/label/alias, maxLoss, minProfit, minRewardRisk, DTE window, riskProfile). Research only, places no orders; requires the chat turn's acting identity. `execute()` (`:1378`) calls `runOptionsStrategyScreenViaDoor()` (`src/agents/orchestrator/meshOptionsStrategyDoor.ts:242`), which assembles NLQ filters and calls `runOptionsStrategyAction(etrade, "options_opportunities", …)` (`:334-335`). | **Yes, via NLQ** — `runOptionsStrategyAction` → `runOpportunityScan()` → site 6. Registry note (`src/agents/registry.ts:1522`): this door "no longer depends on NLQ being on the turn" but evaluates via "the same seam the NLQ options_opportunities action dispatches to". |
| `paid_scan` (NLQ action) | `src/agents/nlq/execution.ts:2206` | **Refused** via `nlqPaidActionRefusal(…, "Paid Options Screener", TRADING_PAID_SERVICES.OPTIONS_SCREENER, …)` — the executor "cannot collect or verify the x402 payment the tier requires" and "the scan no longer runs unpaid" (`:2196-2200`). Same refusal pattern for paid research (`:2230`). | No (refused before any screen). |

## (d) Options Copilot phase-2 sketch — what "onboard Options Copilot onto the new workflow" concretely means

### What exists today

- **No `OptionsCopilotAgent` class.** Grep for `OptionsCopilotAgent` / `optionsCopilotAgent` / `options-copilot-agent` across `src/` returns no matches. Do not invent one.
- "Options Copilot" is a **client-side copilot registration only**: `src/client/chat/copilotRegistry.ts:141` — `{ id: "options", label: "Options Copilot", icon: "🎯", mode: "chat", sourceTab: "Broker · Auto Options Research", … }`, quick chips (Bull Put Spread, SPY Iron Condor, AAPL Covered Call, sweeps, NVDA straddle, delta hedge) and composer placeholder "Ask Options Copilot (e.g. 'Screen for Bull Put spreads on NVDA with max loss <= $30', 'Best SPY Iron Condor')..." (`:188`).
- **Chat routing:** `OrchestratorAgent` (`src/agents/orchestrator.ts:237`) is the turn host. Source tab `Broker · Auto Options Research` is detected at `src/agents/orchestrator/chatTurnHelpers.ts:201` (`isAutoOptionsResearchRequest`); when set, the judge is bypassed and the turn is forced to `agent: "trading"` ("Source-tagged Auto Options Research request; executing its options NLQ workflow directly", `src/agents/orchestrator.ts:2401-2406`), and the query is submitted as an async job with `capability: "nlq.execute"`.
- **What drives screening from chat:** NLQ options actions (`src/agents/nlq/execution.ts:1948-1949` → `runOptionsStrategyAction`, `src/agents/nlqOptionsStrategy.ts:785`) for `options_strategies`, `options_best_trade`, `options_opportunities`, `options_fit_discovery`, `options_comparison` → sites 5 and 6. The mesh door `run_options_strategy_screen` → site 6. `TradingAgent` (`src/agents/trading-agent.ts:912`) owns the `screen_options` / `trade_options` services (direct screen case, E*TRADE-only). `ScreenerAgent` (`src/agents/screener-agent.ts:394`) owns goal screening incl. the options leg → site 7.
- **No Options Copilot cycle / agentic loop.** Greps for `options.*cycle`, `runOptionsCopilot`, `options.*agentic.*loop` return only the scheduled-report and chat-routing hits. The only stock-copilot-style loop is stock-only: `runStockCopilotAgenticCycle()` (`src/services/stockCopilotAgenticLoop.ts:141`, called from `src/services/stockCopilot.ts:717`); no `options` matches in that file. The options scheduled machinery is the **report schedule, not a copilot cycle**: `ScheduledTasksService.autonomousOptionsAnalysis()` (site 8).
- **Whether any options schedule/cycle "never fired" cannot be established from this static tree** — firing history is runtime state, not code. (Contrast #4001, the stock copilot cycle incident — no options analogue was found.)
- **Not established:** whether the TradingAgent `screen_options` tool is actually reachable from an Options Copilot chat turn today (vs. only via A2A / direct service call). The registry lists `trading.screen_options` as a TradingAgent A2A operation; chat reaches options screening via NLQ and the mesh door; no single call chain wires the TradingAgent tool into the `id: "options"` copilot turn.

### What phase 2 must do (the concrete scope)

1. **Route the copilot's screening paths through the engine-routed workflow (not the direct function call).** After phase 1 lands, the NLQ options actions (sites 5/6) and the mesh door `run_options_strategy_screen` must drive the onboarded workflow through the engine's control plane — same screens, one pipeline, one record. This is the phase-2 core; it is the options analogue of what #3214 (agentic stage control via chat, OPEN, filed only — stock) would do for the stock screener, applied to the options stages.
2. **Move the bypassing paid surfaces onto the workflow — or record a decision not to.** `paid_options_screener` ($0.05 x402) and the TradingAgent `screen_options` (E*TRADE-only) both execute the direct screen case today, bypassing even the workflow. Phase 2 must move them onto the onboarded workflow with their gates intact (402 challenge, `mcp:payments` scope, E*TRADE-only refusal) or record an explicit decided-not-to with the reason. The paid scanner `screen_options` ($0.05, Cloudflare Wallets) already reaches the workflow indirectly via REST → site 1; phase 2 must keep that path working through the engine routing, with the queued-job receipt semantics unchanged (a receipt is a receipt, never narrated as a result).
3. **Per-stage chat control of options stages.** Once draft sub-issues 4 + #3945 land, the copilot can run / re-run / stop / resume / cancel an options stage from chat, addressed by `(runId, stageId)` on the 8-stage vocabulary. Phase 2 wires that control surface into the Options Copilot turn (NLQ + mesh door), with gates preserved and failures surfaced with stage + reason (the #2810 path), never as an absence.
4. **Decide the copilot's identity — and record it.** Is there an independent `OptionsCopilotAgent` to build (the stock precedent is #3745, "Remove the Stock Copilot from OrchestratorAgent (after the independent StockCopilotAgent is live)"), or does Options Copilot remain a client registration + NLQ/mesh-door routing on the OrchestratorAgent? Phase 2 decides and records this; it does not silently build a second copilot.
5. **Out of scope for phase 2:** an options agentic cycle/loop (none exists; file separately if wanted — there is no options equivalent of the Realtime RSI epic #3675); any change to screen semantics or results (same screens, one pipeline — the #3186 rule); any live order placement (preview/draft only, per the #3990 guardrail pattern); any change to the #2530 non-deterministic gate or the deterministic default (the #3072 exclusion, carried forward).

### Phase-2 draft

Sub-issue 8 in §(e).

## (e) Draft sub-issues — ready to file under #3551

**Filing notes (not part of the bodies).** 8 sub-issues recommended: 6 prep slices (1–6), 1 follow-up (7, sequenced after the workflow is on the engine), 1 phase-2 issue (8, sequenced after phase 1). NOT filed: an options retire issue (track #3944 as a dependency — fully generic engine work) and a duplicate control-plane issue (track #3945; the options slice is vocabulary coverage only). Agent field in the drafts is #CAIO-quns per #3551's body; **confirm the lane at filing** — the stock six all carry `lane:cto-mbshr`, and the CTO lane is actually building #3550 (comment `6774987208` on #3550, 2026-11-10: "The CTO lane is building #3550 per Venus's direction… starting with the first prep slice #3940"). Sequencing note: #3549 sequences family adoption "one family at a time" and stock is not done yet (#3941/#3943/#3945/#3946 open) — the options prep slices can be filed now, but the onboarding itself sequences after stock's onboarding unless the user directs otherwise. Each draft carries the stock standing rules (one branch, one PR, Merge Queue only, no deletions, locally rebased and re-verified before the PR opens, §15 draft only with separate approval). All evidence verified on fresh main fetched 2026-11-11 08:33 UTC.

---

### Draft 1 — Options canonical leg (analogue of #3940)

**Title:** Options canonical leg — persistCanonicalResults writes through the engine's tenant-aware leg in both residencies

**Body:**

## Agent
#CAIO-quns

## Parent
Sub-issue of #3551 (options family adoption). Stock analogue #3940 (CLOSED via PR #4029) wired the engine's tenant-aware canonical leg; this slice is the options mapping of that leg.

## Problem
The engine's canonical leg is wired (#3940), but no options run uses it. Options canonical rows are written by a different path: `recordUnifiedOptionsRun` → `storeOptionsCanonicalReport` → the route's ORM (`src/services/optionsServeRecord.ts:154-159,76-100`; manual entry `src/agents/routes/etradeOptionsScreen.ts:86-92`). The engine leg writes pipeline-generate reports with generationId `pipeline-generate:<jobId>:<inputArtifactId>` (`src/services/generateJobs.ts:869-873`) through `GenerateStepDeps` / `runGenerateJob`. No options generate job exists in the generate registry, and no options run is dispatched through `JobPipelineWorkflow`. When `persistCanonicalResults` is re-expressed as an engine stage, its canonical write has no home in the engine — onboarding as-is would either strand options reports outside `mas_reports` or fork a parallel store leg (forbidden by #3551's body).

## Outcome
The options `persistCanonicalResults` stage writes its canonical row through the engine's tenant-aware leg (`createTenantAwareCanonicalReportStore`, `src/workflows/jobPipelineWorkflow.ts:95-113` and `src/agents/scheduledTasksPipeline.ts:312-324`), with the `UnifiedOptionsRunRecord` shape carried through and the record builder (`createManualOptionsRecordBuilder`, `src/workflows/manualOptionsScreen.ts:97`) and generation-id scheme mapped onto the leg's input. The leg records "wired" (never `not_wired`) for an options report in workflow residency AND in host residency. The goal leg's omitted-canonical case (`created:false`, no `mas_reports` row, `src/workflows/optionsScreenPorts.ts:88-102`) is decided explicitly under the engine (kept as an honest no-write with its coded reason, or wired — with the reason recorded).

## Acceptance
- An options report's canonical leg records as wired (never `not_wired`) in workflow residency AND in host residency.
- The canonical row lands in `mas_reports` (canonical + parent row) and the Reports surface reads it in both cases.
- No parallel store leg; no fork of the store seam; no deletions; no behaviour change to plan/chainFetch/enrich/screen/risk/shapeReport/deliver.
- The goal leg's no-canonical case has a recorded decision and behaves identically in both residencies.

## Rules
Lossless/additive: the options canonical write moves into the engine improved (tenant-aware, either residency); nothing in the J-stack goes away. One branch, one PR, Merge Queue only, no deletions, locally rebased and re-verified before the PR opens, §15 draft only with separate approval.

---

### Draft 2 — Options feed (analogue of #3941)

**Title:** Options feed — chains as a registered feed job with a persisted dataset, or live-pull pinned to host residency (decision + implementation)

**Body:**

## Agent
#CAIO-quns

## Parent
Sub-issue of #3551 (options family adoption). Stock analogue #3941 (OPEN): "Feed parity — provider pull works in either residency (workflow and host)".

## Problem
There is no options feed job at all. The feed-job registry (`src/services/feedJobs.ts`, `buildFeedJobRegistry`) registers only quotes / fundamentals / technicals / sentiment jobs over stored index universes. A grep for "option" in `feedJobs.ts` / `feedPipelineJobs.ts` returns only a comment (`feedJobs.ts:329-330`). The options feed is a direct live call inside `chainFetch`: `screener.fetchChains(filter)` (`src/workflows/optionsScreenPorts.ts:230`) → `DynamicOptionsScreener.fetchChains` (`src/trading/optionsScreener.ts:769-830`) → per-symbol `fetchChainsForSymbol` (`:539-543`) → injected `OptionChainSource.getOptionExpireDates` / `getOptionChains` (`src/trading/optionChainSource.ts:46-60`). Provider is resolved per tenant broker at the entry by `UnifiedOptionsService.resolveEngineClient` (`src/trading/options/unifiedOptionsService.ts:695`): etrade → raw `ETradeRestClient`; otherwise `platformChainSource(platform)`; no options data plane → `provider_unsupported` with no silent fallback (`:712-725`). No feed dataset is persisted for options: chains live only in the `chainFetch` checkpoint artifact (`options:<runId>:chainFetch`) and the `mas_reports` row's body. `FEED_JOB_NOT_CONFIGURED` (`src/services/feedPipelineJobs.ts:328-332,370-373`) is a J-engine refusal and never applies to options — so the stock acceptance shape ("the same feed job runs to completion in both residencies with identical dataset output and provenance") cannot be met for options without first giving chains a persisted dataset.

## Outcome
Decide, then implement, one of: (a) register options-chains as a feed job with capture wiring and a persisted dataset in the #3530 feed-dataset store, so `chainFetch` consumes a persisted dataset like the stock feed (capture semantics for chains — per-symbol snapshots, expiry handling — defined in the slice); or (b) keep the live pull in `chainFetch` and pin it to host residency, with the decision recorded and an honest coded refusal where it cannot run. The slice must first establish whether the injected chain source (a live client object resolved at the entry) can execute in workflow residency at all — e.g. by running `chainFetch` in workflow residency in a test, or by proving the source needs host storage. The #3990 taxonomy (which brokers/providers serve `optionsChains`; Alpaca via the repo's own read path; Yahoo deliberately not wired) is the provider input to this decision.

## Acceptance
- If (a): the same chains feed job runs to completion in workflow residency AND in host residency, with identical dataset output and provenance; `FEED_JOB_NOT_CONFIGURED` still fires by name where wiring genuinely cannot be built — but 'workflow residency' alone is no longer such a case.
- If (b): the residency pin is recorded on this issue, `chainFetch` executes identically on host residency, and a dispatch elsewhere refuses by name with its coded reason — never a silent fallback, never an uncaptured fetch.
- No silent fallback, no uncaptured fetch, no behaviour change to enrich/screen/risk/persistCanonicalResults/shapeReport/deliver.

## Rules
Lossless/additive. Consistency rule (decided 2026-11-10 on #3550, applies here): every stage/sub-stage must work exactly the same in either residency, or its residency pin is recorded with its coded refusal. One branch, one PR, Merge Queue only, no deletions, locally rebased and re-verified before the PR opens, §15 draft only with separate approval.

---

### Draft 3 — Options delivery suppression (analogue of #3943)

**Title:** Options delivery suppression — (runId, destination) protection onto the options deliver stage, reconciled keying

**Body:**

## Agent
#CAIO-quns

## Parent
Sub-issue of #3551 (options family adoption). Stock analogue #3943 (OPEN): "Delivery suppression re-homed onto the J deliver stage — reconciled (runId, destination) keying". Prep slice — blocks safe re-run/replay.

## Problem
Options delivery has no (runId, destination) suppression. The suppressor (`src/workflows/screenDeliverySuppression.ts`, key `<runId>::<destination>` `:70-72`, `tryClaim`/`wasClaimed`/`release` `:85-113`, destinations `slack | email | webhook`) is backed by durable `mas_delivery_claims` (`src/agents/orchestrator.ts:719`), but a repo-wide grep finds its only caller is the stock `followup.deliver` executor (`src/agents/orchestrator/asyncJobs.ts:2078-2095,2115-2125`). Neither `manualOptionsScreen.ts`, `goalOptionsLeg.ts`, nor the J deliver service references it. The options manual deliver (`createManualOptionsScreenDelivery`, `src/workflows/manualOptionsScreen.ts:126`) sends Slack (bridge or direct A2A) and email (#1336) with no claim check — its only duplicate guard is the composer's per-stage idempotency claim (a re-run with the SAME runId skips the already-claimed deliver stage, `src/workflows/optionsScreenWorkflow.ts:155-160`); a fresh runId re-sends. The J deliver stage dedups by a different key — `(reportKind, channel)` per generated artifact (`deliverPairKey`, `src/services/deliverJobs.ts:583-585,781,812-824`) — which does not apply to options (options never produces a generated-dataset artifact). A re-run or replay of a delivered options report can double-deliver today.

## Outcome
Re-home duplicate-delivery protection onto the options deliver stage (or have the J deliver stage consult the same suppressor) with reconciled keying, so re-runs and replays never double-deliver. The suppression logic stays one module with an injected store — no second suppressor. Keying reconciles the options run-id shapes (`options_scanner:manual:<iso>`, `options_scanner:unified:<iso>:<thesis>`, `nlq-panel:<uuid>`, `nlq-scan:<uuid>`, `goal-screen:<key>:options`, `shard-scan:<chainId>:<symbol>`, `options-manual:<runId>`) with `<runId>::<destination>`, and the J `(reportKind, channel)` dedup is reconciled or explicitly chosen — not silently added as a second suppressor. The `deferred-to-goal-run` case (`src/workflows/goalOptionsLeg.ts:40-43`) must not double-deliver when the goal run delivers.

## Acceptance
- A re-run/replay of a delivered options report does not re-deliver to the same destination (Slack, email).
- Suppression key reconciled between the options run-id shapes and `<runId>::<destination>`; one suppressor module, injected store.
- Lossless/additive: the options delivery guarantee exists in the J-stack with the same strength; nothing in the J deliver stage's existing behaviour goes away.
- The `deferred-to-goal-run` case delivers exactly once, by the goal run.

## Rules
One branch, one PR, Merge Queue only, no deletions, locally rebased and re-verified before the PR opens, §15 draft only with separate approval.

---

### Draft 4 — Control-plane coverage for the options vocabulary (options application of #3945)

**Title:** Control-plane coverage for the options stage vocabulary — seven operations by (runId, stageId) on the 8 options stages

**Body:**

## Agent
#CAIO-quns

## Parent
Sub-issue of #3551 (options family adoption). Engine extension is #3945 (OPEN, generic — do NOT duplicate it); this slice is the options application of #3945.

## Problem
`JobPipelineControl` ops take `(jobId, nodePath)`; #3549 promises addressing by `(runId, stageId)`; there is no "vocabulary" in `jobPipelineEngine.ts`. #3945 extends the plane generically. But the plane must also know the options vocabulary: the 8 execution stages (plan, chainFetch, enrich, screen, risk, persistCanonicalResults, shapeReport, deliver — `src/workflows/stageRuntimeIds.ts:87-96`), which are NOT the 4 catalog display stages (feed/store/serve/deliver, `src/workflows/workflowCatalog.ts:201-242`) and NOT the engine's step ids (`feed.pull`, `enrich.apply`, `analyze.apply`, `generate.apply`, `deliver.apply`). Options already has discrete execution stages, so there is no #3217 analogue needed for options — but until the plane addresses the options vocabulary, the seven operations cannot run on an options stage at all, and #3551's core promise ("the seven operations … addressed by (run id, stage id)") is unmet for this family.

## Outcome
Register the options stage vocabulary with the extended control plane (once #3945 lands) and prove the seven operations — run, re-run, stop, resume, cancel, schedule, re-schedule, with #3069's pinned meanings — work addressed by `(runId, stageId)` on an options run, at the granularity of the 8 execution stages (not the 4 display stages). Depends on #3945 and on the vocabulary decision (sibling sub-issue "Options stage vocabulary — reconcile 8 execution / 6 catalog / 4 display stages; disposition #3072").

## Acceptance
- `runStage`, `rerunStage`, `stopStage`, `resumeStage`, `cancelStage`, `scheduleStage`, `rescheduleStage` each work addressed by `(runId, stageId)` on an options vocabulary stage.
- Existing `(jobId, nodePath)` addressing unbroken; the seven existing operations and their behaviour unchanged.
- Per-stage control addresses the 8 execution stages; display-stage grouping is presentation only and never the control address.

## Rules
Lossless/additive: the new addressing is added, nothing in the J-stack goes away. No parallel control surface, no family fork of the plane. One branch, one PR, Merge Queue only, no deletions, locally rebased and re-verified before the PR opens, §15 draft only with separate approval.

---

### Draft 5 — Options run recorder decision (analogue of #3946)

**Title:** Options run recorder decision — one ledger or two during migration

**Body:**

## Agent
#CAIO-quns

## Parent
Sub-issue of #3551 (options family adoption). Stock analogue #3946 (OPEN): "Run recorder decision — one ledger or two during migration". Prep slice — decide before the onboarding, so run history is not stranded.

## Problem
Options runs record in more places than stock: (i) `mas_reports` canonical rows — only when the canonical store is wired (the goal leg omits it, `created:false`, `src/workflows/optionsScreenPorts.ts:88-102`); (ii) OptionsStageStorage checkpoints `options:<runId>:<stageId>` — in DO storage at the manual entry (`src/agents/routes/etradeOptionsScreen.ts:88`) but **in-memory at most call sites** (only site 1 uses durable SQL claims; sites 4, 5, 8, 9 confirmed in-memory in the survey, sites 2, 3, 6, 7 not individually verified) (`memoryStageClaims()` / `memoryStageStorage()`, `src/workflows/optionsScreenWorkflow.ts:118-135`), i.e. checkpoints that do not survive the process at most entries; (iii) `mas_async_jobs` stage rows (the contract anticipates vocabulary stages checkpointing onto them via the production checkpoint adapter — per #3946); (iv) per-leg D1 stage rows for goal options legs (#3186 / #2038: "Per-leg D1 stage rows for goal options legs ride this workflow's stage record … and surface in Workflow Runs through the #2786 surface"); (v) the scan-run store `mas_opportunity_scans` for the scanner/strategy leg (`src/workflows/strategyScreenPorts.ts:389`); (vi) job-outcome records `options-manual:<runId>` (manual deliver tail). The J engine records D1 AgentDB job instances + `D1JobRunRecordStore`. The checkpoint side can stay; the open decision is the run-record side — and the in-memory checkpoints are a durability question the stock decision did not have to answer.

## Outcome
Decide the run-record shape for options runs (one ledger during migration, or two ledgers with read-surface migration), then implement the decided shape. Read surfaces: Workflow Runs page, ReportsPanel, RunDetailView — plus the per-leg D1 stage rows' surfacing. The decision must explicitly cover: the in-memory checkpoints (do they become durable, and where?), the goal leg's omitted canonical row, the per-leg D1 stage rows, and the `mas_opportunity_scans` scan-run rows.

## Acceptance
- Every options run record readable today stays readable after the migration, from exactly the surfaces the decision names.
- No orphan or duplicate run rows; no silent loss of run history.
- The in-memory checkpoint question has a recorded answer (durable home, or an explicit accepted-absent with its reason).

## Rules
Lossless/additive: no run, result, schedule, or paid-run record is dropped, truncated, or merged. One branch, one PR, Merge Queue only, no deletions, locally rebased and re-verified before the PR opens, §15 draft only with separate approval.

---

### Draft 6 — Options stage vocabulary (options-specific; no stock analogue)

**Title:** Options stage vocabulary — reconcile 8 execution / 6 catalog / 4 display stages; disposition #3072

**Body:**

## Agent
#CAIO-quns

## Parent
Sub-issue of #3551 (options family adoption). #3551 says it "absorbs its family's share of #3069" — that share is #3072.

## Problem
Three vocabularies describe one pipeline. #3072 (OPEN, parent #3069 CLOSED, `lane:cfo-qunso`, created 2026-11-04, never updated, blank §15, 0 comments) uses the 6 catalog stages (feed/gather/analysis/store/serve/deliver) with per-format legs preserved ("per-format generate/store legs are legitimately partial — a failed format does not stop the chain — and delivery is the serve+deliver group"). #3186 (CLOSED via PR #3453) pins 8 options stages: plan, chainFetch, enrich, screen/strategize, risk, persistCanonicalResults, shapeReport, deliver. The catalog on current main partitions the 8 execution stages under 4 display stages (feed covers plan/chainFetch/enrich/screen/risk; store covers persistCanonicalResults; serve covers shapeReport; deliver covers deliver — `src/workflows/workflowCatalog.ts:201-242`). Whether #3072 was superseded by #3186/#3551 or is still live work is not stated in any issue body. The catalog comment says "The legacy #3191 phases are retired (their only publisher was the #3072 emitter, called only by the manual handler)" — #3072's emitter is already retired in code while #3072 itself stays open. And `src/workflows/stageRuntimeIds.ts:82-86` carries a stale stage-mapping comment (it says `persistCanonicalResults` pins to a "canonical mas_opportunity_scans write" — the code writes `mas_reports` via `recordUnifiedOptionsRun`, `src/services/optionsServeRecord.ts:154-159`; it also maps `shapeReport → runPanelPipeline` and `deliver → deliverScreenerToSlackA2A`, which describe legacy mappings, not the current caller-supplied deps).

## Outcome
Pin one addressable vocabulary for the options family: the 8 execution stages are the vocabulary the control plane addresses (sibling sub-issue "Control-plane coverage for the options stage vocabulary"); the 4 display stages are presentation only. Preserve #3072's per-format-leg rule (a failed format does not stop the chain; a failed leg is partial, marked, and never strands the formats that generated). Correct the stale `stageRuntimeIds.ts:82-86` comment block. Record #3072's disposition: close as superseded by #3551 with a comment naming this issue, or keep it with the reason — with the reason recorded either way. #3072's exclusions still bound this slice: no change to the control operations themselves (that is the control-plane slice), no change to the #2530 non-deterministic gate or the deterministic default.

## Acceptance
- One pinned options stage vocabulary, recorded on this issue; the 8 execution stages are addressable, the 4 display stages are display-only.
- Per-format legs: a failed format is partial + marked and never strands the formats that generated (verified by test).
- Stale `stageRuntimeIds.ts:82-86` comment corrected; no stale stage mapping remains in the options workflow files.
- #3072's disposition recorded (closed as superseded with a comment, or kept with the reason).

## Rules
No deletions (retire by rename with a named successor where anything is retired, never delete). One branch, one PR, Merge Queue only, locally rebased and re-verified before the PR opens, §15 draft only with separate approval.

---

### Draft 7 — Route options entry points through the engine (follow-up, after onboarding lands)

**Title:** Route options entry points through the engine — 9 direct call sites + bypasses

**Body:**

## Agent
#CAIO-quns

## Parent
Sub-issue of #3551 (options family adoption). Follow-up — sequenced AFTER the options workflow is on the engine. Per #3551's body: "Exceptions and follow-ups are filed as sub-issues of this issue, never left as comments."

## Problem
Onboarding the workflow alone does not unify options screening (stock Loss 6, #3550 comment `6761599459`). All 9 `runOptionsScreenWorkflow` call sites invoke the function directly, none through the J engine: manual screen (`src/agents/routes/etradeOptionsScreen.ts:104`), unified opportunities (`:197`), manual panel (`src/workflows/manualPanelScreen.ts:66`), strategy pipeline (`src/trading/options/unifiedOptionsService.ts:538`), NLQ panel leg (`src/agents/nlqOptionsStrategy.ts:879`), NLQ scan leg (`:1278`), goal options leg (`src/services/goalDrivenScreen.ts:141`), scheduled monolithic (`src/services/scheduledTasks.ts:2920`), per-symbol shard (`src/services/shardExecutors.ts:515`). And several paths bypass even the workflow: `POST /broker/options/screen` (`src/agents/routes/brokerOptions.ts:66,91`) → `DynamicOptionsScreener.screenOptions()` directly; `UnifiedOptionsService.execute()` screen case (`:840`) → `screenContracts()` directly and opportunities case (`:997`) → `scanOpportunities()` directly; `runPanelPipeline` paths (`src/agents/routes/etradeOptionsEvaluate.ts:180`, `src/services/discoveryService.ts:483`, `src/trading/options/panelPipeline.ts:123`). #3186's acceptance ("No options screen executes outside the workflow after this lands") does not hold on current main — the bypasses are live code.

## Outcome
Route the 9 direct call sites through the engine-routed workflow (same screens, one pipeline, one record per run). Route the bypasses through the workflow or retire them by rename (never delete, repo rule, per #3186's own acceptance). Verify on fresh main that no options screen executes outside the workflow. Paid surfaces keep their gates through the move: the $0.05 x402 challenge on `paid_options_screener` / the paid scanner, `mcp:payments` scope, and the E*TRADE-only refusal on the TradingAgent `screen_options` — a queued job receipt stays a receipt, never narrated as a result.

## Acceptance
- All 9 call sites drive the engine-routed workflow; no direct `runOptionsScreenWorkflow` call remains in production code.
- No options screen executes outside the workflow (verified on fresh main; bypass list above is empty or each entry has a recorded retirement).
- Paid gates intact: 402 challenge without a signature, same price, same scope; queued receipts unchanged in meaning.
- No change to screen semantics or results (same screens, one pipeline — the #3186 rule).

## Rules
Lossless/additive. No deletions ever — retire by rename with a named successor. One branch, one PR, Merge Queue only, locally rebased and re-verified before the PR opens, §15 draft only with separate approval.

---

### Draft 8 — Phase 2: Onboard Options Copilot onto the new workflow

**Title:** Phase 2: Onboard Options Copilot onto the new options workflow

**Body:**

## Agent
#CAIO-quns

## Parent
Sub-issue of #3551 (options family adoption). Phase 2 of the user directive of 2026-11-11 ("onboard OptionsScreenerWorkflow to the J1–J7 stack losslessly/additively, then onboard Options Copilot on the new OptionsScreenerWorkflow"). Sequenced AFTER phase 1 (the workflow on the engine) lands.

## Problem
There is no `OptionsCopilotAgent` class — a grep for `OptionsCopilotAgent` / `optionsCopilotAgent` / `options-copilot-agent` across `src/` returns no matches. "Options Copilot" is a client-side copilot registration only (`src/client/chat/copilotRegistry.ts:141`, `{ id: "options", label: "Options Copilot", sourceTab: "Broker · Auto Options Research", … }`). Chat screening today runs via NLQ options actions (`src/agents/nlq/execution.ts:1948-1949` → `runOptionsStrategyAction`, `src/agents/nlqOptionsStrategy.ts:785` → call sites 5/6) and the mesh door `run_options_strategy_screen` (`src/mcps/openaimp/meshDoorCommands.ts:1300` → `src/agents/orchestrator/meshOptionsStrategyDoor.ts:242` → call site 6), with the OrchestratorAgent forcing source-tagged Auto Options Research turns to `agent: "trading"` (`src/agents/orchestrator.ts:2401-2406`). Two paid surfaces bypass even the workflow: `paid_options_screener` ($0.05 x402, `src/mcps/openaimp/agenticPaymentCommands.ts:79`) and the TradingAgent `screen_options` (E*TRADE-only, `src/agents/trading-agent.ts:264`) both execute the direct `UnifiedOptionsService.execute()` screen case. There is no options agentic loop/cycle (the only stock-copilot-style loop is stock-only, `runStockCopilotAgenticCycle`, `src/services/stockCopilotAgenticLoop.ts:141`); options has only the `autonomousOptionsAnalysis` report schedule. Per-stage chat control of options stages does not exist (the stock analogue, #3214, is OPEN and filed only).

## Outcome
1. Route the copilot's screening paths — the NLQ options actions and the `run_options_strategy_screen` mesh door — through the engine-routed workflow (not the direct function call). Same screens, one pipeline, one record.
2. Move the bypassing paid surfaces (`paid_options_screener`, TradingAgent `screen_options`) onto the onboarded workflow with their gates intact (402 challenge, `mcp:payments` scope, E*TRADE-only refusal), or record an explicit decided-not-to with the reason. The paid scanner `screen_options` ($0.05, Cloudflare Wallets) already reaches the workflow indirectly via REST → the manual route; keep that path working through the engine routing, with queued-job receipt semantics unchanged.
3. Wire per-stage chat control of options stages into the Options Copilot turn (NLQ + mesh door), addressed by `(runId, stageId)` on the 8-stage vocabulary, with gates preserved and failures surfaced with stage + reason (the #2810 path), never as an absence. Depends on the control-plane coverage slice and #3945.
4. Decide and record the copilot's identity: an independent `OptionsCopilotAgent` (stock precedent #3745, "Remove the Stock Copilot from OrchestratorAgent (after the independent StockCopilotAgent is live)") or Options Copilot remaining a client registration + NLQ/mesh-door routing on the OrchestratorAgent. No silent second copilot.

## Acceptance
- A screen requested from the Options Copilot turn executes on the engine-routed workflow and produces one pipeline record, indistinguishable (modulo entry-context fields) from the same screen via any other entry.
- Paid gates intact through the move; queued receipts unchanged in meaning.
- Per-stage chat control works on an options stage from the copilot turn (run / re-run / stop / resume / cancel, with the pinned meanings).
- Agent-identity decision recorded on this issue.
- No live orders, no automatic promotion; no change to screen semantics or results.

## Out of scope
- An options agentic cycle/loop (none exists; file separately if wanted — there is no options equivalent of the Realtime RSI epic #3675).
- Any change to screen semantics or results; any change to the #2530 non-deterministic gate or the deterministic default (the #3072 exclusion, carried forward).

## Rules
Lossless/additive. One branch, one PR, Merge Queue only, no deletions, locally rebased and re-verified before the PR opens, §15 draft only with separate approval.

---

## Topics with NO options analogue (do not file)

- **Retire (#3944 analogue):** #3944 ("Retire operation for stages (eighth uniform op) — non-blocking for onboarding", OPEN) is fully generic engine work — zero stock content in its body. Once it lands, retire is available to options stages under the same addressing. Track #3944 as a dependency of #3551; do not file an options retire issue. Communication note: options today has no per-stage pause/stop at all, so the semantic change (engine stop as the pause-equivalent) lands the same way it does for stock.
- **Control-plane engine extension (#3945 itself):** #3945 ("Control plane extended to vocabulary stages addressed by (runId, stageId)", OPEN) is fully generic. Filing a second control-plane issue would fork the plane. The options work is draft sub-issue 4 (vocabulary coverage + verification) only.

## Sequencing

1. **Vocabulary (draft 6) first** — it gates control-plane coverage (draft 4) and the onboarding itself. It also carries the only cheap wins (stale-comment correction, #3072 disposition).
2. **Prep slices in parallel after that:** canonical leg (1), feed decision + implementation (2), delivery suppression (3), run recorder decision (5). Feed (2) is the most open-ended — it starts with a decision (a) vs (b) and its unknown (whether the injected chain source can execute in workflow residency) must be settled before implementation.
3. **Control-plane coverage (4)** after #3945 lands + vocabulary (6) is pinned.
4. **The onboarding itself** is #3551 (the workflow's stages re-expressed onto the contract) — it consumes 1–6. Note #3549 sequences family adoption "one family at a time" and stock is not done yet (#3941/#3943/#3945/#3946 open); the options onboarding sequences after stock's unless the user directs otherwise.
5. **Entry-point routing (7)** after the workflow is on the engine.
6. **Phase 2 (8)** after phase 1 lands; its per-stage chat control depends on (4) + #3945.

## Open questions / things not established

- **Lane:** #3551's Agent field names #CAIO-quns, but the stock six carry `lane:cto-mbshr` and the CTO lane is actually building #3550 (comment `6774987208`). Confirm the building lane at filing.
- **#3942:** the stock sub-issue numbers skip #3942; it was not read in this survey and no claim is made about it.
- **#3186 live-proven:** #3186 is CLOSED via PR #3453, but the "live-proven" half of the 2026-11-05 condition was NOT independently verified by CLO-arsi; this survey confirms only the closure. Its acceptance ("no options screen executes outside the workflow") does not hold on this tree — the bypasses in §(c) are live.
- **Chain source in workflow residency:** whether the injected `OptionChainSource` can execute in workflow residency is not established from the tree (draft 2 must settle it).
- **Goal run's own delivery vs the suppressor:** whether the goal run's delivery (to which the options goal leg defers) consults the `(runId, destination)` suppressor was not established — the goal leg itself does not; the goal run's delivery path was out of scope for the files read.
- **TradingAgent `screen_options` reachability from a copilot turn:** not established — no call chain wires it into the `id: "options"` copilot turn.
- **Exact DO-SQLite table name** behind `storeCanonicalReport` / `storeReportAtGeneration`: `mas_reports` is named throughout the ports and comments, but the literal CREATE TABLE / INSERT statement was not read.
- **`UnifiedOptionsService.execute()` case at `:1246`:** label not verified in the grep output (presumed `llm_ideas` — not asserted).
- **Other `createOptionsScreenPorts` callers:** only the manual route (`src/agents/routes/etradeOptionsScreen.ts:86-130`) and the goal leg (`src/services/goalDrivenScreen.ts:134-160`) were found by grep; the code mentions "the NLQ legs, the scheduled scan" using `memoryStageStorage` (`src/workflows/optionsScreenWorkflow.ts:114-124`) without naming files — not exhaustively traced.

## Sources

- Tree: fresh main fetched 2026-11-11 08:33 UTC (`~/workspace/verify-options-onboarding/cfagent-main/`).
- Stock bodies: #3940, #3941, #3943, #3944, #3945, #3946, #3551, #3549, #3186, #3072 — read in full via `issue_read` (method `get`) 2026-11-11.
- Stock analysis: #3550 comment `6761599459` + decisions `6761911421`, `6762023056`, `6763074432`, agent claim `6774987208` — saved at `~/workspace/verify-options-onboarding/stock-3550-comments.md`.
- #3940 closed 2026-11-11T06:19:43Z via PR #4029 (MERGED); #3941/#3943/#3944/#3945/#3946 OPEN; #3551 zero formal sub-issues (`has_children: false`); #3549: 26 sub-issues, 1 completed.
