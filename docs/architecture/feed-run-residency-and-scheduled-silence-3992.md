# Feed-run residency and scheduled-silence decision (#3992 PR-5)

Issue #3992, PR-5 of 5 — the closing slice of the repair for the #3976
stuck-run incident. PR-1 shipped the timeout catalogue and the race
helper, PR-2 bounded the universe-refresh leg, PR-3 bounded the
provider-fetch legs and the run-record write, PR-4 bounded the run as a
whole. This document records the two questions those PRs deliberately
left open: where a production pipeline/feed run physically executes
(its residency), and why the scheduled firings in the incident window
left no records (the scheduled silence). **No behaviour change** — this
is the decision record, pinned by
`tests/feed_residency_decision_3992.test.ts`. Change the code, change
this document in the same PR.

## Decision

**STAY.** Production pipeline and feed runs remain resident in the ScheduledAgent host.
Dispatch (panel, schedule, Copilot) enters through
the ScheduledAgent Durable Object's `runPipelineJob` door
(`src/agents/scheduled-agent.ts:706`), which builds the host control
plane via `createScheduledAgentPipelineControl`
(`src/agents/scheduledTasksPipeline.ts:437`) and runs
`JobPipelineControl.runJob` in-process — the completion promise lives
and settles inside the host instance.

The `JobPipelineWorkflow` residency (`src/workflows/jobPipelineWorkflow.ts`)
remains provisioned and uncalled. It is not deleted: the binding, the
workflow class, and the start path stay in place so the option remains
real. Activation, if ever justified, happens ONLY under the follow-up
issue **"Workflow-residency activation for pipeline runs"** (a
sub-issue of #3992, filed alongside this PR) and only after that
issue's prerequisites are met — chief among them closing the
feed-outcome boundary named in Evidence below. No other change may
start dispatching production runs to the workflow residency.

## Evidence

Every claim below was re-verified against the tree this document
ships in; the greps are stated so the check is repeatable.

- **Zero production callers of the workflow start path.** In `src/`,
  `startPipelineJobWorkflow` is referenced only at its definition
  (`src/agents/scheduledTasksPipeline.ts:670`) and at the Durable
  Object door that wraps it (`src/agents/scheduled-agent.ts:1153`,
  import at `:96`). The only `JOB_PIPELINE_WORKFLOW.create(...)` call
  sits inside that same start function (`scheduledTasksPipeline.ts`,
  the `workflow.create` call after the binding is read at `:681`); the
  `ctx.startWorkflow` seam (declared at `scheduledTasksPipeline.ts:150`)
  is never assigned anywhere in `src/` — a scan for `startWorkflow`
  followed by `:` or `=` finds no assignment. The pin suite re-runs
  this scan on every CI run, so a future caller fails loudly here
  first.
- **Host eviction losses are settled and named, not silent (#4002).**
  `ScheduledAgent.onStart` (`src/agents/scheduled-agent.ts:687`) calls
  `settleOrphanedPipelineRuns` (`src/agents/scheduledTasksPipeline.ts:547`),
  which delegates to `JobPipelineControl.settleOrphanedRuns`
  (`src/services/jobPipelineEngine.ts:745`): every instance still
  marked `running` when the host starts — a state no live executor can
  be in, because a live run cannot survive its host's death — is
  settled as failed with a named orphan error, a terminal run record,
  and a published transition, and the job is dispatchable again.
  Pinned by `tests/pipeline_orphan_settle_4002.test.ts` and
  `tests/pipeline_orphan_settle_host_4002.test.ts`.
- **The #3992 bounds are residency-independent.** PR-1's catalogue
  (`FEED_JOB_TIMEOUTS`, `src/services/feedJobTimeouts.ts`), PR-2/PR-3's
  leg races (the runners in `src/services/feedJobs.ts`), and PR-4's
  whole-execution race (`src/services/jobPipelineEngine.ts`, settling
  failed with `FEED_DEADLINE_EXCEEDED` past
  `FEED_JOB_TIMEOUTS.executionMs` = 240s) all live in the shared engine
  and the shared composed step registry that both residencies build.
  Neither residency's deps builder sets `feedExecutionDeadlineMs` —
  not the host's `createScheduledAgentPipelineControl`
  (`scheduledTasksPipeline.ts:437`) and not the workflow's
  `createJobPipelineWorkflowDeps` (`src/workflows/jobPipelineWorkflow.ts:183`) —
  so the catalogue default of 240s applies identically in both.
  Moving residency would neither strengthen nor weaken a single bound.
- **The workflow residency's feed-outcome boundary (current truth).**
  The boundary has narrowed since #3530 slice B, and what remains is
  precise. The feed *pull* itself is wired in the workflow residency
  (#3941): `createJobPipelineWorkflowDeps` composes the same step
  registry, with the feed step's provider built by the capture factory
  over D1 stores, so a feed run dispatched there executes and records
  its dataset rows. The Data Providers panel's per-job status also
  reads residency-neutral stores (the dataset adapter plus the control
  plane's job view, assembled by the ScheduledAgent door at
  `src/agents/scheduled-agent.ts:830` via `buildFeedJobSurfaceView`).
  What the workflow residency does **not** write is the settled-run
  *outcome* — the Job outcomes rows the Autopilot Control Center
  reads. Those are produced by the engine's `runSettledObserver`
  (`src/services/jobPipelineEngine.ts:224`, invoked at `:1611`), which
  only the host's deps builder supplies
  (`runSettledObserver: feedRunSettledObserverFor(ctx)`,
  `scheduledTasksPipeline.ts:448` — it doors the settled outcome to the
  shared Orchestrator instance's `recordFeedJobOutcome` sink). The
  workflow deps builder omits `runSettledObserver` entirely, so a
  workflow-resident feed run would settle with **no outcome row**: the
  exact "ran but invisible" failure this programme exists to end.
  Closing that gap is a stated prerequisite of the follow-up issue.
- **The executor backstop is unchanged.** The manual Run-now path
  rides the async-job executor, whose own defences sit behind the
  pipeline bounds: the max-runtime execution deadline
  (`createExecutionDeadline`, `src/agents/orchestrator/asyncJobs.ts:1111`;
  `ASYNC_JOB_MAX_RUNTIME_MINUTES`, default 90 minutes, `:1090-1091`)
  plus the heartbeat/stale reap (#3907, same file). Nothing in this
  decision touches them; they remain the designed backstop, two orders
  of magnitude above the 240s pipeline bound.

## Why not move

- **What moving would buy is small, now.** The workflow residency's
  distinctive gain is durable step-resume: an execution that survives
  its host. After PR-1..PR-4, every production feed execution is
  bounded at 240 seconds whole-run, with each leg bounded tighter
  (refresh 30s, fetch 60s, capture 30s). The window in which durable
  resume could rescue a run is a four-minute, already-named failure —
  and when the host does die mid-run, #4002's orphan settlement turns
  the corpse into a named, recorded failure the operator can re-run,
  rather than a silent loss. Resume would convert some of those named
  failures into silent successes; that is worth little against the
  costs below.
- **The outcome surface is host-shaped today.** Activating the
  workflow residency before closing the boundary in Evidence means
  feed runs that execute correctly and are invisible in the Job
  outcomes feed — a regression into exactly the incident class #3976
  was filed for. The prerequisite is not paperwork; it is the
  difference between a run the operator can see and one they cannot.
- **Two residencies means two truths to reconcile.** Definitions are
  mirrored into the workflow residency through the control plane
  (`startPipelineJobWorkflow` mirrors before `create`), instances and
  run records live in different stores per residency (DO SQLite on the
  host, D1 in the workflow), and every status surface would need a
  merge rule for which residency's record wins. That reconciliation
  machinery is permanent complexity purchased to serve runs that are
  now bounded at four minutes.
- **Nothing is foreclosed.** The workflow, its binding, and its start
  path stay provisioned and honest (the start path refuses by name,
  `job_pipeline_workflow_not_configured`, when its bindings are
  absent). If the revisit triggers in Consequences fire, the follow-up
  issue activates a residency that already exists instead of building
  one under incident pressure.

## Scheduled silence — mechanism

The incident window: after the Nov 9, 2026 09:35 ET run of
`yahoo-nasdaq100-quotes` failed with `FEED_UNIVERSE_MISSING`, the
job's hourly scheduled firings left **no run records at all** until
the Nov 10 deploy — not failures, not successes, nothing.

**The firing path, as it stands.** `ScheduledAgent.getScheduledTasks`
(`src/agents/scheduled-agent.ts:671`) returns
`declarePipelineTasks` (`src/agents/scheduledTasksPipeline.ts:747`):
on a host without DO SQLite storage it returns `{}` with a warn log
(`job_pipeline.schedule_declarations_skipped_no_storage`) and declares
nothing; otherwise it builds one Think task declaration per registered
(job, node) schedule from `control.registerSchedules` over the ensured
definitions. Each task handler calls `dispatchScheduledPipelineJob`
(`scheduledTasksPipeline.ts:641`), which ensures the job definitions
and calls `control.runJob(jobId, { trigger: "scheduled" })`; the
handler's completion is deliberately voided (`.catch(() => undefined)`)
at the declaration boundary — a throw there would invite a scheduler
retry double-fire — so **the run's own records are the firing's only
failure surface**. A firing that produces no record is therefore
indistinguishable, from the record surface alone, from a firing that
never happened.

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
   (`resolveUniverseListWithHydration`, `src/services/feedJobs.ts:617`),
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
host restart settles orphans by name (#4002), and a declarations skip
is a named warn log rather than an absence. A future silent window is
therefore itself an observable, named event — declarations skipped,
orphan settles, deadline settles — and a recurrence of *unexplained*
silence is a **new incident**, investigated on its own evidence, not a
reopening of this thread.

## Consequences

- **What stays true.** Production feed/pipeline runs execute in the
  ScheduledAgent host, bounded per leg and whole-run, with exactly one
  terminal outcome per run and a truthful busy guard (PR-4). Host
  restarts settle orphaned runs by name (#4002). The async-job
  executor's 90-minute deadline and stale reap remain the backstop.
  The workflow residency stays provisioned, uncalled, and pinned as
  such by `tests/feed_residency_decision_3992.test.ts` — any future
  production caller of its start path fails that suite until this
  document is amended in the same PR.
- **Revisit triggers.** Reopen the residency question — through the
  follow-up issue, not ad hoc — when any of these is observed:
  production run losses attributable to host eviction recurring
  despite #4002 settlement (i.e. the re-run cost becomes the problem,
  not the visibility); a requirement for runs that must outlive the
  host or exceed the 240s whole-run bound by design; or a second
  outcome surface that makes dual-residency reconciliation cheap
  enough to be boring.
- **The split.** Implementation of any move lives in the follow-up
  issue **"Workflow-residency activation for pipeline runs"**
  (sub-issue of #3992): prerequisites are the feed-outcome observer
  wired in the workflow deps (closing the boundary in Evidence), a
  dual-residency status merge rule, and pins proving an activated
  run is visible on every surface a host-resident run is. Until then,
  this decision stands.
