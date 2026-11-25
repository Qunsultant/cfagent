# J-stack hosts: inventory, residencies, dependencies, substrate selection

> Verified on origin/main tip `87a65a0e` (2026-11-21). Line numbers are from that tip; they drift as main moves — recount with `grep -rn "new JobPipelineControl(" src/`. This doc answers, in one place: how many hosts there are, what each one enables for the user, what a workflow / workflow-shard / sync / async / async-alarm is, where a control's dependencies are defined, and what selects a job's substrate. It does not change the engine, add a host, or fix the gaps it names.

## 0. The one-paragraph answer

One engine, eighteen hosts. The engine is `JobPipelineControl` (`src/services/jobPipelineEngine.ts:826`): the execution core that defines and runs jobs — nothing else executes a job. A host is any composition root that constructs a control with wired dependencies. There are eighteen such construction sites on current main, and they exist because five independent axes force the count: store residency, step subset, publisher on/off, invocation substrate, and observers/determinism seams. The engine is identical at every site; the proliferation is composition points, not engine forks. A job's residency — which journal substrate it runs on — is chosen by whichever host defines and runs it, never by the job's own definition; there are no declared substrate-selection criteria, and declaring the substrate in the spec is an open gap routed to #3220 / #4808.

## 1. What a host is — engine vs host vs residency

Three words, three different things. The platform's confusion between them is the most common source of wrong claims about the engine (see also the reference doc §1.1 and `execution-model.md` §1).

| Construct | What it is | Where it lives |
|---|---|---|
| **Engine** | The execution core: `JobPipelineControl` + the stage runner + the journal + the aspects (retry, observability hooks). Defines and runs jobs; nothing else executes a job. | `src/services/jobPipelineEngine.ts:826` |
| **Host** (sense 1 — this doc's default) | A composition root that wires a control's dependencies (stores, adapters, observers, publisher, policy) and calls define/run. A host is not the engine; it is how one residency reaches it. | `src/agents/scheduledTasksPipeline.ts:536` (ScheduledAgent host), `src/workflows/optionsWorkflowHost.ts` (options ThinkWorkflow host), `src/services/researchJobCommands.ts` (research/MCP command hosts) — and every other site in §2 |
| **ThinkWorkflow host** (sense 2 — "host" in `execution-model.md`) | A durable Cloudflare Workflow instance: the ThinkWorkflow host a run executes on, when durable. Inline runs have no ThinkWorkflow host. The five ThinkWorkflow host classes extend `PortThinkWorkflow` (`src/workflows/portThinkWorkflow.ts:34`); the bindings are declared in `wrangler.jsonc:41-53` (`TRADE_WORKFLOW`, `SCREENER_WORKFLOW`, `PAYMENT_WORKFLOW`, `SAGA_WORKFLOW`, `JOB_PIPELINE_WORKFLOW`, each with concurrency limit 1). | `src/workflows/jobPipelineWorkflow.ts:423` (`JobPipelineWorkflow`), `src/workflows/screenerWorkflow.ts:400` (`ScreenerScreenWorkflow`), and the other three host classes |
| **Residency** | The journal substrate a host wires — one of `sync`, `workflow-shard`, `async-alarm` (`StageRunnerInvocation`, `src/workflows/stageRunnerPorts.ts:198`). The same job definition can run in any residency; the residency is the host's choice, not the job's. | Chosen per control; see §5 |

**Vocabulary rule (from `execution-model.md:37`): never say "workflow" bare.** Always "ThinkWorkflow host", "job", or "family" — except in code identifiers (`JobPipelineWorkflow`, `jobPipelineWorkflowFlow.ts`, `optionsWorkflowHost.ts`) and the product name "Cloudflare Workflow(s)". This doc follows that rule: "host" below means sense 1 (composition root) unless it says "ThinkWorkflow host". A "workflow residency" below always means the workflow-shard residency — the ThinkWorkflow-host side — never a bare workflow.

**Reconciling the two senses.** Sense 1 and sense 2 describe the same runs from opposite ends. A sense-1 host is the code that builds a control; a sense-2 ThinkWorkflow host is the durable instance a control's run executes inside, when the run is durable. The ScheduledAgent host (sense 1, site 1) runs jobs inline (`sync`) with no ThinkWorkflow host; the same host's mirror control (sense 1, site 2) defines the job into D1 and creates a `JobPipelineWorkflow` ThinkWorkflow host instance (sense 2) for the durable run. An inline run has a sense-1 host and no sense-2 host; a durable run has both.

## 2. The inventory — all eighteen sites

Every `new JobPipelineControl(` construction site in `src/` on the verified tip, plus the factory. "Executes?" means the control executes steps: read-only and define-only controls never execute a step.

| # | Site (`new` line) | Builder | Invocation | Executes? | User-facing capability |
|---|---|---|---|---|---|
| 1 | `src/agents/scheduledTasksPipeline.ts:594` | `createScheduledAgentPipelineControl` (`:536`) | `sync` (`:642`) | Yes — full | Scheduled + manual feed/screen/chain runs, the full control plane (pause/resume/cancel/retry/replay), execution-mode setting, spec-based definition, and the feed/enrich/analyze/generate surface statuses the UX panels read |
| 2 | `src/agents/scheduledTasksPipeline.ts:906` | `startPipelineJobWorkflow` (`:866`) | `workflow-shard` (`:938`) | No — define-only | Mirrors a definition into the workflow residency (re-defines when `rawConfig` differs), then creates the `JobPipelineWorkflow` ThinkWorkflow host instance |
| 3 | `src/mcps/openaimp/researchJobCommands.ts:183` | `DefinePipelineChainCommand.execute` | `sync` | Yes — research only | MCP/chat defines a declarative research chain (`research-custom-chain`) over the `jobs` family stages; requires the chat turn's acting identity |
| 4 | `src/services/jobPipelineEngine.ts:3789` | `createJobPipelineControl` (factory) | (caller) | — | Test seam only; no production callers |
| 5 | `src/services/stageInMemoryExecution.ts:51` | `runStageInMemory` (#5282) | `sync` | Yes — in-memory | Explicit opt-in in-memory stage execution with named ephemeral guarantees, never a silent production fallback; no static production caller (see note) |
| 6 | `src/workflows/inMemoryWorkflowAdapter.ts:150` | `InMemoryWorkflowAdapter` constructor | default (`sync`) | Yes — in-memory | Test-only fake `WorkflowPort` for screener/goal screens (canned results mapped onto stage outputs); no static production caller (see note) |
| 7 | `src/workflows/jobPipelineWorkflowFlow.ts:70` | `runJobPipelineWorkflowFlow` | from deps (`workflow-shard`) | Yes — full | The workflow residency's execution of any pipeline job — "a workflow run is one dispatch surface, not a second engine" |
| 8 | `src/workflows/optionsScreenEngine.ts:1038` | `dispatchScreenViaEngine` | `sync` | Yes — options only | Options-screen and strategy-screen dispatch from routes, NLQ, and goal-driven screens; runs synchronously in the calling request |
| 9 | `src/workflows/optionsScreenEngine.ts:1219` | `runComparisonViaEngine` (#4276) | `sync` | Yes — comparison only | One three-way comparison through the engine; the engine record is observability (visible as its own job in Workflow Runs) |
| 10 | `src/workflows/optionsStageControl.ts:378` | stage-control resolver (reader) | `sync` | No — read-only | Resolves which job a run defined (options vs strategy), across residencies; the read half of per-stage control |
| 11 | `src/workflows/optionsStageControl.ts:538` | stage-control flow (execution) | `sync` | Yes — one stage | Per-stage run / rerun / stop / resume / cancel on an options/strategy screen run |
| 12 | `src/workflows/optionsWorkflowHost.ts:324` | `startOptionsScreenWorkflow` (define) | `workflow-shard` | No — define-only | Defines an options / strategy / comparison job in D1, attaches to an in-flight run instead of re-defining, then creates the ThinkWorkflow host instance |
| 13 | `src/workflows/optionsWorkflowHost.ts:483` | `startOptionsChainWorkflow` (define, #4780) | `workflow-shard` | No — define-only | The options sharded chain's start seam: validates the chain before defining anything, defines the chain job in D1, creates the instance |
| 14 | `src/workflows/optionsWorkflowHost.ts:691` | `readOptionsWorkflowRun` (read) | `workflow-shard` | No — read-only | Reads a hosted options run back: instance state, one summary per addressable stage, and the `shapeReport` artifact |
| 15 | `src/workflows/researchScreenEngine.ts:251` | `dispatchResearchEngineRun` | `sync` | Yes — research only | Research/OODA runs (the six-stage research pipeline) from the mesh research door, research routes, and MCP |
| 16 | `src/workflows/researchScreenEngine.ts:402` | `readResearchStages` (#5917, read) | `sync` | No — read-only | The six stages of one research run, in pipeline order, for the research page's stage list; an unknown run answers six "pending" |
| 17 | `src/workflows/researchScreenEngine.ts:507` | `executeResearchStageControl` | `sync` | Yes — one stage | Per-stage control on a research run (run / rerun / resume / status); defines the job first when no definition exists yet |
| 18 | `src/workflows/screenerWorkflow.ts:450` | `ScreenerScreenWorkflow.run` | `workflow-shard` | Yes — full | Scheduled stock screens executed durably in the workflow residency (binding `SCREENER_WORKFLOW`, `wrangler.jsonc:43-45`) |

Notes on the table:

- **Sites 5 and 6, "test-only":** no static caller in `src/` or `tests/` outside their own test files. Dynamic or indirect callers (e.g. string-named dispatch) were not exhaustively searched — treat "test-only" as "no static production caller found", not as a proof no caller exists.
- **Site 3's stores in production:** `resolveResearchEngineAdapters` prefers DO SQL, then D1, then in-memory. Which backing the MCP command actually receives in production depends on the MCP host's bindings and was not verified — the doc does not assert it.
- **Shared builders, not construction sites:** `createJobPipelineWorkflowDeps` (`src/workflows/jobPipelineWorkflow.ts:283`, used by sites 7 and 18 and by `JobPipelineWorkflow.run` at `:423`) is the shared workflow-residency deps builder; `JobPipelineWorkflow` (`:423`) is the thin adapter over `PortThinkWorkflow` whose `run()` builds those deps and calls the site-7 flow with the ThinkWorkflow host's step object and `workflowInstanceId: event.instanceId` — the instance id is the replay proof (#4454).
- **Counts:** 11 sites execute jobs (1, 3, 5, 6, 7, 8, 9, 11, 15, 17, 18); 3 are define-only (2, 12, 13); 3 are read-only (10, 14, 16); 1 is the test-only factory (4). 11 + 3 + 3 + 1 = 18. (The research inventory's header line said "3 are read-only or define-only" — that undercounts; the table itself shows six non-executing constructions, three define-only and three read-only. This doc states the corrected partition, verified by recount.) Of the 11 executing sites, 2 (sites 5, 6) have no static production caller — see the note above.

### How the sites differ

A control is its deps. The differences that matter, site by site:

- **Stores.** DO SQLite at site 1 (the ScheduledAgent DO owns the pipeline: `createJobPipelineStoresFromSql`, `src/agents/scheduledTasksPipeline.ts:538`); D1 (`createJobPipelineStoresFromD1`, over `AGENT_DB`) at sites 2, 7, 12–14, 18; in-memory at sites 5, 6, and the research ephemeral fallback (sites 3, 15–17 via `resolveResearchEngineAdapters`). A control cannot run over stores it was not built with.
- **Step subset.** The full `createPipelineStepRegistry` runs at sites 1, 2, 7 (via deps), and 18 (via deps). Everywhere else the registry is narrow: options steps only (sites 8, 9, 11), research steps only (sites 3, 15, 17), builtins only (`createBuiltinStepRegistry`: `noop`, `record`, `echo`, `fail` — sites 10, 12, 13, 14, 16), caller-supplied (site 5), builtins + canned (site 6). A narrow registry exists so a caller cannot accidentally execute a family it has no deps for — an absent family is a named `job_step_unknown` refusal, not a mis-execution. See §4 for the registry composition.
- **Publisher on/off.** Sites 1, 2, 7, and 18 publish status events (`messaging.ports?.publisher ?? null`). Every other host passes `publisher: null`: runs proceed, status publication is skipped, store state remains the truth. The options, research, and MCP hosts deliberately do not publish.
- **Observers and timeouts.** Only site 1 wires OTel (the `runSettledObserver` chain and the traces → metrics → logging → identity step journals, `src/agents/scheduledTasksPipeline.ts:597-603`) and the feed/stage timeouts (`feedExecutionDeadlineMs`, `stageTimeoutMs`, `:614-618`). A code comment at `:547-549` states the other hosts are not yet wired — "same helper, later slice" (tracked as #5489).
- **Determinism seams.** Only site 15 injects `newRunId` (`src/workflows/researchScreenEngine.ts:257` — the OODA job and its durable engine execution are one run) and only site 6 injects `now` (`src/workflows/inMemoryWorkflowAdapter.ts:155`). Site 1 injects the OTel journals and the timeouts. See §9, flag 2, for what the reference doc gets wrong here.
- **Settings: passed by no host.** The per-tenant `settings` field of `JobPipelineDeps` is unwired everywhere (verified by grep across all six host files). The scheduled host passes env only — the `#4782` S3 note states the scheduled host has no per-tenant settings reader and the shared engine must never read a host-global map. The follow-up is #5989 (a per-job policy carrier / the live global-settings loop for shared-host scheduled runs).

## 3. ThinkWorkflow host, workflow-shard, sync, async — four terms, two axes

**ThinkWorkflow host.** A Cloudflare Workflow binding: the durable-steps substrate one journal mode runs on. Since #4924 the five ThinkWorkflow host classes extend `PortThinkWorkflow` (`src/workflows/portThinkWorkflow.ts:34`), the sole `@cloudflare/think/workflows` importer in `src/`. The five are `TradingTradeWorkflow`, `ScreenerScreenWorkflow`, `JobPipelineWorkflow`, `PaymentWorkflow`, and `CrossDomainSagaWorkflow` (`wrangler.jsonc:41-53`, each with concurrency limit 1). A ThinkWorkflow host instance is durable: it survives isolate eviction, and its `event.instanceId` is the replay proof (#4454).

**workflow-shard.** An invocation substrate (`StageRunnerInvocation`, `src/workflows/stageRunnerPorts.ts:198`): durable steps via a Cloudflare Workflow binding. The workflow-shard side is the workflow residency — the ThinkWorkflow-host side. A job runs in the workflow residency when a host defines it in D1 and creates the ThinkWorkflow host instance: the workflow host defines the per-run job in D1, creates the `JobPipelineWorkflow` instance, and polls the durable read-back (`src/workflows/optionsWorkflowHost.ts`). Sites 2, 7, 12, 13, 14, and 18 run on this substrate.

**sync.** An invocation substrate: direct stores, inline in the calling request. The engine runs inside the caller's process (the DO, the REST route handler, the MCP command, the research engine). No ThinkWorkflow host instance exists for a sync run; a process death mid-run loses the in-memory hand-offs and there is no journal to resume from — which is exactly why the durable path exists. Sites 1, 3, 5, 8, 9, 10, 11, 15, 16, and 17 run on this substrate (site 6 by default: it does not set `invocation`, and the engine defaults to `sync`).

**async-alarm.** An invocation substrate: async jobs via Durable Object alarms. It has **no production caller** — the string `async-alarm` appears in `src/` only in the type definition itself (`src/workflows/stageRunnerPorts.ts:198`). Only two of the three substrates are live. Do not cite async-alarm as an available residency.

**async (delivery mode) is a different axis — do not conflate it with the substrates.** `JobExecutionMode.delivery` (`sync` / `async`) answers whether a `runJob` dispatch *awaits settlement*: `JobDispatchResult` (`src/services/jobPipelineEngine.ts:351`) carries, "for sync delivery: the terminal (or paused) state. For async: the state at dispatch" (plus an optional `completion` promise). A sync-invocation host can run an async-delivery job and vice versa; the axes are independent.

| Axis | Values | Answers | Chosen by |
|---|---|---|---|
| Invocation substrate | `sync` / `workflow-shard` / `async-alarm` | Where and how the runner executes | The host, per control (`JobPipelineDeps.invocation`) |
| Delivery mode | `sync` / `async` | Whether `runJob` awaits settlement | The job's resolved execution mode (`JobExecutionMode.delivery`) |
| Durability | `durable` / `in-memory` | Whether checkpoints persist | The job's execution mode (`JobExecutionMode.durability`); in-memory is the explicit opt-in ephemeral execution (#5282, closed) |

**What "a job runs in the workflow residency" means in practice.** Three steps, all host-side: (1) a host defines the job in the D1 residency (`createJobPipelineStoresFromD1`); (2) it creates the ThinkWorkflow host instance with a deterministic id; (3) it polls the durable read-back until the run settles (`awaitOptionsWorkflowRun`, `src/workflows/optionsWorkflowHost.ts:742-757`). The poll is deliberate design owned by #4291 (closed) — see §7. The run's definition is read from the job stores at run start, and the payload the instance carries is a claim-check (ids + trigger only, never configuration or data).

## 4. What a control can be composed of

`JobPipelineDeps` (`src/services/jobPipelineEngine.ts:274`; the constructor takes it at `:833`) is the complete list. Nothing else is injectable; anything a host needs that is not on this list does not exist as a composition point.

| Field | Required? | Notes |
|---|---|---|
| `stores: JobPipelineStores` | yes | `definitions`, `instances`, `artifacts` (`src/data/jobPipelinePorts.ts:368-372`) |
| `runRecorder: JobRunRecorder` | yes | `recordRun` / `listRuns` / `latestRun` |
| `runSettledObserver?` | no | One terminal-recording point (`recordTerminal`); best-effort — an observer failure can never fail, retry, or duplicate the run's own records (#3530 slice B) |
| `publisher: MessagePublisher \| null` | yes (nullable) | Null ⇒ runs proceed, status publication is skipped, store state remains the truth |
| `steps: JobStepRegistry` | yes | One `Map<string, JobStepHandler>` — see below |
| `journal?: JobStepJournal` | no | `do<T>(name, fn)`; the identity journal (`do` runs `fn` directly) is the default. Checkpointing to the instance store happens regardless — the journal makes replays cheap, the checkpoint makes any resume exact |
| `now?: () => Date` | no | Determinism seam; injected only by site 6 in practice (see §2) |
| `newRunId?: () => string` | no | Determinism seam; site 15 uses it to mint the engine run id = the research run id |
| `policy?: PipelinePolicy` | no | Resolved retry budgets; absent ⇒ the constructor resolves from `env` + `settings` (#4782 S3) |
| `env?: Record<string, unknown>` | no | Worker env the policy resolves from; the engine never reads env itself — the host passes what it has |
| `settings?: Record<string, string \| undefined>` | no | Per-tenant `pipeline.*` map; settings beat env. **Passed by no host today** (verified by grep; see §2) |
| `sleep?: (ms) => Promise<void>` | no | Retry backoff and unit deadlines; defaults to a real (unref'd) timer |
| `invocation?: StageRunnerInvocation` | no | "The stage-runner invocation this host drives (the contract's driver kind). Defaults to `"sync"`." The engine reads it from exactly one place (§5) |
| `feedExecutionDeadlineMs?` | no | Whole-execution bound for FEED jobs only (#3992 PR-4 / #4312, 240s default) |
| `stageTimeoutMs?` | no | Global stage default (#4775 S1, 600s default) |
| `scheduleHost?: JobScheduleHost` | no | The schedule host `registerSchedules` registers with |

### The step registry

`JobStepRegistry` (`src/services/jobPipelineSteps.ts:49`) is a single `Map<string, JobStepHandler>` (step name → handler). `createPipelineStepRegistry` (`src/services/enrichPipelineJobs.ts:551`) composes every family into it: `createPipelineStepRegistry(feedDeps, enrichDeps, analyzeDeps?, generateDeps?, deliverDeps?, screenerDeps?, optionsDeps?, optionsChainDeps?, researchDeps?)`. Feed + enrich are required; every other family is optional — "Absent ⇒ the registry simply lacks them." Composition order: feed → enrich → analyze (+ screener-analyze) → generate → deliver → screener → options → options-chain → research.

| Family | Steps | Deps it needs |
|---|---|---|
| Built-ins (`createBuiltinStepRegistry`, `src/services/jobPipelineSteps.ts:97`) | `noop`, `record`, `echo`, `fail` | None — "the built-in steps every host gets" |
| feed | `feed.pull`, `feed.universe` (`src/services/feedPipelineJobs.ts:70-71`) | Registry, `providerFor` factory, `universeStore`, `datasetStore`, `indexRefresh`, `shardsFor`, `userLogin` |
| enrich | `enrich.apply` (`src/services/enrichPipelineJobs.ts:87`) | Enrich deps |
| analyze | `analyze.apply` (`src/services/analyzePipelineJobs.ts:58`) + the screener-analyze step | Analyze deps |
| generate | `generate.apply` (`src/services/generatePipelineJobs.ts:61`) | Generate deps |
| deliver | `deliver.apply` (`src/services/deliverPipelineJobs.ts:68`) | Deliver deps |
| screener (#4190) | Screener steps | Bound over the #3941 provider from the feed deps |
| options (#4289) | The resolving registration | Reads the dispatch request back out of the stored definition and rebuilds the stage ports per invocation |
| options-chain (#4780) | The chain job's six steps | Resolved per invocation from the chain on the stored definition |
| research (#5118 / #5237) | `analyze.ooda` + `evaluate.apply` | Research deps (default deps at the full-registry hosts) |

Which hosts get the full registry: sites 1, 2, 7 (via deps), 18 (via deps). Which get a narrow registry: site 3 (research only), site 5 (caller-supplied), site 6 (builtins + canned), sites 8/9/11 (options steps only), site 15/17 (research only), sites 10/12/13/14/16 (builtins only — read/define-only controls). Family membership is decided at authoring time by a step's input/output contract; the registry enforces nothing about semantics.

**What is NOT in a control's deps.** The spec does not supply deps, and the engine does not read the spec for them. `JobDefinitionSpec` (`src/config/jobDefinitionCatalog.ts:110`) declares only id, name, version, stages, parameters, execution mode, schedule defaults, and axes — no journal, no invocation, no residency field, no store, no publisher. The spec names steps as strings; the host supplies the handlers that make those names run. Four specs exist today: `screener` (v2, `:146`), `feed` (v1, `:191`), `goalScreen` (v1, `:269`), `research` (v1, `:302`). The catalog tracker is #4365; per-family spec adoption is #5563–#5568.

## 5. Substrate selection: there are no declared criteria

This is the section the questions were really asking for, and the answer is a negative: **no declared substrate-selection criteria exist.** Selection is host composition, full stop.

- The engine reads the invocation from exactly one place: `invocation: this.deps.invocation ?? "sync"` (`src/services/jobPipelineEngine.ts:3151`). No `journal`/`invocation` field exists on `JobDefinition` or `JobDefinitionSpec`, and no host reads one from a definition.
- The `invocation` value is a literal in each host's construction call — `"sync"` at site 1 (`src/agents/scheduledTasksPipeline.ts:642`), `"workflow-shard"` at site 2 (`:938`), and so on — never data read from the job.
- How a job gets its residency in practice: whichever host defines and runs it. The ScheduledAgent host defines jobs in its DO-SQLite control (site 1, `sync`); `startPipelineJobWorkflow` (site 2) mirrors a host definition into D1 and creates the ThinkWorkflow host instance (`workflow-shard`); the options ThinkWorkflow host defines jobs directly in D1 and creates the instance (sites 12–13). The mirror re-defines when `rawConfig` differs by JSON comparison, so the residency's copy tracks the host's definition.
- The gap — declaring the substrate in the definition (journal-as-spec) — has **no dedicated open issue**. The question is routed to **#3220** (open, agent-composed execution profiles — the agent composes how a large job should be executed, its parameters, and its lifecycle) and **#4808** (open, screener execution tree: configure and surface per-node exec mode + dispatch mode). **#5282 is not the gap:** it is CLOSED, "[Sub-issue] In-memory execution option for any j-stack stage — named, opt-in, ephemeral guarantees" (sub-issue of #5272; the `runStageInMemory` option, site 5). The reference doc §2.4 names #5282 for this gap; see §9, flag 3.

There is therefore no criteria table to print — no latency rule, no size rule, no family-to-substrate mapping. If a future slice adds one, it lands in the spec (via the #3220/#4808 routing) and this section is the place that records it.

## 6. Why so many hosts — five axes

The count follows from five independent axes. Each host is one point on them, and no single host can serve all points:

1. **Store residency.** DO SQLite (site 1: the ScheduledAgent DO owns the pipeline), D1 (sites 2, 7, 12–14, 18: the workflow residency reads `AGENT_DB`), in-memory (sites 5, 6, and the research ephemeral fallback). A control cannot run over stores it was not built with.
2. **Step subset.** Full-registry hosts (1, 2, 7, 18) vs family-narrow hosts (options-only 8/9/11, research-only 3/15/17, builtins-only read/define controls 10/12/13/14/16). Narrow registries exist so a caller cannot accidentally execute a family it has no deps for.
3. **Publisher on/off.** Sites 1, 2, 7, 18 publish status events; every other host passes `publisher: null`. The options, research, and MCP hosts deliberately do not publish.
4. **Invocation substrate.** `sync` for inline execution in the calling request (the DO, the REST routes, the MCP commands, the research engine); `workflow-shard` for durable execution that survives isolate eviction (the workflow residency, the options chain, scheduled screens). The same job definition can run in either — the residency is the host's choice, not the job's.
5. **Observers and determinism seams.** Only site 1 wires OTel and the feed/stage timeouts; only site 15 injects `newRunId`; only site 6 injects `now` and a single-attempt policy.

What is NOT a justification: there is no per-host engine variant. Every site constructs the same `JobPipelineControl` class; the engine has one code path for define/run/pause/resume/cancel/retry/replay. The proliferation is composition points, not engine forks — which is why the reference doc's one-engine doctrine holds while the host count is eighteen.

## 7. How well J-stack uses the Cloudflare Workflow platform

Partly — the ThinkWorkflow host binding is used as a durable host with a `step.do` journal, while the pacing primitives and the options chain settlement wait are still re-implemented on top. The reference doc §4 states the -ilities as built / partial / filed; this section states the platform-utilization facts the same way.

**Used.**

- **`step.do` as the journal.** In the workflow residency the ThinkWorkflow host's step object becomes the engine's journal: `journal: { do: (name, fn) => step.do(name, fn) }` (`src/workflows/jobPipelineWorkflowFlow.ts:71-75`). Each step invocation is wrapped in `step.do`, so a ThinkWorkflow host replay re-uses journaled step results while the engine's persisted checkpoints carry the resume semantics. The screener host adapts the same way (`adaptStep(step)`, `src/workflows/screenerWorkflow.ts:449-453` — "the journal makes step invocations replay-safe").
- **The ThinkWorkflow host instance id as replay proof.** `JobPipelineWorkflow.run` passes `workflowInstanceId: event.instanceId` (#4454): stable across replays of one instance, distinct across instances, so a replayed flow can prove it dispatched the still-running run it resumes.
- **The binding as the durable host.** Five ThinkWorkflow host bindings in `wrangler.jsonc:41-53`, each with concurrency limit 1. The durable path is the workflow residency: define in D1, create the instance, poll the read-back (§3).

- **`step.waitForEvent` as the engine's wait stage (#3955).** A
  `wait.event` step waits for one named event and resumes on it; the
  platform's timeout throw is classified (`isWorkflowWaitTimeout`) and
  becomes the declared outcome `{outcome: "timeout"}` instead of failing
  the instance. The wait name is the engine's, so a replay re-arms the same
  wait. Delivery rides `instance.sendEvent` through
  `sendManagedWorkflowEvent` (`src/workflows/workflowInstanceSeam.ts`) —
  the seam now addresses instances for delivery as well as for starts.

**Not used.**

- **`step.waitForEvent` in the options chain — still polling.** The engine's wait stage uses it (#3955); the chain's own settlement wait still polls the durable read-back (`awaitOptionsWorkflowRun`), which #2614 owns replacing.
- **`step.sleep` — not used.** Backoff uses the engine's injected `sleep` timer (`JobPipelineDeps.sleep`, default a real unref'd timer); the stage runner's shard-children wait was the one place a sleep loop existed, and #3025 (closed) replaced it with step retries + `waitForEvent` for that path only (#3036). The sleep / retry / rollback step primitives are tracked under #5782 (§8).
- **The platform's own retries — not used.** Retry is an engine-internal aspect in `executeUnit` (`src/services/jobPipelineEngine.ts:3002-3150`): a failed unit retries within its budget with backoff, and the budgets are externalized in `pipelinePolicy.ts`. The platform's per-step retry configuration is not wired.
- **`async-alarm` — not used.** No production caller (§3).

**Trackers.** The programme is #5780 (open, CAIO-quns, parent #5272): "[Programme] Cloudflare Workflows surface adoption into PortThinkWorkflow — steps, triggers, events, concurrency, rules." Nine of its sub-issues were closed with grounds on 2026-11-25 (the #5780 sequencing decision), which leaves one serial ten-landing train: #3955, #5783, #5491, #5278, #5782, #5781, #5958, #5279, #2614 and #5786, with #5794, #5788 and #5796 held on a gated watch list. Related outside #5780: #2614 (open, step retries + `waitForEvent` replacing the poll loop for the options chain / scheduled paths) and #3955 (open, Blocker, durable event-wait / approval-wait stage incl. `sendEvent` — built in `jobPipelineEngine.ts`, `jobPipelineWorkflowFlow.ts` and `workflowEventWait.ts`; the poll loop on the options read-back is #2614's to retire). #3025 is closed and covered only the stage runner's shard-children poll, not the host read-back poll.

## 8. Tracker map — which programme owns which gap

The umbrella programme is **#5272** (open, CAIO-quns): "[Programme] J-stack superiority — control parity + durability gaps, reusing existing issues". It composes existing issues plus #5277–#5280 and has **28 sub-issues** (verified by read-back). Most engine gaps named in this doc ARE its sub-issues:

| Issue | Gap |
|---|---|
| #5277 | Portability — dockerized dev/CI + production portability layer |
| #5278 | Versioning for in-flight runs (resume does not pin the version a run started under) |
| #5279 | Signals + queries for running jobs |
| #5280 | Determinism enforcement for stage handlers |
| #5488 | Run-context seam: one trace per run |
| #5489 | Wire engine observability on every `JobPipelineControl` host |
| #5490 | Resolve `PipelinePolicy` from env+settings at every engine host |
| #5491 | Stamp definition version + run inputs + effective providers on run records |
| #5492 | Audit-ledger coverage for engine control-plane actions |
| #5495 | Declare the run's full consumed source set in `inputs.sources` |
| #5497 | Journaled run-scoped inputs: define-time defaults + per-run overrides |
| #5517 | Retire broker-for-broker substitution: unservable capability refuses by name |
| #5563 | Per-family spec adoption — parameters, binder, and entry routing |
| #5753 | The consolidated j-stack doc itself (closed) |
| #5780 | Cloudflare Workflows surface adoption into `PortThinkWorkflow` (programme; §7) |

**NOT under #5272 — stated explicitly, so no reader assumes the umbrella covers them:**

- **#5586** (exactly-once edge — the claim-RPC-lands-but-its-response-is-lost edge). Parent #4438, not #5272.
- **#3976** (cold-universe incident: a quotes feed job fails `FEED_UNIVERSE_MISSING` from a cold universe state — the job is named in the issue) and the **#6048 family** — #6048 (feed page), #6049 (dependency graph), #6050 (schedule stage filters), #5261 (feed-chain default execution mode), #6028 (ledger stage rows). Parent #3533, not #5272.
- **#5989** (the settings-read door: the live global-settings loop for shared-host scheduled runs + definition-carried per-job policy). Parent #3533. Adjacent to #5490 (policy from env+settings) but a distinct build — #5490 is the resolver at every host; #5989 is the door that carries the settings to the shared host.
- **#2614** (step retries + `waitForEvent` on the options paths) — parent #2528 (CFO-qunso). **#3955** (durable event-wait / approval-wait stage) — parent #3549. Note #5780/#5782 cover the same area generally; these two are the specific builds.
- **#3220 / #4808** (the journal-as-spec routing, §5) — not under #5272.
- **The staleness flags in §9** — untracked anywhere. This doc flags them; no fixing issue exists.

## 9. Known staleness in the reference doc — open flags, not fixed here

This PR deliberately does **not** edit `docs/architecture/agentic/j-stack-workflow-engine.md`. These three flags are recorded here so the next reader does not copy them; fixing them belongs to the reference doc's owner.

1. **§2.1: "Exactly **one** spec exists today: `screener`"** (`j-stack-workflow-engine.md:533`). Four specs exist now: `screener` (v2), `feed` (v1), `goalScreen` (v1), `research` (v1) (`src/config/jobDefinitionCatalog.ts:146/191/269/302`). The sentence is stale since the feed spec landed.
2. **§4.4: "but only the ScheduledAgent host injects them"** (`j-stack-workflow-engine.md:987`, determinism seams `now`, `newRunId`, `sleep`). Site 15 injects `newRunId` (`src/workflows/researchScreenEngine.ts:257`) and site 6 injects `now` (`src/workflows/inMemoryWorkflowAdapter.ts:155`). The sentence is imprecise for those two sites; it should read "only the ScheduledAgent host injects them *among the production full-registry hosts*" — or name the two exceptions.
3. **§2.4: "That gap is #5282"** (`j-stack-workflow-engine.md:618`). #5282 is CLOSED — "[Sub-issue] In-memory execution option for any j-stack stage" (sub-issue of #5272; the `runStageInMemory` option, site 5). The sentence conflates the in-memory option with the journal-as-spec gap. Its second half is right: the journal-as-spec question is routed to #3220 / #4808 (§5).

Line references in the reference doc also drift as main moves (e.g. §3.7 cites `stageRunnerPorts.ts:194`; the type is at `:198` on the verified tip). This doc cites the verified tip for every line; the reference doc's line refs are its owner's to re-verify.

## 10. Maintenance — how to recount

A host is a `new JobPipelineControl(` construction site. To recount: `grep -rn "new JobPipelineControl(" src/` and classify each hit as executes / read-only / define-only / test-only (Table, §2). Update this doc when a site is added, removed, or changes invocation or registry — and re-verify the tip. The factory `createJobPipelineControl` (`src/services/jobPipelineEngine.ts:3789`) is a test seam with no production callers; it is not a host.

## Links

- Reference doc: [`../agentic/j-stack-workflow-engine.md`](../agentic/j-stack-workflow-engine.md) — the product reference this doc inventories; its §1.1 (engine vs host vs door vs agent vs ThinkWorkflow host vs chain vs stage), §2 (jobs-as-data, the spec form), §3.7 (journal modes), §4 (-ilities).
- Vocabulary: [`execution-model.md`](execution-model.md) — one tree, one id convention; the "never say 'workflow' bare" rule.
- Job system: [`../agentic/job-system.md`](../agentic/job-system.md) — the jobs and their producer/consumer contract.
- Stage contract: [`../adr/0027-one-stage-runner-contract.md`](../adr/0027-one-stage-runner-contract.md) — persist → checkpoint → publish.
- Engine: `src/services/jobPipelineEngine.ts` (`JobPipelineControl` `:826`, `JobPipelineDeps` `:274`, `defineJob` version bump `:866/:896`).
- Stores: `src/data/jobPipelinePorts.ts` (`JobPipelineStores` `:368`, `JobNodeConfig` `:137`, `JobDefinition` `:169`).
- Invocation: `src/workflows/stageRunnerPorts.ts:198` (`StageRunnerInvocation`).
- Registry: `src/services/enrichPipelineJobs.ts:551` (`createPipelineStepRegistry`).
- Spec catalog: `src/config/jobDefinitionCatalog.ts` (`JobDefinitionSpec` `:110`).
- Issues: #6057 (this doc) · #5272 (umbrella programme) · #4365 (definition catalog) · #5780 (Cloudflare Workflows adoption) · #3220 / #4808 (journal-as-spec routing) · #5282 (closed in-memory option — not the journal-as-spec gap) · #5989 (settings-read door) · #5489 (observability on every host) · #5490 (policy from env+settings).
