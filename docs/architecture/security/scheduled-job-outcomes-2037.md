# Scheduled-job dispatch observability (Qunsultant/cfagent#2037)

## Problem

The 2026-10-27 Cloudflare Workers log showed `POST
https://agent.internal/reflection/run`, outcome `exception`, 5ms wall,
0 CPU, requestId `6d8b682c33429a3508644fd57a037223` — no message, no
stack, no error code. The throw happened outside the reflection
handler's try/catch (which converts everything to a 500 Response), in
the DO fetch/dispatch layer, before real work ran. Our own systems
could not see it: the Worker fetch wrapper (#1743) never sees a DO
stub fetch, `scheduled()` fire-and-forgets without catching, nothing
alerted, and even a Tuesday skip left no record anywhere except
Cloudflare logs.

## Design (what this slice does)

- **Trace.** `scheduled()` mints one trace per 30-minute tick. Every
  tick dispatch carries a child span as `traceparent` (research,
  reflection, adaptation, corpus sync, digest pass). The DO honors the
  incoming traceparent, so AE events, outcome rows, and alerts all
  correlate to one tick.
- **DO dispatch wrap.** Only the three scheduled-job paths are wrapped
  with the #1743 `withObservability` interceptor at the
  `OrchestratorAgent.onRequest` tail (operation
  `do.internal_dispatch`). A throw inside the dispatch chain emits one
  AE error event (code, never message) and rethrows unchanged.
  Responses pass through untouched, including handler-caught 500s.
  General API traffic is unwrapped — no AE volume change there.
- **Exactly one outcome sink.** Job outcomes (`ran` / `skipped` /
  `failed` + error code, plus the internal skip reason) go to
  `mas_events` rows of type `scheduled_job.outcome` — never a second
  audit system. Handlers record their own outcomes (reflection via
  the audit funnel, research/adaptation via the ORM events port);
  dispatch-layer failures are reported back through the internal
  `POST /scheduled-job-outcome` route, which uses the same sink and
  the same streak/alert logic. Rows are retrievable through the
  existing `GET /audit` read route (type filter supported).
- **Repeat alert.** The failure streak is counted from the sink's own
  recent rows (bounded newest-first read, no second store, no
  SessionStore counter — the #1819 quota lesson rules that out).
  The existing Slack route (`postSlackText`, webhook-then-bot) fires
  when a job's consecutive-failure streak hits
  `SCHEDULED_JOB_ALERT_THRESHOLD` (default 3 ticks, i.e. 90 minutes;
  0 disables; blank/unparseable falls back to the default), and again
  at every further multiple while the streak continues. A success or
  skip resets the streak; jobs do not share streaks.
- **Worker-side observation.** Each of the three dispatch promises is
  wrapped with the same interceptor (operation
  `worker.internal_dispatch`, layer `worker_dispatch`). A rejection
  emits the AE error event, then records the failure via the outcome
  route. If even that record is unreachable (DO wholly down), a
  fail-loud Slack alert fires immediately — that path is deliberately
  not thresholded: an unrecordable failure must not wait.
- **Split of responsibilities, stated honestly.** AE dispatch events
  record transport (a Response arrived, or a throw happened); job
  outcomes live in `mas_events`. A handler-caught 500 therefore shows
  as an AE info event (dispatch succeeded) plus a `failed` outcome row
  plus threshold alerting — not as an AE error. AE keeps the #1743
  no-message rule throughout: error events and outcome rows carry a
  short error code only. The dashboard remains the source for the
  cause (stack).

## What did NOT change

- No new scheduler, no new cron trigger, no behavior change to the
  reflection logic (Sunday guard untouched), no response-shape
  change on any route, no new audit system, no #1743 schema change.
- The adaptation handler keeps its throw-propagating shape (no catch
  added): its failures surface via the DO wrap + Worker observer,
  into the same sink.
- Observation never fails the tick: every audit, streak read, and
  alert is guarded, and the observed dispatch promises never reject.

## Underlying-throw analysis (code only, no dashboard stack)

Code analysis does **not** name a current code defect, so no
follow-up fix issue is filed from this slice (a speculative filing
would invent a cause). The candidates before the handler are the
stub-fetch/binding layer (outside app code), `onRequest` pre-routing
(`ensureTables`, session-context persistence), and the `routeRequest`
delegations ahead of the broker block — but the 5ms/0cpu signature
does not discriminate among them, and the 2026-10-27 event predates
the current dispatch layer (migration v15 class rename, #2331
provision gating). The remaining owner item is the dashboard
exception detail for requestId
`6d8b682c33429a3508644fd57a037223`; if it names a code defect, that
defect gets its own issue. Any recurrence is now observable
end-to-end (AE event + outcome row + threshold alert, all sharing
the tick trace), so the next occurrence arrives with correlation
instead of only a URL.

## Verification

- `tests/scheduled_job_outcomes_2037.test.ts` (21 tests): code-only
  payloads, threshold config, streak/alert cadence, dispatch
  observation (info on success, error+record on rejection, fail-loud
  on unreachable record, 500 not double-recorded), route gating
  (401 non-background, 400 bad job/outcome), and the three handler
  skip audits (Tuesday reflection, weekend research, already-ran
  adaptation).
- Production forcing of a real dispatch failure was not performed
  (no production incident to force); the end-to-end path is verified
  at the module/route/handler level above plus the unchanged
  `scheduled()` dispatch shape (existing `service_identity` tests).
