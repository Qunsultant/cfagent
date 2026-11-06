# GoF / GRASP / SOLID review — the one options workflow (#3186)

Scope: the NEW #3186 code only — the options pipeline (composer,
plain + panel + scanner ports, Blocks), its entry migrations, and
the checkpoint/resume proof. Anchor: issue #488 (conformance
tracker — SOLID/GRASP/GoF, multi-tenancy, SaaS readiness; CLOSED
2026-11-02). Each principle below names where #3186 implements it
and what remains. This review does not check #488 items; it maps
this slice's design onto them.

## GoF patterns

| Pattern | Where in #3186 | Notes |
|---|---|---|
| Template Method | `src/workflows/optionsScreenWorkflow.ts` (`runOptionsScreenWorkflow`) | The composer defines the stage algorithm skeleton — claim → execute → persist → publish — and every stage fills the steps through the same `{execute, persist}` port. No stage re-implements the skeleton. |
| Strategy | `src/workflows/blocks/plannerPort.ts` (ONE planner port + per-asset-class plan Blocks); `OptionsStagePort` per stage | The planner selects the plan Block by asset class; each stage's port is the strategy for that stage; the deliver stage takes an entry-supplied delivery strategy (real delivery for manual/unified, deferred for goal/scanner legs). |
| Observer (pub/sub) | Stage boundary messages (`stageMessage.ts`, `stageQueueTransport.ts`) published per stage to `SCREENER_EVENTS`; consumers (`stageReportConsumer.ts`, Workflow Runs surfacing) subscribe | Producers never call channels directly: the composer publishes messages; delivery happens through the injected delivery, which is itself a publisher behind the event contract (Slack/email A2A). |
| Adapter (port/adapter) | `src/workflows/optionsScreenPorts.ts`, `src/workflows/strategyScreenPorts.ts` | Each production port adapts a concrete engine (options screener, panel kernel, scanner) behind the uniform `OptionsStagePort` interface. The composer never sees an engine. |
| Registry | `src/workflows/blocks/optionsBlocks.ts` (`OPTIONS_BLOCKS`), `src/workflows/legRegistry.ts` (#2991) | Blocks are registered, not hard-wired: the composer resolves stage Blocks by id (`options-<stageId>`) and asserts conformance (`assertBlockConforms`). |
| Facade | `src/workflows/manualPanelScreen.ts` (`runManualPanelViaPipeline`, `runComparePanelViaPipeline`) | Thin facades over the composer for the route entries — the route passes a request + agents and gets a panel result, without constructing the pipeline. Kept thin so `etradeOptions.ts` stays under the #359 50 KB ratchet. |

## GRASP

| Principle | Where in #3186 | Notes |
|---|---|---|
| Information Expert | Claim state owned by `mas_stage_claims` (`src/data/stageClaimsStore.ts`); stage outputs owned by their artifacts (`options:<runId>:<stage>`); quotes owned by `ETradeRestClient`; canonical runs owned by `mas_reports` / `mas_opportunity_scans` | Each piece of state lives where the knowledge lives. No module reaches into another's store. |
| Low Coupling | The composer depends only on port interfaces + Block definitions (`OptionsStagePort`, `StageClaimStore`, `OptionsStageStorage`, `StageQueueSend`); entries inject concrete deps | The composer never imports an engine, a route, or a store implementation. The trading boundary (#290) holds: `src/trading/index.ts` stays the only trading import surface, test-enforced (`tests/trading-boundary.test.ts`, green through every swap). |
| Controller | The composer is the one controller for a run | One place decides stage order, claim discipline, failure, and publishing. Entries create runs; they do not steer stages (stage control is #3069). |
| Creator | Run ids are minted at the entry (`options-panel:route:<symbol>:<iso>`, `nlq-panel:<uuid>`, `options_scanner:unified:<iso>:<thesis>`, …) | The entry that owns the run's context creates its identity; the composer never invents one. |
| High Cohesion | One port per stage; one Block per stage; one helper per route entry | Each module does one stage (or one entry's assembly) and nothing else. |

## SOLID

| Principle | Where in #3186 | Notes |
|---|---|---|
| Single Responsibility | Composer = order + claims + publish, nothing else; ports = one stage each; entries = dep assembly only | The manual panel route's pipeline construction lives in `manualPanelScreen.ts`, not the route, for exactly this reason (and the #359 ratchet). |
| Open / Closed | New legs add Blocks + ports without touching the composer | The panel leg and the scanner leg both landed as port modules; the composer did not change across either. The stocks leg generalizes onto the same contract the same way. |
| Liskov Substitution | Any `OptionsStagePort` runs in any stage slot; any `StageClaimStore` (SQL or memory) backs any run | The step-4 proof runs the same composer over the durable store that step 2 ran over memory claims. |
| Interface Segregation | Ports implement the minimal `{execute, persist}` interface; `StageClaimStore.delete` is OPTIONAL | Implementations that cannot delete (in-memory claims) still satisfy the interface; the composer calls `delete?.()` only on failure. |
| Dependency Inversion | Composer + ports depend on abstractions; entries inject concretes | No concrete engine, store, or queue is named inside the composer or the port contracts. |

## #488 programme items

| #488 item | #3186 standing |
|---|---|
| Think workflow — single pipeline (generate → store → serve → deliver) | This slice IS the single pipeline for options: plan/generate → persistCanonicalResults/store → shapeReport/serve → deliver, staged under one contract. |
| Multi-tenancy | Identity enforced at every entry; owner-scoped canonical writes; the composer never invents an identity. Gap carried from the 15-factor audit (factor 15): no negative test for workflow tenant mismatch / cross-owner replay on the pipeline's stage artifacts. |
| Orchestrator god-object removal (#359 family) | Direction correct: execution moves OUT of the routes/service into workflow modules (`runStrategyPipeline` now delegates; routes delegate to helpers). Standing constraint, not a #3186 gap: `etradeOptions.ts` sits at 49,952 B against the 50,000 B ratchet (48 B headroom) — any further growth to that file must go in a helper module. |

## What remains

- The factor-15 negative tests (tenant mismatch / cross-owner
  replay on stage artifacts) — the one multi-tenancy gap, shared
  with the 15-factor audit.
- The broker durable-async-start question (open on #3186): a 5th CF
  workflow binding vs an async-job handler type is a platform design
  decision, not a pattern question — the pipeline's shape does not
  depend on it.
- The `screen` action stays a direct `screenContracts` call (posted
  on #3186): a stage-subset run is #3069's territory, and forcing
  the data call through the full run pipeline would double-record.
