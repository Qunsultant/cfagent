# Research notes — #4770 dispatch-modes doc

- **Base:** `5ee1f23d008cf93e0493c7b371f4d64a3605a64d` (`feat(flags): enforce Flagship as production system of record (#4613)`), latest tag `v0.1.1855`
- **Worktree:** `~/workspace/w3533/wt-docs-dispatch` (clean except the draft)
- **Evidence:** `inv-01.txt` … `inv-12-final.txt` in this directory
- **Issue:** #4770, sub-issue of epic #3533. LOCAL ONLY — no GitHub writes.

## Diagram convention (user addition 2026-11-16)

- The repo's established convention is **Mermaid `flowchart` blocks**: 34 docs under `docs/` use ` ```mermaid ` blocks (e.g. `docs/architecture/agentic/job-system.md`, `docs/agentic-org/architecture.md`, both `flowchart LR` and `flowchart TD`). No other diagram format is used in `docs/`. The draft uses Mermaid flowcharts, following that convention.
- Every node and edge in the draft's diagrams traces to a verified code fact below (dispatch sites, doors, engine funnel, stores, UI surfaces). No invented boxes or arrows.

## Workflow inventory (real file names — verified)

Workflow declarations (`src/workflows/workflowCatalog.ts`, `WORKFLOW_CATALOG`):
`stock-screener` (:169), `options-screener` (:215), `trading-leg` (:253),
`payment-run` (:283), `saga-run` (:337), `goal-screen` (:377),
`strategy-discovery` (:397). Stage-name vocabulary: feed/gather/analysis/
store/serve/deliver (`src/messaging/messagingPorts.ts:154`).

Workflow classes / flows (all real):
- `ScreenerScreenWorkflow` — `src/workflows/screenerWorkflow.ts` (#1737 → #4192); deprecated flow `screenerWorkflowFlow.deprecated.ts`.
- `TradingTradeWorkflow` — `src/agents/trading-trade-workflow.ts:206` (NOT under `src/workflows/`). There is NO file literally called `tradingWorkflow` — the only hits are a mention in `docs/architecture/reference/cfpay.md` and the class name. The trading workflow is this class + the catalog's `trading-leg` declaration.
- `PaymentWorkflow` — `src/workflows/paymentWorkflow.ts` (#2014) + `paymentWorkflowFlow.ts`.
- `CrossDomainSagaWorkflow` — `src/workflows/sagaWorkflow.ts` (#2041) + `sagaWorkflowFlow.ts`; legs in `sagaTradeLeg.ts`, `sagaCompensation.ts`, `sagaRiskStage.ts`, `sagaTerminal.ts`, `sagaLegPort.ts`, `sagaJourneyGate.ts`, `sagaOutcomeNotice.ts`.
- `JobPipelineWorkflow` — `src/workflows/jobPipelineWorkflow.ts` (#3534) + `jobPipelineWorkflowFlow.ts`.
- Options screen — `src/workflows/optionsScreenWorkflow.ts` (#3186 step 2, thin composer of stage Blocks in `blocks/optionsBlocks.ts`), `optionsScreenEngine.ts`, `optionsWorkflowHost.ts` (#4289), `manualOptionsScreen.ts`, `manualPanelScreen.ts`, `goalOptionsLeg.ts`, `goalStockScreenSpec.ts` (#2882).
- One-engine seams — `runStockScreenViaEngine.ts` (#4278), `runGoalScreenViaEngine.ts` (#4279).
- Workflow substrate — `workflowPorts.ts`, `createWorkflowPorts.ts`, `cfWorkflowAdapter.ts` (#1737), `workflowInstanceSeam.ts`, `workflowCommandEnvelope.ts`, `stageQueueTransport.ts` (#2869, analysis-done stage message only), `stageMessage.ts`, `stageRunnerPorts.ts`, `stageRunnerPlan.ts`, `stageRunnerCheckpoint.ts`, `stageRunnerCheckpointAdapter.ts` (#3549), `runLedgerQueueTransport.ts`, `stageReportConsumer.ts`, `stageReportProduction.ts`, `stageTabularConsumer.ts`.
- `src/workflows/blocks/`: `blockContract.ts`, `contractStack.ts`, `optionsBlocks.ts`, `plannerPort.ts`, `riskInventory.ts`, `sagaBlocks.ts`, `uniformExecution.ts`.

Stage-job builders (`src/services/*PipelineJobs.ts`, epic #3533):
- J2 feed `feedPipelineJobs.ts` (#3535); J3 enrich `enrichPipelineJobs.ts` (#3536); J4 analyze `analyzePipelineJobs.ts` (#3537); J5 generate `generatePipelineJobs.ts` (#3538); J6 deliver `deliverPipelineJobs.ts` (#3539); J7 chains `chainPipelineJobs.ts` (#3540); `optionsPipelineJobs.ts` (#4289); `screenerPipelineJobs.ts` (#4190); `pipelineChains.ts`, `pipelinePolicy.ts`.
- Feed runners (`src/services/feedJobs.ts`): `runFeedJob` :927, `runFeedFundamentalsJob` :1221, `runFeedTechnicalsJob` :1512, `runFeedSentimentJob` :1853, `runFeedOptionsChainsJob` :2290; options `trigger?: "manual" | "scheduled"` :739; `buildFeedJobRegistry` :374. Feed definition builder `buildFeedPipelineJobDefinition` (`feedPipelineJobs.ts:352`); feed step hardcodes `trigger: "manual"` in `runOpts` (:583).

Job definitions:
- Static catalog holds exactly ONE family: `screener` (`src/config/jobDefinitionCatalog.ts:85`), six stages feed/enrich/analyze/store/serve/deliver (:91–96), explicit mode sequential/batch/async/monolith (:107–112). All other chains are built dynamically (feed registry, stage-job builders, per-run screener definitions via `ensureScreenerJob`).

## Dispatch-site table (verified on this base — 14 engine `runJob` sites)

| # | Site | File:line | Trigger passed today |
|---|---|---|---|
| 1 | Schedule firing (`dispatchScheduledPipelineJob`) | `src/agents/scheduledTasksPipeline.ts:709` | `"scheduled"` |
| 2–5 | Downstream chain (enrich/analyze/generate/deliver) | `src/agents/scheduledTasksPipeline.ts:993/:1039/:1085/:1131` | `"scheduled"` each |
| 6 | Completion firing | `src/agents/scheduledTasksCompletion.ts:65` | `"scheduled"` |
| 7 | Door `runPipelineJob` | `src/agents/scheduled-agent.ts:935` | hardcoded `"manual"` |
| 8 | Door `runPipelineChain` | `src/agents/scheduled-agent.ts:1466` | hardcoded `"manual"` |
| 9 | Door `runPipelineStage` | `src/agents/scheduled-agent.ts:963` | param, defaults `"scheduled"` |
| 10 | Workflow residency | `src/workflows/jobPipelineWorkflowFlow.ts:77` | `payload.trigger ?? "manual"` |
| 11–12 | Options screen engine | `src/workflows/optionsScreenEngine.ts:1019` (`params.trigger ?? "manual"`), `:1200` (hardcoded `"manual"`) | as shown |
| 13 | Screener workflow | `src/workflows/screenerWorkflow.ts:308` | `runCommand.trigger` |
| 14 | Engine internal re-run | `src/services/jobPipelineEngine.ts:1032` | hardcoded `"manual"` |

Upstream callers (not `runJob` sites): feed-run route's 7 door call sites
(`src/agents/routes/dataProviders.ts`, incl. :1006 and :1656); mesh doors'
3 `WorkflowJobCommand` builds (`src/agents/orchestrator/meshScreenDoor.ts:568/:659/:1027`,
hardcoded `"manual"`); `runBridge.ts:59` (`trigger: "manual" | "scheduled"`).

## Execution mode (verified)

- Axes `src/data/jobPipelinePorts.ts:60–84`: concurrency sequential|parallel; pacing batch|online; delivery sync|async; shape monolith|sharded. Default: sequential/batch/async/monolith.
- `resolveExecutionMode` (`src/services/jobPipelineConfig.ts:119`) merges a partial mode over defaults axis by axis, refuses invalid values. `assertExecutionModeSupported` (:137) refuses online+sync (`job_execution_mode_unsupported`).
- Per-node override: `effectiveMode` (`src/services/jobPipelineEngine.ts:2743`) merges root + node mode; `execNode` calls it per stage. The stage plan carries only concurrency + pacing (`stageForNode`, engine ~:2402); delivery/shape are consumed by the engine.
- Stage view derives the ROOT mode from the live definition (`definition.config.executionMode ?? null`, engine :649) — per-node overrides invisible, definition change rewrites history (#4766, filed not built).
- Checkpoint `StageRunnerCheckpoint` (`src/workflows/stageRunnerPorts.ts:271`) = `{ runId, units[] }`, persisted as an opaque JSON blob (`stage_checkpoint_json`) in all three instance adapters — no DDL to add a field.

## Trigger vocabularies (verified)

- Instance `runTrigger`: `"scheduled" | "manual" | null` (`src/data/jobPipelinePorts.ts:222`); stamped in `executeRun` (engine :2162); terminal stamping reads `instance.runTrigger ?? "manual"` (:873/:940/:2064/:2090).
- Record `triggeredBy`: `JobRunTrigger = "scheduled" | "manual"` (`src/data/jobRunRecordPorts.ts:54`); validated by `TRIGGERS` (`src/services/jobRunRecords.ts:64`, enforced :97).
- Ledger `trigger`: five-valued (`scheduled|manual|worker-cron|async-chain|unknown`, `jobRunRecordPorts.ts:66–71`); `LEDGER_TRIGGERS` (`src/services/consolidatedScheduling.ts:70`); read normalizer degrades unlisted values to `"unknown"` (`:176`).
- Separate: `WorkflowRunTrigger` six-valued (`src/services/workflowRuns.ts:81`).
- O4 decision: `docs/architecture/scheduling/3121-s0-inventory.md:803` — `trigger` sits ALONGSIDE `triggeredBy`, does not supersede it.
- Current state (honest): Run now on a scheduled job records `"manual"` (door :935 + feed step :583 hardcode it); the three-way split is filed as #4767, not built. Q1 ruled 2026-11-16: chain/completion firings keep `"scheduled"`.

## Schedule, deadline, stores (verified)

- Schedule firing: `dispatchScheduledPipelineJob` (`scheduledTasksPipeline.ts:709`); `registerSchedules` (engine :1121) reads `definition.config.schedule` / `node.schedule`; `JobScheduleConfig` (`jobPipelinePorts.ts`, enabled/cron/interval/registrationId/reason); schedule id threaded per #3310.
- Per-unit deadline: `DEFAULT_SHARD_TIMEOUT_MS = 10 * 60 * 1000` (`src/workflows/workflowPorts.ts:134`); error at `jobPipelineEngine.ts:3186`.
- Stores: definitions/instances/artifacts tables (`jobPipelinePorts.ts:42–44`); `run_trigger` TEXT (`doSqliteJobPipelineAdapter.ts:57`, `drizzleSchema.ts:1821`); run records `triggerText` (D1).
- UI: Data Providers chain view + frontier (`src/client/DataProvidersPanel.tsx:1390–1430`), Last-run line (:149); `WorkflowRunsPanel.tsx` trigger filter; jobStatus route (`src/agents/routes/jobStatus.ts:6`, sub-job control `:48–49`); `subJobStatusFromStageView` (`src/services/jobStageStatus.ts:58`) drops `executionMode`.
- Existing doc to link, not repeat: `docs/operations/jobs-workflows-stages-01.md` (ids/tracking/auditing, entity relationships, status vocabularies, execution mode as a run parameter #4363).

## Could not verify / not in scope

- `TradingTradeWorkflow` has no file-level doc comment above the class (`src/agents/trading-trade-workflow.ts:206`); its two steps (`await-approval`, `settle-trade`) were read from the flow body, not a header. The draft says only what the code shows.
- The draft does not re-derive the O4 history beyond the pinned decision; the inventory doc is the source.
- No claim is made about which Think scheduled tasks exist at runtime beyond `registerSchedules` output; the draft describes the mechanism, not a live enumeration.

## REMEDIATION-ISSUES (user addition 2026-11-16 — reuse checked first)

Every entry was checked against the repo's existing issues before
being listed: keyword search in title/body (public API search) and
the sub-issue lists of #3533 (11 sub-issues) and #3992 (2
sub-issues). Nothing below is covered by #4766 (mode per stage),
#4767 (three-way trigger), #4751 (browse follow-on), or #4758
(seed config). The parent files the issues from this list after
re-verifying each reuse call; nothing here was filed by the
researcher.

### R1 — Two names for the same four mode axes (inconsistency)

- **What:** The workflow catalogue's `StageModes`
  (`src/workflows/workflowCatalog.ts:38`) names the four axes
  timing / concurrency / volume / partitioning, with values
  sync|async, sequential|parallel, batch|online,
  sharded|monolithic. The engine's `JobExecutionMode`
  (`src/data/jobPipelinePorts.ts:60–84`) names the same four axes
  delivery / concurrency / pacing / shape, with values sync|async,
  sequential|parallel, batch|online, monolith|sharded. Same axes,
  different names — and the unsharded value is spelled
  `monolithic` in one place and `monolith` in the other.
- **Evidence:** `src/workflows/workflowCatalog.ts:38–46` vs
  `src/data/jobPipelinePorts.ts:60–84`.
- **Why it needs remediation:** a reader (or a future builder)
  cannot tell from the names alone that these are the same four
  axes; the two spellings of the unsharded value invite a
  string-comparison bug if anyone ever compares them, and the
  doc had to explain the mapping by hand.
- **Suggested parent:** #3533 (Copilot job pipeline epic).
- **Proposed Size/Priority:** Small / Low.
- **Reuse check:** no existing issue found — searched
  "StageModes execution mode axes" (0 results), "monolithic
  monolith StageModes" (0 results), "workflow catalog modes
  timing volume partitioning" (1 result: #3069, closed,
  "Uniform stage control" — the stage-control epic, not mode
  naming). Checked #3533 sub-issues: none covers it.

### R2 — The catalog's screener spec hardcodes the default mode inline (duplicate)

- **What:** The static catalog's `screener` spec sets
  `executionMode: { concurrency: "sequential", pacing: "batch",
  delivery: "async", shape: "monolith" }` as an inline literal
  (`src/config/jobDefinitionCatalog.ts:107–112`). That is the
  third copy of the same four values: `DEFAULT_JOB_EXECUTION_MODE`
  (`src/data/jobPipelinePorts.ts`) and
  `SCREENER_DEFAULT_EXECUTION_MODE`
  (`src/config/screenerExecutionMode.ts:25`, resolved via
  `resolveExecutionMode`, overridable from the
  `SCREENER_DEFAULT_EXECUTION_MODE` env var) already hold them.
  The catalog literal ignores the env override, so the catalog's
  screener can run a different mode than the env-configured
  screener default.
- **Evidence:** `src/config/jobDefinitionCatalog.ts:107–112`,
  `src/config/screenerExecutionMode.ts:19–25`.
- **Why it needs remediation:** three copies of the same four
  values can silently diverge; the env override path (#4447's
  point) does not reach the catalog's screener, so an operator
  who sets the env var gets no effect on the catalog-driven
  screener runs.
- **Suggested parent:** #3533.
- **Proposed Size/Priority:** Small / Low.
- **Reuse check:** PARTIAL REUSE #4447 (closed, "feat(4363):
  the execution mode is a run parameter, recorded and
  surfaced") — it retired the builder's literal and created the
  externalized `SCREENER_DEFAULT_EXECUTION_MODE`. What #4447
  does NOT cover is the catalog literal: the part that still
  needs a new issue is exactly the `jobDefinitionCatalog.ts:107–112`
  inline literal — replace it with a reference to
  `SCREENER_DEFAULT_EXECUTION_MODE` (or omit it and let the
  resolver apply the defaults), with a pin that the copies stay
  in agreement or that only one home remains.

### R3 — Feed chain vs screener chain stage sequences share names but differ (overlap/confusion)

- **What:** Two different stage sequences both present as "the
  pipeline": the J-stack feed chain (feed → enrich → analyze →
  generate → deliver; `src/services/chainPipelineJobs.ts`, J7
  #3540) and the screener chain (feed → enrich → analyze →
  store → serve → deliver; `src/config/jobDefinitionCatalog.ts:91–96`).
  They share the first three stage names and the last one, but
  the middle differs (generate vs store/serve), and a "deliver"
  stage in one is not the same stage as "deliver" in the other.
- **Evidence:** `src/services/chainPipelineJobs.ts:1`,
  `src/config/jobDefinitionCatalog.ts:91–96`,
  `src/workflows/workflowCatalog.ts:169` (stock-screener stages).
- **Why it needs remediation:** the shared names make the two
  chains easy to confuse in conversation, in the UI, and in
  debugging (the Nov 11 Yahoo failure's "feed/enrich/analyze/
  generate/deliver" card is the feed chain, not the screener
  chain). Nothing in the code names the distinction once.
- **Suggested parent:** #3533.
- **Proposed Size/Priority:** Small / Low.
- **Reuse check:** no existing issue found — searched "feed
  pipeline chain naming" (38 results; top hits are incidents
  and enhancements — #4002, #3992, #2870, #3655, #4176 — none
  about chain naming). Checked #3533 sub-issues: none covers
  it. (The distinction is recorded in this doc as the interim
  fix.)

- **Applied (#4774):** the user widened
  the issue to ALL chain shapes and ruled the short ids (comments
  6911310987, 6912854849, 2026-11-16): `feedsrc` = feed chain,
  `stockscr` = screener chain, `optionsscr` = options chain,
  `goalscr` = goal-screen, `strategyscr` = strategy-discovery.
  Goal screens ride the screener chain (same shape), not a separate
  chain shape. The short ids are wired into the catalog ids, the
  chain catalog entries, the job-definition spec, the options-chain
  leaf, the UI labels, and the dispatch-modes doc's naming section
  ("Chain short ids"). The remaining families are now ruled
  (2026-11-17): `tradrun` = trading-leg, `payrun` = payment-run,
  `sagarun` = saga-run; the research family is ruled `resrch` (OODA
  is one research type within the family) but has no catalog family
  yet — #5118 owns the entry. This R3 note is now the record of the
  applied names, not the interim fix.

- **Extended (#4774, user ruling comment 6959360479, 2026-11-17):**
  the short-id system covers ALL execution-tree levels — stages,
  sub-stages, pipelines, chains, workflows, tasks, runs, transactions
  (`src/services/executionTreeIds.ts`: `chain` / `pipe` / `wf` /
  `job` / `stage` / `unit` / `task` / `run` / `txn`, one printable id
  per instance as `<level>:<local-id>`). The stage/step execution ids
  follow the uniform convention (`stage:` / `step:` / `event:`,
  bodies embedded, fixed arity). The OODA ambiguity is resolved by
  level: candidate-level steps are `ooda:*`, run-level research
  stages are plain `stage:` execution ids (`respipe:` retired), and
  each OODA trace entry carries its qualified `shortId` (the bare
  stage strings are unchanged). Every
  run/transaction instance already carries a unique id (engine
  `run:*`, research `rsr_*`, async-job UUID, ledger `id` PK); a trace
  step's instance id is derived (`trace:<runBody>:<loop>:<step>:<index>`), not
  stored. NOT in the slice: the research run's engine onboarding
  (#5109, CFO lane) — the engine job id (`research:<runId>`) and data
  ports landed (#5121); the trigger dispatch (#5120) and cutover flag
  (#5122) are recorded merged; the analyze.ooda step registration
  (#5118, PR #5143 open), AOP compliance (#5119, PR #5144 open), and
  Copilot execution (#5123, no PR) remain. The `ooda:` ids are names
  the #5118 step registration can reuse; CLO-arsi does not build it.

### R4 — Stage per-unit deadline (600s) exceeds the run execution deadline (240s) (inconsistency)

- **What:** Two deadline budgets bound the same run at different
  levels, and the stage budget is the larger one: the stage
  per-unit deadline defaults to 600,000ms
  (`DEFAULT_SHARD_TIMEOUT_MS`,
  `src/workflows/workflowPorts.ts:134`; enforced at
  `src/services/jobPipelineEngine.ts:3186`), while the feed-run
  whole-execution deadline is 240s (#3992). A stage deadline
  can therefore only fire if the run execution deadline has
  already failed to fire — which is the shape of the Nov 11
  Yahoo failure (the feed stage ran past 600s). The two budgets
  have never been reconciled against each other.
- **Evidence:** `src/workflows/workflowPorts.ts:134`,
  `src/services/jobPipelineEngine.ts:3186`, #3992 (feed-run
  timeouts: refresh 30s / fetch 60s / capture 30s / execution
  240s).
- **Why it needs remediation:** the failure mode a run exhibits
  depends on which budget fires first, and today that is
  accidental: a run that hangs inside a stage is killed at 600s
  by the stage budget, not at 240s by the run budget. The
  relationship between the two budgets should be a deliberate,
  documented decision (stage budget ≤ run budget, or an explicit
  reason it is larger).
- **Suggested parent:** #3992 (feed-run timeouts; its acceptance
  is a live run that settles with data landed).
- **Proposed Size/Priority:** Small / Medium.
- **Reuse check:** no existing issue found — searched "per-unit
  deadline shard timeout" (1 result: #3220, "Agent-composed
  workflow solutions: shard plans, parameter control" — about
  agent-composed shard plans, a different topic). Checked #3992
  sub-issues (#4171 workflow residency, #4312 externalize
  FEED_JOB_TIMEOUTS, closed): neither covers the deadline
  relationship. Caveat, recorded honestly: the Nov 11 02:54 run
  predates the #3992 fixes' daytime deployment, so this is a
  structural inconsistency, not a proven live bug.

### R5 — Dead deprecated workflow modules still in the tree (gap/cleanup)

- **What:** `src/workflows/screenerWorkflowFlow.deprecated.ts`
  and `src/workflows/startScheduledShardedChain.deprecated.ts`
  exist in the tree and are referenced by NO code — only by docs
  (the deprecation ledger
  `docs/architecture/transition/deprecations.md:43,195` and the
  lifecycle doc). No `src/` file imports either.
- **Evidence:** grep for both filenames across `src/` returns
  no importers; the only hits are the two docs above.
- **Why it needs remediation:** dead modules in the tree confuse
  the inventory (a reader enumerating `src/workflows/` finds two
  files that do nothing), and the repo's retirement rule expects
  deprecated files to be removed once their successor has landed.
- **Suggested parent:** #3533.
- **Proposed Size/Priority:** Small / Low.
- **Reuse check:** no existing issue found — searched
  "deprecated workflow file removal" (11 results; none about
  removing these two files — closest are the #2299 lean-platform
  programme and #4700, closed, about deep-link keys). Removal
  must follow the deprecation ledger / retirement rule
  (gitops §22), including the ledger update — the issue should
  carry that, not just delete the files.

### R6 — FLAGGED SEPARATELY: workflow-runs trigger vocabulary (needs a user ruling — do NOT file)

- **What:** The separate `WorkflowRunTrigger` vocabulary
  (six-valued: manual/scheduled/autonomous/webhook/agent/unknown,
  `src/services/workflowRuns.ts:81`) — in or out of the #4767
  three-way split? That is Q3 on #4767, and it needs the user's
  ruling before any issue can be filed: bringing workflow runs
  into the split changes the `WorkflowRunsPanel` filter and a
  separate ledger, while leaving them out leaves two trigger
  vocabularies in the product permanently.
- **Status:** not proposed as fileable. Awaiting the user's Q3
  ruling on #4767.

## Considered and NOT filed (with reasons)

- **The options screen engine builds its own `JobPipelineControl`**
  (`src/workflows/optionsScreenEngine.ts`, `invocation: "sync"`),
  separate from the host's control plane. Not filed: it is a
  separate composition (different stores, different step
  registry, different invocation), not a duplicate capability.
- **Goal-screen / strategy-discovery `runtimeMappingGap`s**
  (`src/workflows/workflowCatalog.ts:377`, `:397`). Not filed:
  recorded in the catalog itself as known design decisions
  (#3072, #3073).
- **Options pipeline: 8 execution stages vs 4 display stages.**
  Not filed: documented in the catalog (#4067) — display stages
  partition execution stages by design.
- **Feed step second trigger channel, door trigger defaults,
  stage-view mode drop, O4 doc update.** Not filed here: covered
  by #4766 / #4767 (excluded per the task).
