# 15-factor re-audit — new stock-programme code (#2860)

Scope: the NEW stock-programme code (#2764 slices, gaps G1–G7, G8
wiring, audit follow-ups). Not the pre-existing screener capability —
for that, see the qualified table in
`docs/architecture/application/screener.md` §9 (which this re-audit
does not replace and does not cite as evidence).

Method: code evidence on main after the G-series and audit follow-ups landed. The hardcoded-COMPLIANT test (`tests/fifteen_factor_and_usability.test.ts`, which asserts its own conclusion) is NOT evidence for any verdict below and must not be cited as such.

## Overall: NOT COMPLIANT as a whole

10 PASS / 5 PARTIAL / 0 FAIL / 0 NOT VERIFIED. The original audit
(2026-11-02, on 730c1cb5) found 6 PASS / 7 PARTIAL / 1 FAIL / 1 NOT
VERIFIED. The FAIL (Factor 6) and the NOT VERIFIED (Factor 12) are
closed; Factors 8, 10, 13, 14, 15 remain PARTIAL (each narrowed —
see the rows). No 15-factor compliance claim may be made for new
stock code until 8, 10, 13, 14, 15 are remediated.

## Per-factor verdicts

| # | Factor | Verdict | Evidence (current main) |
|---|---|---|---|
| 1 | One Codebase | PASS | Single repo; stock modules under `src/workflows/`, `src/services/`, `src/client/`; no second repo/app. Unchanged since the original audit. |
| 2 | Explicit Dependencies | PASS | No stock slice or audit PR touches `package.json`; new modules import repo-internal modules + stdlib only. Unchanged. |
| 3 | Config in Environment | PASS | No hardcoded secrets/credentials in new stock modules; provider defaults (`etrade`/`yahoo`) are provider names, not secrets; env bindings via existing routes. Unchanged. |
| 4 | Backing Services | PASS | Canonical store ports, `mas_reports`, `mas_async_jobs`, DO/SQLite/R2 via bindings; the stage consumer reads via injected `readPersisted`, not a hardcoded store. Strengthened since: #3027 adds a production stage checkpoint store over `mas_async_jobs`. |
| 5 | Build / Release / Run | PASS | Vite build → Wrangler release → edge run unchanged; stock slices add no build-time/run-time conflation. Unchanged. |
| 6 | Stateless Processes | PASS (remediated) | The original FAIL root cause is closed in production: delivery suppression is SQL-backed via the one production builder (G6, `orchestrator.ts` `asyncJobsContext()`); stage claims are SQL-backed via the one production consumer caller (G8, `stageReportProduction`); guard pins in `tests/factor6_durable_claims_2860.test.ts` lock both. The in-memory batch tracker has no production caller (its durable form is the job record / workflow collation); the run lock lives in DO SQLite, which is durable by design. Caveat: in-memory fallbacks exist only for SQL-less (test) contexts; production always supplies SQL. |
| 7 | Port Binding | PASS | Worker fetch listener unchanged; stock routes are HTTP routes on the existing binding. Unchanged. |
| 8 | Concurrency | PARTIAL (narrowed) | Cross-instance coordination is closed by SQL-backed suppression (G6). Remaining: the scheduled-chain lock probe and active-chain probe both fail open (proceed ungated if the probe cannot answer) — a deliberate availability choice, documented in `scheduledTasks.ts`. Per-owner locking still gates execution where the probe answers. |
| 9 | Disposability | PASS (remediated) | Suppression claims and stage claims now live in SQL and survive disposal/restart (G6/G8); #3027 adds the production checkpoint store over `mas_async_jobs`. Process lifecycle (fast start/hibernation) unchanged. |
| 10 | Dev / Prod Parity | PARTIAL (narrowed) | G6/G8 tests use SQL-shaped `MockSqlStorage` for the claims stores — closer to production than the pure Sets the original audit found — but the doubles are still not DO SQLite. Miniflare/workerd parity for the Worker itself is unchanged. |
| 11 | Logs as event streams | PASS (remediated) | Both original reasons are closed: the `runScreen` funnel emits structured JSON `logScreenRunEvent` lines (started/completed/failed + classification), and scheduled-chain submission now emits the same events with classification (audit shard-logging PR). The stage-consumer PDF leg runs inside the funnel-logged `persistRun`, so its runs are covered. Nuance, not a gap in this factor: in-flight chain stage execution surfaces via job rows + audits, not structured log events (a shared-executor decision for #2621). |
| 12 | Admin Tasks | PASS (assessed) | Retention register exists (`src/security/storageRetention.ts`, #786 decision: `usage_events` PRUNE-CLASS at 365d); pruning rides the sweep callback, not web requests; migrations run as one-off scripts. Note, not a violation: `mas_reports` has no pruning today — a recorded retention decision (`scheduledReports.ts`), not an admin task running inside the request path. |
| 13 | API-First | PARTIAL (unchanged) | REST routes + typed `StockScreenRunSpec` precede UI use. Remaining: the OpenAPI spec (`src/security/openapiSpec.ts`) covers catalog paths and methods, but hand-written schemas cover only the pilot set (GET `/api/me`, GET `/health`); stock routes are marked "not yet specified" at schema level. Goal spec remains a record, not an executable API path (G7 dated decision: goal execution stays goal-owned). |
| 14 | Telemetry | PARTIAL (narrowed) | Structured run logs + per-run trace ids exist; chain submissions now carry `chainId` as `trace_id`, giving chains a correlation id. Remaining: the funnel `trace_id` is a fresh UUID per `runScreen`, not the workflow `traceparent` (correlation across workflow hops rides `traceparent` separately); no metrics aggregation for new stock modules. |
| 15 | AuthN / AuthZ | PARTIAL (narrowed) | Owner record, per-owner lock, route guards, broker goal guard, workflow tenant isolation. New since the original audit: cross-owner report-read denial is negative-tested (`tests/scheduled_report_by_id.test.ts`: "hides another owner's report when the caller login is known"). Remaining: no negative test found for workflow tenant mismatch or cross-owner replay. |

## What would change the overall verdict

- Factor 8: fail-closed (or explicitly risk-accepted, owner-signed) chain
  lock/active-chain probes instead of fail-open.
- Factor 10: DO-SQLite-backed test fixtures for the claims/suppression
  stores, or a documented parity statement for the doubles.
- Factor 13: hand-written OpenAPI schemas for the stock routes
  (market-data screen, reports/replay, screener routes) beyond the
  pilot set.
- Factor 14: funnel `trace_id` carried from the workflow `traceparent`
  (or an explicit correlation map), plus metrics aggregation for stock
  modules.
- Factor 15: negative tests for workflow tenant mismatch and
  cross-owner replay.

Until then: NOT COMPLIANT as a whole. This document makes no
compliance claim; it records the audit.
