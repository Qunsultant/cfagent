# 0038. One Job Pipeline Control factory, wired once (OODA runs on j-stack and nowhere else)

- Status: accepted
- Date: 2026-11-23
- Deciders: owner (Mubasher)
- Issue: #6250 (related: #6217, #5164 Step 5)
- Implementing PR: (this PR)

## Context

The Job Pipeline Engine (j-stack) was constructed 18 separate times
across the codebase (`scheduledTasksPipeline.ts`, `jobPipelineEngine.ts`
itself, `stageInMemoryExecution.ts`, `researchJobCommands.ts`,
`inMemoryWorkflowAdapter.ts`, `jobPipelineWorkflowFlow.ts`,
`optionsStageControl.ts`, `optionsWorkflowHost.ts`,
`researchScreenEngine.ts`, `screenerWorkflow.ts`,
`optionsScreenEngine.ts`), each wiring its own observers (or none),
its own stores, its own run recorder. The OTel run-settled observers
(logging + metrics + traces) were attached on the ScheduledAgent host
control only — the research engine control (`researchScreenEngine.ts`)
contained no `runSettledObserver` or `otel` reference at all. So
OODA/research jobs ran through the engine but never emitted
`job.run.settled`: Grafana showed zero `ai-search-agent` logs even for
a normally-settling OODA run (`research:mwt7kazh-3`, 6/6 stages,
2026-11-23 11:54 UTC). The #6179 shared observer helper
(`src/observability/otelJobPipelineObservers.ts`) made the observers
composable from env, but each site still had to remember to call it —
one site (the options screen) did, the rest did not.

The OODA/research job also had a second execution path:
`runResearchAndPublish` (`src/agents/orchestrator/researchPublish.ts`)
fell back to a direct pipeline (`agent.runResearch(...)`,
`executionPath` "fallback") when the agent turn did not complete.
The fallback bypassed the engine entirely: no engine record, no
pipeline observability, no `job.run.settled`.

A third settle path bypassed the engine too: the orphan reap
(`recoverStaleRunningAsyncJobs` / `settleStaleFeedDispatch` /
`sweepStaleAsyncJobs`, `src/agents/orchestrator/asyncJobs.ts`) settles
jobs via `ports(ctx).queue.reapStaleRunning(...)` and never calls the
engine's `recordTerminal`, so reaped orphans were invisible to Grafana
by design.

## Decision

### One factory builds every Job Pipeline Control

`createJobPipelineControl` in
`src/services/jobPipelineControlFactory.ts` is the single factory
every dispatch site uses. It wires the OTel run-settled observers
(log + metrics + traces, chained) exactly once, plus the journal, so
every job that runs through the engine emits `job.run.settled` — no
site can forget them. A host's pre-existing `runSettledObserver` is
chained FIRST (kept, never replaced) and a pre-existing journal runs
as the inner journal (kept, never replaced); the composition order
mirrors the ScheduledAgent host exactly. The factory takes its
observers from an already-composed `otel` set when the caller has
one, else from `env` (cached per env object at the dep level, so a
per-dispatch control build never re-creates the OTel providers);
with neither it builds a bare control, exactly as before, for the
in-memory and read-only hosts that have no OTel sink.

The factory is a separate module rather than an extension of the
engine's bare `createJobPipelineControl` because the observer helpers
import the engine's `identityJobStepJournal` as a VALUE — the engine
importing them would be a runtime import cycle. The factory is the
leaf composer (engine + observers, nothing imports it back); the bare
factory stays as the constructor for tests and for hosts that
explicitly pass no observers.

### One dispatch path for OODA/research

The direct-pipeline fallback in `runResearchAndPublish` is removed.
When the agent turn does not complete, the run fails with the named
error `research_agent_turn_incomplete` (escalated to a human through
the task ledger, marked by the structured warning
`researchPublish.research_agent_turn_incomplete` carrying the #543
correlation identifiers) instead of silently degrading to a
non-engine execution. `ResearchExecutionPath` narrows to `"agent"`
only, so the type can never record a fallback run again. The
`direct_rollback` emergency flag in `dispatchResearchEngineRun` is
NOT removed: it is an explicit, default-off incident rollback behind
a named flag (`research_engine_direct_rollback`), not a silent second
path, so it already satisfies the rule.

### The orphan reap emits the same event through the same observer

`emitOrphanRunSettled` (`src/agents/orchestrator/asyncJobs.ts`)
invokes the shared OTel observer set with the same
`JobRunSettledInfo` shape the engine's `recordTerminal` reports —
state "failed" with the orphan error — at all three reap sites
(onStart recovery, feed settle, generic sweep). It constructs no
event, metric, or span itself: the observer owns all three signals.
Identity follows the recording rule (feed job id when the row was
dispatching one, else the row id; pipeline run id when resolved,
else the row id). Best-effort: an observer failure never breaks the
reap.

## Consequences

- Every engine run emits `job.run.settled` (log, metric, trace)
  from exactly one wiring point; a new dispatch site gets the
  observers by using the factory, and a site that forgets the
  factory is caught by the source pin in
  `tests/job_pipeline_control_factory_6250.test.ts` (no
  `new JobPipelineControl(` in src/ outside the engine's bare
  factory).
- The ScheduledAgent host's ~50 lines of inline OTel construction
  are deleted; the factory is the only copy of that composition.
- An incomplete research agent turn is now a visible named failure
  instead of a silent degradation; scheduled discovery no longer
  "stays dependable" by running outside the engine. A permanently
  broken agent path surfaces in Workers Logs and in the escalated
  task, instead of being masked by research output.
- Reaped orphans appear in Grafana as failed `job.run.settled`
  events with the orphan error, so the stillborn/re-arm story is
  observable end to end.
- Residual, named not fixed: `runResearchAndPublish`'s agent turn
  still executes through `ResearchAgent.runResearch` →
  `runResearchPipeline` (the direct function pipeline) — the
  fallback removal makes the agent turn the only path for the
  publish entry, but that path itself is not yet an engine dispatch.
  Unifying it (the agent tool dispatching the engine job) is a
  separate slice, not this one.
- Live verification (owner step, after merge + deploy): run the OODA
  job and confirm `job.run.settled` lands in Grafana with the engine
  path and 6 stages; confirm the AAPL options run emits its settle
  event; confirm no "fallback" executionPath is recorded.
