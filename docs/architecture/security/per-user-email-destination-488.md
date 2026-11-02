# Per-user email destination — issue Qunsultant/cfagent#488

Closes the #488 SaaS-readiness item "Per-user email destination as data,
not a global env var". The tracker rule for #488 was "file sub-issue when
#415 lands"; #415 has landed (sessions + tokens in the SessionStore DO,
PDFs in R2, zero KV bindings — see the #488 tracker comment for the
evidence), so this slice builds the item directly under #488 instead of
filing and stopping.

## Storage

- SessionStore DO, key `user-email-destination:<githubLogin>`, value JSON
  `{ email, updatedAt, updatedBy }` (`src/services/userEmailDestination.ts`).
  The same DO that holds sessions and E*TRADE tokens since #415 — never KV.
- No expiry: a destination must not silently vanish on a TTL boundary;
  clearing is explicit (DELETE). A corrupt record reads as missing, never
  as an address, and a read never overwrites it.

## Resolution (scoped defaults: run > user > global env)

1. The run's explicit `emailTo` (event / call-site option).
2. The user's stored destination.
3. `OPTIONS_EMAIL_TO` (options runs; kept for compatibility).
4. `SCREENER_EMAIL_TO` (deployment default).
5. None — the caller skips email with its existing named reason.

This is a delivery address, not an enforcement gate: setting it changes
where that user's reports go and nothing else, so it is user-configurable
by design. It grants no permission and disables no IAAA gate.

## Wired paths

- Screener bus publishers (completed, failed, PDF attachment) —
  `src/events/screenerPublishers.ts`. Note: the PDF path previously read
  only the global env var, ignoring the run's `emailTo`; it now uses the
  same resolution as the summary path.
- Scheduled-options direct email and sharded-chain email —
  `src/services/scheduledTasks.ts` (the chain's `channels` list now
  includes `email` when the resolved destination exists).
- Self-only route `GET/POST/DELETE /api/user/email-destination` in
  `src/server.ts` (session-gated; the login comes from the session,
  never from request input). GET returns only the stored value plus
  whether an env fallback exists — the global value itself is never
  returned to a caller.

## Not wired in this slice (still env-fallback, not claimed otherwise)

- `src/services/screenerFollowups.ts` / `src/services/screenerFollowupDelivery.ts`
  (follow-up notifications) and `src/agents/orchestrator/asyncJobs.ts`
  (async-job email notices) still resolve from the run option or the
  global env vars. They are direct per-run paths, not the bus/scheduled
  delivery paths above; wiring them to the same resolver is the named
  follow-up, not a silent part of this slice.
- No client UI yet: the route is the API surface; a Settings control
  that calls it is a separate UI slice.
