# Sessions per user, cross-login runs, and quota enforcement (#2840)

Sub-issue of the #2837 security-spectrum program. Step 2 of the
#2836 → #2840 → #2842 run. This document is the implemented
answer to the issue's three questions — not a design note: every
claim below names the code that enforces it, and the tests in
`tests/sessions_runs_quota_2840.test.ts` pin it.

## Q1 — How many sessions can exist for a single user?

**Decision: 10 concurrent ACTIVE sessions per user, oldest-out
eviction — not unlimited.**

Rationale (recorded for owner correction): 10 covers every
plausible multi-device shape (phone, laptop, tablet, several
browsers, a spare) while bounding the sessions-bucket listing the
cap itself reads, the blast radius of a stolen-credential session
spray, and the rows-read cost of the login-time count. Unlimited
was rejected because the store previously had no countability at
all — an unbounded session set is also an unbounded listing for
the #2836 admin surface and for offboarding revocation.

- Config: `maxConcurrentSessionsPerUser: 10` in
  `config/session-limits.json` (via `src/config/sessionLimits.ts`).
  It is NOT a TTL — #1749 owns the TTL bounds, which this slice
  does not change. An invalid config value (non-integer, < 1,
  non-finite) falls back to 10, never to 0 or unlimited.
- Countability: `src/security/sessionCap.ts` reuses the
  SessionStore DO sessions-namespace listing (#1758) and #2836's
  active-session parser (`parseLoggedInSessionEntry`) — no second
  store, no second listing. "Active" means exactly what the #2836
  panel shows: absolute 7d + 30d lifetime cap + idle window, with
  legacy sessions idle-exempt. Expired rows the store still lists
  never count.
- Enforcement point: the generic wired login tail
  (`completeWiredLogin` in `src/security/iaaaLogin.ts`), the only
  browser-session creation path — before `createSession`, so a
  login can never silently push a user over the cap.
- Eviction: oldest by createdAt (ties: lastSeenMs, then session
  id). At the cap, one login evicts one oldest session; over the
  cap (sessions predating the cap), eviction brings the count to
  cap − 1 first. The login itself succeeds. The eviction is
  fail-visible three ways: a `session.evicted` audit event
  (best-effort, actor = the user, correlation = the evicted
  session id), a server log line, and the #2836 logged-in-users
  panel (the evicted session disappears from the user's list;
  admin visibility follows #2836's pattern — tenant admins see
  their tenant only, platform admins all tenants). The evicted
  session's next use fails as unauthenticated (the existing
  deleted-session path), and its isolate cache entry is
  invalidated at eviction time.
- Fail-closed: an unavailable listing or a failed eviction fails
  the login with the distinct `session_limit_unavailable` outcome
  (`/login?auth_outcome=session_limit_unavailable`, new code in
  `src/security/authOutcome.ts`) plus a `SESSION_CAP_UNAVAILABLE`
  / `SESSION_CAP_EVICTION_FAILED` failure audit — never a silent
  over-cap session. A listing failure in production implies the
  same DO the login's own session write needs, so fail-closed
  costs no login that would otherwise have succeeded.
- Limitation, stated plainly: legacy sessions (no
  `internalUserId`) are never counted toward a wired user's cap
  and never evicted by it — they cannot be attributed to the
  logging-in user, and evicting an unattributed session would be
  a cross-user revocation. They stay visible to platform admins
  only (#2836 rule).

## Q2 — Runs across multiple logins: per-kind matrix

Scope rule for every kind: the dedup key is the USER (or the
job), never the browser session. A browser session id enters no
lock, no queue, and no workflow id below.

| Kind | Visible under login B? | Dedup (second submitter) | Second-submitter answer |
|---|---|---|---|
| Screens | Yes — per-owner `screener:<login>` instance; `getLatest`/`getHistory` serve the same instance to every session of the user. | Yes — `ScreenRunLockPort` (user + universe), atomic, 5-min stale takeover (#1993). Verified, unchanged. | NEW: "already in flight" with run id + status. Run id is derived, `screen:<login>:<universe>:<startedAtMs>` (`src/services/screenInFlight.ts`) — stable across both submitters, no lock-schema change, no token embedded. `runScreen` throws `ScreenAlreadyRunningError`; the #832 routes return 429 with `runId` + `status: "running"`; `isScreenRunning` reports the same pair. A stale row reports `runId: null, status: "idle"` (takeover-eligible, not in flight). Results: the second session reads the first session's completed result from the same per-owner instance. |
| Scheduled goals | Yes — the shared ScheduledAgent `"default"` instance: every signed-in session lists the same goals, ticks, and per-run records. (Pre-existing scope note: that instance is shared across users too, not per-user — re-scoping it is not this slice.) | NEW: in-flight firing claim (`src/services/goalFiringClaims.ts` + `ScheduledAgent.onCron`). `addGoal` already refused duplicate ids; what was missing was concurrent firing — a forced trigger bypasses `isDue`, so session B's trigger re-fired session A's running goal. The claim is in-memory (synchronous, atomic in-isolate) + a durable `goalFiring:<id>` marker (survives isolate restart), 30-min stale window (the stuck-run horizon), completed in a `finally` on every exit. Release overwrites the marker with status `"completed"` via put (no delete required — a delete-based release wedged re-fires on put-only stores, found by the #1224 pipeline re-fire test); a completed marker never blocks a later claim, only a `"running"` marker does. | Second trigger returns a tick with `jobsSkipped: 1` and `"<goal>: already in flight (run <id>, status running)"`, plus a skipped per-run record naming the run; the second submitter then sees the first run's success record via `listJobRuns` (same goal id, same instance). A crashed firing leaves a `"running"` marker that blocks re-firing for up to the stale window — the same honesty level as the screen lock's stale window. |
| Orchestrator jobs | Yes — rows are scoped by `sessionKey`, the per-login DO instance id, not by browser session. Two browser sessions for the same login list the same jobs; another login's instance sees nothing. | Submission: NO — `submitAsyncJob` mints a fresh UUID per submission by design; a second submission is a second job. Execution: YES — the guarded `queued → running` claim means an in-flight job's execution is never duplicated, and retry refuses an already-retried job. | The second submitter gets a NEW job id (honest: it is a new job). Automatic submit-time dedup by payload would wrongly collapse legitimate repeats (identical report requests are legal), and no caller today supplies a dedup scope — so no scope is invented here. Carried: a submit-time idempotency key (needs a queue-schema column) is follow-up work, not claimed here. |
| Workflows | Yes — workflow-run rows are per `sessionKey` (same instance rule as orchestrator jobs), and `statusUrl` is per job. | Yes, per job id — `startWorkflowInstance` creates with the derived id; a create failure is followed by a get, and an existing instance is adopted (`existing: true`, same `workflowId`, status `"running"`), never a second run. | The second start returns the adopted handle (same workflow id, `existing: true`, `statusUrl` for polling). A fresh submission with a NEW job id is a new run by design — the job id IS the run identity, so logical-scope dedup for screens belongs to the screen lock, not the workflow port. |

Cross-session tests (in `tests/sessions_runs_quota_2840.test.ts`):
login twice (two browser sessions, same user) is modeled at the
layer where the browser session actually matters — the lock
scope for screens (same userLogin, two acquirers), the shared
instance for goals (two triggers, one firing), the shared
`sessionKey` for orchestrator rows, and the shared job id for
workflows. No test invents a browser-session-scoped store: the
point under test is precisely that no such scope exists.

## Q3 — Quota

### Platform quota (SessionStore / DO free tier, #1819 base)

Fail-visible behavior when the quota is hit, in degradation
order (all pre-existing except the tier alerts — this slice
adds only the tiers, it does not re-plumb degradation):

1. The provider throws on the next SessionStore op (there is no
   pre-emptive shed: measurement is a SessionStore-only LOWER
   BOUND, so shedding on it would drop real work on a false
   signal — the owner acts on alerts, the system does not shed
   on a bound).
2. The session-store breaker trips on real limit errors only
   (5-min block, #2666) and suppresses further store reads.
3. Validations with a cached session keep serving degraded from
   the isolate cache; validations without one throw the typed
   limit error, which the error boundary answers as 503.
4. Fresh logins without a cached session therefore fail visibly
   (typed 503 path), exactly the 2026-10-26 failure mode, now
   classified instead of a 500/1101.

Tier actions on the existing hourly `resource.cap_alert` goal
(`src/telemetry/resourceRollup.ts`, `src/agents/resourceGoals.ts`):

- 70% — watch (unchanged): the existing Slack alert, deduped
  per (budget, day) under the bare budget key.
- 90% — escalate (NEW): a second, distinct Slack alert
  ("ESCALATION … 90%"), deduped per (`rowsRead:90`-style tier
  key, day) so it is never swallowed by the day's already-marked
  70% alert and never re-posts for its own tier-day. Action
  asked of the owner, not taken by the system (see (1) above).
- 100% — critical (NEW): a "CRITICAL … 100%" Slack alert naming
  the degradation in force (breaker + cached serve + typed 503
  for fresh logins). Deliverable at 100% because the alert goal
  reads the D1 projection, not the exhausted SessionStore.
- Boundaries are AT the threshold (90% fires at exactly 90%),
  per budget, on the same UTC-day lower-bound totals. The 70%
  behavior is byte-unchanged for existing consumers.

Note for the cap itself: the login-time listing adds one
SessionStore list per login. At 90%+ that cost is still paid
(the count is the enforcement); if the listing throws a limit
error, the login fails through the cap's fail-closed path
(`session_limit_unavailable`), consistent with the degradation
order above.

### Run budgets (`budgetCents`) — pinned per kind

No user-facing `budgetCents` declaration was found to be
declared-but-never-enforced. The pins, with evidence:

- Scheduled goals (`ScheduledGoal.budgetCents`): ENFORCED
  pre-firing via the PaymentsAgent `budgetCheck` (BudgetGuard,
  ledger-derived, explicit agent bucket) in `onCron` and in
  `fireSynthesizedSchedule`. Rejection skips the firing and
  records a skipped per-run record / tick error — never a
  silent run.
- Synthesized chain records (`record.budgetCents`): ENFORCED
  pre-firing the same way; a budget-rejected firing consumes
  nothing and leaves `firedAt` unset (retryable).
- Compiled chains (`chain.budgetCents`): ENFORCED at compile
  (vs `budgetCapCents`; over-cap refuses, and `runChain`
  re-validates before running) and at every governed firing
  path. The per-leg `budgetCheck` callback in `runChain` is an
  OPTIONAL caller-supplied gate, not a user declaration: a
  caller supplying an executor without one owns the spend
  decision (pinned by `tests/mcp_goal_chain.test.ts`), and the
  MCP tool path supplies no executor, so no paid action runs
  there regardless. This is now commented at the call site
  (`src/mcps/openaimp/goalChainCommands.ts`) so a future
  "fix" does not silently renegotiate those pins.
- `createJob` descriptors (`OrchestratorJob.budgetCents`):
  NOT a second enforcement point — `createJob` mints a pending
  descriptor and executes nothing; its budget rides from the
  goal whose firing already passed the check above.
- Delegation-contract display (`formatBudgetCents`): a
  disclosure of the goal's budget ("as entered"), enforced via
  the goal itself — not a separate declaration.
- Screens, orchestrator jobs, workflows: no `budgetCents`
  declaration exists for these kinds, so nothing is claimed
  for them.

## Privacy

Every new surface carries identity, tenant, times, counts, and
status only: session ids, run ids, statuses, counts. No token,
secret, credential, or payload is read from any record or
returned by any new surface. The screen run id embeds the
holder's start time, never the holder's release token.

## Carried items (not built here, not claimed)

- Orchestrator submit-time idempotency key (needs a queue
  schema column + a caller-supplied scope; no caller supplies
  one today). Visibility + execution dedup are shipped; submit
  dedup is the follow-up.
- #2808 Phase 0 reconciliation (login-trace kind, incl. the
  unbounded login-event record #2836 noted for lifetime login
  counts): reference only, untouched by this slice.
- #2842 (user request quota): next step in the run, untouched.
- The crashed-goal-firing stale window (up to 30 min before a
  re-fire is accepted) is the documented trade-off of the
  firing claim, not a bug to silently work around. A completed
  firing never blocks: its marker is overwritten with status
  `"completed"`, so the window applies only to firings whose
  isolate died before the finally ran.
- Live proof (owner steps, never faked): two real browser
  sessions logging in as one user and observing the cap
  eviction / already-in-flight answers in production, and a
  90% tier alert firing on a real high-usage day, are owner
  verifications, not lane claims.

#CISO-bhdm
