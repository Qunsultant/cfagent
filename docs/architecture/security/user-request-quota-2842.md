# User request quota (#2842)

Sub-issue of the #2837 security-spectrum program. Step 3 of the
#2836 → #2840 → #2842 run. This document is the implemented
answer to the issue — not a design note: every claim below names
the code that enforces it, and the tests in
`tests/user_request_quota_2842.test.ts` pin it.

## Phase 0 enumeration (verified from code)

The gate lives at the run funnel, so every path through the
funnel is covered by one check. Callers found by grep:

| Kind | Verdict | Evidence |
|---|---|---|
| screen (`runScreen`) | CONSUMES | `src/agents/screener-agent.ts` `runScreen` is the one funnel: manual routes (`etradeBrokerScreen`, `marketDataResearch`, `premium`), NLQ-with-screen (`nlq/execution.ts`, `orchestrator/nlqPorts.ts`), scheduled (`scheduledTasks.ts`, `orchestrator/scheduledCallbacks.ts`), workflow shards (`workflows/screenerWorkflow.ts`), A2A (`screenerA2aDispatch.ts`). |
| goalScreen (`runGoalScreen`) | CONSUMES | `src/agents/screener-agent.ts` `runGoalScreen` runs a goal-driven screen producing goal-screen report artifacts (`services/goalScreenReports.ts`). |
| research (`runResearchAndPublish`) | CONSUMES-IN-PRINCIPLE, enforcement CARRIED | `src/agents/orchestrator/researchPublish.ts` genuinely produces reports, but its run path lives in the per-login OrchestratorAgent instance. A second counter store there would split the per-user pool (screen charges in the screener instance, research charges in the orchestrator instance, neither seeing the other's total). The follow-up is a shared counter store (or a screener-stub gate); until then research runs are NOT counted, and that is stated here, not hidden. |
| discovery-report download | NO CHARGE | `src/agents/routes/etradeOptionsDiscoveryReport.ts` serves a stored artifact by key; no run executes. |
| report reads (`getLatest`/`getHistory`/downloads) | NO CHARGE | Reads serve stored results; no run executes. |
| chat turns / NLQ without a screen | NO CHARGE | Not report runs. An NLQ turn that runs a screen charges via `runScreen`. |
| orchestrator jobs / workflows without a screen | NO CHARGE | Execution containers, not report runs; a screen shard charges via `runScreen`. |
| goal ticks that fire no screen | NO CHARGE | Budget-rejected, skipped, and non-screen goals produce no report. |
| canonical-store seam (`storeReportAtGeneration`) | NO CHARGE | The #308 storage seam delivers an already-generated report's canonical copy, not a run. |

Anything not enumerated does not consume quota until it is added
to the matrix (`quotaConsumptionVerdict` in
`src/security/userRequestQuota.ts`) — unknown kinds answer
`no-charge` by construction.

## The pool, windows, and values

- ONE pool: screen + goalScreen charges share a single per-user
  count. The kind is recorded per charge row for attribution, but
  the count ignores kind — "how many reports a user can run" is
  one number.
- Windows are UTC CALENDAR windows (matching #1819's UTC day
  boundary): day = UTC date, week = Monday 00:00 UTC through the
  next Monday 00:00 UTC, month = UTC calendar month. The reset
  time is the next window start, returned as epoch ms + ISO.
- Tenant/user timezone windows are NOT built: they need a stored
  per-user timezone plus DST-safe boundaries, and deriving one
  from a request header would silently move resets. UTC is the
  documented default; a timezone window is follow-up work.
- Initial value set, ALL TIERS, PENDING CBO/owner decision:
  **daily 10, weekly 70, monthly 300** (`DEFAULT_USER_REQUEST_QUOTA`).
  No tiers, prices, or commercial terms are built — the tier →
  quota mapping comes from the CBO plan / owner decision, and the
  over-quota path names the upgrade route without building it.
- Switches (admin/platform-controlled, Worker env):
  `USER_REQUEST_QUOTA_ENABLED` (default true; `"false"` disables
  the gate — the platform kill-switch), `USER_REQUEST_QUOTA_DAILY` /
  `_WEEKLY` / `_MONTHLY` (integer overrides). An unrecognized
  enabled value fails closed to enabled; an invalid numeric value
  falls back to the default and is named in `invalid` (logged by
  the screener gate) — never 0, never unlimited.

## Counting

- Counters live in the per-owner ScreenerAgent instance's own
  SQLite (`user_request_quota_charges`, `user_request_quota_overrides`),
  beside the screen lock — the same residency argument as the
  lock's ADR D-0 note. No second store, no second session store,
  no second observability pipeline is invented.
- Every charge carries `(tenantId, userLogin, windowKind,
  windowKey, kind, runId)`. The gate enforces per-user counters
  partitioned by tenant: one tenant's usage can never consume
  another's (proven by the isolation tests). A tenant-TOTAL cap
  is NOT enforced: it needs a cross-user sum no per-owner
  instance can see.
- Production tenant partition defaults to the run owner's login
  (the #2426 rule: captures already partition by owner login, and
  no route today carries an IAAA tenant into a screen request).
  A caller that later supplies `tenantId` must use the same
  partition for usage lookups, or the lookup misses.
- Idempotent on run id: the charges PRIMARY KEY is
  `(tenant, user, window, window key, run id)`, and charge is
  `INSERT OR IGNORE`. A retried submission with the same run id
  never double-charges. Run ids: screens use the #2840 derived id
  (`screen:<login>:<universe>:<lockStartedAt>` — a retry while
  in flight is refused by the lock without charge; a retry after
  completion is a new lock, hence a new charge, and the completed
  result stays readable via `getLatest`); goal screens use the
  caller's `idempotencyKey` (`goalScreen:<key>`), so true
  retry-idempotency holds there. Client-supplied idempotency
  keys for `runScreen` remain #2840's carried follow-up.
- Charge at acceptance, before any work: the gate probes all
  three windows first (no writes), refuses on the first over
  window (daily, then weekly, then monthly) without charging
  anything, then charges only windows not already holding this
  run id. A run refused at the gate charges nothing and starts
  no partial work; an accepted run that later fails still
  consumed its slot (acceptance consumed capacity). A crash
  between the per-window writes leaves partial charges; a retry
  charges only the missing windows, never double-charges.

## Enforcement point and responses

- `runScreen`: after the lock, before `runScreenInner` (the
  lock is released explicitly on a quota refusal, since the
  try/finally has not started). `runGoalScreen`: at entry,
  before the E*TRADE client and the universe bundle.
- Over quota, the user gets a fail-visible 429 (never a silent
  drop, never a partial run charged as full): limit, usage,
  window, and reset time. The error message carries the fields
  because DO RPC drops class fields (the #2840
  `screenAlreadyRunningDetails` pattern); routes parse them back
  with `quotaExceededDetails`. The three manual routes map it:
  `etradeBrokerScreen` and `marketDataResearch` return the 429
  JSON (and never persist a refused run as a failed run);
  `premium` returns the same fields in its result object.
- Counter failure fails closed: any port throw becomes
  `UserRequestQuotaUnavailableError`, mapped to 503. There is
  NO fail-open path, and no exception is named — the issue's
  "name the exception" clause is satisfied by stating there is
  none.
- Over-quota paths: wait until reset (the 429 names the reset
  time); audited admin override (below); tier upgrade route
  (specified, commercial terms NOT built).
- Graceful degradation (COO alignment): a refusal is
  fail-visible with a retryable flag and a reset time, never a
  silent drop. The burst caps (#1774) and the spend ledger
  (budgetCents, #2840's pins) are consumed, not rebuilt: quota
  is the count limit, budgetCents stays the spend limit, and the
  two compose (a run must pass both).
- No bypass: quota switches are Worker-env (platform-only) and
  overrides are admin-only (below). The gate never lets a caller
  disable its own enforcement.

## Visibility and overrides

- User pre-run: `ScreenerAgent.getUserRequestQuotaUsage` +
  `GET /api/iaaa/quota-usage` (self: no `userLogin` param; the
  screener login is the session's login). Returns daily/weekly/
  monthly limit, usage, remaining, and reset time, plus all
  override rows.
- Admins via the #2836 surface (additive, no change to the
  logged-in-users endpoints): the same route with `userLogin`
  (platform admins: any user; tenant admins: only users with an
  active membership in their own tenant, verified by the revoke
  handler's rule verbatim — a login with no active session row
  cannot be verified and is refused fail-closed), plus a
  "Request quota" lookup + grant block in `LoggedInUsersPanel`
  (reusing the panel's existing classes; no new stylesheet),
  catalogued in `iaaaEndpointCatalog.ts`. The list endpoint is
  NOT fanned out per row: one DO RPC per listed user would
  change its latency and shape for a lookup that belongs on
  demand.
- Override: `POST /api/iaaa/quota-usage/override` (admin-only,
  same scoping as the lookup). The grant targets the CURRENT
  window of its kind and expires at that window's end, so it can
  never leak into the next window. The durable override row IS
  the auditable record (admin, user, tenant, grant, timestamp);
  the route also writes the IAAA audit event (action
  `user_request_quota.override`, correlation = override id) and
  reports `audited` honestly — a failed audit write does not
  un-grant and is not hidden (the #2836 revoke pattern).
  Tenant admins grant into the login partition only; only
  platform admins may name another partition.
- Legacy sessions (no `internalUserId`) answer 403 on the quota
  routes, like every other lifecycle route in the block. Their
  runs still gate inside the screener instance, which needs no
  wired identity.

## Implementation map

- Pure policy: `src/security/userRequestQuota.ts` (matrix,
  UTC windows, config, errors, gate + usage orchestration).
- Port: `src/data/userRequestQuotaPorts.ts`; SQLite adapter
  `src/data/doSqliteUserRequestQuotaAdapter.ts`; in-memory
  adapter `src/data/inMemoryUserRequestQuotaAdapter.ts` (tests);
  composition `src/data/createUserRequestQuotaPorts.ts`.
- Gate wiring: `src/agents/screener-agent.ts` (`runScreen`,
  `runGoalScreen`, `getUserRequestQuotaUsage`,
  `grantUserRequestQuotaOverride`, `listUserRequestQuotaOverrides`).
- Route mapping: `src/agents/routes/etradeBrokerScreen.ts`,
  `src/agents/routes/marketDataResearch.ts`,
  `src/agents/routes/premium.ts`.
- Server routes: `src/server.ts` (`/api/iaaa/quota-usage`,
  `/api/iaaa/quota-usage/override`, inside the IAAA guard block).
- Client: `src/client/loggedInUsersApi.ts` (fetch + grant),
  `src/client/LoggedInUsersPanel.tsx` (lookup + grant block),
  `src/client/iaaaEndpointCatalog.ts` (entries).
- Tests: `tests/user_request_quota_2842.test.ts` (matrix,
  windows, config, both adapters, gate, usage view).

## Privacy

Rows carry identity, tenant, times, counts, and status only.
No token, secret, credential, or payload is read from any record
or returned by any new surface. The quota usage response carries
no run payloads — counts and windows only.

## Carried items (not built here, not claimed)

- Research-run enforcement (see the matrix): needs a shared
  counter store or a screener-stub gate; research runs are
  uncounted until then, stated plainly above.
- Tenant-total caps: need a cross-user sum store.
- Tenant/user timezone windows: need a stored per-user timezone
  + DST-safe boundaries.
- Per-row quota in the #2836 list: needs an on-expand fetch,
  not list fan-out.
- Client-supplied idempotency keys for `runScreen` (#2840
  follow-up): post-completion retries of a screen are new
  charges today.
- Live proof (owner steps, never faked): a real user hitting
  the daily cap in production and observing the 429 with
  limit/usage/reset, and an admin granting an override and
  seeing the raised limit, are owner verifications.

#CISO-bhdm
