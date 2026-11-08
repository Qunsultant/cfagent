### Fixed

- **First-run setup & environment sync endpoints (#3309)**:
  - Added `platform`, `environment`, and `payments` to `isImmediateSync` in `src/server/routes/core.ts` and `isImmediateEndpoint` in `src/agents/orchestrator.ts`.
  - Exempts interactive, sub-millisecond local account creation (`POST /api/platform/accounts/setup`), user profile persistence (`POST /api/platform/accounts/profile`), onboarding state saving (`POST /api/platform/onboarding/state`), and environment switching (`POST /api/environment/switch`) from async job queueing.
  - Resolves issue where first-run setup spun indefinitely on "Signed in as" (account setup) and "Save profile", eliminating stalled background job polling.
  - Added test coverage in `tests/etrade_sync_immediate_flow.test.ts` verifying that `/api/platform/accounts/setup`, `/api/platform/accounts/profile`, and `/api/environment/switch` forward with immediate sync (no `x-async-eligible`). #cpo-dhmp
