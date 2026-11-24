# 0029. One unified schedule store, one run ledger, one management path

- Status: Accepted
- Date: 2026-11-11
- Deciders: owner (authorisation 2026-11-11 ~08:54 EST, "first complete the remaining changes")
- Issue: Qunsultant/cfagent#3123 (sub-issue of Qunsultant/cfagent#3121)
- Implementing PR: this PR (main commit recorded on merge)

## Context

Scheduling consolidation (#3121) landed S0–S6 with the capability
surface unified (§8 home, one UX, one engine, one agent, one
workflow) but the persistence and management layers still
duplicated per kind: six schedule stores (SDK `cf_agents_jobs`
alarms, `paused_schedules` copies, the ScheduledAgent `goals` KV
key, D1 chain tables, the per-kind in-memory lists, the worker
config-only duties), a run ledger split across two stores
(OrchestratorAgent DO SQLite `job_run_records`, cap 100/job, and
ScheduledAgent DO KV `jobRunRecords`, cap 500 total) with two
endpoints merged client-side, and ten management code paths behind
two client modules (`jobsApi.ts` vs `scheduleApi.ts`) plus
direct-fetch clients.

Two verified facts shape this decision:

1. Worker crons are OFF on current main (`wrangler.jsonc`, #4112):
   all three triggers are commented out, "nothing fires". The
   unified store must therefore be trigger-agnostic — it stores
   records and evaluation is a pure function over the store — and
   must not re-enable crons. The S5 named entry points
   (`src/services/consolidatedCronEntries.ts`) stay the dispatch
   targets; restoring firing is an uncomment, not a code change.
2. Pause was a copy: pausing cancelled the SDK schedule and stored
   a record in `paused_schedules`; resuming re-created a NEW
   schedule id. That copy-and-recreate churn broke record identity
   across pause/resume cycles.

## Decision

- One `ScheduleStore` port (`src/data/unifiedSchedulePorts.ts`):
  one record model, kinds `screen | goal | followup |
  worker-duty`, states `active | paused | disabled`, table
  `unified_schedules`, DO SQLite adapter + in-memory test double +
  factory, following the existing port pattern
  (`PausedScheduleStore` / `ChainScheduleStore` /
  `JobRunRecordStore`).
- Pause is a record state, not a copy. Resume re-arms the SAME
  record id. The Agents SDK `schedule()` takes no id parameter
  (verified in `node_modules/agents/dist/` — the id is
  SDK-assigned), so the SDK alarm id rides the record as
  `alarmId`, updated on every re-arm; legacy SDK-only schedules
  keep their SDK id until touched (adoption on touch).
- Physical placement follows ADR D-0 (a record lives in the same
  DO as its mechanism): OrchestratorAgent instances host
  screen/followup/worker-duty records; the ScheduledAgent hosts
  goal records. One port, one schema, one adapter — placement by
  ownership. The Agents SDK scheduler's `cf_agents_jobs` stays the
  alarm substrate (framework-owned, cannot be replaced); the D1
  chain tables stay a projection, not the live store.
- The goals KV key migrates into the store: one-way KV→store
  import for ids missing from the store (store wins on conflict),
  `DEFAULT_SCHEDULES` seeded only when the store is empty, the KV
  key never written again. No-SQL hosts keep the KV path as a
  fallback that never breaks.
- One run ledger: `recordLedgerRun` is THE single DO-SQLite write
  entry for `job_run_records`; the ScheduledAgent KV half is
  migrated to the OrchestratorAgent DO SQLite store (P-A) via the
  existing ScheduledAgent → OrchestratorAgent stub channel, with
  the legacy KV as a never-throw fallback so recording never breaks
  a tick. Existing KV rows keep reading through the one merged
  read (`GET /api/ledger/runs`, newest-first, dedup on
  jobId+started+operation). `mas_async_jobs` stays the async-job
  execution record and `mas_job_outcomes` stays the outcome sink
  (recorded scoping decision — "one ledger" does not merge those
  tables; D1 pipeline run records stay in D1, Qunsultant/cfagent#4124).
- One management service (`src/services/unifiedScheduleManagement.ts`):
  pure domain over ScheduleStore + alarms port, behind both route
  families; routes stay thin adapters; clients converge onto
  `jobsApi.ts` (`listAllRuns` is the one merged read).
- Worker duties are records: `workerDutiesFromInventory()` is a
  pure projection of `WORKER_CRON_TRIGGERS_INVENTORY` (kind
  `worker-duty`, state `disabled`), exposed additively on
  `GET /api/schedule/systems`.
- Maintenance wipe preserves its semantics: it clears paused
  records only (`clearPaused()`), never active ones.
- Five duplicated modules retire by deprecation rename only
  (`foo.ts` → `foo.deprecated.ts`, same directory, imports updated
  in the same slice), with ledger entries at
  `docs/architecture/transition/deprecations.md`. Zero deletions
  (gitops §22).

## Consequences

- Before/after counts (published on Qunsultant/cfagent#3123):
  schedule stores 6 → 1 logical store; ledger writers 10 → 1
  write entry (`recordLedgerRun`) + the unchanged async-job/outcome
  sinks; management code paths 10 → 1 service; ledger read paths
  7 → 1 merged read (`listAllRuns` / `GET /api/ledger/runs`).
- Record identity is stable across pause/resume; the list-item id
  is the record id, not the SDK alarm id.
- Cron-dispatch rows (written to the shared OrchestratorAgent
  instance, previously invisible in the UI) become visible via the
  goal half of the merged read — this aligns with the #3121
  live-proof need (a signed-in ledger showing one cron-dispatch
  row).
- No capability, timing, firing-time, cron-expression, or payload
  change; no new schedule kinds, timing forms, or surfaces.
  Worker crons stay OFF.
- #3122's build sits on this store (its surface is deterministic
  and agent-usable; no agent judgment inside the store).

## Alternatives considered

- Keep the KV half and merge only at read time: rejected — the
  split write path is the duplication the issue names, and two
  write caps (100/job vs 500 total) cannot be reasoned about as
  one ledger.
- Merge `mas_async_jobs` and `mas_job_outcomes` into the one
  ledger: rejected and surfaced as a scoping decision — those
  tables are the async-job execution record (S4 design) and the
  outcome sink, not run-ledger rows; merging them would change
  the chain/outcome contracts.
- Give the SDK `schedule()` an id parameter to carry the record
  id: not possible — the SDK assigns the id; the record carries
  the alarm id instead.
