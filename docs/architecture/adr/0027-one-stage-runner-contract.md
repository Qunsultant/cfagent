# 0027. One stage-runner contract for every screen invocation mode

- Status: proposed
- Date: 2026-11-03
- Deciders: owner (approval pending), #cfo-qunso
- Issue: #2601 (Options Screener programme slice 5), sequenced by #2621
- Implementing PR: this PR (main commit recorded on merge)

## Context

Three invocation paths currently decide the same things independently: the
hand-rolled chain planner in `src/services/shardJobs.ts` decides which stage
advances next; the DO-alarm scheduler in `src/agents/orchestrator/asyncJobs.ts`
decides when a queued row is claimed and retried; and the workflow parent in
`src/workflows/screenerWorkflowFlow.ts` decides batch fan-out and polls child
status on a sleep loop. Each is individually reasonable. Together they are
three partial implementations of one lifecycle, and #2601's stated outcome is
to consolidate onto the single stage runner path — with one seam per PR.

A consolidation needs a contract before it needs a migration: without one,
each seam would move onto whatever shape its first mover invented, and the
"one runner" would be a third implementation reached twice.

Constraints carried into the decision:

- ADR 0017: WorkflowPort is a fixed linear stage pipeline plus parent →
  parallel shards → collation, not a DAG. The contract must not claim DAG
  semantics.
- ADR 0022 D-0: `mas_async_jobs` is DO-resident behind ports because the
  claim relies on instance serialization. A second unit table would be a
  second claim story.
- #2621: extend existing ports, never a second port layer; checkpoint store
  is `mas_async_jobs` (no new `mas_run_units`); deterministic defaults are
  preserved and the #2530 non-deterministic mode stays gated off.
- #2601: no deletions, no behaviour change bundled with a workflow move.

## Decision

1. **One plan, one checkpoint, three drivers.** The runner contract is a
   `StageRunnerPlan` (canonical stage order, per-stage execution/timeout/retry
   bucket/pacing tier, units, mode) plus a `StageRunnerCheckpoint` with one
   entry per planned (stage, unit) pair. Sync inline, async job via alarms, and
   workflow shard steps differ only in the driver that consumes `planNext` /
   `resumeUnits` — never in the decisions.
2. **The stage vocabulary is the existing one.** Stages are `StageName`
   (`feed → gather → analysis → store → serve → deliver`); chain rows are
   `PipelineStage`, mapped by `runnerStageForPipelineStage` (`generate` is the
   analysis stage). The #2621 canonical labels (generation / recording /
   delivery) are labels over that vocabulary, never a second enum.
3. **Retry budgets resolve from `pipelinePolicy`.** A stage declares a bucket
   (`acquisition | report | delivery`); `resolveStageRetryBudget` resolves it
   once. No call-site constants, no per-path retry tables.
4. **Fan-out is capped and the tail is named.** `planStageFanout` starts at
   most `maxParallel` units and returns the tail; `fanoutCapExceeded` produces
   the visible `fanout_cap_exceeded` reason. A large universe queues a second
   round/chain — it is never silently truncated.
5. **Resume re-runs only what did not complete.** A completed or skipped unit
   never appears in `resumeUnits`; absent checkpoint entries are not a resume
   signal (a fresh run has none).
6. **Absent is never-attempted.** The projection puts a planned (stage, unit)
   pair with no stored row down as `never-attempted`, never as `failed` and
   never as missing data. Checkpoint rows are read, never written, by the
   projection; `mas_async_jobs` stays the single unit store.

## Consequences

- The three seams of #2601 can move one at a time onto the same decisions,
  each with its own PR and its own pins, and a seam that has not moved is
  visible rather than assumed.
- The contract is executable: `planRun`, `planNext`, `resumeUnits`,
  `planStageFanout`, `fanoutCapExceeded`, and `checkpointFromStageRows` are
  pure functions pinned by `tests/stage_runner_contract_2601.test.ts`.
- No execution path is wired in this ADR's implementing slice. A later seam
  that cannot be wired without changing selection, content, delivery,
  scheduling, or the deterministic default stops at the contract and says so
  (#2621's rule).
- The workflow poll loop is not removed by this decision. Its replacement
  (step retries + `waitForEvent`) is a named later seam, and the DO alarm
  narrows to sub-minute single-shot delays only — it does not become the chain
  engine.

## Alternatives considered

- **Define a new canonical stage enum (feed/analysis/generation/recording/
  delivery) and map the existing names onto it.** Rejected: it creates a
  second vocabulary that every reader must translate, and ADR 0017 already
  warns that loose naming is how execution models drift. Labels over the
  existing names carry the same programme traceability with no translation
  layer.
- **Create a `mas_run_units` table for per-unit checkpoints.** Rejected:
  `mas_async_jobs` already carries stage, chain id, and the claim; a second
  unit table is a second unit store and a second claim story (#2621's decision,
  ADR 0022 D-0).
- **Let each driver keep its own planner behind a shared interface.** Rejected:
  that is the current state with a nicer boundary — three planners, one name.
  The shared piece must be the decisions, not just the type.
- **Migrate the poll loop in the same slice as the contract.** Rejected by
  #2601's one-seam-per-PR rule and by the behaviour-change separation: the
  contract must be pinned before a workflow move depends on it.
