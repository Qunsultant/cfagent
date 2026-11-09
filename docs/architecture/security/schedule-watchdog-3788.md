# Schedule watchdog (#3788)

Parent incident: #3781 (chat copilot invented an order price). This slice
answers the RCA question "is a schedule that silently never runs
detectable at all?" — before it, the answer was no: a goal that never
fired was readable only if someone opened the goals panel and read
"never", and some firings left no ledger record at all.

## What the watchdog is

One decision core (`src/services/scheduleWatchdog.ts`, pure) consumed
from the two ticks that already exist — no new scheduler, no new store,
no fourth schedule system:

- **ScheduledAgent goals** — `ScheduledAgent.onCron` runs
  `runScheduleWatchdog` at the end of every tick, after the due-goal
  loop (so runs recorded on this tick are visible).
- **Orchestrator durable schedules** — `watchdogMissedSchedules`
  (`src/agents/orchestrator/scheduleWatchdog.ts`) runs on the same
  15-minute sweep tick as #3784's stale-async-job sweep, armed the
  same way in `onStart`. One tick implementation, two consumers — if
  watchdog and sweep ever share machinery, it is one implementation
  consumed by both, never built twice.

## Finding rules

- **Expected tick.** Each enabled schedule's most recent expected tick
  comes from `previousCronTickMs` (`src/schedule.ts`), which mirrors
  `isDue`'s matching rules exactly — a schedule the firing predicate
  can never fire is never flagged as missed.
- **Grace.** A finding fires only when now is past expected tick +
  grace. Grace is `MISSED_SCHEDULE_GRACE_MINUTES` (named env var,
  built-in default 60 minutes, `0` disables the watchdog entirely);
  this slice sets NO production value. The grace absorbs the Worker
  30-minute tick granularity and ordinary platform jitter.
- **First seen.** A schedule first observed after its expected tick
  (just created, or first observed by this deploy) is never flagged
  for that tick. The watchdog attributes a miss only to a schedule
  that existed when the tick passed. First-seen maps live in each
  agent's own storage under `scheduleWatchdogFirstSeen`, pruned to
  live schedules — so a pre-existing goal's first alert comes after
  its next expected tick, not on the deploy tick. If first-seen
  storage itself fails, the watchdog fails closed: a finding with no
  first-seen stamp is never emitted (the miss is unattributable),
  though the tick still runs and heartbeats. An unparseable cron is
  the one exception: it is flagged regardless, because the defect is
  the cron itself, not an attributed tick.
- **Run clears the miss.** A run record at or after the expected tick
  — or a goal's `lastRun` stamp where the record aged out of the cap —
  clears it. A failed run still counts as a firing (its failure is
  already recorded as a failure; the watchdog is about never-firing,
  not failing). Disabled schedules never alert.
- **Unparseable cron.** An enabled goal whose cron is unparseable can
  never fire at all: it is flagged at once as `invalid_cron` (no
  expected tick, no first-seen gate — the defect is the cron itself).
- **Exactly-once.** The missed-fire ledger record IS the claim,
  written first (claim-first, the #2567 precedent): its `started` is
  the watchdog tick, after the expected tick, so the next evaluation
  sees a run at/after the tick and stays silent. No second claim
  store exists. A sweep that cannot write the claim alerts nothing
  for that row this tick and retries on the next one.

## The three signals (every missed fire, claim-first in ledger order)

1. **Runs-ledger record** — outcome `skipped`, detail
   `missed-fire: expected <ISO> (last run: <ISO>|never)` (or
   `invalid-cron: <cron> never matches; goal cannot fire`). Skipped
   is the ledger's value for "no run happened"; `buildJobRunRecord`
   accepts it — no fourth outcome is invented anywhere.
2. **Durable audit event with a code, never a raw message** (#1743) —
   goals: `schedule.goal.missed_fire` (code `missed_fire` /
   `invalid_cron`, with `expectedTick` and `lastRun`) through the
   goal-lifecycle sink; durable schedules: `schedule.missed_fire`
   (same shape); delivery: `schedule.missed_fire_alert` /
   `schedule.missed_fire_alert_failed` on the orchestrator hook.
3. **Slack alert** through the existing `postSlackText` seam
   (webhook first, bot token second), rendered from the catalog
   template `missed_schedule_alert` (legacy twin
   `legacy_missed_schedule_alert`, #2975 pattern).

The watchdog never stamps `lastRun` (a missed fire must not suppress
the next evaluation) and never fails its tick: per-goal/per-row
try/catch, and a Slack failure is a tick error, not a tick failure.

## Heartbeat (Worker cron triggers)

Worker cron triggers are deployment-only and have no per-trigger
watchdog. The watchdog's own heartbeat record each tick makes a dead
tick path visible: goals side, one ledger row per `onCron` (job
`schedule-watchdog-heartbeat`, outcome `success`,
`examined=N missed=M`); orchestrator side, one row per sweep
(operation `schedule.watchdog_sweep`, with `skippedUnrecorded`
added). **No heartbeat in 24h means the tick path itself is dead.**
A grace of `0` disables the watchdog entirely: no findings, no
heartbeat (a disabled watchdog is an operator choice, recorded here,
not a dead tick — do not confuse the two).

Heartbeat/cap trade-off (goals side): the heartbeat shares
`SCHEDULED_AGENT_JOB_RUN_CAP` (500, newest-first across all goals)
with goal runs — ~48 heartbeat rows a day against roughly 7 days of
retained history at current goal volume. The 50-entry `tickHistory`
stays the short-term proof either way. The orchestrator ledger
prunes per job, so its heartbeat never evicts other jobs' records.

## Per-firing-type ledger coverage

| Firing type | Ledger record | How |
| --- | --- | --- |
| ScheduledAgent goal firing (terminal point) | Yes | `recordGoalRun` in `onCron` (pre-existing, #2964) |
| Orchestrator creatable callback (4) | Yes | Method wrappers (pre-existing, #2964) |
| Orchestrator internal-only callback (4 — see `RECORDED_SCHEDULE_CALLBACKS` in `src/agents/orchestrator/scheduleCallbacks.ts`) | Yes since #3788 | Method wrappers added here, mirroring the creatable four; the trigger route treats them as self-recording so manual triggers record exactly once |
| Copilot Think task firing | Yes since #3788 | `recordScheduleCallbackRun` around the cycle; `ok` → success, every refusal state → skipped with the cycle status as detail |
| Copilot Think task non-declaration | Audit only | `stock_copilot.not_declared` with cause class `flag_off` / `no_login_context` / `context_error`, deduped on change of cause class (or 24h) in agent storage |
| Copilot cycle early return (no SQL) | Audit only | `stock_copilot.no_sql_storage` with code `no_sql_storage` |
| Copilot cycle failure (handler) | Audit only (+ failure ledger row when the cycle itself threw after the wrapper engaged) | `stock_copilot.cycle_failed` with an error code (`cycle_failed` default); the handler still never throws (no retry double-fire) |
| Worker cron trigger firing | Heartbeat only | Deployment-only; the watchdog heartbeat is the proof the tick path lives |
| Framework sweep callbacks (`sweepStaleAsyncJobs`, `sweepStaleLedgerTasks`, `watchdogMissedSchedules`) | **Named gap, no per-run record** | They return sweep-result objects, not callback outcomes, so the outcome-reporting recorder needs mapping surgery of its own (follow-up slice). Their firing is observable via their effects (rows transitioned, tasks closed, heartbeat rows), and the watchdog skips them by name — counted as `skippedUnrecorded` — rather than flagging schedules it cannot observe |

## Named non-findings (deliberate, not silent)

- **`opportunity-hunt` (`0 */6 * * *`, no timeZone).** Its cron is
  valid per the zoned parser but never due per the preserved
  no-timeZone quirk in `isDue` (documented in `src/schedule.ts`).
  `previousCronTickMs` mirrors the firing predicate, so the watchdog
  never flags it. Fixing the cron is a separate decision, not part
  of this slice.
- **A valid cron with no tick inside the 8-day scan window** (e.g.
  monthly): no attributable tick yet, never alerts.
- **A stuck interval schedule** whose SDK `time` never advances
  alerts once (one expected tick, one claim). Recovery is visible
  when it fires again; the ledger record persists as the visible
  state in between.

## #1819 goals

The resource rollup / cap-alert / comparison goals are just goals:
the same mechanism covers them, proven in test with a
`resource-daily-rollup` id (`tests/scheduled_goals_watchdog_3788.test.ts`).
Their firing state is provable from the same surface (runs view /
ledger) as every other goal. Note the alert branch still never stamps
`lastRun` by design — the watchdog reads the run record, not
`lastRun`, so hourly alert goals are covered.

## Relationship to sibling slices

- **#3784 (stuck alert without polling):** sibling, not duplicate.
  The watchdog rides the same 15-minute tick and the same Slack seam;
  the sweep is one implementation consumed by both. #3784 is about
  jobs completing/failing visibly; this slice is about schedules
  firing and being observable.
- **#3811 (job execution telemetry):** the watchdog READS run records
  and builds no heartbeat/progress/executor telemetry of its own.
- **#3787 (screener chain) / #3810 (runs-ledger provenance):**
  separate surfaces; this slice touches only the files it needs.

## Tests

- `tests/schedule_watchdog_3788.test.ts` — pure core (ticks, grace,
  first-seen, durable schedules, copilot classification/mapping).
- `tests/scheduled_goals_watchdog_3788.test.ts` — `onCron`
  integration (ledger + Slack + heartbeat, exactly-once, #1819
  resource goal, never stamps `lastRun`).
- `tests/stock_copilot_watchdog_3788.test.ts` — non-declaration
  signals + dedup, early-return signal, handler failure code,
  firing ledger record.
- `tests/schedule_watchdog_orchestrator_3788.test.ts` — sweep
  (all three signals, exactly-once, unrecorded skip, disabled).
- Pins updated in place: `tests/schedule-3121-s1-parity.test.ts`
  (goal lifecycle events: four → five),
  `tests/catalog_rendering_2975.test.ts` (new templates).

#CISO-bhdm
