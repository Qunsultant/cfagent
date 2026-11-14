# 0031. Legacy shard chain per-stage scheduling is mooted by the workflow-host migration

- Status: Accepted
- Date: 2026-11-14
- Deciders: CTO lane (#CTO-mbshr), under #4426's explicit authorization to record the decision instead of building it
- Issue: Qunsultant/cfagent#4426 (sub-issue of Qunsultant/cfagent#4366)
- Implementing PR: Qunsultant/cfagent#4549 (this PR lands the decision, the scope statement, and its pin — no scheduling code)

## Context

- **Engine jobs already have per-stage scheduling.** A job definition addresses stages by node path (`JobScheduleConfig`, `scheduleStage` / `rescheduleStage`), and `POST /api/schedules/workflow-stages` creates one stage schedule, validated against the ScheduledAgent's job registry.
- **Chain stages are not engine nodes.** A legacy shard chain's stages (feed → generate → store → serve → deliver) are `mas_async_jobs` rows driven by the chain planner (`src/services/shardJobs.ts`); they have no schedule identity, and the stage-schedule route refuses them at registry validation because there is no job/stage to address.
- **No surface claims otherwise.** The Schedules home has no stage-creation form at all (#2329: stage creation is API + agent channels), so no UI presents a chain stage as schedulable today.
- **The chain's execution path is being replaced.** #4471 (shard-executor cutover onto the workflow host) is open in the chain's own programme, alongside #4470 (scheduled firer), #4450 (manual route) and #4451 (comparison). Once the chain's stages are workflow-host nodes, the engine's existing per-stage scheduling applies to them unchanged.
- Building chain-stage scheduling now would mean a **second scheduler**: a new per-stage schedule model keyed by chain stage, wired into the chain planner, with its own store, its own firing path and its own UI — on a component whose execution path is scheduled to move.

## Decision

- **Do not build per-stage scheduling for the legacy shard chain.** The gap is mooted by #4471: after the cutover, per-stage scheduling for those stages is the engine's existing mechanism, not a chain-specific one.
- **Route the migration question to the chain's programme** (#4471), recorded as a comment there, so its acceptance includes "the chain's stages are schedulable per stage through the existing engine path".
- **Keep the current state honest.** Engine job stages remain schedulable; chain stages are not, and no surface presents them as schedulable. If a surface later gains a stage-scheduling affordance, it must state the scope (engine job stages only) and point here until #4471 lands.

## Consequences

- Positive: one scheduling model for the whole platform; no scheduler built for a surface that is being replaced; no second schedule store to migrate or delete later.
- Negative and limits: an owner cannot schedule a single chain stage until the cutover lands. The interim workarounds are scheduling the whole chain (its existing schedule) or scheduling the engine stage the chain invokes (the per-symbol strategy screen is already an engine job).
- Detection: if the cutover stalls, this gap stays open and visible through this ADR; #4426 closes on the decision, not on the capability, and reopens as new work if the cutover is abandoned.
- Reversal: a new ADR superseding this one, recording that chain-stage scheduling is built on the chain as it stands.

## Alternatives considered

1. **Build a chain-stage scheduler now** (schedule identity per chain stage, planner support to run one stage, Schedules support). Rejected: a parallel scheduler on a component being replaced; #4471 would inherit its decommissioning, and the two models would drift in the meantime.
2. **Map chain stages onto synthetic engine jobs** purely to inherit scheduling. Rejected: a fake engine job per chain stage is a second model wearing the first one's clothes — it changes the chain's run records and its provenance for no capability the cutover does not deliver properly.
3. **Do nothing and leave the gap undocumented.** Rejected: an owner asking "can I schedule the enrich stage?" deserves a recorded answer with a reason and a routing, not silence.

## References

- Per-stage scheduling today: `JobScheduleConfig`, `scheduleStage`/`rescheduleStage` (`src/services/jobPipelineEngine.ts`), `POST /api/schedules/workflow-stages` (`src/agents/routes/schedules.ts`), `createStageSchedule` (`src/client/jobsApi.ts`).
- The chain as it stands: `src/services/shardJobs.ts`, `src/services/shardExecutors.ts`.
- The cutover: #4471, #4470, #4450, #4451.
