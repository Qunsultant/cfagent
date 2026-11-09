# Workflow runs provenance (#3810)

## The gap

The Workflow runs view rendered "Not recorded" / "Not recorded by
the source" for the trigger of MCP tool runs and other non-screen
runs, and "Not recorded" for their schedule. The rendering was
deliberate — the read model has an honesty rule ("a field the store
does not record is null, never invented; trigger is 'unknown' when
no store records one") — but the gap was in the DATA: no store
recorded the trigger or the schedule linkage for a run that had no
screen-outcome row. The trigger came only from `mas_job_outcomes`
(`triggerFromOutcome`), and saga chains carried no trigger field at
all ("audit payloads and projection rows carry no trigger field, so
it stays unknown").

## The fix

Provenance is stamped at submission onto the async-job row — the
J1 job model, no second ledger, no new table:

- `mas_async_jobs` gains three probed additive columns
  (`trigger`, `triggered_by`, `schedule_id`), in the same migration
  family as the graph columns and the stuck-alert stamp. Existing
  tables upgrade in place; legacy rows read as unprovenanced.
- A submission may carry `trigger` / `triggeredBy` / `scheduleId`
  (`AsyncJobGraphFields`). `submitAsyncJob` resolves them with
  `resolveJobProvenance`: explicit submission fields win; otherwise
  the payload's §4 `ledgerLinkage` (stamped by the follow-up
  planners) is the fallback — `manual`/`scheduled` map directly,
  `worker-cron` maps to `scheduled`, `async-chain` maps to NULL
  (the chain step inherits its trigger from the chain, never from a
  guess), `unknown` stays NULL.
- The projection (`runFromJobs`) reads the stamped columns first
  (`triggerEvidence`): a stamped trigger wins over every payload
  heuristic, with evidence ("Agent — recorded by <actor>" or
  "Agent — recorded on the run's job tree"). An invalid stored
  value is ignored.
- Schedule provenance (`scheduleProvenanceForJobs`) reads the
  stamped `schedule_id` before the payload's own hint (after the
  workflow-binding marker, whose precedence is unchanged).
- Saga chains use the trigger their entry carried: the saga's
  entry trigger rides its audit rows (`baseAudit`), and
  `buildSagaChainRuns` passes it through to `runFromSagaChain`.
  Without one the chain stays "unknown".
- Stamping sites: the MCP queue points (the turn adapter and the
  MCP handler — trigger `agent`, actor from the turn's acting
  identity when resolved) and the scheduled market-screen
  callback's shard submitter (the callback's own trigger +
  schedule id). A retry keeps the source row's provenance; the
  screener-run bridge stamps the outcome's trigger + schedule id.
- The panel distinguishes "none" from "not recorded": a run whose
  trigger is a non-scheduled origin (manual / agent / webhook)
  with no schedule shows "Not scheduled"; a scheduled / unknown
  trigger with no schedule evidence keeps "Not recorded"; a
  schedule object stamped "not-scheduled" (#3813's rule, kept
  from main) also renders "Not scheduled". A run
  that produced no documents and no artifacts renders "None" in
  the document cells; a recorded document failure still renders
  as a failure badge.

## Honesty rules (unchanged)

- A submission with no origin stays "unknown" — the fix stamps
  real provenance, never invents it.
- A run that was never scheduled shows "Not scheduled"; only data
  that should exist but doesn't shows "Not recorded".

## Deliberately not stamped

- The feed-snapshot API route (`POST /schedules/feed-snapshot`):
  its origin is ambiguous (an authenticated API submission, which
  may itself be schedule-driven), so its rows stay "unknown"
  rather than risk a wrong "manual".
- HTTP request jobs keep their existing treatment ("Submitted as
  an async API request") — the channel is evidence of how the job
  arrived, never a guess at its trigger.

## Out of scope (dependencies)

- End / duration / result for stuck rows: #3784's sweep (merged,
  undeployed) reaps/flags stuck rows so they get terminal states.
  This slice does not rebuild it.
- Job execution telemetry (heartbeat, executor failure capture):
  #3811.

## Files

- `src/types.ts` — `AsyncJobTrigger`, provenance fields on
  `AsyncJobGraphFields` and `AsyncJobRecord`.
- `src/data/asyncJobPorts.ts`, `src/data/doSqliteAsyncJobAdapter.ts`,
  `src/data/inMemoryAsyncJobAdapter.ts` — row type, probed
  columns, INSERTs, SELECTs.
- `src/agents/orchestrator/asyncJobs.ts` — `resolveJobProvenance`,
  submit stamping, retry preservation, bridge stamping.
- `src/services/workflowRuns.ts`, `src/services/workflowLifecycle.ts`,
  `src/agents/routes/workflowRuns.ts` — projection + route mapping.
- `src/agents/mcpAdapter.ts`, `src/mcps/openaimp/handler.ts`,
  `src/agents/orchestrator/scheduledCallbacks.ts`,
  `src/workflows/sagaWorkflowFlow.ts` — stamping sites.
- `src/client/WorkflowRunsPanel.tsx` — "Not scheduled" / "None".
- Tests: `tests/workflow_runs_3810.test.ts`,
  `tests/async_job_provenance_3810.test.ts`,
  `tests/workflow_runs_panel_3810.test.tsx`; pins updated in
  `tests/async_jobs_modes_1724.test.ts` (submission now carries
  the agent trigger) and
  `tests/async_jobs_step4a_census_2358.test.ts` (adapter
  statement count 37 → 40: the three probed columns).
