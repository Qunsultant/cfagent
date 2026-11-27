# Feed-run residency and scheduled-silence decision (#3992 PR-5)

Issue #3992, PR-5 of 5 — the closing slice of the repair for the #3976
stuck-run incident. PR-1 shipped the timeout catalogue and the race
helper, PR-2 bounded the universe-refresh leg, PR-3 bounded the
provider-fetch legs and the run-record write, PR-4 bounded the run as a
whole. This document records the two questions those PRs deliberately
left open: where a production pipeline/feed run physically executes
(its residency), and why the scheduled firings in the incident window
left no records (the scheduled silence).

**Amended by #4171 (2026-11-27).** The follow-up issue "Workflow-residency activation for pipeline runs" activated workflow residency
for feed runs after the #3992 hang fix landed and its live
verification showed feed dispatches still wedging in the host. The
Decision, Evidence, Why not move, and Consequences sections below
record the activated state; the scheduled-silence mechanism section
stands as written, with its firing path updated to the workflow
dispatch. This document is pinned by
`tests/feed_residency_decision_3992.test.ts`. Change the code, change
this document in the same PR.

## Decision

**ACTIVATE (feed jobs).** Feed jobs execute in workflow residency
only. Dispatch (panel, schedule, Copilot) still enters through the
ScheduledAgent Durable Object's doors (`runPipelineJob`,
`runPipelineStage`, `resumePipelineJob`, `retryPipelineJob`,
`controlPipelineStage`, `replayPipelineRun`, scheduled firings, and
completion-trigger firings in `src/agents/scheduled-agent.ts` and
`src/agents/scheduledTasksPipeline.ts`), but the ScheduledAgent host
is now the control plane and dispatcher for feed jobs, never their
executor: every feed dispatch starts a `JobPipelineWorkflow`
instance through `dispatchFeedJobWorkflow` /
`startPipelineJobWorkflow`, and the door awaits that specific
instance's outcome. The host execution path for feed jobs is
retired; the externalized `FEED_JOB_RESIDENCY` switch defaults to
`workflow` and the retired `host` value refuses by name
(`feed_job_host_residency_retired`).

Non-feed pipeline jobs and composed chains are unchanged: they
remain resident in the ScheduledAgent host. The legacy
`screener.feed` step retires separately with slice 7 (#5828); this
decision covers pipeline feed jobs only.

The `JOB_PIPELINE_WORKFLOW` binding's concurrency limit is sized
for simultaneous multi-user invocations (32: the 25 registered feed
jobs plus headroom for resume/retry/replay instances), superseding
the #4213 limit of 1 for this binding. Same-job duplicates stay
serialized by the engine's atomic dispatch claim
(`job_already_running`); instances beyond the limit queue.

## Evidence

Every claim below was re-verified against the tree this document
ships in; the greps are stated so the check is repeatable.

- **The trigger fired.** The #3992 hang fix merged (PR #6700) and
  deployed, but live verification on 2026-11-27 showed feed
  dispatches still wedging in the host (background feed-run jobs
  stuck `running`, the Data Providers panel never answering, no new
  run-ledger record). That is the revisit trigger this document
  named — production run losses attributable to the host residency —
  so #4171 activated the workflow residency for feed runs.
- **The feed-outcome boundary is closed.** The workflow deps builder
  (`createJobPipelineWorkflowDeps`,
  `src/workflows/jobPipelineWorkflow.ts`) now carries the feed
  run-settled observer through the ONE env wiring both residencies
  share (`src/services/feedRunSettledObserverWiring.ts`): a
  workflow-resident feed run reads its own feed record back through
  the same dataset adapter and writes its Job outcomes row through
  the same Orchestrator door as a host-resident run did. Parity is
  pinned by `tests/feed_workflow_residency_4171.test.ts` (dataset
  records, run records, surface views, and outcome rows match
  across residencies).
- **The dispatch facts ride the payload.** The workflow payload
  carries the acting user login, the firing schedule id, the
  operation (run / resume / retry / stage actions / replays), and
  the #6584 provenance carrier, so per-login providers resolve
  exactly as at the host door and the terminal record joins to its
  schedule. The door awaits the specific workflow instance it
  started (status read through `readManagedWorkflowStatus`), so
  simultaneous dispatches by the same user, other users, or other
  tenants never read one another's outcomes.
- **Host eviction losses are settled and named, not silent (#4002).**
  `ScheduledAgent.onStart` calls `settleOrphanedPipelineRuns`, which
  delegates to `JobPipelineControl.settleOrphanedRuns`: every
  host-resident instance still marked `running` when the host
  starts is settled as failed with a named orphan error, a terminal
  run record, and a published transition. Workflow-resident
  instances (stamped with a workflow instance id) are skipped —
  their executor is the workflow, which survives the host restart
  and settles or replays the run itself. Pinned by
  `tests/pipeline_orphan_settle_4002.test.ts`,
  `tests/pipeline_orphan_settle_host_4002.test.ts`, and
  `tests/feed_workflow_residency_4171.test.ts`.
- **The #3992 bounds are residency-independent.** PR-1's catalogue
  (`FEED_JOB_TIMEOUTS`, `src/services/feedJobTimeouts.ts`), PR-2/PR-3's
  leg races (the runners in `src/services/feedJobs.ts`), and PR-4's
  whole-execution race (settling failed with
  `FEED_DEADLINE_EXCEEDED` past `FEED_JOB_TIMEOUTS.executionMs` =
  240s) all live in the shared engine and the shared composed step
  registry that both residencies build. Both deps builders resolve
  the same env-knobbed execution deadline and stage timeout, so the
  bounds are identical in both residencies.
- **The executor backstop is unchanged.** The manual Run-now path
  rides the async-job executor, whose own defences sit behind the
  pipeline bounds: the max-runtime execution deadline
  (`createExecutionDeadline`, `src/agents/orchestrator/asyncJobs.ts`;
  `ASYNC_JOB_MAX_RUNTIME_MINUTES`, default 90 minutes) plus the
  heartbeat/stale reap (#3907, same file). Nothing in this decision
  touches them; they remain the designed backstop, two orders of
  magnitude above the 240s pipeline bound.

## Why not move

This section recorded why the residency stayed put before #4171;
each reason is answered by the activation, in order:

- **"What moving would buy is small" — no longer true.** The
  bounded-run argument held while host losses were named failures
  the operator could re-run. The 2026-11-27 live verification
  showed the failure mode is worse: dispatches wedge inside the
  host and the surfaces that would name the failure never answer.
  Durable workflow execution removes the run from the host whose
  liveness the surfaces depend on.
- **"The outcome surface is host-shaped" — closed first.** #4171
  wired the feed run-settled observer into the workflow deps
  through the shared env wiring before any feed dispatch moved, so
  no workflow-resident run settles invisible.
- **"Two residencies means two truths" — one truth for feed jobs.**
  Feed jobs have exactly one execution residency now. Definitions,
  instances, run records, and dataset records are D1-resident in
  both residencies (#6609), so no merge rule is needed: the
  workflow reads and writes the same stores the host reads.
- **"Nothing is foreclosed" — the option was exercised.** The
  provisioned workflow, binding, and start path were activated
  under #4171, the follow-up issue this document named, after its
  prerequisite (the outcome observer) was met.

## Scheduled silence — mechanism

The incident window: after the Nov 9, 2026 09:35 ET run of
`yahoo-nasdaq100-quotes` failed with `FEED_UNIVERSE_MISSING`, the
job's hourly scheduled firings left **no run records at all** until
the Nov 10 deploy — not failures, not successes, nothing.

**The firing path, as it stands.** `ScheduledAgent.getScheduledTasks`
returns `declarePipelineTasks`
(`src/agents/scheduledTasksPipeline.ts`): on a host without the D1
binding it returns `{}` with a warn log
(`job_pipeline.schedule_declarations_skipped_no_d1`) and declares
nothing; otherwise it builds one Think task declaration per registered
(job, node) schedule from `control.registerSchedules` over the ensured
definitions. Each task handler calls `dispatchScheduledPipelineJob`,
which — for a feed job, since #4171 — starts a `JobPipelineWorkflow`
instance carrying the firing's schedule id and the service login,
and for any other job dispatches `control.runJob(jobId, { trigger:
"scheduled" })` on the host. The handler's completion is deliberately
voided (`.catch(() => undefined)`) at the declaration boundary — a
throw there would invite a scheduler retry double-fire — so **the
run's own records are the firing's only failure surface**. A firing
that produces no record is therefore indistinguishable, from the
record surface alone, from a firing that never happened.

**Candidate mechanisms for the historical window — not discriminable
from code.** Three mechanisms are each consistent with the code that
was live in the window, and the code cannot say which one (or which
combination) produced the silence:

1. **Declarations absent on the then-live host** — if the host that
   owned the schedule had no DO SQLite storage, or its declarations
   never reconciled, there was nothing to fire: no handler ran, so no
   dispatch, no run, no record.
2. **Firings reached the runner and failed before any record existed**
   — pre-#3976, universe hydration lived in the feed *step*, which
   swallowed refresh failures (`.catch(() => undefined)`); a
   cold-universe firing could therefore fail before the runner ever
   reached its `record()` — the failure existed only as a swallowed
   rejection on a voided completion. This is the mechanism #3979
   removed: hydration now lives in the runners
   (`resolveUniverseListWithHydration`, `src/services/feedJobs.ts`),
   which record every failure mode by name
   (`FEED_UNIVERSE_REFRESH_FAILED`, `FEED_REFRESH_TIMEOUT`,
   `FEED_UNIVERSE_MISSING`).
3. **The host was never woken, so no firing occurred** — declarations
   reconcile when the host starts; a host that never started in the
   window declared nothing and fired nothing, leaving the same empty
   record surface as both mechanisms above.

Stating this plainly is part of the decision: the historical window is
**not** retroactively diagnosable, and no claim below pretends
otherwise.

**The live discriminator, going forward.** Since #3979 and PR-1..PR-4,
every firing that reaches dispatch settles and records, or fails by
name: refresh, fetch, and capture legs are bounded and named
(`FEED_REFRESH_TIMEOUT`, `FEED_FETCH_TIMEOUT`, `FEED_CAPTURE_TIMEOUT`),
the whole execution is bounded (`FEED_DEADLINE_EXCEEDED`, 240s), a
host restart settles host-resident orphans by name (#4002), a
workflow-resident run survives the host restart in its workflow, and
a declarations skip is a named warn log rather than an absence. A
future silent window is therefore itself an observable, named event —
declarations skipped, orphan settles, deadline settles — and a
recurrence of *unexplained* silence is a **new incident**,
investigated on its own evidence, not a reopening of this thread.

## Consequences

- **What stays true.** Feed runs execute in workflow residency,
  bounded per leg and whole-run, with exactly one terminal outcome
  per run and a truthful busy guard (PR-4). Host restarts settle
  host-resident orphaned runs by name (#4002) and leave
  workflow-resident runs to their workflows. The async-job
  executor's 90-minute deadline and stale reap remain the backstop.
  Non-feed pipeline jobs and chains remain host-resident.
- **What changed.** The ScheduledAgent host is the feed control
  plane and dispatcher, never the feed executor; the retired host
  residency refuses by name. The workflow binding's concurrency is
  sized at 32 for simultaneous multi-user invocations. The
  activation is pinned by `tests/feed_residency_decision_3992.test.ts`
  and `tests/feed_workflow_residency_4171.test.ts` — a future change
  that reintroduces host feed execution fails those suites until
  this document is amended in the same PR.
- **Revisit triggers.** Reopen the residency question — through a
  follow-up issue, not ad hoc — when any of these is observed:
  workflow-resident feed losses recurring despite the engine bounds;
  a requirement for feed runs that must exceed the 240s whole-run
  bound by design; or the remaining pipeline families (enrich,
  analyze, generate, deliver, chains) needing the same activation,
  which would be its own issue per family.
- **The split.** The activation lives in #4171 ("Workflow-residency activation for pipeline runs", sub-issue of #3992): the observer
  prerequisite, the externalized dispatch switch, the parity pins,
  the host-path retirement, and the concurrency sizing. The legacy
  `screener.feed` retirement stays with slice 7 (#5828).
