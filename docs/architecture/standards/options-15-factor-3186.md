# 15-factor audit — the one options workflow (#3186)

Scope: the NEW #3186 code only — the options pipeline (composer,
plain + panel + scanner ports, Blocks), its entry migrations (goal
leg, manual entry, unified handler, NLQ legs, scheduled monolithic
branch, sharded branch, manual panel route, compare route,
`runStrategyPipeline`), and the checkpoint/resume proof. Not the
pre-existing screener capability — for that, see the qualified table
in `docs/architecture/application/screener.md` §9 (which this audit
does not replace and does not cite as evidence).

Method: code evidence in the #3186 build tree (base `a40c33cb`,
steps 1–3e + step 4 proof + step 5 AOP decision). Factor numbering
and interpretations follow `docs/agentic-org/architecture.md` §6 —
§6 ordering governs (factor 15 is authentication/authorization).
Format follows the #2860 re-audit
(`docs/architecture/standards/stock-15-factor-reaudit.md`). The
hardcoded-COMPLIANT test (`tests/fifteen_factor_and_usability.test.ts`,
which asserts its own conclusion) is NOT evidence for any verdict
below and must not be cited as such.

## Overall: NOT COMPLIANT as a whole

9 PASS / 6 PARTIAL / 0 FAIL / 0 NOT VERIFIED. No 15-factor
compliance claim may be made for the one workflow until Factors 6,
7, 9, 10, 14, 15 are remediated (each narrowed — see the rows).

## Per-factor verdicts (§6 order)

| # | Factor | Verdict | Evidence (#3186 build tree) |
|---|---|---|---|
| 1 | One codebase, one application | PASS | Single repo; new modules under `src/workflows/` (`optionsScreenWorkflow.ts`, `optionsScreenPorts.ts`, `strategyScreenPorts.ts`, `goalOptionsLeg.ts`, `manualOptionsScreen.ts`, `manualPanelScreen.ts`, `blocks/optionsBlocks.ts`) plus entries in existing route/service/trading files. No second repo/app. |
| 2 | API first | PASS | Contracts precede implementation: the #2869 stage-message contract (`src/workflows/stageMessage.ts`, stage ids + claim rules), the Block contract (`blocks/blockContract.ts`), the planner port, and the stage port interfaces (`OptionsStagePort`) were built in steps 1–2 before any entry migrated in step 3. Stage ids are pinned by tests (`tests/stage_families_3186.test.ts`). No new HTTP API surface: entries reuse existing routes. |
| 3 | Dependency management | PASS | No `package.json` change in the #3186 diff (48 changed files, none of them `package.json`); new modules import repo-internal modules + stdlib only. |
| 4 | Design / build / release / run | PASS | Vite build → Wrangler release → edge run unchanged; the pipeline adds no build-time/run-time conflation. Build verified green repeatedly through the step-3e swaps. |
| 5 | Configuration / credentials / code | PASS | No hardcoded secrets/credentials in new modules; no new env vars; the `SCREENER_EVENTS` queue binding rides the existing env; stage storage/claims/queue are injected deps, never hardcoded. |
| 6 | Logs | PARTIAL | Stage boundary messages ARE structured events (stageId, runId, family, idempotency key, outcome code) published per stage via the queue transport, and the composer warns (`deps.warn`) on skipped publishes. But the options pipeline emits no structured JSON log lines of the `logScreenRunEvent` kind the stock funnel has — new-module logging is `console.warn`/`console.error` calls (manual-entry delivery failures, scanner persist failure). A run's progress is visible via the queue / Workflow Runs surface, not the log stream. Redaction is not a gap here: messages carry run/stage ids and error strings, no secrets. |
| 7 | Disposability | PARTIAL | Proven for the durable-store legs: the step-4 proof (`tests/options_checkpoint_resume_3186.test.ts`) shows a second run over the same runId re-executes nothing, claims survive an instance eviction (fresh store over the same SQL still skips), and a failure releases only the failed stage's claim with resume after the last completed stage. But the in-memory legs (NLQ panel/scanner, scheduled, shard) lose stage artifacts on eviction — their durable record is the persist stage's canonical write + downstream report/delivery, and durable claims/storage for those legs is a NAMED follow-up (doc comment on the shared helpers), not built. No explicit cancel path in the pipeline (that is #3069). |
| 8 | Backing services | PASS | All backing state behind explicit injected interfaces: `OptionsStageStorage`, `StageClaimStore`, `ScanRunStore`, queue (`StageQueueSend`), canonical store via `optionsServeRecord`. No hardcoded store access in the composer or ports. |
| 9 | Environment parity | PARTIAL | Test doubles are SQL-shaped `MockSqlStorage` for claims (closer to production than pure Sets) and Map memory storage for the in-memory legs; the in-memory legs run on DO storage in prod (manual/unified/goal) vs memory in NLQ/scheduled/shard by design — the difference is documented in code (`optionsScreenWorkflow.ts` header, per-entry comments) but is a real behavioral difference (no resume for those legs). Miniflare/workerd parity for the Worker itself unchanged. |
| 10 | Administrative processes | PARTIAL | No new admin process rides the request path; the claims table is ensured lazily per the #2869 pattern (unversioned — no migration file). The gap: NO retention decision for `mas_stage_claims` — the retention register (`src/security/storageRetention.ts`) claims a decision for EVERY `mas_*` table and this table is absent, while every pipeline run writes up to 8 rows that are never deleted. Filed as #3253 (sub-issue of #3186). |
| 11 | Port binding | PASS | No new entrypoint; the pipeline runs inside existing Workers (routes + DO + scheduled tasks). The 5th CF workflow binding question (durable async start for the pipeline) is OPEN on #3186 as a platform design decision, not a violation — the pipeline is in-process where no binding exists, like the goal leg. |
| 12 | Stateless processes | PASS | No reliance on accidental process memory: durable state has explicit ownership (`mas_stage_claims`, `mas_reports`, `mas_opportunity_scans`, stage artifacts keyed `options:<runId>:<stage>`); in-memory stores are per-run (`memoryStageStorage`/`memoryStageClaims` created per run) and documented as run-duration only. |
| 13 | Concurrency | PASS | One run is sequential (stages in order); the scanner's per-symbol fetch is bounded by `mapLimit` + the #1204 shared fetch budget (pre-existing); cross-instance claim races rely on DO residency + `INSERT OR IGNORE` (the #2869 design, documented in `stageClaimsStore.ts`). No new unbounded concurrency. |
| 14 | Telemetry | PARTIAL | Per-stage boundary messages with the runId correlating all 8 stages; outcome codes from the catalog (step 5: generic `SCREEN_*` only, pinned); Workflow Runs surfacing via #2786. Remaining: no metrics aggregation for the new modules; the runId is not the CF workflow `traceparent` (the #2860 factor-14 gap persists — correlation across workflow hops rides `traceparent` separately; the #2989 `workflow_run_id` seam correlates where a CF workflow instance exists). |
| 15 | Authentication / authorization | PARTIAL | Identity enforced at every entry: goal leg + manual entry fail closed without a login; unified handler + panel route + compare route fail closed at the route; `runStrategyPipeline` threads `this.userLogin` (required by the service ctor, #1185); NLQ legs thread the session login; the composer never invents an identity; owner-scoped canonical writes (`requireLogin` in the plain ports; owner-scoped `scanRunStore` get/save). Remaining (the #2860 factor-15 gap, unchanged): no negative test for workflow tenant mismatch or cross-owner replay FOR THE PIPELINE — stage artifacts are keyed by unguessable runIds under the DO storage handle, but no test proves a second tenant cannot read/replay them. |

## What would change the overall verdict

- Factor 6: structured JSON log lines for pipeline runs (a
  `logScreenRunEvent` equivalent for the options pipeline), or an
  explicit decision that stage messages are the log stream for this
  path.
- Factor 7: durable claims/storage for the NLQ, scheduled, and shard
  legs (thread the sql handle through, as the goal leg / manual entry
  / unified handler already do).
- Factor 9: DO-SQLite-backed test fixtures for the claims/storage
  doubles, or a documented parity statement for the in-memory legs.
- Factor 10: #3253 — retention decision + enforcement for
  `mas_stage_claims`, recorded in the retention register.
- Factor 14: metrics aggregation for the new modules, and runId ↔
  `traceparent` correlation (or an explicit correlation map).
- Factor 15: negative tests for workflow tenant mismatch and
  cross-owner replay on the pipeline's stage artifacts.

Until then: NOT COMPLIANT as a whole. This document makes no
compliance claim; it records the audit.
