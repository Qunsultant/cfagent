### Schedules home: one-click empty the list (#5893)

- The Schedules home gains one "Empty the list" action (platform-admin gated, same overview probe as the admin queue): preview what will go (alarms + paused records) and what will come back on its own (derived rows, declared tasks, built-in goals), confirm, then verify by re-fetching the list.
- Reuses the existing wipe routes — POST /api/schedules/cancel-all and POST /api/maintenance/clear-table — with their existing audit events; no new route, no new wipe primitive, no new audit event type. Own instance only; KV is never touched.
- A failed clear step after a successful cancel is reported as a partial wipe, never claimed as empty.
