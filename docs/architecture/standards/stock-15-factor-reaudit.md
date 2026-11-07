# 15-factor re-audit — new stock-programme code (#2860)

Scope: the NEW stock-programme code (#2764 slices, gaps G1–G7, G8
wiring, audit follow-ups). Not the pre-existing screener capability —
for that, see the qualified table in
`docs/architecture/application/screener.md` §9 (which this re-audit
does not replace and does not cite as evidence).

Method: code evidence on main after the G-series and audit follow-ups landed. The hardcoded-COMPLIANT test (`tests/fifteen_factor_and_usability.test.ts`, which asserts its own conclusion) is NOT evidence for any verdict below and must not be cited as such.

## Overall: COMPLIANT

15 PASS / 0 PARTIAL / 0 FAIL / 0 NOT VERIFIED. The original audit
(2026-11-02, on 730c1cb5) found 6 PASS / 7 PARTIAL / 1 FAIL / 1 NOT
VERIFIED. The FAIL (Factor 6) and the NOT VERIFIED (Factor 12) were
closed in the first re-audit (PR #3040, main 6f24ec0e, 10 PASS /
5 PARTIAL). The five remaining partials — Factors 8, 10, 13, 14, 15 —
are remediated below, one slice each, all merged via the queue under
#2860 (user decision 2026-11-06 06:03 EST: FULLY COMPLIANT, not
"qualified, not compliant"; all five bundled, not Factor 15 standalone).
No 15-factor compliance claim is made beyond what this document records.

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
| 8 | Concurrency | PASS (remediated) | PR #3560, main 6a17e04d: both sharded-chain gate probes are fail-closed in `src/services/scheduledTasks.ts` (`autonomousMarketScreenSharded`) — a probe that throws now yields a skipped shape `{skippedReason:"gate-unavailable"}`, audited as `screener.sharded_chain_gate_unavailable`, and no `shardSubmit` runs. `tests/factor8_fail_closed_probes_2860.test.ts` (6 tests, TDD red→green). Boundary, unchanged by this slice: an unconfigured probe (no `platformDeps.sql`) is not fail-closed — only an attempted probe that throws. Post-merge CI on 6a17e04d verified green (15 successful, 4 skipped, 0 failed). |
| 9 | Disposability | PASS (remediated) | Suppression claims and stage claims now live in SQL and survive disposal/restart (G6/G8); #3027 adds the production checkpoint store over `mas_async_jobs`. Process lifecycle (fast start/hibernation) unchanged. |
| 10 | Dev / Prod Parity | PASS (remediated) | PR #3569, main c876b443: DO-SQLite-backed fixtures (`tests/do-sqlite-fixture.ts`, `node:sqlite` — the same SQLite engine `ctx.storage.sql` runs, reached through the same `SqlStorage` exec shape; file-backed `reopen()` is the DO-eviction stand-in). `tests/factor10_do_sqlite_claims_2860.test.ts` (7 tests) runs both production stores (`createSqlDeliverySuppressionStore`, `createSqlStageClaimStore`) on real SQLite — claim/already-claimed/release, per-destination and per-stage scoping, the real `(key) PRIMARY KEY` constraint (a raw duplicate INSERT throws), and cross-instance suppression after close + reopen. The existing G6/G8 suites are untouched (they still pin bridge behavior against their doubles; this slice adds real-SQLite coverage alongside them). The documented-parity-statement alternative was NOT taken — full compliance means real fixtures. Post-merge CI on c876b443 verified green (10 successful, 6 skipped, 0 failed; Tests MQ/PR shards skipped). |
| 11 | Logs as event streams | PASS (remediated) | Both original reasons are closed: the `runScreen` funnel emits structured JSON `logScreenRunEvent` lines (started/completed/failed + classification), and scheduled-chain submission now emits the same events with classification (audit shard-logging PR). The stage-consumer PDF leg runs inside the funnel-logged `persistRun`, so its runs are covered. Nuance, not a gap in this factor: in-flight chain stage execution surfaces via job rows + audits, not structured log events (a shared-executor decision for #2621). |
| 12 | Admin Tasks | PASS (assessed) | Retention register exists (`src/security/storageRetention.ts`, #786 decision: `usage_events` PRUNE-CLASS at 365d); pruning rides the sweep callback, not web requests; migrations run as one-off scripts. Note, not a violation: `mas_reports` has no pruning today — a recorded retention decision (`scheduledReports.ts`), not an admin task running inside the request path. |
| 13 | API-First | PASS (remediated) | PR #3582, main aee297b5: hand-written OpenAPI schemas for 10 stock paths in `src/security/openapiSpec.ts` (`stockPaths()` / `stockSchemas()` / `STOCK_SPEC_PATHS`, merged into `buildOpenApiSpec()`). `tests/openapi_spec.test.ts` pins all 10 paths/methods, `$ref` resolution, and spot-checks (202/429, replay 404/422, preset enum + name `maxLength` 100, artifact 404s, regenerate 502). `/api/reports/list` + `/api/reports/seed-canonical` stay not-yet-specified; goal spec stays a record, not an executable API path (G7 dated decision: goal execution stays goal-owned). Post-merge CI on aee297b5 verified green (10 successful, 6 skipped, 0 failed; Tests MQ/PR shards skipped). |
| 14 | Telemetry | PASS (remediated) | PR #3587, main 879bd3bd: `funnelTraceIdForRun` (`src/workflows/screenRunAspects.ts`) returns the workflow `traceparent`'s trace-id (malformed or absent traceparent keeps the old fresh-UUID behavior); the traceparent threads `WorkflowJobCommand` → `shardScreenRequest` → adapter `toAgentRequest` → `ScreenerRunRequest.traceparent` → `runScreen`, where ONE derived traceId serves the whole run (lock refusal, started, completed, failed). Metrics aggregation is new `src/telemetry/screenRunStats.ts`, folded at the `logScreenRunEvent` join point (started/completed/failed counts + total duration by (trigger, universe), failures by classification, snapshot reader + test reset; per-isolate, following the `retrievalStats` precedent — the durable home is #1743's Analytics Engine pipeline, a named follow-up, not built here). `tests/screen_run_traceparent_metrics_2860.test.ts` (12 tests). Post-merge CI on 879bd3bd verified green (10 successful, 6 skipped, 0 failed; Tests MQ/PR shards skipped). |
| 15 | AuthN / AuthZ | PASS (remediated) | PR #3596, main 1ab34135: `tests/factor15_replay_negative_2860.test.ts` (12 tests) — replay API cross-owner 404 by `reportId` / `runId` / `symbol` (never the envelope), own replays 200 with provenance, unauthenticated 401; MCP replay path per-user asset-instance isolation (another owner's key misses on the caller's own `ReportAssetAgent` instance as `asset_not_found`, list scoped to the caller, no acting identity fails closed); workflow read-back tenant filter over a real D1 adapter (`readJobHistory`: a chain under tenant A does not read back under tenant B; unbound store reads nothing). NO HOLE FOUND on any seam — the existing owner/tenant scoping already refused everywhere probed, so per the test-plus-harden decision (2026-11-06) this slice is test-only: no code change, no follow-up filed. The `buildReplayFromRecord` seam stays as documented (row lookup enforces owner scoping). Post-merge CI on 1ab34135 verified green via the check-runs API: 30 successful, 4 skipped, 0 failed across the 34 check runs on the commit — all required checks successful (Policy Gate, CodeQL, Gitleaks, Test & Build (Node 22) [PROD], Load Active Environment); Tests MQ shards 1–4 successful, Tests PR shards skipped. |

## What changed the overall verdict

- Factor 8: fail-closed chain lock/active-chain probes (PR #3560, main
  6a17e04d) — the fail-open availability choice is gone; the
  owner-signed risk-acceptance alternative was NOT taken.
- Factor 10: DO-SQLite-backed test fixtures for the claims/suppression
  stores (PR #3569, main c876b443) — the documented-parity-statement
  alternative was NOT taken.
- Factor 13: hand-written OpenAPI schemas for the stock routes
  (market-data screen, reports/replay, screener routes) beyond the
  pilot set (PR #3582, main aee297b5).
- Factor 14: funnel `trace_id` carried from the workflow `traceparent`,
  plus metrics aggregation for stock modules (PR #3587, main
  879bd3bd).
- Factor 15: negative tests for workflow tenant mismatch and
  cross-owner replay, on both surfaces (PR #3596, main 1ab34135) —
  no hole found, test-only per the test-plus-harden decision.

Overall: COMPLIANT (15 PASS / 0 PARTIAL / 0 FAIL / 0 NOT VERIFIED).
This document records the audit; it makes no compliance claim beyond
the verdict above, which rests on the per-factor evidence in the
table. The hardcoded-COMPLIANT test
(`tests/fifteen_factor_and_usability.test.ts`) remains NOT evidence
for any verdict here.
