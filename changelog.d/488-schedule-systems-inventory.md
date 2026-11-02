### Added

- **Schedule systems inventory (#488, #457):** `src/services/scheduleSystems.ts` is the single canonical description of the three schedule systems — Orchestrator durable schedules, ScheduledAgent goals, Worker cron triggers — with the unification questions from #457 answered with evidence and the remainder explicitly carried. Its inventories are test-pinned to `CREATABLE_SCHEDULE_CALLBACKS`, `DEFAULT_SCHEDULES`, and the `wrangler.jsonc` crons, so drift in any source fails a test. No system, endpoint, or creation path is removed or merged by this slice.
