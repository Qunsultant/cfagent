# Screener workflow: current state and transformation to the unified workflow

**Status:** v2, published 2026-10-27. v1 (PR #1979, main `cbbe5f7`) mapped the pipeline and
proposed the transformation; v2 folds in all six lanes' feedback on #1972 (comments
`6447040561`, `6447045836`, `6447078725`, `6447089438`, `6447094527`, `6447165544`) and
the owner's product framing (§0). **No implementation starts from this document alone** —
the journey it describes begins only after lane feedback (now received) and the queue
decision in §7. Evidence base: code research on `origin/main` at `4852476` (2026-10-27),
issue states re-verified 2026-10-27, the #1963 fix verified on main at `9b38d3b` (PR
#1974, merged), and lane feedback verified against main `b1201801` (2026-10-27).

**Related issues:** #1963 (CLOSED — goal-screen false `Complete`, fix PR #1974 merged),
#1972 (OPEN — goal screen on the unified workflow), #1904 (OPEN — IROS target-state
remediation program, owns the target DAG), #1965/#1966 (scheduled-auth fix, merged),
#1968 (audit read path, open), #1969 (AOP codes program, open), #1344 (per-user jobs,
open — gating, see §7), #1955 (PortThink migration sequencing, see §7).

## 0. Product framing: the lifecycle this journey serves

This document's transformation (§7) is one program inside a larger product, stated by the
owner 2026-10-27. The product is a **multi-dimensional agentic SaaS stocks / options /
goal / strategy screener — a research product — built as an RSI/ASI product on an
agentic platform**: multiple engines + thinkagent (goal orientation, memory, vector, and
related capabilities) + queues + workflows with stages + schedules (timed and manual
triggers) + D1/DO/R2 state management + Flagship feature flags, with real-time **and**
batch capability, sync **and** async capability, full resilience and other ilities, and
observability/testability — built per architecture standards, best practices, blueprint,
guidelines, and a framework-driven approach with all aspects (AOP) — to build
competencies and enable capabilities that empower day-traders through wealth managers.

**Boundary:** it is a research product. It recommends and creates autonomously; a human
approves before any trade execution (#1904 invariant). The lifecycle empowers the
decision; it does not take the trade.

**The lifecycle, in one line:** the unified workflow (schedule → queues → feed → gather
→ store → serve → deliver) × all four screen families × the scenario set below, closed
by the #1904 P4 outcome→calibration loop (thesis realizations feeding calibration
decisions, #1742) — that loop is what makes the product self-improving rather than a
collection of screens. #1972 migrates one family (goal) onto that workflow; it does not,
by itself, deliver the product.

**Scenario set the lifecycle must serve** (owner's list, mapped to coverage):

| Scenario | Coverage today | Journey note |
|---|---|---|
| Pick best trade | Standouts/opportunities selection + candidate structures exist in the engines. | Trustworthy only with staged leg honesty (done via #1963). |
| Name that fits my strategies | Screening (strategies → names) exists. | The staged path makes it auditable per stage. |
| Strategies that fit my name | Reverse direction: recommendation kernel + comparison route + goal candidate structures exist as pieces. | Not yet a staged flow; a capability to wire, not a new engine. |
| No-thesis approach | Unknown, intended as everything — works mechanically. | Unusable as a 6594-row table; needs a capped/summarized view in the staged panel (CPO). |
| Portfolio repair | Repair thesis (one of nine theses). | Deferred by CPO sequencing: after the two-thesis proof. |
| Hedging | Hedge/Protect thesis (one of nine theses). | Deferred by the same sequencing. |

The nine theses are Income, Directional, Volatility/Event, Hedge/Protect, Repair,
Deconcentrate, IV Harvest, Capital-Efficient Leverage, Cash-Secured Entry. CPO's
sequencing proves selective screening on two first (Income+Bullish, Directional+Bullish)
and lets the other seven follow once the leg pattern is proven — scoping all nine into
Phase 3 would repeat the everything-or-nothing failure mode at program scale.

**Vision → state, honestly:** engines exist (unification missing); thinkagent is partial
(actor port + ScreenerAgent-as-actor exist, #1738; retrieval #1740 exists but its graph
was never populated in production — do not plan on it; PortThink #1955 in flight);
queues/workflows/schedules/state/flags exist (former gaps Q1 consumer, DLQ, breaker durability — closed by #2544 and Phase 5 slices 1–2);
batch is real, real-time is live-fetch + poll with **no streaming or push** (true push
realtime, if the vision needs it, is a named gap, not a current capability); sync + async
both exist; resilience/observability/testability exist with the gaps §2.5/§6 name; AOP is
aspect-adjacent, not aspect-driven (#1969 closes that gap); the RSI loop (P4) is an open
program piece, not a shipped loop.

## 1. The target workflow in one paragraph

The standing ruling, and the IROS target DAG, is one staged pipeline every screen family
runs through:

**schedule → queues → feed → gather → store → serve → deliver**

The UX submits a run request through the same submission endpoint as other screeners; the
flow is triggered by creating a schedule (or an ad-hoc run request) → workflow → queues →
feed (acquire) → gather (enrich with indicators) → store (report/blob) → serve
(Reports/Runs) → deliver (email/Slack/webhook). The UI reads the stored result instead of
awaiting a synchronous screen. Stock, goal, options, and strategy screens all run this same
pipeline — providers shared via the registry **and** the workflow shared end to end.

Section 2 maps what exists today against that DAG. Sections 3–5 explain the one place the
DAG is most visibly broken (the goal screen) and correct an overbroad claim made about it.
Section 7 turns the map into a sequenced transformation.

## 2. Current state: the map

### 2.1 Stages (9, in order)

The code's own canonical order names only 5 — `feed, generate, store, serve, deliver`
(`src/services/shardJobs.ts:88-95`, `PIPELINE_STAGE_ORDER`) — because it folds trigger/auth
into the caller and analysis into `generate`. The full execution order, with the places the
2026-10-27 failures actually lived, is:

| # | Stage | What it does | Owner |
|---|---|---|---|
| 0 | Trigger / schedule fire | Agents SDK schedule (cron or interval) fires a stored callback; manual Trigger-Now dispatches the same callback with `trigger:"manual"`. | `src/agents/orchestrator/scheduledCallbacks.ts:98,299,386`; `src/agents/routes/schedules.ts:120-127` |
| 1 | Identity + auth guard | Payload login wins over saved execution context (`resolveScheduledLogin`, post-#1965); E*TRADE preflight: verify → one renew attempt → block. Stock/goal-stock blocked runs fall back to Yahoo; options runs block hard (AUTH_003). **Trust correction (CISO):** the guard stage must also authorize the run itself through the PDP seam (`checkPermission`, #1751) — not just preflight the token — and must carry the #1749 legacy-session bound (PDP-exempt only inside absolute session lifetime; past it, gates deny until re-login). | `src/agents/orchestrator/scheduleMaintenance.ts`; `src/services/etradeAuthPreflight.ts` via `src/services/scheduledTasks.ts:475-503`; `src/security/authorization.ts` |
| 2 | Feed / acquire | Resolve universe → listings (Nasdaq) → quotes (E*TRADE batch, or Yahoo batch). Sharded stock chains split this into `nasdaq → etrade → yahoo` feed shards, in that dependency order. **Route-table correction (CDO):** live-quotes mode is E*TRADE primary + Yahoo gap-fill **per element** (contract + per-element routing, #1118); etrade-only mode has no gap-fill and fails hard. A gap-filled quote must carry its gap-fill mark; an etrade-only refusal must surface, not silently Yahoo. Every platform-routed leg also writes capture rows (see §2.4 stage 2). | `src/trading/screenerPipeline.ts:1010`; `src/services/shardJobs.ts:54,136-172`; `src/trading/dataProviders/contract.ts`, `adapters.ts` |
| 3 | Gather / enrich | Attach technicals + factor grades to every quote: RSI/MACD/gap via `attachTechnicals`, grades via `attachFactorGrades`. **This is the pipeline's gather — not `gather.ts`** (§5). | `src/agents/screener-agent.ts:359-364`; `src/trading/screenerPipeline.ts:1810,1840` |
| 4 | Analysis / score / filter | Apply filters, compute screened set, select standouts/opportunities. Options: strategy engine + direction tags over chains. Goal: scenario/thesis gates over legs (on raw listings quotes, not gathered indicators, for the goal path — §3). | `src/trading/screenerPipeline.ts:1716,1858,1895`; `src/trading/options/unifiedOptionsService.ts` via `src/services/scheduledTasks.ts:1760+` |
| 5 | Generate report | PDF via ReportAssetAgent (single owner), XLSX, CSV. Per-format failures are recorded, never fatal, in the monolithic path. | `src/services/unifiedReportPipeline.ts:124+`; `src/agents/screener-agent.ts:1408` |
| 6 | Store | Persist run (latest + history), canonical `mas_reports` row, report blobs (R2 or DO-base64 legacy). Sharded chains: per-format store shards + per-shard projection rows. | `src/agents/screener-agent.ts:1352` (`persistRun`); `src/services/reportBlobStore.ts`; `src/services/shardJobs.ts:237` |
| 7 | Serve | `followup.report` job adopts stored artifacts and verifies them; UI reads `/api/screener/latest`, history, and `report.pdf?key=…`. Serve "performs reads, not fetches, and carries no withRetry" (`shardJobs.ts:88-95`). | `src/agents/orchestrator/asyncJobs.ts:760+`; `src/services/screenerFollowups.ts:221` |
| 8 | Deliver / notify | Per-channel `followup.deliver` jobs (Slack, email, webhook) + `followup.notify` lifecycle messages (started/completed/partial/failed/blocked/held/delivered). Plus in-process event-bus publishers, the CF Queue delivery subscriber, and websocket `broadcast`. | `src/agents/orchestrator/asyncJobs.ts`; `src/events/screenerPublishers.ts:209`; `src/messaging/screenerQueueConsumer.ts` |

The four wrappers converge — but not identically. All four live in
`src/agents/orchestrator/scheduledCallbacks.ts` and delegate to `ScheduledTasksService`
(`src/services/scheduledTasks.ts:303`): `autonomousMarketScreen` (:98) → stock pipeline;
`autonomousGoalScreen` (:299) → `executeGoalScreenRun` → `ScreenerAgent.runGoalDrivenScreen`
(a different engine, §3); `autonomousStrategyDiscovery` (:386) → discovery pipeline
(`SqlDiscoveryRunStore`); `autonomousOptionsAnalysis` (an `OrchestratorAgent` method,
`src/agents/orchestrator.ts:818-850`, not a scheduledCallbacks function) →
`UnifiedOptionsService`. All four share stages 0–1 and stage 8 plumbing, but stages 2–5
differ by family. "Same pipeline" is true at the *scheduling + delivery* layers, false at
the *screen engine* layer.

### 2.2 Agents, workflows, schedules, job systems

| Agent / system | Role |
|---|---|
| OrchestratorAgent (`src/agents/orchestrator.ts`) | Schedule host: callbacks, `submitAsyncJob` port, follow-up bridge, broadcast, schedule store, sweep. Not the screen engine. |
| ScheduledTasksService (`src/services/scheduledTasks.ts:303`) | The actual pipeline orchestrator: guard, sharded dispatch, fallback, audit, event publish, report/delivery chaining. All four wrappers funnel here. |
| ScreenerAgent (`src/agents/screener-agent.ts`, DO `SCREENER_AGENT`) | Stock screen (`runScreen`, `runScreenInner`), per-user lock, duplicate claim, `persistRun`, PDF/XLSX getters, goal-screen surface (`runGoalDrivenScreen`). |
| ScheduledAgent (`src/agents/scheduled-agent.ts`) | **Not** a screener agent. Evaluates goals on the `*/30` tick; its header says screening callbacks do **not** live here. |
| ReportAssetAgent (`src/agents/report-asset-agent.ts`) | Single owner of PDF generation. |
| ResearchAgent / TradingAgent / PaymentsAgent / OptionsScannerMCP | Bound DOs, not in the scheduled screen path. |
| Worker crons (`wrangler.jsonc:108-127`) | `0 3 * * *` token renewal; `*/30 * * * *` ScheduledAgent tick; `0 4 * * *` retention. **No screen cron lives here** — screens are Agents SDK schedules, not Worker crons. |
| Agents SDK schedules (`src/agents/routes/schedules.ts:120-127`) | **The screen scheduler.** Per-schedule cron, interval (options: 3600s), date, or delay. Stored in Orchestrator DO. |
| Cloudflare Workflow `screener-screen-workflow` (`wrangler.jsonc:15-18`, `src/workflows/screenerWorkflow.ts`) | Parent fan-out (max 4 parallel, 10-min shard deadline, 15-s poll, step retries 3) + child shard flows (execute → store → deliver → project). **Only 3 manual routes call it** (`etradeBrokerScreen.ts:114`, `marketDataResearch.ts:328`, `premium.ts:493`). **Zero callers in `scheduledTasks.ts` or `scheduledCallbacks.ts`.** Falls back to sync on any start failure. |
| Sharded async-job chains (`src/services/shardJobs.ts`, `src/services/shardExecutors.ts`) | **The scheduled path's actual "workflow".** Chain: feed → generate (assemble → pdf/xlsx/csv) → store → serve → deliver, advanced hook-by-hook on completion. A failed shard stops its chain. Separate from Cloudflare Workflows — two staged systems, same stage names. |
| `stageChain` mechanism (`src/agents/orchestrator/asyncJobs.ts`, `orchestrator.ts`) | **The per-stage record system the stage model rides on (COO correction — v1 mentioned it once in passing).** Per-record chaining, per-stage status, per-stage retry (`retryAsyncJob`: failed-only, `retryOf` + original stage/chain identity carried, double-retry refused). Market-screen bridge (C3 #1277/#1316); extended to options/discovery/goal + generic http.request (C4 #1329/#1359); goal deliver chaining (#1549). |
| Feed seam (`mas_feed_snapshots`, `feed.snapshot` job, `snapshotInput` consumer) | **The feed persistence seam (COO correction — v1 cited only `SqlFeedSnapshotStore`, discovery only).** Two snapshot mechanisms exist; the journey must pick one deliberately, not invent a third. `#1236` / PR #1691. |
| Flag rollout idiom (`FeatureFlagPort` + Cloudflare Flagship `FLAGS` binding) | **The rollout vehicle (COO correction — v1 had no flag idiom).** Precedent: C5 adaptation routes behind a default-OFF flag. The goal flow rolled out behind a default-OFF flag, goal flow only (see §7) — default-ON since #2051. |
| `mas_async_jobs` job table (Orchestrator DO SQLite) | `submitAsyncJob` (`asyncJobs.ts:206`); capabilities include `followup.report`, `followup.deliver`, `followup.notify`, `shard.execute`, `feed.snapshot`. Platform alarm re-arms once at most (`maxAttempts:1`); job-level retry is manual (`retryAsyncJob`). Queued rows re-arm after restart (cap 100/batch). |
| Follow-up chain, shard reconcile, sweep, retention, token renewal | Chain bridge (`asyncJobs.ts:444,552`); hook-driven reconcile (`shardJobReconcile.ts:51`); stale-ledger sweep; nightly retention; nightly token renewal with deduplicated Slack alert on failure (no morning refresh exists). |

### 2.3 Queues (7 mechanisms, 2 Cloudflare Queues)

| # | Queue | Producer → Consumer | Loss behavior |
|---|---|---|---|
| Q1 | CF Queue `screener-events` (`wrangler.jsonc:46,56`) | Point-to-point work queue: `producer.send` → Worker `queue()` (`server.ts:4834`) → `createScreenerEventsWorkHandler` (`src/messaging/screenerEventsConsumer.ts`), the consumer revived in #2544. Sole defined work semantics: `options_analysis` (envelope type, or data-level `taskType`); any other envelope type drops as `no_handler`. | Handler throw → platform retry (max 3) → `screener-events-dlq` with run/unit ids intact; undecodable → ack + dead-letter record (never poison-loop); terminal drops persisted + operator-replayable since Phase 5 slice 1 (denied/undecodable refused). No production producer sends to Q1 today (verified 2026-11-02); the goal flow never touches Q1 (Workflow + Q4 job rows + Q2). |
| Q2 | CF Queue `screener-events-delivery` (`wrangler.jsonc:47,57`, `max_batch_size:10`, `max_retries:3`) | `CfQueueMessagingAdapter.publish` → Worker `queue()` (`server.ts:4784`) → `createScreenerQueueHandler`, handling only `screener.completed`/`screener.failed` for subscriber `delivery`. | After 3 retries: **`screener-events-delivery-dlq`** (wired #2544; `wrangler.jsonc:57`). Undecodable messages are acked + logged (deliberate loss, avoids poison-loop). Dedup seen-set is per-isolate only — cross-isolate duplicates can double-deliver. |
| Q3 | In-process `ScreenerEventBus` (`src/events/screenerEvents.ts`) | Service / queue consumer → publishers (`registerScreenerPublishers`). | **In-memory fan-out, no durability.** If the isolate dies mid-publish, undelivered events are gone. When no queue binding exists, the bus is the *only* path. Publish failures are `console.warn`-only. |
| Q4 | `mas_async_jobs` table | `submitAsyncJob`, follow-up planner, shard planner → Agents SDK `executeAsyncJob` alarms. | Durable; history pruned by design (30 days, latest 500/session) — history loss, not job loss. Oversize payload/result fails the job, does not queue it. |
| Q5 | Agents SDK schedule store (Orchestrator DO) | Schedules API → platform callback dispatch. | Durable; duplicates suppressed by slot claims. Unowned schedules are deleted by `removeUnownedBaselineSchedules` (deliberate, not loss). |
| Q6 | ScheduledAgent goals store (`goals` + `tickHistory` capped at 50) | Goal seeding/admin → `onCron`. | Failed goal run stamps nothing, stays due → retries next tick by design. History truncation is observability loss, not work loss. |
| Q7 | Cloudflare Workflow instances (`SCREENER_WORKFLOW`) | 3 manual routes → Workflow runtime (parent polls children). | Step retries 3; shard past 10-min deadline → `timed_out`, collation proceeds without it (`BudgetConstrained`). If all children time out, the run is `Failed` with summaries only. |

**Total: 7 mechanisms; 2 CF Queues; 5 durable-or-platform-backed in production (Q2, Q4,
Q5, Q6, Q7); Q1 consumer-wired but with no production producer today; Q3 in-memory.** "Nothing is lost" is a design goal, not the
current state.

### 2.4 Persistence + error handling per stage

| Stage | Persistence | On failure |
|---|---|---|
| 0 Trigger | DO schedule store (`schedule.created` audit). | Create throw → API error, nothing created. Callback itself never throws (platform retry deliberately not used; dedup instead). |
| 1 Guard | Audit only: `mas_events` row `etrade.auth_blocked`. Episode-dedup flag in DO blob storage. Guard is read-only — no token row written. | Blocked → typed `AUTH_003` + one alert per episode; rest of day quiet (dedup, by design). Stock/goal-stock → Yahoo fallback; options → hard fail. Audit-insert failure **warns** with type + login + error on the worker-log channel (#1999 D1) — a blocked run with a failed audit write leaves a diagnosable trace, never a silent gap. (Pre-#1999 it was swallowed by `catch {}`.) When a blocked goal-stock run falls back to Yahoo, the audit record must carry which basis ran (E*TRADE vs Yahoo fallback), or the thesis result is not auditable back to its indicators. |
| 2 Feed | **Correction (CDO): for every platform-routed leg, feed persistence is real — every platform fetch writes a `mas_data_captures` row (raw + normalized, run-linked, immutable history) plus a fetch-outcome row** (`captureStore.ts`, #1133; fetch-outcome recording #1248; capture coverage on ALL stock-screen legs including goal screens, #1686). In the monolithic path, quotes additionally live in invocation memory until stage 6. Sharded path: feed shard rows in `mas_async_jobs` + feed snapshots (see §2.2 feed seam). | Per-fetch `withRetry` (acquisition policy, 3 attempts). A *mid-run* feed failure is not retried as a whole run; it surfaces as partial/failed. |
| 3 Gather (pipeline) | **None** — technicals attached in memory, persisted only as part of the stage-6 run row. | Missing history → honest nulls; gates fail closed on absence. No retry, no separate failure state — a gather miss is invisible except as missing fields. **In-memory-only stage.** |
| 3′ Gather (`gather.ts`) | **Would-be:** one JSON blob per run `gather/<runId>.json` (R2 when bound, else DO base64). | N/A — never runs in production (§5). |
| 4 Analysis | **None** until stage 6. Options: `SqlScanRunStore` rows during scan. | Partial → `SCREEN_002` warn + partial publish (or degraded notice below the #1718 floor); zero evaluated → `SCREEN_003` throw → discard, **no report published**. Goal legs pre-#1963: error-status leg surfaced as `Complete` (§3). |
| 5 Generate | R2 bucket `screener` (`REPORTS_BUCKET`) via `reportBlobStore.putReportPdf`; unbound → base64 in DO. Keys `report:pdf:*`, `report:xlsx:*`, `report:csv:*`. | Each format is its own failure domain: status `failed` + error recorded, run continues without that artifact; **no fabricated URL**. Report policy retry: 2 attempts. |
| 6 Store | **Authoritative record first (COO/CDO correction): the canonical `mas_reports` row (one per generation, `reportDispatch.ts`) is the run/result record; the data record is `mas_data_captures` (same run id); artifacts are R2 blobs derived from the row.** ScreenerAgent DO storage (`screener:last_runs` capped 20, `LATEST_KEY` + `HISTORY_KEY`) is a delivery cache, not the record — and its persistence failure is swallowed, so it cannot be authoritative. D1 `AGENT_DB` is a governance projection (seeds, shard reconcile, telemetry), **never the run record** (v1's "D1 projections for the workflow path only" qualifier is withdrawn). `SqlFeedSnapshotStore` holds feed input snapshots, not run results. | Persistence failure in the market wrapper is **swallowed** (`catch {}` — "must not break the screen"). A run can succeed on Slack while leaving no stored run. **Trust correction (CISO): for the goal path, deliver must not claim success for a run with no stored record — that breaks the audit chain Phase 4 is supposed to establish.** `persistRun` records PDF/XLSX failures as status fields, not throws. |
| 7 Serve | Reads stage-6 artifacts; `followup.report` job row in `mas_async_jobs`. | Serve failure → job `failed`, manually retryable only; no `withRetry`. A failed serve blocks deliver (chain stop-point). |
| 8 Deliver | Delivery job rows (`followup.deliver`/`followup.notify`); channel calls synchronous inside the job; queue path Q2. | Delivery policy 3 attempts with backoff; terminal failure → job `failed` + `DELIVER_002`. Broadcast (websocket) failures are `catch {}`-swallowed. Email false-delivered defect class is #1941 (open; binding + result-propagation fix). |

**Swallowed-failure inventory, dispositioned in #1999:** audit insert (stage 1) now
warns; goal-bridge failure now retries + audits; IV-collection store failure now
reports failure; the remaining `Non-critical` sites (message-record writes, websocket
broadcast, idempotent migration, retention-report copy) are accepted with named
reasons on #1999, and one trading-path swallow is tracked as follow-up #2165. For
the goal path the stage-1 and stage-6 items are fail-visible, not merely listed.

### 2.5 Retries, backoff, circuit breaker, observability

One shared executor, `src/services/resilience.ts` (`withRetry`, `base × 2^(retryIndex-1)`,
capped, ±jitter), driven by `src/services/pipelinePolicy.ts:DEFAULT_PIPELINE_POLICY`:
acquisition 3 attempts (250 ms → 4,000 ms, ±25%), delivery 3 (500 ms → 8,000 ms, ±25%),
report 2 (500 ms → 4,000 ms, ±25%); shard mapping: feed→acquisition, generate/store→report,
deliver→delivery, **serve→no `withRetry`**; `RateLimitError`/429 `Retry-After` overrides the
backoff for that attempt; workflow step retries 3.

Circuit breaker: `src/breakers/breakerPorts.ts:62` — failureThreshold 3 consecutive
retryable failures, resetTimeout 30,000 ms, half-open max probes 1; non-retryable
(auth/config) failures do not count. Wired at Yahoo quotes (goal + market paths),
E*TRADE/Nasdaq/public-fetch paths via `defaultBreakerRegistry()`. **Breaker state is
in-memory per isolate** (`src/breakers/inMemoryBreakerAdapter.ts:34`; header: state "resets
on isolate recycle (fail-open on cold start)"). A trip in one isolate does not protect
siblings. A durable cross-isolate breaker store is a stated follow-up in that header — and
is one of the transformation's genuinely-missing pieces (§7). The in-memory *messaging* and
*workflow* adapters exist but are **explicitly never built by the production composition
roots** (`createMessagingPorts.ts:56`, `createWorkflowPorts.ts:51`) — tests/local only.

Observability per stage: audit events via `mas_events` (`schedule.created`,
`etrade.auth_blocked`, `etrade.token_auto_renewed/failed/error`,
`screener.sharded_chain_submitted`, `screener.run_fallback`, `screener.run_completed`,
`screener.opportunities_detected`, `screener.screen_failed`, `goal_screen.*`,
`options.scheduled_analysis_*`, `async_job.queued/retried`, …); Workers Logs (100%
sampling); the **#1743 observability stream — a designed surface, not a passive tap
(CAIO correction): one event schema, W3C traceparent, key-based redaction with
truncated-hash `sessionRef`, whitelist envelope folding counts+ids only, tenant-as-index
single-index rule, Analytics Engine adapter, binding `OBSERVABILITY`, dataset
`observability`**; admin/job
surfaces (`/api/jobs/:id`, AsyncJobsPanel, Records & Ledger Explorer, ScreenersHub history).
**Blind stages:** feed per-symbol failures (only aggregated counts + top skip reason
survive); gather misses (no event, no metric); serve internals (job row only); Q1 (no
consumer metric); breaker trips (emission exists as `breaker.state_changed` CloudEvents,
#1745, but no production subscriber/wiring in the screen path — the #1743 stream is the
subscriber surface; the gap is the wiring); audit *read* path (writes proven; payload
retrievability is #1968, open). **Trace correction (CAIO):** trace propagation across
queue/workflow boundaries is **mechanism-designed, production-proof + surfacing missing**
— not "none": #1739 gives one correlationId from enqueue → run → events → projected D1
rows, #1743 events carry W3C traceparent, job rows join the same chain. Genuinely
missing: production proof on a real staged run, traceparent threading through the
Cloudflare Workflows runtime itself (Workflows do not natively propagate W3C context, so
the envelope must carry it — designed but unproven on the Q7 path), and any surface that
uses the traces (dashboard UI + SQL aggregation are open #1743 follow-ups).

### 2.6 Async vs sync, batch vs realtime

**Boundary-async, execution-sync.** Schedule fire async → wrapper `waitUntilStable` 30 s +
`keepAliveWhile` sync-await → guard sync-await → `runScreen` sync-await (one invocation;
universe fetch batched where available, else per-symbol) → `persistRun` sync-await → event
publish async (queue) or sync (bus fallback) → follow-up jobs async (alarms,
`not_before` stagger) → channel sends sync inside the async job. Sharded variant:
submission sync, all shard work async, collation async (hook-driven). Workflow variant:
parent/child async with 15-s poll sleeps. Manual variant: HTTP request sync-await end to
end (goal screen returns inline, §3), except `async=1`, which selects the workflow path
(202 response).

**Batch vs realtime, quantified.** Subrequest budget `DEFAULT_SUBREQUEST_BUDGET = 35`
(`src/config/etapiConfig.ts:6`); measured options cost ~12 fetches/symbol → monolithic cap
`floor(35/12) = 2` symbols (`scheduledTasks.ts:1690`) — hence auto-shard above 2 symbols for
scheduled options, and the pre-#1785 exactly-3-of-100 symptom. Options sharding: 1 paced job
per symbol, stagger 1,000 ms; 100 symbols ≈ 100 jobs + chain jobs. Stock sharded chains:
feed shards `nasdaq → etrade → yahoo`; generate shards `assemble → pdf/xlsx/csv`. Workflow
sharding: max 4 parallel, 10-min deadline, 15-s poll. Batch windows: `screener:last_runs`
capped at 20; job history pruned at 500/session + 30 days; tick history 50; quote cache
5 min / 200 entries. Realtime pieces: manual trigger, Trigger-Now, live quote fetch at run
time, websocket `broadcast`, queue batch max 10. **No streaming feed, no realtime push of
quotes into an open screen** — every "live" number is a fetch at run time.

### 2.7 AOP fit/gap (from `docs/architecture/code/aop-fit-gap-analysis.md`)

The pipeline is *aspect-adjacent*, not aspect-driven: it has the catalogs, the retry
executor, the breaker port, and the audit sink the AOP doc prescribes, but each is invoked
manually per call site, with per-isolate state and hand-written message variants. Per stage:
trigger — no `@Audit`/`@TenantAware` interceptor, tenant threaded manually, no traceparent
across schedule → callback; guard — best-covered stage (typed `AUTH_002/003`,
`codedMessage`, episode dedup) except the Slack alert text is a hand-written variant, not
the catalog `businessMessage` (#1969 gap); feed — `withRetry` + breaker + registry, but
breaker state in-memory, no `@Measure`/`@Trace` spans, 429 handling per call site; gather
(pipeline) — **no stage identity at all** in the monolithic path (no `gather.*` event, no
metric, no failure state); analysis — coded `SCREEN_002/003` + coverage floor, but raw
`throw new Error` still used for universe/validation failures, and goal-leg failures had no
coded stage failure until #1963; generate — report retry + `REPORT_001/002/003` + single
owner, but per-format failure is `console.warn` + status field, no `@TrackCost`; store —
canonical-report seam, but store failure swallowed in the market wrapper, no `@Audit`
interceptor; serve — job-row projection, but no `withRetry` and no adoption-time validation
(a "ready" result with no artifact key is a downstream `REPORT_003` skip); deliver —
delivery retry + `DELIVER_002` + notification matrix, but per-channel texts hand-built, not
catalog-rendered (#1969 gap #1). A full AOP pass would not invent new stages — it would wrap
the existing ones (interceptor-emitted audit + trace propagation across the Q2/Q4/Q7
boundaries + catalog-only rendering + durable breaker state) and give stage 3 a first-class
failure state. **v2 notes (CAIO):** the AOP doc's observability 62/100 score predates
#1743's Foundation layer and is stale; what remains is Phase 2–4 items (the
MCP-permissions part landed via #1744; the rest sits with IAAA/#1717) plus
dashboard/aggregation. Gap 7's "trace propagation: none" is reworded per §2.5 (mechanism
designed, proof + surfacing missing).

## 3. The goal-screen divergence: why thesis selection was impossible

This section is the #1963 record, kept here because it is the clearest proof of what
"no stage contract" costs. #1963 is now CLOSED; its fix is merged as `9b38d3b` (touches
`src/client/GoalScreenPanel.tsx`, `src/services/goalDrivenScreen.ts`, plus panel and
phase-3 tests). The defect below is the *before* state the fix corrects.

### 3.1 Where the 6594 comes from

The Nasdaq all-listings universe, resolved through the platform Nasdaq provider route. It
is the raw universe size that morning — not E*TRADE quotes, not a filtered result. The
leg's quotes carry price, daily change, and market cap, but **not technical fields**.

### 3.2 Why nothing for any thesis

A thesis maps to a technical momentum filter: Bullish → `bullish_breakout`, Bearish →
`bearish_pullback`, Volatile → `high_relative_volume`. Those gates need 52-week highs,
average volume, and RSI — fields listings quotes do not carry. So `screenLive` refuses
technical filters up front and returns 0 matched plus a `validationError` message saying
exactly that. The goal screen discarded that message and reported `Complete, 0 hits`.
`Unknown` bypasses the guard (momentum `any`), so it returns the whole universe as
"hits". In short, as wired for manual runs, the goal screen's stock leg can only return
**everything or nothing**. No thesis produces a selective screen through it.

The deeper gap, in the §1 frame: the goal screen runs **feed-only for stocks** — it
bypasses the gather stage, so momentum has no indicators to evaluate on. Surfacing the
refusal is the bug fix; actually doing thesis selection (routing to a capable provider, or
through gather) is a follow-up program decision, not the #1963 PR. That decision is §7.

### 3.3 The two live cases (#1963)

- Case 1 — Directional / Unknown, Stocks + Options, symbols `AAPL, NVDA, MSFT`: green
  `Complete — directional (unknown)`, `Scanned 6594 stocks (6594 matched), 0 option
  underlyings (0 contracts matched); 6594 hit(s)`, with Candidate structures `—` on every
  row. The Unknown-direction whole-universe return is **intended** (no thesis =
  everything) and the fix does not change it.
- Case 2 — Income / Bullish, symbol `aapl`: green `Complete — income (bullish)`,
  `Scanned 6594 stocks (0 matched), 1 option underlyings (0 contracts matched); 0 hit(s)`.
  The stock leg is the RC4 refused-filter case; the options leg (1 underlying scanned, 0
  contracts) is exactly the dead-E*TRADE-auth failure with symbols present, previously
  swallowed as `Complete`.

### 3.4 Data sources, artifacts, reuse

- **Data sources.** Stocks = Nasdaq listings + live quotes via the quotes route
  (E*TRADE-primary + Yahoo gap-fill; with E*TRADE dead, effectively Yahoo gap-fill).
  Options = E*TRADE chains — dead auth, so fetches fail.
- **Manual-run artifacts.** A manual run leaves the UI result plus a canonical report in
  Reports, PDF + XLSX + CSV artifacts (0 hits included), and an activity log entry. It
  does **not** email or Slack — the panel sends no delivery request. Scheduled runs add
  deliveries.
- **Pipelines reused.** Route → run execution → ScreenerAgent → provider registry → task
  ledger → scenario engine for the plan → listings stock leg / E*TRADE options leg →
  artifacts → report → log. **The gather stage is the one piece it does not reuse.**
- **Standalone? No.** The goal screen is an orchestration layer over those shared pieces,
  not a second screening implementation.
- **Different from the screener? Different capability, same engine family.** The
  Stocks/Options screens are filter-driven; Goal Screen is goal-driven (scenario → plan →
  candidate structures). The discarded-signal defect is goal-screen-specific — the
  underlying screeners produced the error signals; the goal screen threw them away.

### 3.5 The #1963 fix (Phase 0 of §7 — done)

Strictly three things, per the issue: (1) error-status leg → PARTIAL/FAILED per the #462
partial contract (`failedClasses`); (2) `validationError` stock leg (listings feed refusing
a technical filter) → PARTIAL with the feed's reason; (3) hide the structures column when
no hit carries structures. It does not change the intended Unknown semantics, and it does
not wire gather. Reported at the time: 36/36 targeted tests, `tsc` clean, full battery
re-running on the final tree — then PR → merge → §15 + close. That sequence has since
completed: fix merged as `9b38d3b`, #1963 closed.

### 3.6 Panel and user-read gaps the staged path must fix (CPO)

Two UX gaps the mechanism map misses, both user-facing regressions if the staged panel
repeats them. **In-flight state today:** on submit the panel clears the previous result
and shows only a disabled "Screening…" button — no spinner, no progress, no way back if
the wait exceeds apiFetch's 10-minute deadline (408, job continues in the background). A
staged run makes that gap permanent unless the panel gains a real in-flight view: live
stage progress (stage name + leg status, reusing AsyncJobsPanel/RunDetailView, not a
spinner), the previous result kept visible until the new one lands, and a way back on
408/timeout (the job link and the stored run in Reports/Runs). **Result shape:** a
full-universe result renders thousands of rows, so even the intended Unknown case is
unusable as a table — pagination or a capped/summarized view belongs in the staged
panel's result contract. **Backtest is a consumer of stored runs** (`POST
/api/screening/backtest`, provenance + limitations shown): the staged path must keep
backtest working against stored runs, not just inline results. **The user read:** a user
cannot distinguish "everything matched because no thesis" from "everything matched
because the filter failed" — both render identically. The staged path must keep per-stage
visibility (not per-run only) so that distinction is visible, and must keep the options
leg's dead-auth failure visible per stage as #1963's PARTIAL does per run.

## 4. The correction arc: what was overstated, and what replaced it

The lane investigation of 2026-10-27 first concluded, in the user's words, that "the
staged workflow does not exist yet as runnable code for screens" and that there was "no
feed/gather". That conclusion was investigated narrowly: it grepped for the #1654
`gather.ts` function names, found zero callers, and leapt to "no workflow, no gather".
That conflated one module with the stage, and skipped the lane-built work. The correction,
verified against the actual code, is:

- **Workflows exist.** `ScreenerScreenWorkflow` (Cloudflare Workflows binding) with parent
  fan-out + shard children, store/deliver steps, and stage honesty — running sharded
  market screens.
- **Gather as a stage exists.** Inside the delegated market screen, as technicals
  attachment (`attachTechnicals` / `fetchPlatformTechnicalsBatch` — RSI/MACD/gaps) before
  screening. That is the pipeline's gather. What is unwired is only the #1654 `gather.ts`
  dataset module — a different artifact.
- **Schedules, queues, agents, job system all exist.** ScheduledAgent ticks → callbacks,
  `screener-events` + delivery queues with the bus bridge, the full DO fleet, `asyncJobs` +
  ledgers + shard store + outcome sink.

**The precise divergence is narrower:** goal screens — manual and scheduled — never run
through that workflow or that delegated screen. Scheduled runs use the schedule layer but
the same direct engine; manual runs skip even that. The goal screen's stock leg never gets
the technicals gather, which is why thesis filters refuse.

**Record of the correction:** #1972 was rewritten from "build the workflow" to *migrate
the goal screen onto the existing workflow machinery* (body + correction comment
`6445967705`), and the overbroad claim on #1963 was withdrawn (comment `6445968907`). The
#1963 fix itself is unchanged — it still just makes the direct path honest. #1972 stays
filed, not started, awaiting the queue call in §7.

**Why the UX looked workflow-integrated when it was not:** every `/api/*` request goes
through the same HTTP entry and job envelope, and `apiFetch` polls the 202 job to a result
transparently — so the goal screen *submits* like everything else. The divergence is
inside the handler: instead of a staged workflow, it runs one synchronous direct-registry
screen and returns inline. The goal screen was built (Phase 3) as plan + orchestration over
the provider registry — direct calls by design at the time, before gather existed. Gather
was built later (#1654 slice 8) and never wired into any flow, so there was no staged
pipeline for the goal screen to plug into. The manual path wants a synchronous-looking
result for the UI, so it kept the direct call; scheduled paths added job-tree tracking and
deliveries without changing the screen engine, which made the direct engine look
workflow-integrated. In the user's frame: "same pipeline" is true at two layers (HTTP
submission, shared providers via the registry) and false at the one that matters (the
staged workflow).

## 5. Connectedness verdict (per component, not a blanket yes/no)

- **Genuinely exists and is wired:** schedules, wrappers, `ScheduledTasksService`, stock +
  options engines, shard-chain staged execution for scheduled stock/options,
  `mas_async_jobs` + follow-up chains, CF Queue delivery for `screener.*` events,
  in-process bus delivery, provider platform, breaker + retry executors, canonical store +
  R2 blobs.
- **Exists but is unwired (or wired only narrowly):** `gather.ts` slice-8 module (zero
  production callers — confirmed by grep: only `src/trading/gather.ts` itself and
  `tests/gather_stage_1654s8.test.ts`); CF Queue `screener-events` (consumer wired
  since #2544, but with no production producer today — the consumer waits for work;
  see §6 gap 8); Cloudflare Workflow engine (wired for 3 manual routes, unwired for all
  scheduled and all goal runs); in-memory messaging/workflow adapters (deliberately
  test-only, correctly unwired); breaker state durability (in-memory by design,
  cross-isolate sync missing).
- **Does not exist at all as runnable code:** a single unified workflow that stock, goal,
  options, and strategy screens all run through; a staged goal-screen flow on either
  staged engine; a per-stage failure state for pipeline gather in the monolithic path; a
  DLQ for the delivery queue; a durable cross-isolate breaker store; trace propagation
  across queue/workflow boundaries.
- **Where the original lane report was wrong or overstated:** (1) any blanket "nothing is
  connected" — the scheduled stock/options path is connected end to end (schedule → guard
  → screen → store → serve → deliver, with queue + job tracking when `stageChain` is
  present); (2) any "no gather" without qualification — pipeline gather is wired, slice-8
  gather is not, and they are different modules; (3) any "staged workflow does not exist"
  — withdrawn by #1972 itself; (4) calling #1963's honesty patch done before it merged —
  it is now merged (`9b38d3b`) and #1963 closed, which is what makes it Phase 0 rather
  than a pending item; (5) treating #1904 as the decided vehicle for #1972 — the queue
  decision between them is explicitly still open.

### Lane reuse audit (from #1972 feedback — what slices must reuse, not rebuild)

| Lane | Must reuse (module + issue/PR) |
|---|---|
| COO | `buildSchedulePayload` + Orchestrator schedule store (C3 #1277/#1316); `stageChain` per-stage records/status/retry + goal deliver chaining (#1549); generate/store/serve split + canonical `mas_reports` (C4 #1329/#1359); feed seam `mas_feed_snapshots` + `feed.snapshot` job (#1691); `SubrequestBudget` (#1204/#1222); v2-only `strategyWeightsV2` + `championChallenger` (#1257/#1889 — v1 deleted); `FeatureFlagPort` + Flagship `FLAGS` rollout idiom; `screenerFollowups` + Q2 delivery chain. |
| CISO | PDP seam + obligation/advice channel (#1751, merged — **no live route calls it yet**; reuse-by-adoption, a CTO #945 wiring follow-up); revocation targets (#1750); legacy-session PDP bound (#1749); #1763 attribution audit (G-AUD-2/3); SEC-005 sanitizer; SessionStore + wired validation; `mas_events` audit sink — **not** the Analytics Engine. |
| CPO | GoalScreenPanel + honesty rendering + conditional structures column + backtest (#1963, #1201, #1912/#1981); apiFetch 202-job poll (10-min deadline → 408); AsyncJobsPanel + RunDetailView; ScreenersHub run views; goal report artifacts (#1335). |
| CAIO | Messaging (#1739); WorkflowPort + `ScreenerScreenWorkflow` (#1737); actor port (#1738); breakers (#1745, `breaker.state_changed` events); telemetry (#1742, thesis-realizations dataset); observability (#1743, one schema + traceparent); AI Gateway (#1741 — inert, owner activation not done); MCP permissions (#1744); parity harness (#1746); enrichment (#1888); D1 foundation (#1546 — halt seed + canonical seed **not run**, `agent_reports` starts empty); delivery (#1262). |
| CDO | Data-provider platform, epic #1116 (route table, contract + per-element provenance, immutable `mas_data_captures`, capture coverage incl. goal legs #1686, lifecycle, tiers `minTier`, health); enrichment compute `fetchPlatformTechnicalsBatch` (#1331); single `screenerPipeline` (#958); goal-leg attribution (#1571); canonical report writer (`reportDispatch.ts`). |
| CTO | `ScreenerScreenWorkflow` machinery + delegated screen (#1737); goal-screen engine + #1963 fix (PR #1974); #1972 program scope; #1904 target DAG. (CTO's workflow-questions answer, comment `6447040561`, is the corrected program statement: migration, not build.) |

**Record rule (CDO, decided): one record per concern, no second one invented.** Run/result
= `mas_reports`; data = `mas_data_captures`; artifacts = R2 blobs derived from the row.
`SqlFeedSnapshotStore` (feed input snapshots), D1 `AGENT_DB` (governance projection), and
`screener:last_runs` (delivery cache) are **not** records. A staged goal run writes its
result to `mas_reports` + its data to `mas_data_captures`, keyed by the same run id.

## 6. Gap list (what is genuinely missing)

1. A unified run-request path that goal submissions use (same submission endpoint,
   schedule or ad-hoc run request → workflow → queues → …).
2. A goal-screen flow on the existing workflow machinery (not a new workflow).
3. Thesis gates evaluating on enriched data (technicals gather) for the goal stock leg —
   i.e. real thesis selection, not just surfacing the refusal (§3.2).
4. ~~A decision on slice-8 `gather.ts`~~ — **DECIDED (CDO, v2): leave it unwired
   deliberately, and do NOT reuse its schema** for staged-run persistence (a third format
   violates the record rule, §5). Carry its *idea* instead: per-symbol provenance
   labeling (bar provider + fetch time + completeness label `iex-partial`/`complete`/
   `unknown`) into staged-run provenance.
5. A DLQ for the delivery queue (today: drop after 3 retries). Design + binding choice
   (queue + `dead_letter_queue` + replay procedure + depth alert) still open.
6. A durable cross-isolate breaker store (today: per-isolate, fail-open on cold start) —
   or explicit owner acceptance of fail-open, plus a trip subscriber + trip alerting.
7. Trace propagation across queue/workflow boundaries — **reworded (CAIO, v2): mechanism
   designed, production proof + surfacing missing** (see §2.5). Dashboard UI + SQL
   aggregation are open #1743 follow-ups.
8. A consumer for `screener-events` (Q1) — or a deliberate decision to remove the
   producer-only queue. **RESOLVED (Phase 5 slice 8, #2000): KEEP.** The consumer exists since #2544 (Worker `queue()` `screener-events` branch, `server.ts:4834` → `createScreenerEventsWorkHandler`; config pinned vs `wrangler.jsonc:56`; DLQ wired; terminal drops persisted + operator-replayable since slice 1). The goal-flow constraint is discharged, not lifted by code: `publish` (broadcast) never routes to Q1 — `screener.*` events fan out to subscriber queues (Q2 delivery) — and the goal flow sends no work items to Q1 (it rides the Workflow + Q4 job rows + Q2). Putting goal work ON Q1 would need new work-item semantics + dispatch + producer — a follow-up build slice, not a flag flip; until such a slice lands, goal work stays off Q1. Revisit condition: if Q1 is still producer-less when the goal-work question is next reviewed, re-raise removal (unbind + deprecate consumer + retire pins) rather than carrying it indefinitely.
9. Serve-stage retry — **narrowed (COO, v2): chained runs already retry per stage via
   `retryAsyncJob`; the gap is monolithic serve only** — plus a first-class failure
   state for pipeline gather in the monolithic path.
10. A usable audit read path (#1968, open) — captures must be retrievable with their
    code, message, and structured payload fields, or the stage contracts in §7 cannot be
    verified from the record alone. **CISO: #1968 is a precondition for Phase 4 —
    sequence before or with it.**
11. **Owner binding for scheduled jobs (#1344) — a requirement, not current state
    (CISO, v2):** `ScheduledGoal` has no owner/login field today, and the executor
    falls back to `default_trader` + the static pair for E*TRADE paths. Until owner
    binding lands, a staged goal run touching E*TRADE must **fail closed**, not run on
    the shared identity. This may reorder phases (see §7 gate).
12. **Callback identity (CISO, v2):** Workflow steps and queue consumers have no user
    session — how a step carries the run's user login must be named at slice design.
    If it cannot, the step must fail loudly. Admin-triggered runs still execute as the
    owning user or fail, never as admin; admin run-management (cancel/retry) needs
    audit-before-allow, and no obligation kind covers it yet.
13. **Revocation mid-run (#1750) + attribution (G-AUD-2/3, #1763):** targets exist, but
    no run-path consumer cancels/fails a run whose authorizing grant/session is revoked
    mid-run; stage records inherit the agent-turn/system-login attribution gaps unless
    closed or explicitly accepted.
14. **Q7 (CISO+CDO, blocking #945 Slice 5):** which consequential actions are blocked
    when durable audit cannot be recorded, the retention period, and the tamper
    mechanism — `iaaaAudit.ts` proposes a tamper-evident hash chain but states it is a
    proposal, not settled policy, and makes no retention claim. Correct claims:
    "tamper-evident hash chain (proposed)" + "retention undecided" — never
    "tamper-proof" or settled retention.
15. **Stuck-job handling (COO, v2): decided (Phase 5 slice 6,
    #2000)** — the #2567 machinery exists: stuck-`running` alert
    (30-minute default threshold + guarded claim-once +
    `async_job.stuck_detected` audit + Slack delivery) + read-path
    reap (2-hour backstop, guarded `failed` transition, never a
    delete) + runbook procedure
    (`docs/operations/runbook/stuck-runs.md`). The remaining
    question — a background sweeper — is DECIDED: no sweeper; the
    read-path alert + reap stand (see
    `docs/operations/runbook/stuck-sweeper-decision.md` for the
    evidence, the gaps left open, and what would reopen the
    decision). No sweeper, reaper-gap, or heartbeat-gap remains.
16. **Poll-202 design is a rows-read decision under the #1819 lens (COO, v2), not just
    UX** — interval × isolate churn × per-request auth reads. D1 reads are a separate
    meter from DO rows.
17. **#1942 is OPEN, not completed work (CDO, v2):** staged-run provenance must NOT be
    claimed via the XLSX Formulas & Methodology tab until #1942 is fixed; XLSX
    provenance is downstream of capture-layer provenance.

## 7. Transformation to the target state

**Sequencing rule:** each phase lands as its own slice with its own verification; lane
feedback on this document is now in (v2). #1963's fix is the dependency everything else
inherits (its PARTIAL contract). **Ship gate (CISO, CONDITIONAL):** slices may build the
run path, but **no staged goal run ships as audited** until four things close: #1968,
Q7 (gap 14), attribution G-AUD-2/3 (gap 13), and fail-visible swallowed failures (§2.4).
Separately, **gap 11 (#1344 owner binding) gates any E*TRADE-touching staged run** — it
must fail closed until binding lands, and that fact may reorder phases (an owner-binding
slice or a fail-closed design for E*TRADE legs may need to precede E*TRADE-leg
shipments, even if the non-E*TRADE staged path proceeds).

### Phase 0 — Make the direct path honest (DONE)

#1963: legs fail loudly (PARTIAL/FAILED per the #462 contract), refused filters surface
with the feed's reason, structures column hidden when no structures exist. Merged
`9b38d3b`; #1963 closed. This phase changes no engine and wires no gather — it only stops
the direct path from discarding signals. Every later phase inherits its PARTIAL contract:
a leg failure must surface at its stage, never as a false `Complete`.

### Phase 1 — Decide the vehicle (DECISION, before any build)

The "Venus queue decision" from #1972: **standalone #1972 program, or a #1904 P1 slice**
(the IROS program owns the target DAG; this migration may ride it). #1904's own framing
ruling applies: it is an enhancement program, not a greenfield build — most capabilities
it describes are already built; P1/P3 are consolidation/formalization, and its first job
is re-verifying the target doc's gap claims against current main before slicing. Whichever
vehicle is chosen, the slices below scope to verified gaps, not assumed ones. **Still open
at v2:** CTO/owner decision; COO and CISO explicitly defer it. The CISO gates (run
identity #1344, stage-contract audit, revocation #1750, no `default_trader` fallback) are
vehicle-independent and must not be absorbed into a later phase without a named owner.

### Phase 2 — Goal submission through the unified run-request path

The UX submits a goal run request through the same submission endpoint as other
screeners; the flow is triggered by creating a schedule (or an ad-hoc run request) →
workflow → queues → feed → gather → store → serve → deliver. The UI reads the stored
result instead of awaiting a synchronous screen (the 202-job poll the UX already uses is
the natural shape for this — the submission layer already exists; only the handler's
engine changes). No new workflow is built: the goal-screen flow rides the existing
`ScreenerScreenWorkflow` machinery (parent fan-out + shard children + store/deliver steps
+ stage honesty), extended with a goal-plan step, not a parallel implementation.
**Rollout (COO):** behind a Flagship/config flag, default OFF, goal flow only; rollback =
revert PR; the direct path stays until its retirement slice merges. **Failure rule
(COO):** if the staged path fails, it **fails loudly at the stage** (coded failure +
persisted record + PARTIAL per #462/#1963) — **never a silent fallback to the direct
engine mid-run** (that recreates the bypass). Flag-OFF is the rollout control, not a
per-run fallback. **UX rules (CPO):** sync-looking is acceptable and already the panel's
shape, but not opaque — live stage progress (AsyncJobsPanel/RunDetailView), previous
result kept visible until the new one lands, a way back on 408, backtest kept working
against stored runs (§3.6). **Deployment (COO):** no `deploy.yml` change, no new
workflow or queue binding for the goal flow (reuses Q2 + job rows), **zero new cron
triggers** (rides ticks + the existing 3 triggers; the 5-trigger ceiling is not
engaged), no owner web-UI steps for code/binding changes. **Sequencing (CAIO):** goal
slices touching ScreenerAgent sequence around the PortThink migration (fleet slice
#1955) — no-shared-file-races.

**Phase 2 implementation shape (#1997, rebased onto #1996):** #1996 shipped the goal flow itself — a goal run is
one "goal" shard on the existing parent machinery (parent poll + collate + project unchanged), executed by the
child's `runGoalScreen` and stored/delivered through the goal doors (`goalScreenDispatch.ts`), with the run
request carried as `command.goalScreen`. Phase 2 does NOT add a second flow: it adds the rollout control and
the read-back #1996 deferred. Flag: `goal_workflow`, default-OPEN since #2051 (opt-out; #1997's strictly-closed default is superseded). Flag OFF → manual and scheduled goal runs go direct, exactly as before #1996's opt-in (explicit opt-out only since #2051; the default is workflow-first, reversible by disabling the flag). Flag ON → the workflow is REQUIRED on both entries: a start failure answers a
coded 500 on the route (`goal_workflow_start_failed` + stable code + reason naming the missing dependency) and throws on the scheduled tick (failure result +
`run_failed` audit carrying the code) — a flagged run fails loudly at its stage, never by silent fallback to direct. Since #2065 the start attempt is wrapped in the `withObservability` aspect (one sink event per attempt, code + binding facts, never the raw message), and long job ids derive a bounded hash-form instance id instead of refusing (short ids keep their readable form; this complements the adapter-level fallback-id retry that landed first on the same issue, which cannot preserve duplicate-start adoption for long ids). Chain-mode
scheduled runs stay direct (they need the completed result for the chain bridge, as #1996 established), and
Yahoo-fallback scheduled runs ride the workflow with their provider markers when the flag is ON (the default since #2051; the #1996
command carries provider/providerFallback through). Report-id surfacing: the goal door returns the canonical
report id (throwing when the store returns null, making #1996's "store failure throws" docstring true), the
flow surfaces it on the shard row result, and the panel fetches the stored run by that id. Panel: the UX rules
above hold, but the progress source is the job-history route (`/api/jobs/history?chainId=`), polled directly
with a small stage list — AsyncJobsPanel reads `mas_async_jobs` and RunDetailView renders reports, neither
reads D1 stage rows, so reuse there would have been the wrong source. Since #2129 the panel persists its tracking handle in sessionStorage and resumes it on mount with the original submit deadline, and with no handle it loads the newest stored goal run as the previous result — a reload never shows a bare form for a run that already exists; a projection that lands nowhere now warns with chain, stage, and cause instead of silently no-op'ing. Leg visibility in Phase 2 is the stored
result's PARTIAL rendering (failed classes + reasons, per #1963), read from the fetched report body — per-leg
D1 stage rows are deferred to a follow-up, not dropped: the shard row carries one whole-run outcome, and
splitting it into leg rows needs a projection step the market flow does not have. Per-leg EXECUTION
(timeouts/isolation) is likewise deferred: per-leg agent calls would mint stray artifacts (`runGoalScreen`
generates artifacts unconditionally per executed run), so leg execution needs artifact discipline first.

### Phase 3 — Thesis gates on enriched data (a PRODUCING phase)

The goal stock leg routes through the delegated screen's technicals gather
(`attachTechnicals` / `fetchPlatformTechnicalsBatch`) so momentum filters
(`bullish_breakout`, `bearish_pullback`, `high_relative_volume`) evaluate on RSI, 52-week
highs, and average volume instead of refusing. This is the actual thesis-selection
capability §3.2 says is missing. **Reframed (CAIO/CDO, v2): this phase PRODUCES the
persisted gather output and has goal gates read it — it does not read an existing
enriched dataset, because none exists.** There is no standing enriched dataset today:
the delegated screen's technicals are computed per run in memory and persisted nowhere,
and enrichment stage records are feed-side input, not gather output. Stage-spec rule:
analysis only on post-gather data; each stage stores its own versioned results. Enrichment
is a compute path, not a store: the goal leg should call `fetchPlatformTechnicalsBatch`
(the function it currently never calls), over the run's captured bars — **not** wire
slice-8 as an enrichment store (gap 4: deliberately unwired, schema not reused).
**Provenance a staged goal run must carry (CDO):** run id → all `mas_data_captures` rows
(exact quotes/bars/chains, `provider_id` + gap-fill marks + fetch outcomes); route-table
version at run time; per-leg `providerId` + `providerFallback` (#1571, already carried —
keep it; the canonical row's `provider` field is a single run-level default, insufficient
for per-element audit, so make the run-id→capture link the audit path, not a second copy
of per-element data in the row); deterministic technicals chain (`technicals.ts` over
captured bars — same bars → same indicators, reproducible without storing them; the slice
must pin the recomputation with a test asserting indicators recompute from the run's
captured bars); slice-8 completeness labels on bar inputs. **Scope (CPO, v2): prove
selective screening on TWO theses first, not all nine** — (1) Income+Bullish (the #1963
RC4 refused-filter case; proof the gather fix works), (2) Directional+Bullish
(`bullish_breakout` on enriched data; cleanest selective case). Success from the user's
side: a selective count (neither 6594 nor 0), rows carrying actual candidate structures
(not `—` everywhere), backtest working on stock hits. Unknown stays as-is. The remaining
seven theses follow once the leg pattern is proven.

**Phase 3 implementation shape (#1998):** the goal leg does NOT reroute to
the delegated screen — `screeningRuntime.ts` binds the goal stock leg to the
live listing-feed engine deliberately (a discovery screen, not the DO
pipeline's per-run PDF/lock/record path), and rerouting would change
artifact semantics. Instead `screenLive` takes an OPTIONAL `enrichment`
hook on its seam (`NasdaqUniverseSeam.enrichment`, interface in
`screener.ts` so the trading layer never imports a service module).
The ScreenerAgent attaches it only when it resolves `goal_workflow` ON
from its own env (ON by default since #2051; direct + workflow-child goal runs alike; Yahoo-fallback
runs keep their Yahoo engine; flag OFF or any binding failure = no hook
= refusal exactly as before). #2056 dataset rule (refined): rows come from the live source
alone; Yahoo complements columns on those rows (live wins on shared
columns) and never adds or vetoes rows — gap-fill membership is
retired; a Yahoo-only symbol is never stored, and a live-only symbol
is stored with live columns and reported honestly, never zero-filled. The hook (`services/goalGather.ts`) runs
separate live and Yahoo quote fetches — rows come from the live side
alone, Yahoo complements columns where present (never adds rows,
never vetoes them) — plus `fetchPlatformTechnicalsBatch`
over the run's history deps for real RSI, persists one
`mas_data_captures` row per live symbol (capability
`"quotes"` — no vocabulary extension, no new store, no `gather.ts`
schema; `runId` = the caller run id per D2, the idempotency key), then
reads the rows BACK (digest-verified, latest-write dedup, a corrupt
latest row fails closed to missing) and returns those as the evaluation
input. Screen-side, a stored row lacking a field the filter needs is
excluded and ledger-rejected with the honest missing-data reason
(a missing 52-week high is not "not breaking out"); nothing evaluable
at all is a failed leg (the #1963 contract), never an empty success.
Per-field coverage is the honest shape: a stored row's columns are the
live ∪ Yahoo union, so a field either source carries is present. Provenance: the canonical report body
gains `idempotencyKey` on both paths (direct body; workflow envelope +
door body), so a staged run's record alone resolves to its captures;
the route "version" is the content hash of the quotes + historicalBars
route rows at run time (no version column exists); rows carry per-symbol
provider + gap-fill marks; the result carries a `gather` summary
(stored/missing/excluded/gapFilled/routeVersionHash); the #1743 sink
gets a `goal.gather.stored` event. Structures reading: the proof run's
OPTIONS rows carry structures; stock rows are selective names (no
stock-hit construction change, per the #1963 RC3 rule).

### Phase 4 — Stage contracts for legs

Every leg failure has a stage to fail in, with a coded stage failure, a persisted stage
record, and a retrievable audit event — the §2.4 table becomes the contract, not a
description. Shipped in #1999: gather gets a first-class failure state (`status:
"failed"` + error on `StockScreenGatherSummary`, surfaced through the partial
contract — not just missing fields); the chain-bridge submission (the monolithic
serve path) gets report-policy retry plus a `followup.schedule_failed` audit on final
failure; the goal-path audit insert warns instead of vanishing (stage 1); goal audit
rows carry `principalKind` (system on scheduled rows, session on route rows); and the
swallowed-failure inventory (§2.4) is dispositioned — 31 sites: 3 fixed in the slice,
1 tracked as follow-up #2165, the rest accepted with named reasons. The audit read
path (#1968) is fixed alongside this phase (own PR) so a future incident's record
answers "which code, what happened, for which login" from the record alone (the #1969
usable-captures principle). **Corrections to the pre-slice spec, recorded on #1999:**
the guard does NOT authorize through the PDP seam in this slice — the seam's own
header forbids route/job wiring before migration + provisioning (epic §8), and the
goal path carries logins while the PDP takes internal user ids, with no resolver on
this path; revocation mid-run is entry-gate only (route requests re-validate the
session; scheduled runs and workflow doors carry no session token to re-validate);
Q7 is proposed as a decision record for CISO+CDO sign-off, not decided by this lane.
**"As audited" status is withheld until #1968 merges and Q7 is signed off** — the
code ships, the gate does not claim otherwise. **Q7 implementation status
(program #2178, landed):** S1 put the SHA-256 hash chain on `mas_events`
(PR #2287); S2 enforces the blocking set per family — trade
execution/approval, delivery claims, report store, guard decisions, E*TRADE
token ops block when their own audit write fails (PR #2493). Retention, gap
14's third leg, is answered here as ratified policy: `mas_events` rows are
pruned after 365 days by the nightly retention pass
(`src/security/storageRetention.ts`, `MAS_EVENTS_RETENTION_DAYS`, #786) —
the implemented policy is adopted as the Q7 retention answer. What is NOT
claimed: CISO+CDO sign-off on #945 is still pending, so the ship gate above
still holds — no staged run ships as audited until that sign-off lands.
Stage audit records belong in
`mas_events`, **not** the #1743 Analytics Engine dataset (telemetry has no
retention/tamper contract; building stage audit there would create a second audit
system). Stage contracts use the #1743 stream only for operational visibility (new
`type` values, counts+ids — see Phase 5).

### Phase 5 — Harden the shared path

DLQ for the delivery queue (new queue + `dead_letter_queue` in `wrangler.jsonc` per ADR
0003 + replay procedure + DLQ-depth alert); durable cross-isolate breaker store (or
explicit owner acceptance of fail-open) + trip subscriber + trip alerting (alerting list:
DLQ depth, breaker trips, stuck rows, serve-stage failures, gather misses — a gather-miss
event must exist first); trace propagation across the Q2/Q4/Q7 boundaries (envelope
carries the traceparent through the Workflows runtime; production proof + dashboard/SQL
aggregation surfacing); a Q1 consumer — **RESOLVED (slice 8): KEEP** (consumer wired since #2544; goal-flow constraint discharged — see §6 gap 8; goal work onto Q1 is a follow-up build slice, not a flag flip); catalog-only rendering of per-channel texts (#1969 Phase 1) so the
guard's Slack alert and every other channel render from the catalog, not hand-written
variants. **Stage events (CAIO): YES — emit as event types in the #1743 schema** (one
envelope, `type` as blob dimension, tenant-as-index; a new stage event = a new `type`
value with counts+ids payload, NOT a schema change; whitelist + redaction already apply).
**#1819 resource events: CONFIRMED with conditions** (a #1743 `type` carrying count
fields fits; counts/aggregates only, no raw payloads/per-row data; cardinality guard +
aggregation treatment proven through the #1743 dashboard/SQL-aggregation follow-up;
per-row form rejected). **Stuck-job alert + runbook** (gap 15)
    and the sweeper decision — DECIDED (Phase 5 slice 6): no
    background sweeper; the read-path alert + reap stand.
These are shared-path improvements: they pay off for every family, not just goal.

### Non-goals (from #1972, carried forward)

PROD E*TRADE reconnect; options Yahoo fallback; #1904 P2 swarm negotiator and P4 closed
outcome→calibration loop; provider-contract changes. None of these ride this journey.
**Also non-goals (lane feedback, v2):** any metering/paywall change — goal screens carry
no payment gate (paid list = OPTIONS_SCREENER, MARKET_RESEARCH, STOCK_SIGNALS via
x402/USDC; no 402 handling on goal POST); if metering is ever added it must be per user
run-request (one staged run = one charge, never per stage/shard/leg), and that is a
product decision on its own issue, not a migration side effect. No new secrets for the
goal flow if reuse holds (existing SessionStore tokens, bindings, `mas_events` sink) —
exceptions confirmed at slice design: the callback-identity mechanism (if it needs a new
scoped platform identity) and any Phase 5 queue/workflow binding (a COO deployment
item). No gateway change: #1741 is inert in production (owner activation not done) and
the deterministic screen path makes zero LLM calls, so the journey needs nothing from
it. No reliance on the #1740 market graph (unpopulated in production) or on #1546
seeds that have not run (`agent_reports` starts empty).

### Exit criteria (the journey is done when all hold)

1. Stock, goal, options, and strategy screens all run the same staged pipeline
   (schedule → queues → feed → gather → store → serve → deliver).
2. A leg failure surfaces at its stage with a coded failure and a persisted record —
   never as a false `Complete`, never silently discarded.
3. Thesis selection works on enriched data: a thesis produces a selective screen, not
   everything-or-nothing — proven on Income+Bullish and Directional+Bullish first
   (selective count, rows with real structures, backtest working).
4. The swallowed-failure inventory is empty or explicitly owner-accepted, with the
   goal path's stage-1 and stage-6 items fail-visible.
5. Delivery is durable or its loss modes are explicit (DLQ wired, Q1 resolved, bus no
   longer the sole path anywhere).
6. Lane feedback on this document is incorporated and the slices were scoped to verified
   gaps.
7. **Audited-ship gate (CISO):** a staged goal run is claimed as audited only once
   #1968, Q7, attribution G-AUD-2/3, and fail-visible swallowed failures have closed.
8. **Record rule:** every staged run's result is in `mas_reports` and its data in
   `mas_data_captures`, keyed by the same run id — no second record invented.
9. **E*TRADE gate:** no staged goal run touching E*TRADE runs on the shared
   `default_trader` identity — owner binding (#1344) has landed, or the leg fails
   closed.

## 8. Open questions (v2 — decided items recorded, remaining items for slice design)

**Decided by lane feedback (v2):** record rule (§5); slice-8 deliberately unwired,
schema not reused (gap 4); flag rollout default-OFF + revert-PR rollback + fail-loud
(Phase 2 — default superseded by #2051: default-ON, opt-out; fail-loud + revert-PR rollback unchanged); two-thesis proof scope (Phase 3); sync-looking UX with live stage progress,
kept previous result, way back on 408 (Phase 2); no metering/paywall change
(non-goals); stage events into #1743 as new `type` values (Phase 5); #1819 resource
type confirmed with conditions (Phase 5); Q1 deferred to Phase 5; serve-retry gap
narrowed to monolithic serve; trace mechanism-designed / proof-missing (§2.5); #1743
stream as designed surface; #1942 open (gap 17); no gateway change; deployment surface
(Phase 2).

**Still open (answer at slice design or by owner decision):**

1. **Vehicle:** #1972 standalone program, or #1904 P1 slice? (CTO/owner; COO and CISO
   defer.)
2. **Q7:** consequential-action blocking set, retention, tamper mechanism (CISO+CDO,
   blocking #945 Slice 5).
3. **Callback identity:** how do Workflow steps / queue consumers carry the run's user
   login with no session? (Must be named at slice design, CISO.)
4. **#1344 owner binding:** design + sequencing — does an owner-binding slice precede
   E*TRADE-leg shipments, or does a fail-closed design for E*TRADE legs ship first?
5. **DLQ + breaker-store binding choices:** DLQ queue + replay procedure; durable
   breaker store binding (D1/KV/DO) or explicit owner acceptance of fail-open.
6. **Q1:** consumer vs remove (Phase 5).
7. **Sweeper:** DECIDED (Phase 5 slice 6, #2000) — no background
   sweeper; the read-path alert + reap stand (see
   `docs/operations/runbook/stuck-sweeper-decision.md`).
8. **#1968 sequencing:** before or with Phase 4 (CISO: precondition).
9. **#1942 fix:** before any XLSX-provenance claim on staged runs.
10. **#1743 follow-ups:** dashboard/aggregation + production stream confirmation on a
    real staged run.
11. **#1955 sequencing detail:** which goal slices touch ScreenerAgent and in what order
    relative to PortThink.
12. **Poll-202 rows-read design:** interval × isolate churn × per-request auth reads
    under the #1819 lens.

## 9. Sources

- Code: `src/agents/orchestrator/scheduledCallbacks.ts`, `src/agents/orchestrator.ts`,
  `src/services/scheduledTasks.ts`, `src/services/shardJobs.ts`,
  `src/services/shardExecutors.ts`, `src/agents/screener-agent.ts`,
  `src/trading/screenerPipeline.ts`, `src/trading/gather.ts`,
  `src/workflows/screenerWorkflow.ts`, `src/workflows/screenerWorkflowFlow.ts`,
  `src/agents/orchestrator/asyncJobs.ts`, `src/services/screenerFollowups.ts`,
  `src/services/resilience.ts`, `src/services/pipelinePolicy.ts`,
  `src/breakers/breakerPorts.ts`, `src/breakers/inMemoryBreakerAdapter.ts`,
  `src/messaging/screenerQueueConsumer.ts`, `src/services/goalDrivenScreen.ts`,
  `src/services/screeningRuntime.ts`, `wrangler.jsonc` (queues, workflows, crons,
  bindings) — all on `origin/main` at the evidence base above.
- Issues: #1963 (closed, fix `9b38d3b`, PR #1974), #1972 (open, incl. correction comment
  `6445967705`), #1963 claim-withdrawal comment `6445968907`, #1904 (open), #1965
  (fix merged `c2f7c86`), #1967, #1968, #1969, #1718, #1785, #462 (partial contract),
  #1344 (open, gating), #1955 (PortThink sequencing), #1743 (observability), #1742
  (telemetry), #1741 (AI Gateway, inert), #1740 (retrieval graph, unpopulated), #1546
  (D1 foundation, seeds not run), #1942 (open, XLSX provenance).
- Lane feedback on #1972 (2026-10-27, all within ~12 min of the questions, comment
  `6446863373`): CTO `6447040561`, COO `6447045836`, CISO `6447078725`, CPO
  `6447089438`, CAIO `6447094527`, CDO `6447165544`. v2 corrections and decisions are
  attributed to the lane that stated them.
- Docs: `docs/architecture/code/aop-fit-gap-analysis.md` (incl. 2026-10-27 addendum),
  `docs/architecture/enterprise/iros-system-analysis.md` (IROS target DAG).
