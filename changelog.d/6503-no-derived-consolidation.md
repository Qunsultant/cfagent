### Changed
- Every schedule is now a real stored schedule in the one D1 unified store: the six system schedules (schedule-watchdog, sweep-stale-async-jobs, sweep-stale-ledger-tasks, token-renewal, retention, nightly-research) are stored rows, created paused at the monthly floor, and fully controllable (pause, resume, re-time, delete) instead of derived read-time records that refused every control verb.
- Schedule controls are gated by the level rule: platform-level schedules are platform-admin only; user-level schedules are platform-admin, tenant-admin of the user's tenant, or the owning user. The gate covers single and bulk pause/resume/trigger, update, cancel, cancel-all, create, and the maintenance clear-table route.
- Every schedule control write is audited before it lands, with caller attribution; refusals are audited too. A failed audit blocks the write.
- Paused is enforced on every scheduled firing path: a paused schedule never fires, and triggering a paused schedule is refused (resume first).
- Declared tasks (strategy-scan observe, Stock Copilot cycle) seed exactly one stored schedule row each; an operator's pause, re-time, or deletion survives reconcile.
- The hourly Worker-cron watchdog now also observes the schedule-watchdog's own heartbeat row and alerts when it goes missing or stale.
- The remaining hardcoded scheduling values are externalized as managed settings (sweep/watchdog reap policy, watchdog grace, research hour, due guard, heartbeat interval/stale-after, goal-run retention), with defaults unchanged.
- Ticker-push is a feed card on the Schedules home, not a schedule row, and is excluded from bulk scopes.
- iv-history-collection has no stored schedule in this slice: D1 starts empty and collection stops at cutover. Re-creation as a real stored schedule at monthly cadence, created paused, is follow-up OpenAIMP/cfagent#6544.
