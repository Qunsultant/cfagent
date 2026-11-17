### Audit chain verification checkpointed (#2437)

- The nightly retention pass now verifies only the post-checkpoint window of the mas_events chain and persists the last-verified record (position + outcome) in mas_settings, so a stale verification is itself observable.
- New read-only status route: GET /api/audit/chain-verification returns the persisted record, or `{"verified": false}` when the chain has never verified.
