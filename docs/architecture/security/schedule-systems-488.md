# Schedule model unification — issue Qunsultant/cfagent#488 (#457)

Answers the #488 item "Schedule model unification questions — #457" with
evidence, and carries what cannot be answered by engineering alone.

## The answer in one paragraph

There are three schedule systems, not one, and the unification this
slice delivers is a single canonical description of them
(`src/services/scheduleSystems.ts`, test-pinned to all three sources),
not a merged store. Orchestrator durable schedules and ScheduledAgent
goals are different stores with different creation surfaces and
different execution; conflating them is the confusion #457 documented.
Orchestrator jobs are the convergence point: a due goal creates an
Orchestrator job, and a durable schedule runs inside the Orchestrator.

## The three systems (verified on current main)

| System | Owner | Store | Created via | Runs via |
| --- | --- | --- | --- | --- |
| Orchestrator durable schedules | OrchestratorAgent | Orchestrator DO SQLite (`this.schedule()`) | `POST /api/schedules/create` (gated to `CREATABLE_SCHEDULE_CALLBACKS`); baselines reconciled on start | DO wakes the callback directly |
| ScheduledAgent goals | ScheduledAgent | ScheduledAgent DO SQL (`goals`) | `POST /api/schedule/goals`; seeded from `DEFAULT_SCHEDULES` only when empty | Worker `*/30` tick → budget-check → Orchestrator jobs |
| Worker cron triggers | Worker entry | None (platform config) | `wrangler.jsonc` crons + deploy | `scheduled(event)` dispatch on `event.cron` |

Current inventories (test-pinned, so this table cannot silently drift):
creatable callbacks `autonomousOptionsAnalysis`,
`autonomousMarketScreen`, `autonomousStrategyDiscovery`,
`autonomousGoalScreen`; goal ids `daily-qa-sweep`,
`opportunity-hunt`, `daily-social-post`, `resource-daily-rollup`,
`resource-cap-alert`, `resource-dashboard-comparison`; Worker crons
`0 3 * * *`, `*/30 * * * *`, `0 4 * * *`. The daily
options-research run deliberately rides the `*/30` tick instead of a
fourth trigger (free-plan ceiling note in `wrangler.jsonc`).

## Carried, with owner and reason (not claimed done)

- Rotating-thesis baseline scanner: keep, remove, or replace — human
  owner; a product decision carried from the #457 close comment.
- Externalize the baseline set into config — human owner; a deployment
  behavior change needing an owner direction on the config surface.
- Merge the durable-schedule and goals stores into one schedule store
  — human owner; a genuinely separate slice requiring a store
  migration plus a merged API and UI, keeping both existing paths
  working behind a switch per NEVER-EITHER/OR.

## What this slice deliberately does not do

It does not delete, rename, or merge any schedule system, endpoint, or
creation path, and it does not change any schedule's timing or
callback. A future merge slice starts from this inventory and its
pins, not from re-researching #457.
