# The j-stack workflow engine — product reference

Status: current as of main `de6d60fb` (2026-11-19). This is the one
consolidated reference for the j-stack as a product: what it is, the
features and capabilities it has, the concepts it supports and how each
one is implemented, and its characteristics (the -ilities) with the
current state of each stated honestly.

Reading convention: every implementation claim carries a code reference
(`file:line` at the build tip). Where a capability is filed but unbuilt,
the doc says so and names the issue — nothing filed-but-unbuilt is
presented as built. This doc LINKS the existing docs listed in
§7; it does not copy them. Where an existing doc is the authority for a
topic, this doc states the one-paragraph summary and points at it.

Terminology note: the phrase "jobs-as-data" appears nowhere else in
`docs/` — the concept lives in code as the uniform job contract
(`docs/architecture/agentic/job-system.md` §3) and in the types in
`src/data/jobPipelinePorts.ts`. This doc uses the phrase because it is
the accurate name for the mechanism (§2), and records the fact so the
next reader does not search the docs for it in vain.

## 1. What the j-stack is

The j-stack is the platform's **one durable workflow engine**: the
execution core that runs every workflow family (stock screen, options
screen, goal screen, strategy screen, research/OODA, feed pipelines,
and the scheduled chains) under one stage contract, one stage runner,
and one control plane. It is the engine *inside* the target system,
not the whole of it: the target system also has agents, doors, the
mesh, copilots, payments, and the data foundation, and none of those
are the engine.

The engine is `JobPipelineControl`
(`src/services/jobPipelineEngine.ts:715`), created by
`createJobPipelineControl` (`:3425`), plus the stage runner, the
journal, and the aspects (retry, observability hooks). Everything else
is a caller, a wiring point, or a surface on top of it.

### 1.1 Engine vs host vs door vs agent vs workflow vs chain vs stage

These words are distinct constructs; the platform's confusion between
them is the most common source of wrong claims about the engine.

| Construct | What it is | Where it lives |
|---|---|---|
| **Engine** | The execution core: `JobPipelineControl` + stage runner + journal + aspects. Defines and runs jobs; nothing else executes a job. | `src/services/jobPipelineEngine.ts:715` |
| **Host** | The composition root that wires a control's dependencies (stores, adapters, observers, publisher, policy) and calls define/run. A host is not the engine; it is how one residency reaches it. | `src/agents/scheduledTasksPipeline.ts:511` (ScheduledAgent host), `src/workflows/optionsWorkflowHost.ts` (workflow host), `src/services/researchJobCommands.ts` (research/MCP command hosts) |
| **Door** | Validates and routes a chat/MCP request into the platform, including into the engine. A door never executes a job itself. | `src/agents/orchestrator/meshScreenDoor.ts`, `src/agents/orchestrator/meshDoors.ts` |
| **Agent** | A durable actor (ThinkAgent behind `PortThink`, `src/actors/thinkAdapter.ts:276`). Agents call doors and hosts; they are not the engine. | `src/actors/` |
| **Workflow** | A Cloudflare Workflow binding: the durable-steps substrate one journal mode runs on. Since #4924 the five workflow classes extend `PortThinkWorkflow` (`src/workflows/portThinkWorkflow.ts:34`), the sole `@cloudflare/think/workflows` importer in `src/`. | `src/workflows/jobPipelineWorkflow.ts`, `src/workflows/portThinkWorkflow.ts` |
| **Chain** | A declarative stage chain (`PipelineChain`): a named composition of stages a host can define and run. A chain is data the engine executes, not an executor. | `src/services/` chain definitions; `runPipelineChain` in `docs/operations/jobs-workflow-pipelines-stages-dispatch-modes.md` |
| **Stage / step / unit** | Runner vocabulary. A **stage** is a node in the job tree; a **step** is one named invocation inside a stage (`JobStepConfig`, `src/data/jobPipelinePorts.ts:127`); a **unit** is one item of work a step processes (one shard, one symbol batch). Checkpoints are per (stage, unit). | `src/data/jobPipelinePorts.ts:127-168`, `src/workflows/stageRunnerPorts.ts:209-327` |

### 1.2 One engine, every family

There is one composed step registry, not one registry per family.
`JobStepRegistry` (`src/services/jobPipelineSteps.ts:49`) is a single
`Map<string, JobStepHandler>` (step name → handler), and
`createPipelineStepRegistry` (`src/services/enrichPipelineJobs.ts:422`)
composes every family into it: the five generic families
(feed/enrich/analyze/generate/deliver) plus screener steps (#4190),
options steps (#4289), options-chain steps (#4780), and research steps
`analyze.ooda` + `evaluate.apply` (#5118). A family contributes steps
by registering them with optional deps arguments; absent deps simply
mean the registry lacks those steps.

Family membership is decided at authoring time by a step's input/output
contract, and the registry enforces nothing about semantics. The five
families are the five pipeline jobs of the job system — see
[The Job System & 5-Stage Pipeline Engine Architecture](./job-system.md)
§2 for the jobs and their producer/consumer contract:

- **feed** acquires external data into the dataset store
  (`feed.pull`, `src/services/feedPipelineJobs.ts:67`);
- **enrich** joins rows (`enrich.apply`,
  `src/services/enrichPipelineJobs.ts:87`);
- **analyze** applies rule sets over enriched rows (`analyze.apply`,
  `src/services/analyzePipelineJobs.ts:58`);
- **generate** shapes reports (`generate.apply`,
  `src/services/generatePipelineJobs.ts:61`);

<!-- 5825: screener-report kind — begin -->
The generate family produces two report kinds
(`GENERATE_REPORT_KINDS`, `src/services/generateJobs.ts`):
`analysis` (the analyzed dataset as a report) and
`screener-report` (#5825, #4437 slice 4) — the screener's
report shape over the analyzed artifact: the market-screen
title and summary, the opportunities (top by composite), the
screened symbols with their verdicts, and the gaps, rendered
in every format and stored through the canonical leg (#3940)
where a host wired it. The kind is opt-in per job (the
`REPORTS` knob or the step params); the built-in default
stays `analysis`, so no existing generate job silently gains
a second report. The kind's renders carry only what the
analyzed artifact carries: the bespoke report's rich
per-symbol fields (RSI-14, MACD histogram, P/E, company
name, sector, sentiment, factor grades) are not in the
analyzed artifact and are not in this document — closing
that gap needs the analyzed row to carry the screener's
per-symbol fields (analyze/enrich schema work). No matched
count is stated either: the analyzed artifact carries no
matched notion, and the kind fabricates none.
<!-- 5825: screener-report kind — end -->
- **deliver** sends through channel senders (`deliver.apply`,
  `src/services/deliverPipelineJobs.ts:68`).

One registry does not mean one step signature. Converging the step
contracts — so every family runs on the generic steps — is the #4437
decomposition work, not something the registry gives for free. The
stock screener is redefined onto the generic steps (#5884,
#4437 slice 6b3, the flip): the `screener` spec (v2,
`src/config/jobDefinitionCatalog.ts:147`) is five generic nodes
— `feed.pull`, `enrich.screener`, `analyze.screener`,
`generate.apply`, and `deliver.apply` (the deliver node flipped
onto the generic step in slice 6c, #5885).
The options-chain family likewise uses bespoke steps; no other
family has yet been redefined onto the generic steps.

The screener's feed stage nevertheless reads through the generic feed
machinery for its quotes (#5823): the step handler binds the quote /
history deps over the #3941 capture-wired provider
(`createScreenerFeedDepsFactories`,
`src/services/screenerPipelineJobs.ts:208`), so a screen run's feed
stage executes via the same provider construction the feed jobs run
through (`createCaptureWiredFeedProvider`,
`src/services/feedProviderWiring.ts`), freshness-gated per #5822
(fresh capture serves with zero live provider calls; stale or missing
capture fetches live once and writes through). The agent no longer
binds quote/history deps at stage time on the engine path — the stages
refuse by name (`SCREENER_QUOTE_DEPS_MISSING` /
`SCREENER_HISTORY_DEPS_MISSING`) when the handler omits them. The
bespoke flow (`runScreenInner` / `screenLive`) keeps its own bind
until slice 7 (#5828) retires it; the feed stage is visible as a
generic feed step in Workflow Runs.

The screener's market analyze likewise runs as a generic analyze
application (#5824, slice 3a): the `analyze.screener` step
(`src/services/analyzePipelineJobs.ts`) applies the `screen` and
`factors` rule sets over the gather output, mapped to enriched rows
by `resolveScreenerHandOff` (`src/services/analyzeJobs.ts`) — the
parent-hand-off input mode, because the factor grades read quote
fields the persisted enriched rows do not carry. Standout selection
is summary output, and parity with the bespoke analyze is pinned by
`tests/screener_analyze_parity_5824.test.ts` (same quotes → same
screen signals, momentum scores, factor grades, standouts). The
spec pointed its analyze node at `screener.analysis` until slice
6b3 (#5884) re-pointed the whole market spec onto the generic
chain; the goal branch and the portfolio modifier are separate
slices (#5873, #5874).

<!-- 5873: goal branch out of the screener analyze node -->
The goal leg rides its own definition (#5873, #4437 slice 3b): a
goal command builds the `goalScreen` spec (same six kinds, the
analyze node the goal dispatch step `screener.goal`), while a
market command builds the re-pointed `screener` spec (v2, five
generic nodes). The goal step is a thin handler delegating
to a new agent stage method, `screenGoalStage`, which carries the
goal-branch body moved verbatim — the goal runner (the engine
method, with the test injection point) plus the goal-shaped
output — and `screenAnalysisStage` is market-only. The goal leg
is a dispatch (quota charge, trade client, goal universe deps,
options leg, production goal screen), not a computation
expressible as a generic analyze rule set, so it cannot ride
`analyze.screener`; the flip (slice 6b3, #5884) re-pointed only
the market spec, and the goal definition is untouched. Parity
is pinned by
`tests/screener_goal_definition_5873.test.ts` (goal command →
goal definition, goal run through the goal step with the market
analyze never invoked; market command → market definition,
market run unchanged).
<!-- /5873: goal branch out of the screener analyze node -->

<!-- 5874: portfolio modifier as an analyze input -->
The portfolio modifier rides the parent hand-off (#5874, #4437 slice
3c): positions arrive as a stage input, not a live leg inside
analyze — option (i) from the issue. The gather stage fetches the
book (the one live broker leg, via `loadPortfolioBook` on the
per-run state the feed stage already bound) and carries the JSON
snapshot as `portfolioBook` on the gather output; the analyze stage
applies `applyPortfolioContextToOpportunities` purely from that
snapshot and never touches the broker. The leg is best-effort,
exactly like the gather stage's persisted reads: no broker in scope
records a `no-broker` snapshot, a failed fetch records
`positions-unavailable`, and a goal run skips the fetch entirely
(the goal leg never consumes positions, and the gather input already
carries `goalScreen`). A hand-off without the field degrades to
`positions-unavailable` in analyze, never a failure. Option (ii) —
an optional portfolio leg inside analyze — was rejected: analyze's
input model is persisted/hand-off data, and a live broker leg inside
it is a contract change with its own failure modes. The snapshot
flows forward with the hand-off (`ScreenerAnalysisStageOutput`
spreads the gather output), so the slice-6 flip can consume it
wherever the ranking lands without a new fetch; the legacy
`runScreenInner` path keeps its own live fetch until slice 7
retires it. Parity is pinned by
`tests/screener_portfolio_handoff_5874.test.ts` (analyze reads the
hand-off with no broker in state; gather records the snapshots and
skips goal runs; the fetch lives in gather, never in analyze).
<!-- /5874: portfolio modifier as an analyze input -->

<!-- 5884: the flip — screener spec onto the generic chain -->
The flip re-points the market spec onto the generic five-stage
chain (#5884, #4437 slice 6b3): the `screener` spec goes v1 → v2,
five nodes — `feed.pull`, `enrich.screener`, `analyze.screener`
(params `ruleSets: ["screen", "factors"]`, `inputMode: "handOff"`),
`generate.apply` (params `reports: ["screener-report"]`), and
`screener.deliver` (bespoke; flipped onto `deliver.apply` in 6c,
#5885). The family job ids are
computed per command, never pinned in the spec: provider =
the command's provider, falling back to the tenant default
data provider (a static spec literal would pin one provider
for every run — a broker substitution, forbidden by #5517), feed job `<provider>-nasdaq100-quotes` validated against
`FEED_PIPELINE_CATALOG` (unknown provider refused by name,
`SCREENER_FEED_JOB_UNKNOWN`), then derived `<feed>-enrich` →
`-analyze` → `-generate`, injected into the per-node params by
`screenerFamilyJobIds` (`src/services/screenerPipelineJobs.ts`).
The run's single universe rides the feed node only when every
shard naming one agrees (`screenerFeedNodeUniverse`); per-shard
universes govern per unit (6b1), explicit-symbols shards name
none (6b0). Goal commands build the untouched `goalScreen` spec
— a goal param on a market definition is refused, never
dropped. The deliver leg is flipped in 6c (#5885, below);
the collation is taught the generic shape in 6e (#5922,
below). The flip also fixed
`analyze.screener`'s hand-off for sharded runs: the engine hands
a sharded unit the per-shard map, and the step unwraps its own
shard's entry (the bespoke `priorFor` idiom) before resolving
the hand-off — without it a sharded run failed
`ANALYZE_HANDOFF_MALFORMED`. The 2863 criteria stamp's home is
the generated screener-report document: `generate.apply` passes
`params.filters` as `criteria` when present, never invented.
Pinned by `tests/screener_generic_definition_5884.test.ts`
(five nodes, per-provider job ids, shards on every node, goal
param refused) and the moved pins in
`tests/screener_substrate_4190.test.ts` /
`tests/stage_visibility_4365.test.ts`.
<!-- /5884: the flip — screener spec onto the generic chain -->

<!-- 5885: the deliver flip — generate→deliver payload mapping + sink wiring -->
Slice 6c (#5885) flips the deliver node onto generic
`deliver.apply` (params `screener: true`) and wires the real
sink at both residencies — the ScheduledAgent host's
`deliverStepDepsForScheduledAgent` and the workflow host's
inline deliver deps in `createJobPipelineWorkflowDeps` both set
`screenerDeliverOutcome: buildDeliverDoor(env)` (the door,
exported from `src/services/screenerPipelineJobs.ts`); without
it a `deliver: true` dispatch refuses
`DELIVER_SCREENER_SINK_NOT_CONFIGURED` and fails the run. The
engine proof now dispatches with `deliver: true`. The payload
mapping is generate-output payload + door stamp, not a door-side
conversion: the door has no store access (orchestrator stub
only), the deliver step must not consult the channel path's
stores (#5826 pin), and the generate run is the only place where
the document, the format records and the canonical record coexist
without a store read. So `runGenerateJob` builds the delivery
payload in its per-report loop (`buildScreenerDeliveryPayload`,
`src/services/generateJobs.ts`) — trigger, success, timestamp
(the run's finishedAt), totalScanned, universe (the document's
label), summary, thesis (the document's title), the top-by-composite
opportunities joined with their rows (signal from the row's
"screen" signal, momentum from the row's composite score, price
from the row; a top symbol with no row still rides, scored from
the summary alone), and the canonical report id when the leg stored
(or deduped) a row — and carries it on the run result as
`deliveryPayload` (screener-report runs only) alongside `reportId`
(the first stored/deduped canonical record's id, in configuration
order; null when no leg stored a row). `generate.apply` passes
both through as `payload` + `reportId` on its step output, which
the deliver step already reads (`prior.payload`,
`prior.reportId`). The door converts via
`screenerOutcomeFromRunResult` (unchanged) and stamps the
payload-carried canonical report id onto the market outcome
(`buildScreenerMarketOutcome`, pure and unit-tested) — the stamp
fires only for payloads that carry the field, so the bespoke path
is unchanged and a bespoke market run with PDFs still takes the
PDF-adoption branch downstream (the C4 canonical branch sits
after the pdf-failed branch and before the no-keys branch in
`asyncJobs.ts`; stamping from `opts.canonicalReportId` instead
would have diverted those runs). Without the stamp a generic
delivery is dead on arrival: no pdfKeys and no canonical id hits
"no artifact" → `FAILURE_REPORT_ARTIFACT_MISSING`. What the
document does not carry, the payload does not invent: no
matchedCount (the analyzed artifact carries no matched notion),
no pdfKey/xlsxKey/csvKey (the generic formats are inline bodies,
not artifact keys) — rich per-symbol parity is #5875, owned by
slice 7. Known limitation, pinned by test: the generate output
carries no `duplicate` field, so the scheduled-duplicate
pass-through never fires in the generic chain — delivering the
same generate output twice calls the sink twice with the same
`workflow:<jobId>` delivery id (wasted work, not double delivery;
the sink converges on the delivery id). Pinned by
`tests/screener_generate_delivery_payload_5885.test.ts`
(converter, run result, step pass-through, door stamp), the
restored full-chain + step parity tests in
`tests/screener_deliver_generic_5826.test.ts`, and the flipped
proof + definition pin in `tests/screener_substrate_4190.test.ts` /
`tests/screener_generic_definition_5884.test.ts`.
<!-- /5885: the deliver flip — generate→deliver payload mapping + sink wiring -->

<!-- 5886: the market refusal — a goalScreen param fails named on the market chain -->
Slice 6d (#5886) makes the market refusal runtime-real. Slice 6b3
(#5884) pinned the definition level: a market definition carries
no `goalScreen` param on any node, and a goal command builds the
untouched `goalScreen` spec. What it left open was the runtime: a
hand-built or stale market definition carrying a `goalScreen`
param would ride the generic nodes, which silently ignored it, and
reach the sink's goal path — which reads `payload.result.goalKind`
from a goal envelope the generic chain never builds. Now every
market-only generic step refuses the param at its entry, before
any fetch or compute: `feed.pull`, `enrich.screener`,
`analyze.screener`, and `generate.apply` each call
`refuseGoalScreenParam` (`src/services/jobPipelineSteps.ts`) first
and fail the run with `GOAL_SCREEN_ON_MARKET_CHAIN`. The shared
`deliver.apply` step does not refuse — it serves the goal outcome
through the door's goal path by design — and the bespoke goal
steps (`screener.feed`, `screener.gather`, `screener.goal`) read
the param as before. The spec-route binder already refused
undeclared params (`bindJobDefinitionParams`); the refusal of
`goalScreen` on the `screener` spec (declared parameters universe
+ deliver only) is pinned alongside. Acceptance (1) verified, not
rebuilt: a goal run executes on the goal definition — the goal
definition test (`tests/screener_goal_definition_5873.test.ts`)
and the goal-leg dispatch tests
(`tests/screener_cutover_4192.test.ts`, goal runner on the same
six nodes, never the market runner) pass unchanged. What 6d does
NOT do: the engine-steps conversion of the goal runner. The goal
step still dispatches through `runGoalScreenOnEngine`
(`src/agents/screener-agent.ts`) — quota, trade client, goal
universe deps, options-leg deps, then `runProductionGoalScreen`.
Both legs already run on engines (stock via the S3 seam,
`runStockScreenViaEngine`; options via the one options pipeline,
`runOptionsScreenViaEngine` / host dispatch), but the composition
— plan, ledger claim/complete, leg dispatch, result assembly —
is a function call, and its state is DO-owned (task ledger, DO
storage, ORM) that the workflow residency can reach only through
the agent stub. Converting the composition into engine nodes
(plan + ledger + legs + assembly as steps, D1-resident ledger,
child-job dispatch) is a programme of its own; it decomposes
under #5886 as follow-up sub-issues, it is not built here.
Pinned by `tests/screener_market_refusal_5886.test.ts` (four
step refusals + controls, binder refusal).
<!-- /5886: the market refusal — a goalScreen param fails named on the market chain -->

<!-- 5922: collation on generic-chain outputs — begin -->
Slice 6e (#5922) teaches the collation the generic shape
(`shardOutcomeFromStageOutputs`, `src/workflows/screenerCollation.ts`):
the generic deepest output (`deliver.apply` output = generate
output + delivery flags) carries no `screenResult` /
`expectedCount` / `matchedCount` / `servedReport`, so its screen
evidence is the 6c delivery payload — `payload.totalScanned`
(the validated count; a non-number fails the shard as
malformed, never completes it with coerced zeros),
`payload.timestamp` (the run's finishedAt, feeding the
`childRunIds` `screener:<timestamp>` links), and
`payload.canonicalReportId` (the report-id fallback) — and its
store evidence is the canonical leg map:
`canonical["screener-report"]` of `stored`/`deduped` means the
canonical row exists, `failed` means unstored with a store
error naming the leg, `not_wired` means unstored with no error.
The leg's reason is not in the step output (the canonical map
carries statuses only), so the error names the leg, never a
fabricated detail. `expectedCount` rides the command when the
artifact lacks it — `composeScreenerCollation` passes the
shard's asked-to-consider count (`shard.symbols.length`) as a
fourth parameter to `shardOutcomeFromStageOutputs`; the
artifact's own value still wins, and the field is omitted when
neither has it (universe shards). `matchedCount` is omitted for
generic runs (the analyzed artifact carries no matched notion,
#5825's document rule). No per-format key is fabricated: the
generic formats are inline bodies in the generated artifact, and
a canonical report id is a mas_reports row id, not a PDF blob
key — `/api/screener/report.pdf` takes a blob key — so putting
it in `pdfKey` would build a broken download link (and would
divert the parent-report C4 canonical branch). The downloadable
references for a generic run are the shard outcome's `reportId`
+ the generated artifact id; the per-format-download gap
(generate renders formats inline with no asset keys) is filed
separately. A generate output with no screener payload fails
loudly as malformed ("no screener delivery payload"), never as
"never reached analysis" — the market spec always generates
the screener-report kind. The bespoke path is unchanged (its
three counts are still all required as numbers; a bespoke
`stored` boolean still wins). Pinned by
`tests/screener_collation_generic_5922.test.ts` (8 unit tests:
generic success, canonical stored/deduped/failed/not_wired,
expected-count fallback + artifact-wins, malformed payload,
bespoke unchanged) and the restored dispatch tests in
`tests/screener_cutover_4192.test.ts` (2-shard market screen
collates `ReportGenerated` with 4/4 coverage, canonical-leg
refusal records `Completed` with per-shard store errors,
`deliver=false` skips delivery), whose harness now composes
the full pipeline registry (`createPipelineStepRegistry` +
`ensure*PipelineJobs`, the 4190 pattern) with a storing fake
canonical seam.
<!-- 5922: collation on generic-chain outputs — end -->

<!-- 5873: goal branch out of the screener analyze node — superseded by #6072 (6d-a), which replaces the single dispatch with the eight-step composition below; kept as the 3b history -->
The goal leg rides its own definition (#5873, #4437 slice 3b): a
goal command builds the `goalScreen` spec (same six kinds, the
analyze node the goal dispatch step `screener.goal`), while a
market command builds the unchanged `screener` spec (analyze node
`screener.analysis`). The goal step is a thin handler delegating
to a new agent stage method, `screenGoalStage`, which carries the
goal-branch body moved verbatim — the goal runner (the engine
method, with the test injection point) plus the goal-shaped
output — and `screenAnalysisStage` is market-only. The goal leg
is a dispatch (quota charge, trade client, goal universe deps,
options leg, production goal screen), not a computation
expressible as a generic analyze rule set, so it cannot ride
`analyze.screener`; the flip (slice 6b3) re-points only the
market spec's analyze node, and the goal definition is
untouched. Parity is pinned by
`tests/screener_goal_definition_5873.test.ts` (goal command →
goal definition, goal run through the goal step with the market
analyze never invoked; market command → market definition,
market run unchanged).
<!-- /5873: goal branch out of the screener analyze node -->
<!-- 6072: goal composition onto engine nodes — begin -->
Slice 6d-a (#6072) converts the goal-run composition from the
direct-runtime function `runGoalScreenOnEngine` into engine nodes
on the goal definition's analyze node: `goal.quota` →
`goal.plan` → `goal.ledgerClaim` → `goal.stockLeg` →
`goal.optionsLeg` → `goal.assemble` → `goal.ledgerComplete` →
`goal.artifacts` (`GOAL_COMPOSITION_STEPS`,
`src/services/screenerPipelineJobs.ts`). Each step's output is
the next step's input, threading an accumulated
`GoalCompositionState` (gather output, plan, ledger task, leg
outcomes, assembled result) through to the artifacts step, which
builds the `ScreenerAnalysisStageOutput` the store stage consumes
(the shape `screenGoalStage` returned, verbatim — a duplicate
delivery carries no result, so the store stage records its
refusal by name, as the direct path did). The quota step charges
`goalScreen:<runId>` before any work (a duplicate delivery
re-charges the same id and the port counts it once, #2842); the
plan step is the pure `buildGoalScreenPlan` derivation (symbols
from the gather stage's goal symbols, else the command's); the
claim step is the #5269 adoption verbatim on a D1-resident
ledger (terminal record = duplicate, `executed:false`, providers
never re-invoked; active record = adopt through claim/start/
heartbeat; fresh = create + claim + start + heartbeat); each leg
step catches its dispatcher's throw as a failed class (#462 —
never a failed run) and skips a class the command did not
request; the assembly is the extracted pure
`assembleGoalScreenResult` (`src/services/goalDrivenScreen.ts`,
the #1963 error-status checks + #462 partial contract + #1998
gather carry + #2882 stock-spec record, verbatim from
`runGoalDrivenScreen`, which now collects leg outcomes and calls
it); the ledger-complete step completes with the deterministic
evaluation, or fails + escalates when every leg failed; the
artifacts step stamps the run's data mode + provider onto the
result and runs the report tail. The ledger is D1-resident
(`agent_screener_task_entries`, migration 0079, `ScreenerTaskStore`
over drizzle D1 — `D1ScreenerTaskStore`, keys `screener:`-namespaced
exactly as the DO-storage implementation stores them — plus an
in-memory adapter for tests), wired from `env.AGENT_DB` in the
step-deps factories; unbound = a named refusal
(`GOAL_TASK_LEDGER_NO_D1`), never a silent fallback to the
DO-storage ledger, so a goal run's ledger survives a workflow
eviction replay. The steps' production defaults resolve from the
agent port (new methods `chargeGoalScreenQuota`,
`runGoalStockLeg`, `runGoalOptionsLeg`,
`generateGoalScreenArtifacts`, reusing the private dep builders
`runGoalScreenOnEngine` used — the quota counters live in DO
SQLite, the trade client / universe deps / screeners are built
there, the blob store lives there); `runGoalScreenOnEngine` and
`screenGoalStage` are never called on the path. The leg functions
`runGoalStockLegViaWorkflow` / `runGoalOptionsLegViaWorkflow`
are exported for the 6d-b (#6073) / 6d-c (#6074) re-points, which
remove the transitional leg bindings. A stage may now declare
`steps?: string[]` on its spec (`JobStageSpec`, validated by
`resolveStage`); the builder runs every declared step on the
node. The goalScreen spec is v2; its legacy single `step` stays
`screener.goal` for old stored definitions, which still resolve.
Pinned by `tests/goal_composition_nodes_6072.test.ts` (6 tests:
builder, full run with no `runGoalScreenOnEngine` call, quota
refusal before any ledger record, terminal duplicate, failed leg
as failed class, active-record adoption on eviction replay) and
the re-pointed 4192 / 5873 goal tests.
<!-- 6072: goal composition onto engine nodes — end -->

The screener's deliver stage likewise runs through the generic deliver
machinery (#5826): `deliver.apply` gains a screener application
(params `screener: true`) that delivers a screen outcome through the
orchestrator sink — the same door the bespoke `screener.deliver` step
calls (`deliverWorkflowScreenOutcome` for market outcomes,
`deliverWorkflowGoalScreenOutcome` for goal outcomes), with the same
`workflow:<jobId>` delivery id, goal/delivery/stage-chain threading,
and canonical report id. The bespoke deliver rules carry over (a
scheduled duplicate passes through untouched, `deliver: false` skips,
a sink refusal is recorded never a failed run, an unwired sink refuses
`DELIVER_SCREENER_SINK_NOT_CONFIGURED` by name), and the screener
application never consults the channel stores. The screener definition
still names `screener.deliver` — the redefinition (slice 6, #5827)
moves its deliver node onto this step and wires the sink in the
residencies. Parity is pinned by
`tests/screener_deliver_generic_5826.test.ts`.

<!-- 5883: screener enrich hand-off -->
The screener's enrich application likewise runs as a generic step
(#5883, #4437 slice 6a): `enrich.screener`
(`src/services/enrichPipelineJobs.ts`) sits beside `enrich.apply`
(the `analyze.ooda` / `analyze.screener` precedent — a separate
step for a different input/output contract) and runs the enrich job
identically, but returns the gather-shaped hand-off the
`analyze.screener` hand-off mode consumes
(`resolveScreenerHandOff`: an object with `acquired.quotes` plus
`platformRunId` / `taskId` / `timestamp` lineage) instead of the
enrich summary alone. The hand-off carries the input feed
artifact's quotes verbatim — the same quotes the bespoke gather's
`acquired.quotes` carries, since the gather stage spreads its feed
output — shard-filtered under sharding to exactly the partition
the enrich job enriched, with the enrich summary riding along so
the recorded output still carries the run's outcome exactly as
`enrich.apply` records it. The alternative — persisting the quote
fields as enrich features — was rejected: `rsi` is a history
element the default enrich job does not request (it needs the
history element plus the technicals join, not the quote), it
produces no hand-off at all (6b would have to flip analyze to
persisted mode, against the 3a design), and it changes persisted
rows for every consumer of the enrich job. Parity is pinned by
`tests/screener_enrich_handoff_5883.test.ts` (same quotes → same
`acquired.quotes` hand-off as `screener.gather`, and the hand-off
drives `analyze.screener` to the same standouts).

Two decisions ride with this slice. The feed node's freshness
decision: the re-pointed chain fetches once per run (`feed.pull`)
and everything downstream reads the persisted copy, so the
bespoke double-fetch is gone by construction — the remaining loss
is only dedup across separate runs minutes apart, and a
feed-node freshness check is a feed-family change (the `feed.pull`
contract, a TTL, reused-run semantics), a separate logical change
set filed as its own follow-up; the loss is accepted here, bounded
by one batch fetch of ~100 symbols on an hourly cadence. The feed
node itself flips to `feed.pull` in 6b, not here: flipping the
feed node alone breaks the bespoke gather (`feed.pull` outputs a
feed-job summary, not a `ScreenerFeedStageOutput`, and the gather
step passes its feed output straight to `screenGatherStage`), so
the flip can only land with the enrich flip in the 6b spec
re-point.
<!-- /5883: screener enrich hand-off -->

<!-- 5954: explicit-symbols feed mode -->
The feed family runs a symbols-fed mode (#5954, #4437 slice 6b0):
`feed.pull` reads the unit's explicit symbols — the shard table's
row for this unit's shard key, else the flat `params.symbols`
list, the bespoke `shardSymbolsFor` idiom — and the quotes
runner fetches exactly those symbols under the #4065 membership
rule, extended from the options-chains runner: every named symbol
a member of the stored list the run resolves ⇒ an index-kind
subset universe; ANY named symbol outside it ⇒ a symbols-kind
universe, the symbols used as-is (filtering would silently drop
the caller's symbols). The membership check is a plain store
read — a symbols-fed run never triggers an index refresh for a
list it may not need — and a cold universe store is fine: the
premium path (payer-chosen listings, `premium.ts`) screens its
own symbols with no stored list at all. The runner's invariant
— "the stored index list, never an invented one" — is HONORED,
not changed: explicit symbols are the caller's own list,
recorded on the artifact as their provenance (a symbols-kind
universe's symbols ARE the provenance, per
`FeedDatasetSymbolUniverse`); the feed family still invents no
membership. The one normalizer (`normalizeSymbolsInput`,
uppercase/trim/dedupe) is shared by the quotes and
options-chains runners so the two runs can never disagree on
what "the same symbols" means. Two named refusals guard the
mode: a `"symbols"` universe with no explicit symbols throws
`FEED_UNIVERSE_UNKNOWN` before any fetch (never a silent
default-list pull), and explicit symbols on a non-quotes
dataset throw `FEED_SYMBOLS_UNSUPPORTED` (quotes only — other
runners would ignore the option and silently run the stored-list
path). A sharded partition still rides `opts.symbols` — a filter
on the stored list, never an explicit-symbol run — so the
membership rule only answers `opts.explicitSymbols`. Parity is
pinned by `tests/feed_symbols_5954.test.ts` (premium symbols
shard fetches exactly the requested symbols with a cold store;
all-members ⇒ index-kind subset; partially-outside ⇒
symbols-kind, nothing dropped; ordinary index and sharded
partition runs unchanged).

One correction to the 6b survey rides with this slice: the quotes
jobs are NOT parameterized — all four are built by
`nasdaq100QuotesJob` with no `parameterizedUniverse` flag; only
fundamentals, technicals, sentiment, and options-chains are. So
the 6b3 flip cannot pass a `universe` param to the quotes feed
node as-is (any universe input throws `universeUnknown` on a
non-parameterized job). RESOLVED by 6b1 (#5955, next section):
the four nasdaq100 quotes jobs are parameterized now, so the flip
can pass a universe param.
<!-- /5954: explicit-symbols feed mode -->

<!-- 5955: per-shard universe in feed.pull -->
One job definition serves multi-universe commands (#5955, #4437
slice 6b1): `feed.pull` reads the unit's shard universe — the
shard table's row for this unit's shard key (`shardRowFor`, the
one shard-table reader in the step, shared with 6b0's
`explicitSymbolsFor`), the bespoke `screenRequestFromParams`
idiom — and the run input the quotes runner resolves is the
shard's stored list. Precedence: explicit symbols (6b0) win over
the shard universe; the shard universe wins over the node's
`universe` param; absent ⇒ the job's default, as before. The
quotes jobs had to become parameterized for this to work: the
four nasdaq100 jobs (all built by `nasdaq100QuotesJob`) now carry
`parameterizedUniverse: true` on the #3930 idiom — the id names
the DEFAULT universe, a run's `universe` input names the stored
list it actually pulls. The per-universe-job route was not
viable: only one source has per-universe quotes jobs, so the
other three sources could not serve an ALL run that way.
Parameterizing is backwards-compatible: no existing caller
passed a universe input to a quotes job (it threw), an absent
input still resolves to nasdaq100, and the per-universe jobs
stay registered for their existing callers.

A universe-shard unit pulls its WHOLE universe, never a
partition of it: the shard IS the universe (the bespoke feed
resolves the shard's universe to its full list). The step's
`feedShardSymbols` partition splits ONE universe across N units
and applies only when the shard row carries no universe (the
feed family's own s0/s1 sharding); partitioning a universe shard
across all shard keys would silently drop most of the universe
(an ALL unit fetched one-sixth of nasdaq100 before this slice).
A shard universe with no stored index list (ETF / LEV_ETF — no
`IndexId`) refuses by name (`FEED_UNIVERSE_UNKNOWN`) before any
fetch; that coverage is 6b2's slice (#5956, next section). Parity is pinned by
`tests/feed_per_shard_universe_5955.test.ts` (each ALL unit
fetches its own whole universe; monolith single-universe runs
unchanged; explicit symbols still win; partition sharding
unchanged).
<!-- /5955: per-shard universe in feed.pull -->

<!-- 5956: non-index universe coverage in feed.pull -->
The three screener universes with no stored index list — TECH,
ETF, LEV_ETF — resolve and screen on the generic chain (#5956,
#4437 slice 6b2). They are selectors over the live listings
directory (`resolveUniverse`: TECH keyword discovery over
company names, ETF flag/name match, the leveraged-ETF subset),
not published tables or holdings files, so the coverage is a
third adapter of the #1852 port family — the listings-derived
adapter (`createListingsDerivedIndexMembershipAdapter`) — which
runs the SAME selectors the bespoke feed runs and stores the
result as a snapshot-dated index list (source `listings`,
snapshot date the fetch date, 10-day freshness budget, the
table budget). One port, three adapters, one store: no second
universe system. The listings fetch happens in the refresh
(the scheduled goal, or a cold-store hydration), never in the
run — the runner still pulls a stored list — and a selector
that yields no members is refused, never stored as an empty
list. `IndexId` gains `tech | etf | lev_etf`; the refresh gains
the `listings` group and the `index.refresh_listings`
operation, catalogued and executable (forced trigger /
operator-added goal); the built-in weekly goal entry is a
follow-up activation, not this slice. The listings adapter is
bound for real at all three host sites (workflow residency,
scheduled-tasks pipeline, scheduled-agent executor) — never a
stub: a cold-store hydration for one of those universes calls
it. TECH stays a stored selector-computed list rather than a
mapping onto the sector list: keyword discovery and the sector
list are different memberships, and the flip must screen what
the bespoke feed screened. The vocabulary governs declared
universe names; the feed runner governs stored-list names.
Parity is pinned by `tests/feed_non_index_universes_5956.test.ts`
(each of the three commands resolves and screens; a seeded
list is used as-is with no listings fetch; the node universe
param works; unknown universes still refuse; explicit symbols
still win).
<!-- /5956: non-index universe coverage in feed.pull -->


### 1.3 The one-engine doctrine

The governing rule is the one-engine consolidation doctrine (#3549):
the stage contract plus the stage runner executes every workflow
family. A second engine, a second stage vocabulary, or a second stage
store is drift, even when it works. The doctrine is recorded in
[The Job System & 5-Stage Pipeline Engine Architecture](./job-system.md)
§1.1 (the one-engine doctrine, the uniform job contract §3, execution
modes and refusals §7, architectural guarantees §8) and in ADR 0027
([One stage-runner contract for every screen invocation mode](../adr/0027-one-stage-runner-contract.md)),
which is the stage-runner contract decision this engine implements.
How the engine, doors, workflows, jobs, stages, stores, and UI fit
together in one dispatch is drawn in
[Jobs, workflows, pipelines, stages — dispatch modes](../../operations/jobs-workflow-pipelines-stages-dispatch-modes.md)
("Relationships — engine, doors, workflows, jobs, stages, stores, UI").

## 2. Jobs-as-data

A job is defined by a value, not by code. `JobNodeConfig`
(`src/data/jobPipelinePorts.ts:137`) is the recursive node — job /
sub-job / stage / sub-stage — and the comment on it states the rule
directly: "Every field is configuration data — a job is defined by a
value of this shape alone, with no job code." The fields are `kind`,
`steps`, `children`, `inputs`, `processing`, `outputs`,
`executionMode`, `schedule`, and `retired`.

A stored definition (`JobDefinition`, `src/data/jobPipelinePorts.ts:169`)
carries the recursive root, the raw configuration exactly as supplied
(`rawConfig`, which patches merge into), the resolved form
(`ResolvedJobConfig`), a `version`, and an `updatedAt`. `defineJob`
(`src/services/jobPipelineEngine.ts:741`) is an upsert: it resolves the
supplied configuration, stores it, and bumps `version` by one on every
re-definition. A re-definition therefore never silently overwrites
history — it is a new version — but note the honest limit in §4:
resuming a job re-reads the *current* definition; the engine does not
pin the version a run started under (#5278).

### 2.1 The spec form: `JobDefinitionSpec`

The hand-declared catalog form of a job is `JobDefinitionSpec`
(`src/config/jobDefinitionCatalog.ts:73`). A spec declares an id, a
name, stages (a chain of `kind` + `step` nodes), parameters
(`JobDefinitionParameter[]`), an execution mode, and schedule defaults.
It is data: the catalog is validated on load and addressable by id +
version (`src/config/jobDefinitionCatalog.ts:6-7`).

Exactly **one** spec exists today: `screener`
(`src/config/jobDefinitionCatalog.ts:103`), "the six-stage stock screen:
feed → enrich → analyze → store → serve → deliver", with two parameters
(`universe`, a required select, and `deliver`, a boolean defaulting to
`false`) and an execution mode of sequential +
batch + async + monolith. Every other family predates the spec
mechanism and hand-builds its definition in code; the catalog refuses
spec-less families by name (opt-in), and only the screener opted in.
The spec mechanism is new (November 2026: #4466, #4773, #4774) — the
scarcity of specs is age, not a design limit. Per-family spec adoption
for the remaining families is filed as #5563–#5568; their blocker, the
generic binder, has landed (#5496 — see §2.2), so the slices are
unblocked on that dependency and their builds are owner-sequenced.

### 2.2 Parameters and the one generic binder

Parameters travel from spec to run in two steps:

1. **Validation + generic binding** — `bindJobDefinitionParams`
   (`src/services/jobDefinitionParamBinders.ts:89`) validates the
   supplied parameters against the spec's declarations (unknown names
   refuse by name; a required parameter that is absent refuses) and
   then binds them *generically* from the declarations alone: type,
   enum source, default (literal or `{ setting }` reference),
   required-ness, and named derivations. The enum sources and
   derivations live in a small registry,
   `src/config/jobDefinitionParamRegistry.ts` (`ENUM_SOURCES` at `:24`,
   `PARAM_DERIVATIONS` at `:28` — today one of each: `universes`,
   `shardsForUniverse`). There is no per-family binder code any more:
   the `BINDERS` record is deprecated and empty
   (`src/services/jobDefinitionParamBinders.ts:28-31`, #5496), and a new
   family is added as data — a spec declaration — not as code. The
   screener declares `universe` (`enumSource: "universes"`,
   `derivation: "shardsForUniverse"`) and `deliver` (`default: false`).
   The binder throws rather than returning a partially bound set.
2. **Build** — `buildJobConfigFromSpec`
   (`src/services/jobDefinitionSpecBuilder.ts:73`) turns the spec +
   bound parameters into a `RawJobConfig`. Its `withParams` (`:29`)
   spreads the run parameters into *every* step's params, recursively
   through children — a parameter is therefore visible to every step,
   not only to the stage that names it. The spec's execution mode
   becomes the root node's mode (#4773), sitting under any mode a
   stage-level override already carries.

The only production caller of `buildJobConfigFromSpec` is the
scheduled agent (`src/agents/scheduled-agent.ts:1405`, reached through
`:1323-1332`). Per-stage overrides reach the builder through
`bindStageOverrides` (`src/services/jobDefinitionParamBinders.ts:150`,
called at `src/agents/scheduled-agent.ts:1399`). Spec generation from
UX or chat does not exist yet — see §5.

### 2.3 Run inputs: what `runJob` takes

`runJob(jobId, opts)` (`src/services/jobPipelineEngine.ts:797`) takes
**no per-run data inputs**. Its options are dispatch metadata only:
`trigger`, `scopePath`, `scheduleId`, `asyncJobId`,
`workflowInstanceId`. Step data arrives by define-time binding (§2.2)
or from the definition's declared inputs. Run values that must vary
per run are therefore bound at define time, not passed at run time —
which is exactly the gap the journaled run-inputs issue (#5497, G10)
exists to close: define-time defaults plus per-run overrides, with the
effective inputs journaled before execution.

The run's declared inputs are `JobInputsConfig`
(`src/data/jobPipelinePorts.ts:102`): `sources` (named sources to
read), `datasets` (named persisted datasets), `items` (inline input
items — the batch/online stream the steps process). Consumption today
is uneven and the doc states it plainly: `sources` and `datasets`
have zero consumers in `src/`; `items` has exactly one
(`src/services/jobPipelineEngine.ts:2839`). Every family builder
declares single-element inputs today. Declaring the run's full consumed
source set in `inputs.sources` is filed as #5495 (G8).

### 2.4 Per-node overrides

Execution mode is set at the definition root and may be overridden per
node: `JobNodeConfig.executionMode`
(`src/data/jobPipelinePorts.ts:155`) is a partial mode merged over the
job's resolved mode. The same override is settable from outside the
definition: the HTTP route `src/agents/routes/jobDefinitions.ts:148`
accepts `stageModes` in the body, and the mesh door returns the
resolved mode with `appliedTo: "next-run"`
(`src/agents/orchestrator/meshDoors.ts:1365`). What does *not* exist is
per-node *substrate* selection (which journal a stage runs on) — the
journal substrate is chosen by host composition, not declared in the
spec and not selected by the engine. That gap is #5282, and the
journal-as-spec question is routed to #3220 / #4808.

## 3. Concepts and how each is implemented

### 3.1 Job definition / instance / run

Three records, three lifecycles:

- **Definition** — `JobDefinition` (§2), versioned, upserted by
  `defineJob` (`src/services/jobPipelineEngine.ts:741`). Reconfiguring
  merges a patch into `rawConfig` and re-resolves; it applies to the
  next run or resume.
- **Instance** — the live management state of a job (one per job id),
  holding state (`queued` / `running` / `paused` / settled), the
  current run id, checkpoints, and the last error. `runJob` refuses a
  new run while the instance is queued, running, or paused, throwing
  `job_already_running` (`src/services/jobPipelineEngine.ts:797-813`).
  `runJob` on a settled instance starts a fresh engine run.
- **Run** — one execution of a definition, identified by a run id
  minted at dispatch (`newRunId`, `src/services/jobPipelineEngine.ts:823`)
  and recorded in the run record (§3.10). A run's terminal state is
  written exactly once by `recordTerminal` (`:2050`). One run is one
  execution tree with one id convention — see
  [Execution model: one tree, one id convention](../application/execution-model.md),
  which works the convention through a full stock-screen example (§6)
  and records the open rulings (§7).

### 3.2 Stage / step / unit

A **stage** is a node in the job tree (`JobNodeConfig.kind`, a free
string — `"feed"`, `"enrich"`, `"analyze"`, `"generate"`,
`"deliver"`, or any host kind). A **step** is one configured invocation
inside a stage: a name into the platform step library plus data
(`JobStepConfig`, `src/data/jobPipelinePorts.ts:127`). A **unit** is one
item of work within a step — one shard, one symbol batch. The runner
executes units; checkpoints are per (stage, unit)
(`src/workflows/stageRunnerPorts.ts:271-286`); the stage runner plan is
`StageRunnerPlan` (`:209`), compiled per job and run through the
runner plan functions with the run checkpoint as a
`StageRunnerCheckpoint`.

Three stage vocabularies exist and are not interchangeable:
`RegistryStage` (the registry's families), the runner's `StageName`,
and `PipelineChainStageKind` (chains). The vocabulary mapping lives in
`src/services/jobPipelineEngine.ts:519-629`
(`vocabularyStageForNodeKind`, `optionsVocabularyStageForNodeKind`,
`strategyVocabularyStageForNodeKind`, `projectStageViews`). The
research/OODA pipeline is six stages — feed, enrich, analyze,
generate, deliver, evaluate
(`src/workflows/stageRuntimeIds.ts:148-155`); the options screener is
eight execution stages partitioned under four display stages
(`:160-168`); the stock screener spec is six stages (§1.2). The five
generic families are not a five-stage cap — a job composes steps from
the registry.

### 3.3 Chain

A chain is a declarative composition of stages, defined once and run
many times. Chains are data: the engine executes them through the same
`defineJob` / `runJob` path as any job, via the host doors
`runPipelineChain` (run now, a chain) and `runPipelineJob` (run now,
one job) — see
`docs/operations/jobs-workflow-pipelines-stages-dispatch-modes.md`
§"The nine named components". MCP-defined chains are defined through
`define_pipeline_chain`; the wire-not-retire decision for them is on
#5288 (landed via the CFO lane), and the definition half for five
families is filed as #5257–#5261 (mode-only declarations, lane
clo-arsi, parent #4773).

### 3.4 Node kinds

`JobNodeConfig.kind` is a free string
(`src/data/jobPipelinePorts.ts:138`). The generic kinds are the five
families (§1.2); hosts add their own (`"store"`, `"serve"` in the
screener spec; options-chain and research kinds in their families).
The engine resolves a node's execution mode from its kind and its
overrides, and resolves its display stage from its kind
(`vocabularyStageForNodeKind`, `src/services/jobPipelineEngine.ts:519`).
A kind that no vocabulary knows is not refused — it simply has no
display stage.

### 3.5 Execution modes

`JobExecutionMode` (`src/data/jobPipelinePorts.ts:68`) has four axes:

| Axis | Values | Default |
|---|---|---|
| `concurrency` | `sequential` / `parallel` | `sequential` |
| `pacing` | `batch` / `online` | `batch` |
| `delivery` | `sync` / `async` | `async` |
| `shape` | `monolith` / `sharded` | `monolith` |

The default is sequential + batch + async + monolith
(`DEFAULT_JOB_EXECUTION_MODE`, `src/data/jobPipelinePorts.ts:76`). The
mode is set at the definition root and overridable per node (§2.4).
One guard exists: `assertExecutionModeSupported`
(`src/services/jobPipelineConfig.ts:132-141`) refuses **online + sync**
only — "a synchronous dispatch cannot await the terminal state of an
online (streaming) run". "Online" means streaming item-by-item, not
"user online"; a UX request is a bounded run (pacing batch) with
delivery sync, which is allowed. The guard is enforced at the door
(`src/agents/orchestrator/meshScreenDoor.ts:487`), at the scheduled
agent (`src/agents/scheduled-agent.ts:1348`), at catalog load
(`src/config/jobDefinitionCatalog.ts:179`), and at dispatch
(`src/services/jobPipelineEngine.ts:814`). The full mode matrix,
including refusal behavior, is in
`docs/architecture/agentic/job-system.md` §7.

### 3.6 Processing config and shards

`JobProcessingConfig` (`src/data/jobPipelinePorts.ts:112`) carries
`inMemory` (in-memory hand-offs instead of persisted artifacts;
**default OFF**), `checkpointEverySteps` (persist a checkpoint after
every N steps; default 1), and `shards` (shard keys for the sharded
shape). Sharding is a run property, not a method: the engine branches
on `mode.shape === "sharded"` (`src/services/jobPipelineEngine.ts:2778,
2866`); a sharded shape with no shard keys refuses by name
(`:2781`). The screener seam auto-shards when more than one shard id
is present (`src/services/screenerPipelineJobs.ts:444`); the
options-chain family declares sharded when symbols > 1. The old
`runSharded` method has zero live callers and is dead code, not a
sharding mechanism. The one behavior difference from the old method:
quota is charged once per shard now, where `runSharded` charged once
per universe — making that granularity configurable is #5747.

### 3.7 Journal modes

The journal substrate is chosen by **host composition**, not declared
in the spec and not selected by the engine. There is no `journalMode`
identifier in code. The three substrates, named by the invocation type
`StageRunnerInvocation`
(`src/workflows/stageRunnerPorts.ts:194`), are:

- **sync** — direct stores, inline in the calling request;
- **workflow-shard** — durable steps via a Cloudflare Workflow binding
  (`src/workflows/jobPipelineWorkflow.ts`); the workflow residency;
- **async-alarm** — async jobs via Durable Object alarms — which has
  **no production caller** today.

The workflow residency is the durable path: the workflow host defines
the per-run job in D1, creates the `JobPipelineWorkflow` instance, and
polls the durable read-back (`src/workflows/optionsWorkflowHost.ts`).
Journal-as-spec — declaring the substrate in the definition — does not
exist; see §2.4.

### 3.8 Checkpoints

The runner checkpoints per (stage, unit) into the stage ledger
(`StageRunnerCheckpoint`, `src/workflows/stageRunnerPorts.ts:271`).
The checkpoint is written before the stage action is published
(persist → checkpoint → publish, the stage contract's order —
[ADR 0027](../adr/0027-one-stage-runner-contract.md);
`src/services/jobPipelineEngine.ts:3019-3023`). A retry keeps the
unit's original start stamp so the window stays wall-clock time
(#4359, `:3011-3014`). `checkpointEverySteps` (default 1) controls
how often checkpoints persist (§3.6). Resuming re-reads the current
definition (§2) — the checkpoint pins the *progress*, not the
definition version (#5278).

### 3.9 Retry aspect and replay

Retry is an engine-internal aspect in `executeUnit`
(`src/services/jobPipelineEngine.ts:3002-3150`): a failed unit retries
within its budget with backoff (`computeBackoffDelayMs(budget, tries)`,
`:3125`), and a forced re-run restarts at step 0 (#4895). Retry
budgets are externalized in `pipelinePolicy.ts`
(`resolvePipelinePolicy`, `src/services/pipelinePolicy.ts:164`), but
the engine calls the policy resolver with no env or settings and hosts
never pass a policy — operator control of retry budgets is filed as
#5490 (G3). The backoff calls the shared resilience executor
(`src/services/resilience.ts:37`) without an injected RNG, so it uses
`Math.random` — a determinism gap filed as #5280.

**Replay** is `replayJob` (`src/services/jobPipelineEngine.ts:914`):
it replays a run on the same instance identity, proven via
`runWorkflowInstanceId` (#4454). Replay is not a re-run from scratch
and not a resume — it re-executes the recorded run. There is no
approval/wait aspect in the engine or the stage contract; approvals
are a door/host concern, and their absence from the engine is evidence
for #5279.

### 3.10 Pause / resume / cancel / rerun

The control plane, all on `JobPipelineControl`:

| Operation | Method | Behavior |
|---|---|---|
| Pause | `pauseJob` (`:839`) | Honored at the next step boundary; the run checkpoints and settles as paused, its in-flight unit recorded stopped, never failed. |
| Resume | `resumeJob` (`:857`) | Re-reads the current definition (§2); refuses a run with no checkpoint ("paused without a checkpoint; retry it instead", `:869`). |
| Cancel | `cancelJob` (`:961`) | Settles the run cancelled via `recordTerminal`. |
| Retry | `retryJob` (`:1011`) | Restarts the run's failed units within budget. |
| Rerun stage | `rerunStage` (`:1318`), `rerunStageByVocabulary` (`:1814`) | Re-executes one stage (by node path or by vocabulary stage). |
| Resume stage | `resumeStage` (`:1445`), `resumeStageByVocabulary` (`:1828`) | Resumes one paused stage. |
| Cancel stage | `cancelStage` (`:1488`), `cancelStageByVocabulary` (`:1833`) | Cancels one stage; downstream never proceeds. |

Stage retirement is persisted on the definition (`retired`, #3944,
`src/data/jobPipelinePorts.ts:159-167`): a retired stage never
executes again in any run of the job; a new dispatch of a job carrying
a retired stage refuses by name, and a live run reaching the stage
settles cancelled with the stage named.

No HTTP route calls this control plane. Chat reaches it through the
options/strategy door and the NLQ action; MCP through the same door;
UX is view-only (no stage-control buttons) — see §4.

### 3.11 Aspects

Aspects are cross-cutting behaviors the engine applies around unit
execution. Implemented: **retry** (§3.9) and the **observability**
hooks (§4, OTel observers + the run-settled observer). The engine's
policy dependency defaults to `resolvePipelinePolicy()` with no
env/settings; hosts never pass it. There is no approval/wait aspect,
no circuit breaker on step invocation (the survey recommended no
filing for a breaker), and no per-stage journal-substrate aspect
(§2.4, #5282).

### 3.12 CloudEvents

Engine events travel under a CloudEvents v1.0 envelope, validated by
`assertMessageEnvelope` (`src/messaging/cfQueueMessagingAdapter.ts:107,
117, 141`). The envelope supports `correlationid` / `traceparent`
extensions that engine events never set — one trace per run is filed
as #5488 (G1). The stage contract's publish order is persist →
checkpoint → publish (§3.8); observer failure can never fail, retry,
or duplicate the run (`src/services/jobPipelineEngine.ts:235-237`).

### 3.13 Provenance stamps

`JobRunRecord` (`src/data/jobRunRecordPorts.ts:141`) carries the #3655
provenance fields — `brokerId`, `dataProviderId`, `mode`,
`modeSource` (pin / selection / inference) — stamped from the firing
schedule payload at record creation. The D1-backed rows do not carry
these fields yet (no migration adds the columns there); the DO-SQLite
ledger is the surface that stores them. The engine itself never stamps
them: there are zero `provenance` references and zero `audit`
references in `src/services/jobPipelineEngine.ts`. Provenance is a
writer concern (schedules, doors, hosts), and the engine stamping them
is filed as #5491 (G4).

### 3.14 Run records

The terminal record is written by `recordTerminal`
(`src/services/jobPipelineEngine.ts:2050-2101`): job id, operation,
timestamps, outcome, trigger, schedule id, async-job id, workflow
instance id, descriptor, artifact references, and the provenance
fields (§3.13). The run-record store surface is `JobRunRecordStore`
(`src/data/jobRunRecordPorts.ts:182`); the ScheduledAgent host wires a
SQL-backed recorder (`jobRunRecorderFromStore`,
`src/services/jobPipelineEngine.ts:194`). The terminal descriptor is
produced by steps but consumed nowhere in the engine — surfacing step
descriptors in the terminal record is filed as #5585. The run ledger's
read surface is Workflow Runs (§4).

### 3.15 Stores

Stores are port/adapter pairs under `src/data/`, one implementation
per residency:

- **DO SQLite** — `src/data/doSqliteJobPipelineAdapter.ts`
  (authoritative per the platform's data-foundation rule: the
  Durable Object is authoritative, D1 is a read projection);
- **D1** — `src/data/d1JobPipelineAdapter.ts` (read projection);
- **In-memory** — `src/data/inMemoryJobPipelineAdapter.ts:107`
  (`InMemoryJobPipelineStores`), plus
  `src/workflows/inMemoryWorkflowAdapter.ts` for the workflow port.

The in-memory adapter exists for tests and for the workflow port's
test execution. Its header rule is "NEVER a silent production
fallback", and no production composition root builds it. Making it an
option for any stage is filed as #5282. New persistence in engine work
extends the ORM data foundation (Drizzle, versioned migrations);
a hand-rolled raw-SQL adapter track beside it is drift.

### 3.16 Hosts

| Host | Wiring | File |
|---|---|---|
| ScheduledAgent | The only host wiring the OTel observers (§4); builds the control with stores, the SQL run recorder, the chained run-settled observers, and the OTel step journal. | `src/agents/scheduledTasksPipeline.ts:511` (`createScheduledAgentPipelineControl`), observers at `:563-580` |
| Workflow (options / strategy / goal / comparison) | Defines the per-run job in D1 (workflow residency), creates the `JobPipelineWorkflow` instance, polls the durable read-back. Since #5270 the start is idempotent per run id (`attachToInFlightRun` + managed create). Passes `publisher: null` (three sites). | `src/workflows/optionsWorkflowHost.ts` |
| Research / MCP command | Defines and runs research and MCP chains over the same control. | `src/services/researchJobCommands.ts` |
| In-memory (test) | The in-memory adapter as the composition root for test execution. | `src/workflows/inMemoryWorkflowAdapter.ts` |

A host is the composition root; the engine is the execution core
(§1.1). A new residency is a new host, not a new engine.

### 3.17 Doors

Doors validate and route requests into the engine. The screener door
(`src/agents/orchestrator/meshScreenDoor.ts:483-498`) resolves the
requested execution mode, asserts it is supported, and falls back to
the screener default; the mesh door returns the resolved mode with
`appliedTo: "next-run"` (`src/agents/orchestrator/meshDoors.ts:1365`).
The options/strategy door carries broker + mode + account into the
options and strategy hosts. Doors never execute jobs and never hold
engine state. Chat control of a goal leg over D1 stores is #4859
(landed); the NLQ action routes through the same door.

## 4. The -ilities as product characteristics

Each -ility is stated with its current state: **built** (in code at
the tip), **partial** (built with a named gap), or **filed**
(issue open, not built). A filed -ility is not presented as built
anywhere in this doc.

| -ility | State | Gap issue |
|---|---|---|
| Durability | Partial | #5278 (no version pin on resume), #5586 (exactly-once edge) |
| Reliability | Partial | #5586; no engine alone gives exactly-once |
| Resilience | Partial | #4775 (stage vs run deadline), #3533 (fan-out cap, retry buckets) |
| Determinism | Filed | #5280 |
| Observability | Partial | #5488 (G1), #5489 (G2), #5492 (G5) |
| Configurability | Partial | #5490 (G3), #4775, #3533 remainder |
| Operability / dashboarding | Partial | #3202, #5027, #4808, #4766 (control surfaces) |
| Portability | Filed | #5277, #5281 |
| Scalability | Partial | #3533 (fan-out cap) |
| Testability | Built | — |
| Security | Partial | #5492 (G5, audit-ledger coverage) |
| Extensibility | Built | — |

### 4.1 Durability — partial

Built: the journal (three substrates, §3.7), per-(stage, unit)
checkpoints (§3.8), the versioned definition store (§2), the run
record (§3.14), and replay on the same instance identity (§3.9). A
run that never dispatches still settles through `recordTerminal`
(`src/services/jobPipelineEngine.ts:295`). Gaps: resume re-reads the
current definition instead of pinning the version the run started
under (#5278); the exactly-once edge in §4.2 (#5586); the async-alarm
journal substrate has no production caller, so only two of the three
substrates are live.

### 4.2 Reliability — partial

Built: fail-closed behavior throughout. Refusals name the reason:
`job_already_running`, online+sync unsupported, sharded without shard
keys, retired stage, unknown universe, unknown parameter, unknown
step. A charge that lands stands even if the start then fails (quota);
a refusal throws before any start. The delivery-claims door (#4438)
makes duplicate delivery suppression durable instead of in-memory.
**Not built: exactly-once side effects.** No engine alone gives
exactly-once — idempotent activities and idempotency keys are
required (IROS doc Q4, §6). The known edge is #5586: if a claim RPC
lands but its response is lost, the retry suppresses a pair that was
never sent (claim durable, send never happened). The door is
fail-closed and the DO RPC within one Worker makes the edge rare, but
it is an edge, not a guarantee.

### 4.3 Resilience — partial

Built: the retry aspect with per-unit budgets and backoff (§3.9), the
stage ledger's stopped-never-failed pause semantics (§3.10), and the
persist → checkpoint → publish order (§3.8). Not built: a circuit
breaker on step invocation — the survey recommended no filing for
one, so its absence is a recorded decision, not an oversight. The
stage per-unit deadline (600s) and the run execution deadline (240s)
are hardcoded and unreconciled (#4775); the fan-out cap and the
retry-bucket table are hardcoded (#3533 survey). An approval/wait
aspect does not exist in the engine (§3.9).

### 4.4 Determinism — filed (#5280)

The engine is not deterministic today. Backoff uses `Math.random`
because the engine calls the resilience executor without an injected
RNG (`src/services/jobPipelineEngine.ts:3125`,
`src/services/resilience.ts:37`); event ids use `randomUUID`. The
determinism seams exist — `now`, `newRunId`, and `sleep` are
injectable on the control's dependencies
(`src/services/jobPipelineEngine.ts:245-254`) — but only the
ScheduledAgent host injects them. Enforcement of determinism is filed
as #5280 and deferred to a future phase.

### 4.5 Observability — partial

The OTel observers exist: S1 logging, S2 metrics, S3 traces
(`src/observability/otelJobPipeline.ts`,
`otelJobPipelineMetrics.ts`, `otelJobPipelineTraces.ts`, plus the
run-settled observer and the step journal in `otelProvider.ts`). But
they are wired on **one host only** — the ScheduledAgent host
(`src/agents/scheduledTasksPipeline.ts:563-580`). The workflow,
options, research, and MCP hosts pass no observers, and several pass
`publisher: null` (`src/workflows/optionsWorkflowHost.ts:327, 485,
692`). Wiring observability on every host is #5489 (G2). The engine
itself emits **zero log lines** (no `console` / `structuredLog` call
in `src/services/jobPipelineEngine.ts`); what is observable about a
run comes from the observers, the journal, and the run record — or it
does not exist. One trace per run (setting `correlationid` /
`traceparent` on engine events) is #5488 (G1). The structured audit
sink `mas_events` and the mesh trace spine are documented in
`docs/OBSERVABILITY.md`; the engine has zero audit-ledger references
— audit-ledger coverage for control-plane actions is #5492 (G5).

### 4.6 Configurability — partial

Built: execution modes are externalized per job and per node (§2.4,
§3.5); retry budgets are externalized in `pipelinePolicy.ts`
(`src/services/pipelinePolicy.ts:164`); feed timeouts are
externalized; schedules are declared per node
(`JobScheduleConfig`, `src/data/jobPipelinePorts.ts:83`). Not built:
`resolvePipelinePolicy` is called with no env or settings and hosts
never pass a policy, so operator control of retry budgets does not
reach a run — #5490 (G3). The full inventory of what is externalized
versus hardcoded is
`docs/architecture/survey/pipeline-variables-externalization-survey.md`;
hardcoded today: the stage timeout, the fan-out cap, and the
retry-bucket table (§4.3). The job-system doc's rule "zero code
constants" (`docs/architecture/agentic/job-system.md` §3) is the
doctrine; the survey is the actual state. Defaults resolve at run
start and are journaled only once #5497 (G10) lands; until then a
run's effective inputs are not journaled.

### 4.7 Operability, dashboarding, visualization — partial

Built: the Workflow Runs read surface — the run ledger and its read
surface, documented in `docs/agents/workflow-runs.md` (what a run is,
what the tab shows, trigger classification, honesty rules, the read
surface, the code map, known limits). The stage tree is projected by
`projectStageViews` (`src/services/jobPipelineEngine.ts:629`) and
read back by `readStagesFromPipelineStores` (`:702`); the client panel
is `src/client/WorkflowRunsPanel.tsx`. Not built: the surface is
**read-only**. There are no stage-control buttons in UX, no chat
authoring of execution modes, and no HTTP route that calls the control
plane. The control surfaces are filed as #3202 (UX), #5027 (chat),
#4808 (screener execution tree), #4766 (record resolved exec mode
per stage), under the #2859 execution-modes epic and the #3214 chat
umbrella. Until they land, control is door/chat/MCP only (§3.17).

### 4.8 Portability — filed (#5277, #5281)

The engine is Workers-coupled: Durable Objects, D1, Workflows,
Queues, Cron, R2. No Dockerfile, compose file, or miniflare config
exists in the repo. The portability gaps are: (a) dockerized dev/CI
via workerd — buildable now; (b) workerd + celld self-hosting
distribution (#5281, under #5277); (c) Workers AI / Browser / Email
bindings, which have no open equivalent. There is no from-scratch
portability layer to build — the gaps are the distribution and the
unmatched bindings. Portability is deferred to a future phase.

### 4.9 Scalability — partial

Built: sharding by shape + shard keys (§3.6), with the engine
branching on `mode.shape === "sharded"` and refusing a sharded shape
without keys. The scheduled sharded chain dispatches through the
engine seam, and the options-chain family declares sharded when
symbols > 1. Limits: the fan-out cap is hardcoded (#3533); the
workflow-shard journal is bounded by the hosted Workflows service's
limits (25,000 steps per instance, 1 GB persisted state on Paid, per
the Workflows changelog) — a ceiling the sync and async-alarm
substrates do not share, which is one more reason the journal
substrate is a host decision, not a spec field.

### 4.10 Testability — built

The in-memory adapter (`src/data/inMemoryJobPipelineAdapter.ts:107`)
gives every host a test composition root with no production fallback
(§3.15). The stage runner's plan/checkpoint seams
(`StageRunnerPlan` / `StageRunnerCheckpoint`,
`src/workflows/stageRunnerPorts.ts:209, 271`) let a test compile a
plan and run it against a checkpoint without the engine. The
governance battery (TDD red→green per gitops §7, the pin suites, the
neutrality census) runs against these seams. Nothing about
testability is filed-but-unbuilt.

### 4.11 Security — partial

Built: refusals by name instead of silent failure (§4.2); fail-closed
gates (the broker gate, the delivery-claims door, quota refusal
before start); the IAAA audit ledger exists with writers in the
orchestrator and routes. Not built: the engine writes **no** audit
rows itself — audit-ledger coverage for engine control-plane actions
is #5492 (G5) — and the engine never stamps provenance (§3.13, #5491
G4). The engine's security posture is therefore: it refuses loudly
and fails closed, but it does not record its own control-plane
actions; the record lives with the callers.

### 4.12 Extensibility — built

A new step family is a registration, not an engine change: write the
step handler, add a `register*Step(registry, deps)` function, and pass
the deps into `createPipelineStepRegistry`
(`src/services/enrichPipelineJobs.ts:422-460`) — the screener,
options, options-chain, and research families each landed exactly
this way (#4190, #4289, #4780, #5118). A new job family is a
definition (hand-built) or a spec (catalog opt-in, §2.1). A new host
is a composition root (§3.16). The extension points are the registry,
the catalog, and the host — never a second engine.

## 5. WorkflowSpec — planned, not built

`WorkflowSpec` is **planned** (Phase 6). It does not exist in code:
there are zero `WorkflowSpec` hits in `src/`. This section records
the planned state only; the build stays deferred under #4177, and
nothing in this doc authorizes starting it.

The design, as recorded in
`docs/architecture/agentic/doors-and-layers.md` (Phase 6, lines
416, 450, 520, 704, 720): a prompt step produces a WorkflowSpec —
never executable code. A deterministic compiler validates the spec
against the registry allowlist, and registration needs human approval
plus CISO review. As designed, a WorkflowSpec compiles *into*
registered job definitions (§2) — it does not replace them, and it
does not execute anything itself. The existing work items are #4181
("WorkflowSpec type + store rule + spec-to-run-input adapter", in the
#4177 set, deferred per owner 2026-11-12), #3442, and #2048
("[Program] Phase 6: Prompt-driven workflow generation").

Until the compiler lands, spec generation from UX or chat does not
exist (§2.2), and the catalog's one spec remains hand-declared. Any
claim that a WorkflowSpec runs today is wrong.

## 6. What it is not

- **Not a general-purpose durable-execution platform.** The engine
  comparisons are in the IROS doc's Q4
  (`docs/architecture/enterprise/agentic-IROS.md` §10–§11 and the
  FOSS table §9): Temporal is the FOSS equivalent (MIT) and the
  stronger engine in the abstract — maturity, determinism
  enforcement, exactly-once execution, UI/replay tooling,
  portability. DBOS is the better fit if Postgres lands (MIT; needs
  a long-lived app process plus Postgres, so it cannot run *with*
  the j-stack inside Workers). Inngest is SSPL; Restate is BSL;
  Step Functions is proprietary and AWS-only. The j-stack's claim is
  narrower and is the only one this doc makes: for a Workers-native
  platform that needs jobs as data under one control plane, building
  on the primitives already there beats importing a second engine.
- **Not LangGraph.** LangGraph is a graph framework (StateGraph
  nodes/edges plus a checkpointer for state snapshots), adopted in
  the IROS doc for **graph agents** — "pair with Temporal/DBOS for
  durability" (`docs/architecture/enterprise/agentic-IROS.md:538`).
  It is the agent layer, not the durability layer. Using it to build
  the job graph and integrating it with a Cloudflare Workflow was
  never evaluated; the fit questions are recorded in the #5272
  programme (job-as-data vs graph-as-code; two durability mechanisms
  to reconcile — Workflow steps vs the checkpointer, whose
  production forms need Postgres; the control plane is built on the
  journal + D1 records, not LangGraph threads; a third orchestration
  model alongside Think agents and Cloudflare Workflows).
- **Not a feed framework, not a retrieval framework.** LlamaIndex
  was never evaluated for feeds: it is a retrieval/RAG framework
  (load → chunk → embed → index → retrieve for LLM context), while
  the platform's feeds are deterministic market-data capture
  (per-source feed jobs → the #3941 capture-wired provider →
  immutable R2 capture blobs + provenance + replay + quota). The
  feed sources are provider SDKs/APIs behind the port. Retrieval
  over captured data is the Vectorize / AI Search leg, a different
  surface.
- **Not the whole target system.** The j-stack is the engine inside
  the autonomous financial intelligence system, not the system
  itself (§1). It does not research, trade, or pay — it executes the
  jobs that do, under doors, agents, and copilots.
- **Not a dashboard with controls.** Workflow Runs is a read ledger
  (§4.7). Control is door/chat/MCP only until the control surfaces
  land.

## 7. References

The existing docs this reference links (all verified to exist at the
build tip). This doc summarizes each in one paragraph at most and
points here for the authority.

**Core references — read these first.** The four docs that define the
engine, in the order to read them:

- [The Job System & 5-Stage Pipeline Engine Architecture](./job-system.md)
  — the one-engine doctrine (#3549), the 5 pipeline jobs, the Uniform
  Job Contract (§3), execution modes and refusals (§7), architectural
  guarantees (§8).
- [Jobs, workflows, pipelines, stages — dispatch modes](../../operations/jobs-workflow-pipelines-stages-dispatch-modes.md)
  — dispatch modes and the nine named components (`runJob`,
  `scheduledTasksPipeline`, `runPipelineJob`, `runPipelineChain`).
- [Execution model: one tree, one id convention](../application/execution-model.md)
  — one execution tree per run, one id convention, the worked
  stock-screen example (§6), open rulings (§7).
- [ADR 0027: One stage-runner contract for every screen invocation mode](../adr/0027-one-stage-runner-contract.md)
  — the stage-runner contract decision.

**Engine** (the four core docs above, plus)

- [ADR 0033: Cross-store consistency contract](../adr/0033-cross-store-consistency-contract.md)
  — the consistency contract the engine's stores and run records
  rely on.

**Operations surfaces**

- [Workflow Runs — the run ledger and its read surface](../../agents/workflow-runs.md)
  — the dashboard doc: what a run is, what the tab shows, trigger
  classification, honesty rules, the read surface, known limits.
- [Observability](../../OBSERVABILITY.md) — Workers logs, the
  `mas_events` structured audit sink, the mesh trace spine, retention
  honesty.

**Configurability and generation**

- [Pipeline variables externalization survey](../survey/pipeline-variables-externalization-survey.md)
  — the full inventory of what is externalized versus hardcoded;
  the authority for §4.6's actual state.
- [Doors and layers](./doors-and-layers.md) — Phase 6 and the
  WorkflowSpec design (§5); the door/layer model the engine sits
  behind.

**Strategy and technology**

- [Agentic IROS architecture](../enterprise/agentic-IROS.md) —
  §10 (line 583) is the technology *needs* for the j-stack, not
  current behavior; §9 is the FOSS technology table; Q4 is the
  engine comparison (§6).
- [Technology stack](../../technology/tech-stack.md) — the one
  record of what the platform is built on, including the LangGraph
  verdict (ADOPT for graph agents).

**Gap issues (the -ility gaps this doc references)**

Parent programme: [#5272](https://github.com/Qunsultant/cfagent/issues/5272).
Engine gaps G1–G10: [#5488](https://github.com/Qunsultant/cfagent/issues/5488)
(G1, run-context seam), [#5489](https://github.com/Qunsultant/cfagent/issues/5489)
(G2, observer wiring), [#5490](https://github.com/Qunsultant/cfagent/issues/5490)
(G3, policy resolution), [#5491](https://github.com/Qunsultant/cfagent/issues/5491)
(G4, run-record stamp), [#5492](https://github.com/Qunsultant/cfagent/issues/5492)
(G5, audit ledger), [#5493](https://github.com/Qunsultant/cfagent/issues/5493)
(G6, feed-family spec), [#5494](https://github.com/Qunsultant/cfagent/issues/5494)
(G7, capability-registry resolution), [#5495](https://github.com/Qunsultant/cfagent/issues/5495)
(G8, declare sources), [#5496](https://github.com/Qunsultant/cfagent/issues/5496)
(G9, generic binder), [#5497](https://github.com/Qunsultant/cfagent/issues/5497)
(G10, journaled inputs); G11:
[#5499](https://github.com/Qunsultant/cfagent/issues/5499) (universe
step). Related: [#5278](https://github.com/Qunsultant/cfagent/issues/5278)
(versioning), [#5279](https://github.com/Qunsultant/cfagent/issues/5279)
(signals + queries), [#5280](https://github.com/Qunsultant/cfagent/issues/5280)
(determinism), [#5282](https://github.com/Qunsultant/cfagent/issues/5282)
(in-memory option), [#4775](https://github.com/Qunsultant/cfagent/issues/4775)
(stage vs run deadline), [#5586](https://github.com/Qunsultant/cfagent/issues/5586)
(exactly-once edge), [#5563](https://github.com/Qunsultant/cfagent/issues/5563)
(per-family spec adoption), [#4177](https://github.com/Qunsultant/cfagent/issues/4177)
(WorkflowSpec programme, deferred).
