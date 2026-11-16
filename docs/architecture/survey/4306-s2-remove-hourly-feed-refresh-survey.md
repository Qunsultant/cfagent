# #4306 S2 survey — remove the hourly feed-refresh goal (fresh, 2026-11-13 03:57 EST, main 7be5b070)

S1 merged (PR #4311). S2 is the second half of #4306 (sub-issue of #3121): delete the
hourly `feed-refresh` goal and close every path that could add it back. The live
`removeGoal("feed-refresh")` on the deployment is a SEPARATE parent step — it needs a
signed-in session and is NOT part of this build.

## Lane-claim / coordination (checked 2026-11-13)
- #4306 comments: only mine (S1 notes). No other lane claims S2. PASS.
- #4253 (CEO lane, OPEN, claimed 2026-11-12 by #ceo-aimp): externalize DEFAULT_SCHEDULES
  to config — built-in goals configurable, removal durable. NO open PR for #4253 as of
  this survey. S2 does NOT build config externalization (that is #4253's scope) and does
  not touch #4253's design. Coordination note: the two re-add paths #4253 names (the
  seed rule re-seeding all of DEFAULT_SCHEDULES when empty, and the "Seed all built-in
  goals" button) both seed FROM DEFAULT_SCHEDULES — deleting feed-refresh from
  DEFAULT_SCHEDULES closes them for this goal, without building #4253.
- #4331 / #4332 (landed overnight, autoclaw-001 lane, schedule-list UI): do NOT touch
  the goal-definition sites. No collision.

## Sites on current main (7be5b070, verified by grep)
- `src/schedule.ts:78` — `FEED_REFRESH_OPERATION = "feed.refresh_all"` (const; comment :74).
- `src/schedule.ts:212-215` — the `feed-refresh` goal entry in DEFAULT_SCHEDULES (id + operation).
- `src/agents/scheduled-agent.ts:1941-1983` — the goal-dispatch branch
  (`if (goal.operation === FEED_REFRESH_OPERATION)`) that fans out to
  `dispatchScheduledPipelineJob` per job. REMOVE the branch.
- `src/agents/scheduled-agent.ts:33` — imports FEED_REFRESH_OPERATION; `:515-516, :547-564` —
  the seed rule (seeds DEFAULT_SCHEDULES only when empty). Deletion from DEFAULT_SCHEDULES
  closes the re-seed for this goal; pin it (seed with an empty store, assert feed-refresh absent).
- `src/services/scheduleSystems.ts:78-88` — `SCHEDULED_GOAL_IDS_INVENTORY` (9 entries);
  remove `"feed-refresh"` → 8.
- `src/services/agentScheduleCapability.ts:100` — `"feed.refresh_all"` in the capability
  operation list; remove.
- `src/agentic/capabilityRegistry.ts:205` — capability `id: "feed-refresh-all"`; remove.
  `src/agentic/unitDrivers.ts:121` — same capability id; remove if it is the same registration.
- `src/orchestrate.ts:140,148` — `feed.refresh_all` NOT an orchestrator job + operations entry; remove.
- `src/client/ScheduledGoalsPanel.tsx:460` — "Seed all built-in goals" seeds in
  DEFAULT_SCHEDULES order; deletion closes it for this goal (no panel change expected;
  verify by the seed pin).
- `src/services/stockCopilotIntrospection.ts:761` — diagnostic string says feed datasets are
  produced by the feed-refresh goal; after S2 that is FALSE — update to the per-job mechanism.

## Stays (do NOT remove)
- `dispatchScheduledPipelineJob` (`src/agents/scheduledTasksPipeline.ts:647`) — the per-job
  dispatch; called from the per-job task path (`:804`). Only its goal-branch caller goes.
- All 26 per-job stored schedules (S1, monthly). Chains. The `feed.refresh_all` operation
  string itself only where it is the goal's operation (remove with the goal).

## Tests referencing the goal (7 files — pin-update candidates)
- `tests/feed_refresh_goal_3787.test.ts` (the goal's own suite — most of it goes with the goal)
- `tests/goal_compiler.test.ts`, `tests/schedule-3121-3124-parity.test.ts`
  (may pin the 9-goal inventory — expect 9→8 updates, disclosed, not weakened)
- `tests/schedule_api_builtin_3996.test.ts`, `tests/scheduled_goals_builtin_3996.test.ts`,
  `tests/scheduled_goals_panel_3996.test.tsx` (builtin-goal suites — the feed-refresh
  rows go; the other eight stay)
- `tests/screener_chain_stuck_3787.test.ts`

## Out of scope (S2)
- #4253 config externalization. The live `removeGoal` (owner sign-in). The #3121
  inventory-gap flag comment. The periodic reaper / async-job deadline. #4304's ef0c6a8b
  record. Any change to per-job schedules, chains, or the 26 monthly defaults.
