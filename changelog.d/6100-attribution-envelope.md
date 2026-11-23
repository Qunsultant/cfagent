### Attribution envelope on `mas_events` (#6100)

- One attribution envelope type (`src/security/attributionEnvelope.ts`): platform, tenant, user, session, action, correlation/trace id, stamped once at the orchestrator's `recordAudit` boundary and carried into every `mas_events` row.
- `mas_events` gains five first-class nullable columns (`platform_id`, `tenant_id`, `principal_id`, `correlation_id`, `trace_id`) plus four indexes, so the per-tenant, per-user, per-session, and per-action read questions are column queries, not payload scans. Legacy rows keep NULL, never an invented value; the hash chain is unchanged (the seven hashed fields are untouched).
- `usage_events` keeps its metering axis and maps to the same envelope (`usageEventToEnvelope`).
- Platform id is a deployment config value (`PLATFORM_ID` env, default `"cfagent"`), resolved at the boundary — the design's claim that it comes from the platformIdentity service was wrong: that service resolves tenant/user for a login and has no platform field (see the PR body).
