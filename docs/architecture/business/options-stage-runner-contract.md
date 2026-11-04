# Options screener slice 5 — stage-runner contract (#2601)

**Status:** contract only. This slice lands the contract, its pure planner, its
checkpoint projection, and their pins. **No execution path is moved, wired, or
changed**; the three seams below move one per PR, each naming the seam it moves
and the Cloudflare-reuse step it belongs to.

**Related:** #2601 (this slice), #2621 (runtime unification sequencing; journey
1 shape), #2528 (programme blueprint), #2610 (single resumable runner), #2612
(reuse step 2, port-only additions), #2614 (step 4, step retries +
`waitForEvent`), #2615 (step 5, `StageRunnerPort` on workflows), #2617 (step 7,
narrow DO-alarm `JobPort`), #2618 (step 8, unbounded fan-out removal).
Decision record: [ADR 0027](../adr/0027-one-stage-runner-contract.md).

## 1. Why this contract exists

Three surfaces decide the same lifecycle today, independently:

| Seam | Where it lives | What it decides today |
|---|---|---|
| **A. Hand-rolled chain planner** | `src/services/shardJobs.ts` (`planShardAdvance`, `planNextFeedShard`, `assessFeedGate`, `SHARD_RETRY_BUCKET`, `staggerRunAt`) | which stage advances, when a stage is complete, what a failed shard does |
| **B. DO-alarm scheduler** | `src/agents/orchestrator/asyncJobs.ts` (alarm claim, `recoverQueuedAsyncJobs`, retry/reap) | when a queued row is claimed, when it is retried, when it is declared stuck |
| **C. Poll loop** | `src/workflows/screenerWorkflowFlow.ts` (`runParentFlow` batch loop + `pollBatch` sleep loop) | batch fan-out, child-status polling, per-shard deadline |

Each is a partial implementation of one stage runner. Consolidating them one at
a time needs a contract first, or each seam lands on whatever shape the previous
one invented.

## 2. The contract (implemented)

- `src/workflows/stageRunnerPorts.ts` — the plan/checkpoint types, the canonical
  stage order (`StageName`), the `PipelineStage` → runner-stage mapping, the
  retry-bucket table, and `assertStageRunnerPlan` (refuses, never repairs:
  empty plan, duplicate stage, out-of-order stage, non-positive cap/deadline).
- `src/workflows/stageRunnerPlan.ts` — `planRun` (validate + freeze, mode
  defaulting to deterministic), `planNext`, `resumeUnits`, `planStageFanout`,
  `fanoutCapExceeded`.
- `src/workflows/stageRunnerCheckpoint.ts` — `checkpointFromStageRows`
  (mas_async_jobs rows → one entry per planned (stage, unit) pair, absent =
  `never-attempted`), plus a tests-only in-memory `StageCheckpointStore`.
- `tests/stage_runner_contract_2601.test.ts` — 12 pins.

Deliberately reused, not re-declared: `StageName` (messaging port),
`PipelineStage` and the workflow shard constants (`workflowPorts`),
`pipelinePolicy.retry` budgets, `StageStatus` (stage-chain read model).
There is no new stage enum, no new status enum, no second unit store.

## 3. Stage mapping (stated, not conflated)

| Runner stage (`StageName`) | Chain row (`PipelineStage`) | #2621 label |
|---|---|---|
| `feed` | `feed` | feed |
| `gather` | — (runs inside analysis; recorded on stage transitions) | gather |
| `analysis` | `generate` | generation |
| `store` | `store` | recording |
| `serve` | `serve` | delivery (Docs availability) |
| `deliver` | `deliver` | delivery (per-channel outcomes) |

`STAGE_CANONICAL_LABEL` carries the labels; the enum stays `StageName`.

## 4. Invocation modes — same plan, different driver

| Mode | Driver | What differs |
|---|---|---|
| `sync` | inline caller waits; steps still checkpoint | nothing in the plan or the decisions |
| `async-alarm` | queued `mas_async_jobs` row + alarm claim (seam B) | claim/retry timing only |
| `workflow-shard` | `ScreenerScreenWorkflow` parent + shard children (seam C) | who executes a unit; collation unchanged |

The plan carries `screenMode`, defaulting to `deterministic`. The
non-deterministic mode (#2530) stays gated **off**; this contract never turns it
on, and a plan naming it is still refused downstream while the gate is closed.

## 5. Migration order (one seam per PR)

| # | Seam | Moves onto | Reuse step | Dependency |
|---|---|---|---|---|
| 1 | contract + planner + projection | — | step 2 shape (port-only additions; no behaviour change) | — | **done** (PR #3012) |
| 2 | A — `shardJobs` chain planner | stage order + retry buckets derived from the contract | step 5 sequencing | contract merged | **done** (behaviour-preserving; per-format/gate domain rules stay) |
| 3 | C — workflow fan-out | `planStageFanout` partitions the shard rounds at the stage cap | step 5 shape | seam A | **done** (behaviour-preserving; same batches, same order) |
| 3b | C — workflow poll loop | step retries + `waitForEvent` | step 4 | seam C fan-out | **declined for #2601**: a behaviour change (polling → child-signalled events) that needs its own approval and child-side emission; it must not ride a consolidation slice |
| 4 | B — DO-alarm scheduler narrowed | `planNext` claim/re-arm; sub-minute single-shot only | step 7 | seams A+C | **declined for #2601**: the alarm path decides from a queue row, not a stage plan; moving it before queue delivery (step 3) and workflow retries (step 4) would invert the reuse-report order and change claim semantics. It stays named here as the next runner step |

Step 6 (Agent schedules replacing the tick loop) and step 8 (unbounded fan-out
removal) stay sequenced under #2621; this document does not claim them.
Unbounded fan-out is already refused *by contract* here (`fanoutCapExceeded`),
which is the part seam 8 needs.

## 6. What this slice deliberately does not do

- No production wiring, no route change, no workflow-file change.
- No deletion or deprecation; nothing is retired by a contract.
- No change to selection, thesis, caps, delivery, scheduling, or the
  deterministic default.
- No claim that any of A/B/C has moved. A seam that cannot move without a
  behaviour change stops and says so (#2621's journey-1 rule).

## 7. Pins

`tests/stage_runner_contract_2601.test.ts` pins: canonical order and loud
refusal of an out-of-order/duplicate/empty plan; deterministic mode default;
`pipelinePolicy`-resolved retry budgets (a policy change moves the budget);
the stage-name mapping and canonical labels; fan-out cap with a named deferred
tail and the shared default cap; `planNext` advancing past completed stages;
`resumeUnits` never returning a completed unit; total checkpoint projection with
`never-attempted` for unrecorded stages; in-memory store round-trip.

## 8. Exit criteria

- [x] Contract + planner + projection land with pins; typecheck clean.
- [x] Exact seams named with file and symbol, each with its reuse step.
- [x] Deterministic default preserved; ND gate untouched.
- [ ] Seam A moved (own PR), then C, then B — tracked by #2601.
