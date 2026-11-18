# Recording — one runs ledger, one source of truth (S6, #5085)

Observability program #5080, slice S6. Issue
[Qunsultant/cfagent#5085](https://github.com/Qunsultant/cfagent/issues/5085).
PR: (see the §15 report on #5085). `#CISO-bhdm`

## The problem

Three views could disagree about whether a run happened:

- the **runs ledger** (run rows),
- the **Audit Vault** (agent-event records),
- the **Loop status** on the Stock Copilot panel (lastCycle / neverExecuted).

The #4001 incident is the shape: the copilot cycle fired (events in
the Audit Vault, status ok, no trades, no errors) but the ledger had
no Stock rows, there was no lastCycle, and no named failure. The
Loop status read the activity table for lastCycle and used the
ledger only as a neverExecuted corroboration, so a cycle that wrote
a ledger row but no activity record showed "never executed" with no
lastCycle, and an activity record with no ledger row showed a live
lastCycle. The two stores could disagree in both directions.

## The decision

**The runs ledger is the source of truth for "did the run happen".**
The Audit Vault records the authorisation / attribution of the run
(audit, not recording). The Loop status reads the ledger (never a
second store).

## One run-row model

`JobRunRecord` (`src/data/jobRunRecordPorts.ts`, built by
`buildJobRunRecord` in `src/services/jobRunRecords.ts`): job id, run
id (the record's own identity), system
(`orchestrator-schedule` / `job-pipeline` / `worker-cron` /
`scheduled-agent-goal`), operation, started / finished, outcome
(three-valued: success / failure / skipped), trigger vocabulary,
§4 linkage fields (trigger / scheduleId / asyncJobId / workflowId),
provenance (brokerId / dataProviderId / mode / modeSource), and
result / dataset / artifact refs. A run with no artifact still
records its job/run ids (the #4002 rule — #4015 / #4018).

## One ledger

One write entry: `recordLedgerRun` (`src/services/unifiedLedger.ts`,
which builds via `buildJobRunRecord`, then stores). The schedule
callbacks write through `recordScheduleCallbackRun`
(`src/agents/orchestrator/scheduleCallbackRunRecords.ts`); the
ScheduledAgent goals write through `recordJobRun`
(`src/agents/scheduled-agent.ts`); the agent-schedule executor
writes through its `recordLedger` dep, which S6 routed through
`recordLedgerRun` (it previously called `ledgerStore.record`
directly — the one direct bypass the S6 grep found, in
`src/services/agentScheduleCapability.ts`). Grep proof (run at PR
time): the only `SqlJobRunRecordStore.record` call in `src` is
inside `recordLedgerRun` itself (`unifiedLedger.ts`), plus the D1
residency exception below.

One physical ledger: the OrchestratorAgent Durable Object SQLite
`job_run_records` table (`SqlJobRunRecordStore`,
`src/data/doSqliteJobRunRecordAdapter.ts`), per-job cap 100 rows.
The D1 `job_run_records` table is a read replica fed by the
projector (`src/services/runLedgerProjectionPosting.ts`); the D1-only
read seam is `src/services/runLedgerReads.ts` (modes d1-only vs
merged, default merged). The ScheduledAgent side stores the same
record shape under its own DO KV key `"jobRunRecords"` (transport
fallback until the service user is configured; merged on read).
`mas_async_jobs` stays the async-job execution record;
`mas_job_outcomes` stays the outcome sink — neither is a second
runs ledger. Known exception, filed as #4124 (a sub-issue of
#3123, recorded in `unifiedLedger.ts`): the D1 pipeline residency
(`D1JobRunRecordStore`) writes directly to D1 because the workflow
residency has no DO sql handle — those pipeline runs land in D1
only, not in the DO ledger. S6 does not rebuild that; it is
documented here as the one known second write path.

## The three views, reconciled

- **Runs ledger** — the source of truth. The Jobs runs view
  (`?tab=schedules&view=runs`, `ScheduleRunLedgerPanel`) reads the
  one ledger model via the established read paths (`mergeLedgerRuns`
  / `SqlJobRunRecordStore.listRecent`).
- **Audit Vault** — records who authorised the run and whether it
  was allowed. It reads `mas_events`, the orchestrator's older
  agent-event record — S6 does NOT re-point it (that is #5264's
  decision, filed as [Out-of-Scope] under #5080). The canonical
  audit surface S5 proved is the IAAA Admin Overview Audit events
  view, which reads the canonical IAAA audit store.
- **Loop status** — reads the ledger. `lastCycle` is a projection
  of the newest copilot cycle ledger row
  (`src/services/stockCopilotLedger.ts`:
  `latestCopilotCycleLedgerRow` + `projectCopilotLedgerRowToLastCycle`),
  across both job ids the cycle can carry
  (`stock-copilot-paper-cycle`, `callback:stock-copilot-paper-cycle`).
  `neverExecuted` is simply "no ledger row". The activity table
  stays as the "Cycle activity" detail feed; it is not the liveness
  proof. The three readers (REST status route, mesh door,
  introspection `lastCycleStatus`) all follow the ledger.
  `recentCyclesCount` / `refusals` stay activity-based — they are
  feed stats, not liveness.

## The outcome class rides the ledger row

The cycle mapping (`copilotCycleLedgerOutcome`,
`src/services/scheduleWatchdog.ts`) writes a descriptor naming the
class for an ok cycle — "cycle complete: traded" when the cycle
placed at least one entry or exit, "cycle complete: no trade"
otherwise — so the Loop status can render the panel badge from the
row alone. Refusal classes ride the detail, kept byte-identical
for the #3788 pin (`cycle refused: <status>`,
`cycle outside_enabled_sessions`, `cycle paused`, `cycle disabled`);
the projection reads the descriptor first, then the detail
("inactive" is checked before "refused" because the inactive-broker
detail reads "cycle refused: inactive_broker"). Legacy rows whose
descriptor is the bare "cycle complete" fall back to the ledger
outcome (success → no_trade, skipped → inactive, failure →
refused) and are documented as such.

## A failed ledger write is named

One shared namer, `nameLedgerWriteFailure`
(`src/agents/orchestrator/scheduleCallbackRunRecords.ts`): every
`recordScheduleCallbackRun` site names the failure — the copilot
site with an explicit `onRecordFailure` hook (event type
`stock_copilot.ledger_write_failed`, preserving the #4001 pin);
the nine orchestrator schedule-callback sites pass their `audit`
sink and the namer applies BY DEFAULT with
`schedule.ledger_write_failed`. The default (not a per-site hook
in `orchestrator.ts`) is what keeps that file at the #992 line
budget of 3325: a per-site namer method + nine hook arguments
pushed it to 3338 lines and failed the standing inventory gate.
A site with neither a hook nor an audit sink still gets the
OBS-1020 log floor in `storeRecord` (named, never silent), just
no audit event. The namer audits the failure (code
`ledger_write_failed`, job id, operation, error) AND logs a
coded **OBS-1020** structured-log line — the queryable signal.
The hook never breaks the callback (a throwing audit is swallowed;
the structured logger never fails its caller).

The watchdog sweep (`src/agents/scheduled-agent.ts`) wires the
same namer at its two write sites (the missed-fire claim write and
the heartbeat write) via `recordJobRun`'s new optional failure
hook + boolean return: a failed claim write is named and the goal
is skipped that tick, so the finding recurs next tick and the claim
is retried rather than alerting without a claim. (The sweep's old
`catch { continue; }` could never fire — `recordJobRun` already
swallowed its own failures internally — so the claim failure was
doubly silent; S6 names it at the swallow point.)

The #4921 KV marker sink is the follow-up mechanism for naming a
failure the SQL path cannot report at all — mentioned here, not
built here. #4921 is its own fix issue, queued separately.

## Coded messages and config

- **OBS-1020** `otel.ledger.write_failed` — a runs-ledger write
  failed and was named (audited + logged) instead of vanishing
  silently. Added to `src/observability/otelMessages.ts`; severity /
  rule mapping lands with the S7 catalog (#5086), as with the S4
  codes.
- No new config in S6. Retention of run rows lives in config
  through the S7 config port (#5086) — S6 invents no second config
  catalog. The per-job 100-row cap is the pre-existing store cap,
  unchanged.

## What S6 deliberately did NOT do (residuals)

1. **No `job_run_records` DO→D1 projector.** In d1-only read mode
   the runs view does not show DO-written `job_run_records` rows
   (including copilot cycles) — there is no projector for that
   table (the #4116 reconcile sweep covers `mas_reports` +
   `mas_async_jobs` only). Building one is a new projection
   capability, a separate slice. The runs-view work in S6 is
   verifying by test + grep that the runs view reads the one ledger
   model via the established read paths, and documenting the homes
   honestly here.
2. **ScheduledAgent goal-run recording failures stay silent.**
   `recordJobRun`'s failure hook exists now, but only the sweep's
   two sites wire it. The goal-run sites (goal firings, one-shot
   firings) keep the KV fallback — a row is lost only when BOTH the
   ledger post AND the KV put fail — and that double failure is
   still swallowed. Wiring the namer there is a one-line-per-site
   follow-up.
3. **The Audit Vault still reads `mas_events`** (#5264) and the
   #1688 audit REPORT family stays as-is (a projection of different
   events) — both recorded in the S5 decision doc, unchanged by S6.
4. **A step span is a root span** (S3 seam honesty, unchanged).
