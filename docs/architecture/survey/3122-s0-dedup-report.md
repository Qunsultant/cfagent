# #3122 S0 Inventory + #3755 Dedup Report

**Dispatch:** Phase 3 groundwork for #3121 #3122 — survey only, no build.
**Date:** 2026-11-11. **Verified against:** current main `20d26df2` (gitops.md blob `f0564b29`, 1921 lines — read first, per task).
**Verdict up front:** S0 is complete. #3755 is **DISTINCT** from #3122, not a duplicate and not overlapping in any way that requires a change. The proposed boundary list is in §8. Three findings change what the build must do: (F1) the NLQ schedule path has **no callback allow-list** — an LLM plan can arm any host method name, including token renewal; (F2) most goal operations **do not execute at firing** — the tick mints a non-persisted pending descriptor and records success; (F3) **no PDP call exists on any schedule route** — PDP enforcement is new wiring, not reuse. Build preconditions: owner boundary confirmation + #3123's unified store landing.

---

## 1. What can schedule today — the four systems (S0 doc §1.1, verified)

| System | Store / arming | Who can create | Authorization today |
|---|---|---|---|
| **T2 — SDK alarm schedules** (`POST /api/schedules/create`) | OrchestratorAgent DO, `ctx.schedule` / `scheduleEvery` | Signed-in user (REST); NLQ (chat); code (internal) | Callback allow-list (4); trusted-identity stamp; broker-credential preflight; monetization guard; audit `schedule.created` |
| **T3 — Tick-polled goal schedules** (`POST /api/schedule/goals`) | ScheduledAgent DO SQL, key `goals`, `*/30` tick-evaluated | Signed-in user (REST); A2A edge-authenticated caller | `addGoal` validation (cron, catalog, budget, unique id); budget gate per firing; DO-side lifecycle audit |
| **T1 — Worker cron duties** (`wrangler.jsonc`) | Deployment config, not user schedules | Nobody at runtime (deployment only) | Background-attribution gate; skip-when-unprovisioned; dispatch ledger row |
| **T4 — Async-job follow-up chains** | `mas_async_jobs` (parent/chain/stage) | Nobody directly — minted by run outcomes inside the orchestrator | Chain rules (retry-once, recovery bounds, stuck detection) |

S0 doc: `docs/architecture/scheduling/3121-s0-inventory.md` (1126 lines; §1.4 behavior inventory B-T2/B-T3/B-T1/B-T4, §7 open items, §9.7 S6 trace closure — U-10 Chat Scheduler sub-view → #3122, B-T3-07 goal store → #3123).

---

## 2. T2 — SDK alarm schedules: the allow-listed path

**Creatable callbacks — exactly 4** (`src/agents/orchestrator/scheduleCallbacks.ts:22-29`, `CREATABLE_SCHEDULE_CALLBACKS`): `autonomousOptionsAnalysis`, `autonomousMarketScreen`, `autonomousStrategyDiscovery`, `autonomousGoalScreen`. All 4 are in `ACCOUNT_SCOPED_SCHEDULE_CALLBACKS` (require an authenticated broker account).

**Internal-only, NOT creatable** (`INTERNAL_RECORDED_SCHEDULE_CALLBACKS`, #3788): `executeAsyncJob`, `expireStaleOrderDraft`, `collectIvHistory`, `autoRenewETradeTokens`. `RECORDED_SCHEDULE_CALLBACKS` = 4 creatable + 4 internal.

**Create route** (`src/agents/routes/schedules.ts:649+`, invoked from `routeRequest.ts:880`):
1. Allow-list check FIRST — anything else is 400, no schedule created (schedules.ts:653-664, comment cites #111).
2. Trusted identity via `resolveTrustedScheduleIdentity` (schedules.ts:227-244): `x-user-login` / `x-environment` headers set by the authenticated Worker forwarder win; caller payload `userLogin`/`environment` is never trusted (comment: "Never trust a caller-supplied payload.userLogin to select another account's E*TRADE credentials").
3. Account-scoped callback + no login → 401 (schedules.ts:689).
4. Broker credential check (#3655): follows the tenant broker, not E*TRADE unconditionally; missing credential is a 409 **naming the broker**. Broker + data provider + mode are resolved server-side and stamped onto the payload at build time (identity, never a form value).
5. Monetization guard for stock `one_off` (#2373 slice C; one-off stock schedules can never checkout).
6. `buildSchedulePayload` → idempotency dedup (#2071, `schedule.duplicate_suppressed`) → provenance stamp (`origin: "user"`, `createdBy` trusted login, #3121 S1) → arm via `ctx.schedule`/`scheduleEvery` → audit `schedule.created`.

**Timing forms** (S0 B-T2-01): cron → `ctx.schedule(cron, …, { idempotent: true })`; interval → `scheduleEvery`; one-shot date; delay. List filters `?type=cron|interval|delayed|scheduled`.

**Management** (S0 B-T2-04): pause cancels the SDK schedule and stores a paused record (`src/services/scheduleManagement.ts`, `SqlPausedScheduleStore`); resume re-creates (new schedule id); trigger manually dispatches the schedule's own callback; delete removes a paused record too; update = cancel+recreate (screening payloads re-validated via `buildSchedulePayload`). List merges paused items back, flagged `paused`.

**System-job trigger routes** (S0 B-T2-05, no schedule row needed): `trigger-screen`, `trigger-renew` (401 if no login), `trigger-options-analysis`, `trigger-retention`, `trigger-iv-collection`, `trigger-discovery`, `record-cron-dispatch` (S5). Cancel-all: POST, `confirm:true`, audited (`schedules.cancelled.all`, #2280/#2457).

**Per-schedule audit events** (S0 B-T2-06, via `ctx.audit`): `schedule.created`, `schedule.cancelled`, `schedules.cancelled.all`, `schedule.paused`, `schedule.resumed`, `schedule.triggered`, `schedule.updated`, `schedule.duplicate_suppressed`.

**Named gap carried in S0** (B-T2-07): SDK firings of internal-only callbacks leave no per-run record. Per-run records exist only for the four creatable callbacks (`scheduleCallbackRunRecords.ts` → `job_run_records`).

**Baseline reconciliation** (B-T2-08): `removeUnownedBaselineSchedules` removes baselines not owned by the instance on agent start.

---

## 3. T3 — Goal schedules: the governed path, with a sharp limit

**Goal API** (`src/server/routes/trading.ts:73-180`): `GET/POST /api/schedule/goals`, `GET /api/schedule/operations` (derived from `OPERATION_CATALOG` at request time), `GET /api/schedule/builtin-goals` (from `DEFAULT_SCHEDULES`), `GET /api/schedule/ticks`, `GET /api/schedule/runs`, `GET /api/schedule/systems`, `POST /api/schedule/goals/:id/(enabled|trigger)`, `DELETE /api/schedule/goals/:id`. All session-gated (unauthenticated → 401; pinned by `meshGoldenTasks.ts:332`).

**`addGoal` validation** (`src/agents/scheduled-agent.ts:2073-2160`): id normalized + required; name required; cron must look like `minute hour * * *`; timeZone must be a valid IANA zone; `budgetCents` must be a positive number; id must be unique; **operation must be in `OPERATION_CATALOG`** ("Unknown operation" otherwise). Server stamps provenance (`origin: "user"`, `createdBy: session.githubLogin` — server wins over caller-supplied) and threads the session login as the lifecycle-audit actor.

**Lifecycle audit — DO-side sink** (S0 §7 O2, resolved in S3, #3312 fixed): `schedule.goal.added / .enabled / .triggered / .removed` are emitted by the `ScheduledAgent` mutation methods themselves (`addGoal`/`removeGoal`/`setGoalEnabled`/`triggerGoal`) — the one funnel every entry path flows through, best-effort (audit failure never fails the mutation). #3312 stays open until live proof of an A2A-path event.

**`OPERATION_CATALOG`** (`src/orchestrate.ts:30-148`) — 12 agents, 19 operations: search `search.query`; payments `payments.draft`; tasks `tasks.create`; memory `memory.remember`; nlq `nlq.execute`; qa `qa.supervised_fix`, `qa.run_sweep`; trading `trading.screen_stocks`, `trading.screen_options`, `trading.trade_stock`, `trading.trade_options`; scheduled `chain.execute`; social `social.publish`, `pipeline:social-daily`; resource `resource.rollup_daily`, `resource.cap_alert`, `resource.dashboard_comparison`; index `index.refresh_wikipedia`, `index.refresh_holdings`; feed `feed.refresh_all`.

**Shipped goals** (`src/schedule.ts:83+`, `DEFAULT_SCHEDULES`, 9 ids, seeded only when storage is empty): `daily-qa-sweep` (`qa.run_sweep`), `opportunity-hunt` (`search.opportunity_hunt`), `daily-social-post` (DISABLED, `social.publish`), `resource-daily-rollup`, `resource-cap-alert`, `resource-dashboard-comparison`, `index-refresh-wikipedia`, `index-refresh-holdings`, `feed-refresh` (`feed.refresh_all`, #3787).

**Tick semantics** (S0 B-T3-01..06): each `*/30` tick iterates every stored goal; disabled or not-due goals are skipped (no per-run record). `isDue` (UTC mode: minimal `minute hour * * *` parser with a 23-hour anti-double-fire guard; timezone mode matches wall-clock parts; never throws). Budget gate: every due goal passes a PaymentsAgent budget check (`budgetCents`, bucket `AGENTIC_SPEND_AGENT_ID`, #2327) exactly once per firing; rejection records a `skipped` run and creates no job. In-flight guard (#2840): a second submission while a firing runs is answered "already in flight" (claim stale after 30 min, `goalFiringClaims.ts`). Pipeline goals run ordered stages back-to-back in ONE firing under the single budget check; unknown pipeline ids fail closed. Synthesized schedules must materialize first and fire via `onCron`; direct firing is refused.

### FINDING F2 — most goal operations do not execute at firing

`createJob` (`src/orchestrate.ts:641-668`) is **descriptor-only**: it validates the operation is in the catalog and returns a pending descriptor (`job_<ts>_<rand>`, status `"pending"`). It persists nothing and executes nothing. **No consumer of the `OrchestratorJob` type exists anywhere in `src/` outside `orchestrate.ts`, and no pending-job runner was found.** The descriptor id is recorded as `asyncJobId` in the goal's `job_run_records` row (`recordGoalRun`, `scheduled-agent.ts:1233-1290`, linkage via S1 `buildLedgerLinkage`: scheduleId = goal id, workflowId = null) — the row records "success" at mint time.

The operations that **do** execute at firing are exactly the direct-handler families in `onCron` (`scheduled-agent.ts:1400-1960`):
- `social.publish` → social goal executor (direct, not `createJob`)
- `resource.*` → resource goal handlers (direct; comment: "createJob mints a pending descriptor and executes nothing")
- `index.refresh_*` → direct (AGENT_DB binding read)
- `feed.refresh_all` → `dispatchScheduledPipelineJob` (pipeline control plane's scheduled-firing seam)
- `chain.execute` → chain legs run for real BEFORE any descriptor is minted (#1517/#1523); refuses to fire with no synthesized record
- `pipeline:*` goals → stages back-to-back in one firing

A grep for `run_sweep|search.query|screen_stocks|trade_stock|supervised_fix|nlq.execute|tasks.create|memory.remember|payments.draft` in `scheduled-agent.ts` returns **zero hits** — there is no direct-execution branch for search, payments, tasks, memory, nlq, qa, or trading operations. A `trading.screen_stocks` or `qa.run_sweep` goal firing mints a descriptor and records success; the work does not run from the tick. (`qa.run_sweep` appears in `src/` only in the catalog, the seed list, and `payments-agent.ts:56` — a budget reference, not an execution site.)

**Consequence for #3122:** the task registry must distinguish "schedulable and executes" from "schedulable and mints a descriptor." An agent scheduling a `trading.*` or `search.query` goal today would get a success row and no work. The build must either wire execution for the operations it offers, or exclude them from the agent-schedulable set until their execution path exists. This is a design decision for the owner, not a bug to fix silently inside #3122 (scope discipline: the execution wiring is its own capability).

**Two pre-existing dead goals (do not conflate with F2):** `opportunity-hunt` — operation `search.opportunity_hunt` is NOT in the catalog (filed as #3652, build not authorized), AND its cron `0 */6 * * *` maps the hour through `Number()` to `NaN` and is therefore NEVER due in UTC mode (S0 B-T3-02, preserved quirk, pinned — do not fix). `daily-social-post` ships DISABLED (#1077 Phase 5b).

---

## 4. The NLQ schedule path — FINDING F1 (no allow-list)

**Port** (`src/agents/nlq/types.ts:66-83`, `NLQSchedulingPort`): `schedule` / `scheduleEvery` / `cancelSchedule` / `listSchedules`, bound by `nlqSchedulingPort` (`src/agents/orchestrator/nlqPorts.ts:192-210`) straight to the host's typed SDK methods.

**Plan layer:** `scheduleData.callback` is `z.string().optional()` (`src/agents/nlq/schema.ts:117`) — a **free-form string, no enum, no allow-list**, at the plan layer or anywhere else in the NLQ path. The deterministic planner (`planning.ts`) only ever names `sendScheduledReminder` (reminders) and `autonomousMarketScreen` (screen intervals). The LLM planner (`llmPlanning.ts:112`) takes the callback as a free string in the prompt JSON — whatever the model returns passes zod validation.

**Executor** (`src/agents/nlq/execution.ts:1242-1430`): list (cap `plan.limit||25`), cancel (audited `schedule.cancelled`), create — screening callbacks via shared `buildSchedulePayload`; **anything else gets a generic `{ userLogin, description }` payload and is armed verbatim via the port**. No allow-list check, no PDP check anywhere in the executor (grep for `pdp|authorize|allowlist` in `execution.ts` returns only unrelated order-approval lines). The only backstops are the SDK throwing for an unknown method name, and the host's own methods.

**Audit:** the executor's local `audit` closure (`execution.ts:1259-1273`) writes `schedule.created` / `schedule.cancelled` to `orm.events` (`mas_events`, agent `"orchestrator"`, session id attached), best-effort ("the Scheduler itself is the source of truth"). A separate `auditNlqExecution` (`execution.ts:34`) writes `nlq.executed` / `nlq.error` for the query as a whole.

**F1 stated plainly:** through NLQ today, a user prompt (and therefore any agent driving NLQ) can arm **any method that exists on the OrchestratorAgent host by name** — including `autoRenewETradeTokens`, `executeAsyncJob`, `expireStaleOrderDraft`, and `collectIvHistory` — with an arbitrary payload. The REST create route's allow-list (#111) does not apply here. The build MUST close this: NLQ schedule creation must be allow-listed to the same `CREATABLE_SCHEDULE_CALLBACKS` (plus goal operations via the goal API), with anything else refused honestly. This is the single most consequential boundary item, because it is a live hole, not just a rule.

---

## 5. A2A entry path into scheduling

`src/agents/scheduledA2aDispatch.ts` (issue #2223) serves exactly 6 operations (pinned in `tests/a2a_remaining_handlers_p2223.test.ts`): `scheduled.list_goals`, `scheduled.tick_history`, `scheduled.add_goal`, `scheduled.remove_goal`, `scheduled.set_goal_enabled`, `scheduled.trigger_goal`. The body's `op` is mapped onto `addGoal`'s `operation` field; the method validates (cron shape, catalog membership, duplicate id). Actor on the A2A path is the edge-authenticated caller (`a2a-credential:<surface>`, S0 §7 O2).

Two hard rules in that file: **`onCron` — the governed firing path — is deliberately NOT an A2A operation**; and A2A resolution for `"scheduled"` lands on the live `"default"` instance (a virgin instance would seed `DEFAULT_SCHEDULES` and serve plausible-looking wrong state — the handler only ever runs on the resolved instance, and nothing here seeds, synthesizes, or fabricates schedule state).

So: **agents CAN already schedule goals today, via A2A** — edge-authenticated, catalog-validated, lifecycle-audited. What they cannot do is manage SDK alarm schedules (no A2A operation for them), touch Worker duties, or fire `onCron` remotely. #3122's job is to generalize and govern this existing seam (PDP + approval + unified store + UI parity), not to invent agent scheduling from nothing.

---

## 6. Worker crons, internal schedules, follow-up chains — system only

**Worker crons** (`wrangler.jsonc`, S5 named entry points in `src/services/consolidatedCronEntries.ts`; thin dispatch `scheduled()` in `src/server.ts:304`): `0 3 * * *` renewal (`renewTokens` — `renewAllStoredETradeTokens` enumerates every stored token, asserts no identity, runs either way, S0 B-T1-01); `*/30 * * * *` tick (`tick` — fans out to **seven** dispatches: `onCron` + six POSTs; S5 correction to the S0 doc, which said six); `0 4 * * *` retention (`retention` — dispatches `POST /api/schedules/trigger-retention` under the service identity; audit chain verified before any prune, failed verification skips the prune). Each dispatch writes a ledger row recording the DISPATCH, not downstream outcomes (`jobId` + `scheduleId` = the cron expression; `asyncJobId`/`workflowId` explicit nulls). **Hard ceiling:** the account is at the Workers Free ceiling of 5 triggers/account (error 10072) — a fifth cron fails the deploy (S0 B-T1-04). No new Worker cron can be added.

**`record-cron-dispatch`** (`src/agents/routes/cronDispatchRecord.ts`): background-attribution ONLY — caller must resolve to the background actor (login == configured service login), else 401; with no service login configured, nothing is background and the route refuses everyone (fail-closed). The Worker-side poster logs a 401 and swallows it (best-effort row).

**Internal schedules armed by code** (same ensure-pattern: list schedules, skip when present): `ensureStaleSweepSchedule` (#618 — `sweepStaleLedgerTasks`, per user); `ensureScheduleWatchdogSchedule` (#3788 — `watchdogMissedSchedules`, once per instance); `ensureStaleAsyncJobSweepSchedule` (#3784 — `sweepStaleAsyncJobs`, once per instance); `ensureStrategyScanSchedule` (#992, in `scheduleMaintenance.ts`); TickerAgent `ensureTickerPushArmed` (`scheduleEvery` → `pushTicks`, interval from `resolveTickerPushIntervalSeconds(env)`, `ticker-agent.ts:164`); Think `internal_reconcileScheduledTasks` (#3899 RC1 — SDK hook re-reconciling Think `getScheduledTasks()` declarations after app-owned data changes).

**Follow-up chains** (S0 B-T4-01..05): `scheduleScreenerFollowups` records the finished run as the main async job and bridges record + notify + report; chain graph via `parent_job_id`/`job_kind`/`channel`/`stage`/`chain_id`/`not_before`; deferred stages re-arm at remaining delay on recovery (`recoverQueuedAsyncJobs`, `LIMIT 100` per pass); retry (#1277 C3) resubmits a failed job from its recorded payload verbatim, once, audited as `async_job.retried`; recovery bounds (30-day stale cutoff, 2-hour stale-started threshold, stuck detection default 30 min). Minted by run outcomes inside the orchestrator — not by users or agents directly.

**ActorSchedulePort** (`src/actors/actorPorts.ts:233-250`): `schedule` / `scheduleEvery` / `listSchedules` / `cancelSchedule` (+ optional `getScheduleById`), schedule-by-method-name; adapters `cfAgentsAdapter.ts:67` (SDK) and `inMemoryActorAdapter.ts:58` (test double). `PortThink` overrides SDK `schedule`/`scheduleEvery` and refuses `capability_requires_state:scheduler` on fully ephemeral instances (#3923).

---

## 7. Authorization today — and FINDINGS F3, F4

### What exists
- Session gating (401 anonymous) on all `/api/schedule/*` and `/api/schedules/*` routes.
- Callback allow-list on the REST create route (F1's exception: NLQ has none).
- Trusted-identity stamping (Worker headers win; caller payload ignored).
- Broker-credential preflight (409 naming the broker, #3655).
- Monetization guard (stock `one_off` can never checkout, #2373 slice C).
- Goal budget gate per firing (PaymentsAgent, #2327).
- Audit on every path (T2 `schedule.*` events; T3 `schedule.goal.*` DO-side sink; NLQ `schedule.created/cancelled` to `mas_events`; T1 dispatch ledger rows).
- `ActorSchedulePort` method-name scheduling with the SDK as the enforcement floor (unknown method throws).

### FINDING F3 — no PDP call on any schedule route
`evaluateRoutePep` lives in `src/security/pepGateway.ts:71`. Its **four gateway sites are all in `src/server/routes/auth.ts`** (lines 179, 298, 387, 457) — auth routes only. A grep for `evaluateRoutePep|pdp.` across `routeRequest.ts` and `server.ts` returns nothing; no schedule route, goal route, NLQ executor, or A2A dispatch consults the PDP. (`src/security/session.ts:159` says the four sites are "in server.ts" — stale; the routes moved to `server/routes/auth.ts`, pinned by `tests/iaaa_legacy_pdp_bound_1749.test.ts` #1755.) **#3122's "every action PDP-enforced" is therefore new wiring to `evaluateRoutePep` (or the PDP port), not reuse of an existing check on this path.** The build must also decide the PDP's subject for agent actions (agent identity + principal's scope, per #2331 run-as) — the PDP has never yet evaluated an agent as a subject on this path.

### FINDING F4 — no tenant field on any schedule record
S0 §7 O3 (resolved in S3, stated plainly): **goals carry no tenant field and live in one DO instance's `goals` key**; a tick evaluates one instance's goals. Instances are per login; the tenant-to-login mapping is still undesigned (#2457, cross-tenant management). "The consolidated surface enforces the same gates #2457 sets, it does not invent a mapping." The same holds for SDK schedules (per-instance DO state). **#3122's "tenant-scoped" is therefore undefined until the owner rules:** either tenant = the per-login instance (the only scope that exists today), or the build waits on #2457's mapping. The build must NOT invent a tenant mapping. This is an owner decision, listed in §10.

---

## 8. Proposed boundary list (for owner confirmation)

### A. EXCLUDED from agent scheduling — system/privileged, never armable by an agent
1. **Worker cron duties** — renewal (`0 3`), tick (`*/30`), retention (`0 4`). Deployment config, not schedules; plus the 5-trigger Free ceiling means no new cron can be added at all.
2. **Internal-only callbacks** — `executeAsyncJob`, `expireStaleOrderDraft`, `collectIvHistory`, `autoRenewETradeTokens` (REST already refuses them with 400; NLQ must be closed to match — F1).
3. **Internal maintenance schedules armed by code** — `sweepStaleLedgerTasks`, `watchdogMissedSchedules`, `sweepStaleAsyncJobs`, strategy-scan ensure, TickerAgent `pushTicks`, Think scheduled-task reconciliation.
4. **Follow-up chain minting** (T4) — `scheduleScreenerFollowups`, `recoverQueuedAsyncJobs`, `retryAsyncJob`. Minted by run outcomes, not by agents; retry is a verbatim resubmission of a recorded payload.
5. **Platform duties** — kvWipe / data-lifecycle routes (clean state, platform/tenant bootstrap), retention prune (audit-chain verification gate), `record-cron-dispatch` (background-attribution only, fail-closed).
6. **`onCron` itself** — deliberately not an A2A operation; the governed firing path is not remotely invocable, by anyone.
7. **Timing policy (#2461)** — cron expressions, tick cadence, firing/dispatch mechanics, retention constants. No agent authority over timing policy; #2461 stays separate.
8. **Cross-tenant scheduling, tenant-isolation bypass, platform-admin minting through scheduling** — already #3122 non-goals; reaffirmed here as excluded, not merely deferred.

### B. APPROVAL-BOUND — an agent may propose, a human approves before arming
9. **External sends** — `social.publish`, notification/report delivery (any schedule whose firing sends outside the platform).
10. **Spend** — any goal/schedule carrying a budget above a threshold. **Threshold value is an owner decision** (not set here).
11. **High frequency** — intervals/crons below a floor. **Floor value is an owner decision** (not set here).
12. **Trading operations** — `trading.trade_stock` / `trading.trade_options` (in the catalog; the #1904 invariant — human approves before any trade execution — means a schedule arms at most a draft/preview, never a live order). Note F2: these operations have no direct execution path from a goal firing today, so approval-binding is necessary but not sufficient — execution wiring is a separate decision (§3, F2).

### C. AGENT-SCHEDULABLE (once the build lands, on #3123's store, PDP-enforced, audited)
13. The 4 creatable screen callbacks (`autonomousMarketScreen`, `autonomousOptionsAnalysis`, `autonomousStrategyDiscovery`, `autonomousGoalScreen`).
14. Goal operations that execute at firing: `social.publish` (approval-bound per B9), `resource.*`, `index.refresh_*`, `feed.refresh_all`, `chain.execute`, `pipeline:*`.
15. Whole-workflow scheduling (as today; per-stage scheduling is #3310, webhook minting is #3311 — both consumers of these rules, §9).
16. Goal operations in the descriptor-only set (`search.query`, `payments.draft`, `tasks.create`, `memory.remember`, `nlq.execute`, `qa.*`, `trading.*`) are **NOT schedulable by agents until their execution path is wired or the owner explicitly accepts descriptor-only scheduling** (F2 decision).

---

## 9. Dedup verdict: #3755 vs #3122 — DISTINCT

**#3122** (open, enhancement + `lane:ceo-aimp`, updated 2026-11-04; body 4543 chars): agent schedule management — create/update/pause/resume/trigger/delete/list — tenant-scoped, on the consolidated store, PDP-enforced, consequential schedules approval-bound, audited in the run ledger, UI parity. S0 first; task registry; non-goals: no tenant bypass, no cross-tenant, no platform-admin minting, no firing/timing/dispatch changes, no timing-policy authority.

**#3755** (open, agentic + architecture + `lane:ceo-aimp`, updated 2026-11-08; body 2492 chars): "Collaborative Mesh" — an **A2A Event Bus for copilots**: hedging coordination, yield harvesting, coordinated risk defense. Events: `EQUITY_POSITION_OPENED`, `ELEVATED_DRAWDOWN_ALERT`, `HEDGE_OPPORTUNITY_PROPOSED`, `MACRO_REGIME_SHIFT`. Human-in-the-loop via `StrategyCard`/`OrderTicket`; **no broker execution without confirmation**. The word "schedule" (and any timing, cadence, or scheduler concept) appears **nowhere** in #3755's body.

| Comparison point | #3122 | #3755 | Overlap? |
|---|---|---|---|
| Capability | Manage schedules (7 actions) | Fan events out between copilots; coordinate reactions | No — different verbs on different objects |
| Mechanism | Schedule-management capability on the consolidated store | A2A event bus + HITL cards | No — no shared code, store, or route |
| State | Schedule records + run ledger | Transient events + cards | No |
| Authorization model | PDP, tenant scope, approval-bound consequential schedules | HITL confirmation before broker execution | Same *principle* (human gate), different *mechanism* — not a duplication |
| Acceptance | Agent exercises 7 actions per task kind; denials audited; UI parity | Copilots coordinate on the four events; no execution without confirmation | No shared acceptance criterion |
| A2A use | A2A dispatch as one of two agent channels (with NLQ) | A2A as the event transport | Adjacent, not shared: `scheduledA2aDispatch.ts` serves goal CRUD; the mesh bus would carry copilot events. Different operations, different payloads |

**The apparent overlap** is vocabulary only: both are "agents/copilots coordinating." Coordination ≠ scheduling. #3755 coordinates copilots *reacting to events*; #3122 lets an agent *manage schedules*. The one genuine composition point: a #3755 event (e.g. `ELEVATED_DRAWDOWN_ALERT`) could in future be a *reason* for a #3122 schedule action (e.g. an agent pausing a screen schedule) — but the bus would carry the event and the schedule capability would perform the action, under #3122's PDP/approval/audit rules. That is composition across a seam, not duplication.

**What must change in either issue to remove the overlap: nothing mandatory.** No scope text, acceptance criterion, or implementation step in either issue duplicates the other. If the owner wants belt-and-braces, two optional one-line cross-references (not required, and NOT filed here): add to #3755's Scope — "event reactions that change schedules go through #3122's schedule-management capability, not through the bus"; add to #3122's non-goals — "does not add cross-copilot eventing — that is #3755." Neither line changes what either issue builds.

**Related, also distinct — consumers of #3122's rules, not duplicates:**
- **#3310** (open, Medium): per-stage workflow scheduling. Blocked by S1 + S2; stage registry is #1972's. Extends the *schedulable unit* to a workflow stage, under #3122's rules ("stage-schedules are schedulable by agents under the same rules"; its Agentic-design field cites #3122 for delegation/no-self-expansion). Distinct capability, depends on #3122 — not a duplicate.
- **#3311** (open, Medium): webhook-triggered scheduling — a workflow step calls an authenticated, PDP-authorized webhook; ScheduledAgent mints a follow-up on the async-job chain with correlation ID; both call and minted schedule audited; no self-re-arm without approval. Blocked by S1 + S4. A new *entry point* governed by #3122's rules — distinct, not a duplicate.

---

## 10. #3122 capability-model outline (task registry)

The registry as it stands today, and what #3122 adds. "Agent" below means an agent acting within its principal's scope (run-as, #2331); "User" means the signed-in session owner.

| Task kind | Schedulable today? | By whom, through what | Authorization today | #3122 adds |
|---|---|---|---|---|
| Stock screen (`autonomousMarketScreen`) | Yes | User via `POST /api/schedules/create`; NLQ (schedule family); agent via NLQ only | Allow-list; broker-credential preflight; monetization guard; audit | Agent-facing capability: PDP + approval (if consequential) + ledger audit with agent identity + UI parity, on #3123's store |
| Options analysis (`autonomousOptionsAnalysis`) | Yes | Same as above | Same | Same |
| Strategy discovery (`autonomousStrategyDiscovery`) | Yes | Same as above | Same | Same |
| Goal screen (`autonomousGoalScreen`) | Yes | Same as above | Same | Same |
| Reminders (`sendScheduledReminder`) | Yes | NLQ only (deterministic planner) | NLQ audit only; no allow-list (F1) | Bring under the allow-list; agent-schedulable on the same terms |
| Goals — executing families (`social.publish`, `resource.*`, `index.refresh_*`, `feed.refresh_all`, `chain.execute`, `pipeline:*`) | Yes | User via `POST /api/schedule/goals`; agent via A2A `scheduled.add_goal` | `addGoal` validation; budget gate; DO-side lifecycle audit | PDP + approval for consequential ones + unified store + UI parity |
| Goals — descriptor-only families (`search.query`, `payments.draft`, `tasks.create`, `memory.remember`, `nlq.execute`, `qa.*`, `trading.*`) | Yes (but see F2) | Same as above | Same as above | **Held** — not agent-schedulable until execution is wired or the owner accepts descriptor-only (F2 decision) |
| Whole-workflow schedules | Yes | Existing workflow scheduling | Existing guards | Agent management on the unified store |
| Per-stage workflow schedules | No | — (#3310, blocked S1+S2) | — | #3310 builds on #3122's rules |
| Webhook-minted follow-ups | No | — (#3311, blocked S1+S4) | — | #3311 builds on #3122's rules |
| Worker duties (renewal/tick/retention) | No (system only) | Deployment config | Background attribution; skip-when-unprovisioned | Nothing — excluded (§8A.1) |
| Internal callbacks + maintenance sweeps/watchdogs/`pushTicks` | No (system only) | Code-armed | SDK/instance discipline | Nothing — excluded (§8A.2–3) |
| Follow-up chains (T4) | No (system only) | Minted by run outcomes | Chain rules | Nothing — excluded (§8A.4) |
| `onCron` remote firing | No | — | Deliberately not an A2A operation | Nothing — excluded (§8A.6) |

**The seven agent actions** (per #3122): create, update, pause, resume, trigger, delete, list — each PDP-enforced (tenant scope + role), consequential ones approval-bound before arming, every action audited in the consolidated run ledger with agent identity / tenant / schedule. UI parity in the surface family (`?tab=schedules` home + sub-routes). Acceptance (for the build, per dispatch): in a test tenant, an agent exercises all seven actions per task kind (screen, goal, workflow, discovery); unauthorized attempts denied + audited; UI parity; agent- and user-created schedules fire identically with identical audit.

**Dependency — #3123** (open, enhancement + `lane:ceo-aimp`): "Reuse: unify schedule store, run ledger, and management code; retire duplicated per-kind paths." Post-parity only. One schedule store holding all kinds (screens, goals, followups, worker duties); one run ledger every kind writes and every surface reads; one pause/resume/trigger/delete/detail path shared by all surfaces; retired modules deprecated by rename only with a ledger entry; before/after counts published. Non-goals: no capability/timing/firing change, no new kinds, no deletion. Its Agentic-design field states the point explicitly: "The store, ledger, and management path are deterministic code. Agent judgment stays out of them; the sibling agentic-scheduling sub-issue builds the agent-facing layer on top of this unified store, it does not live inside it." **#3122's build cannot start until #3123 lands** — there is no unified store to operate on yet (per-kind stores: SDK schedules in the OrchestratorAgent DO, goals in the ScheduledAgent DO SQL `goals` key, follow-ups in `mas_async_jobs`).

---

## 11. Build preconditions + owner decisions owed

1. **Boundary confirmation** — §8 lists A (excluded), B (approval-bound), C (schedulable). Confirm as written, or amend.
2. **F1 fix scope** — NLQ allow-list closure is part of the #3122 build (it is the agent-scheduling path), or a separate fix first? Recommend: inside #3122, since NLQ is one of its two agent channels; but it is also a live hole on the user path, so the owner may want it fixed sooner.
3. **F2 decision** — descriptor-only goal operations: wire execution, or exclude from agent scheduling until a later slice? (Execution wiring is its own capability; do not fold it silently into #3122.)
4. **F4 decision** — what "tenant-scoped" means: per-login instance (the only scope that exists), or wait on #2457's tenant-to-login mapping? The build must not invent a mapping.
5. **Approval thresholds** — budget threshold (§8B.10) and frequency floor (§8B.11) values. Owner decisions, not defaults to invent.
6. **#3123 landing** — the unified store is the build's base; Phase 2 coordinator is building it in parallel with this survey.

## 12. Evidence index (every claim, file + line, main `20d26df2`)

- gitops.md (governs; read first): blob `f0564b29`, 1921 lines; delta vs morning = #4099 out-of-scope rule + gate check (k) only.
- `src/agents/orchestrator/scheduleCallbacks.ts:22-29` — 4 creatable + 4 internal callbacks.
- `src/agents/routes/schedules.ts:227-244` — `resolveTrustedScheduleIdentity`; `:649-720` — create route (allow-list 400, trusted identity, 401, #3655 broker 409); `:1009-1010` — `record-cron-dispatch` route.
- `src/agents/routes/cronDispatchRecord.ts` — background-attribution-only gate, fail-closed.
- `src/agents/orchestrator/routeRequest.ts:880` — `handleSchedulesRoutes` invocation; no PDP call in the file.
- `src/agents/nlq/types.ts:66-83` — `NLQSchedulingPort`; `src/agents/orchestrator/nlqPorts.ts:192-210` — port binding; `src/agents/nlq/schema.ts:117` — callback `z.string().optional()`; `src/agents/nlq/llmPlanning.ts:112` — free-string callback; `src/agents/nlq/execution.ts:1242-1430` — executor, `:1259-1273` audit closure, `:1329` cancel audit, `:1443` create audit.
- `src/agents/scheduled-agent.ts:1994` `listGoals`; `:2073-2160` `addGoal`; `:2149` `removeGoal`; `:2621` `triggerGoal`; `:1233-1290` `recordGoalRun`; `:1400-1960` `onCron` dispatch branches; `:1880-1960` `createJob` call sites.
- `src/server/routes/trading.ts:73-180` — goal routes (session-gated 401).
- `src/agents/scheduledA2aDispatch.ts` — 6 A2A operations; `onCron` deliberately not an operation.
- `src/orchestrate.ts:30-148` — `OPERATION_CATALOG` (12 agents, 19 ops); `:641-668` — `createJob` descriptor-only.
- `src/schedule.ts:83+` — `DEFAULT_SCHEDULES` (9 goals).
- `src/actors/actorPorts.ts:233-250` — `ActorSchedulePort`; `src/agents/orchestrator.ts:1300-1330,1770-1810` — internal ensure-schedules; `src/agents/ticker-agent.ts:164` — `pushTicks`.
- `src/security/pepGateway.ts:71` — `evaluateRoutePep`; `src/server/routes/auth.ts:179,298,387,457` — the only four gateway sites; `src/security/session.ts:159` — stale "server.ts" note.
- `src/server.ts:304` — `scheduled()` thin dispatch; `src/services/consolidatedCronEntries.ts` — tick/renewTokens/retention entry points.
- `docs/architecture/scheduling/3121-s0-inventory.md` — §1.4 (B-T2/B-T3/B-T1/B-T4/B-L), §7 O1–O4, §9.7 (U-10 → #3122, B-T3-07 → #3123).
- Issues (read via `issue_read`, method `get`): #3122, #3755, #3123, #3310, #3311 — all open, all `lane:ceo-aimp`.

## 13. Current-state verification (2026-11-25)

This addendum preserves the 2026-11-11 survey as a dated snapshot and records what has landed since it. Verified against the current #3122 issue, current checkout, and GitHub:

- The #3123 unified-store dependency landed in merged PR [#4191](https://github.com/Qunsultant/cfagent/pull/4191); #3123 itself remains open. The #3122 core capability landed in merged PR [#4197](https://github.com/Qunsultant/cfagent/pull/4197); #3122 itself remains open.
- Current schedule-management entry points are the signed-in schedule routes (`src/agents/routes/schedules.ts`), the NLQ schedule family (now routed through the shared capability and the F1 callback allow-list), and seven typed Orchestrator A2A operations (`schedule.create|list|update|pause|resume|trigger|delete`, `src/agents/orchestrator/a2aDispatch.ts`). These converge on `src/services/agentScheduleCapability.ts` and the unified store. The A2A operations are available on the Orchestrator card, but the chat-turn tool set is populated through MCP discovery and no schedule-management command is registered in that catalog. Therefore the new Scheduler chat sub-view cannot yet perform conversational schedule-management tool calls. Internal code-armed schedules remain outside the agent capability.
- The approved S0 boundary is represented by the capability registry and `tests/schedule-3122-agent-capability.test.ts`: four creatable screen callbacks; executing goal families; and workflow-stage schedules through the shared workflow-stage adapter. Internal callbacks and system duties are excluded; descriptor-only goal operations remain excluded; consequential actions stay approval-bound. Tenant scope remains the per-login DO instance.
- **PDP gap found and closed in this worktree:** `evaluateAgentSchedulePdp` returns `enforced: false` when the PDP switch is off. Both the schedule action executor and approval-decision route now deny and audit that state instead of proceeding; focused regression tests cover both paths.
- **Two-mode gap:** `UnifiedScheduleRecord` has no `executionMode`; `ScheduledAgent` explicitly has no turn path or port hooks today; and `ResolvedEnvironment.agentSchedule` has no loop bounds or kill switch. The requested loop-mode dispatch and bounded-run acceptance are therefore not implemented.
- **Chat-view follow-up implemented in this worktree:** `AgentChatTabContent` now accepts `?view=scheduler` and renders a Scheduler surface alongside the shared conversation. It reuses the existing schedule, goal, and run-ledger panels and adds an inline queue for both schedule and goal approvals, with decisions sent through the existing protected endpoints. The schedule action tools remain the existing typed A2A operations; no duplicate MCP or schedule-management path was added.

The 2026-11-04 owner comments add dual-mode scheduling, direct tool use by LLM agents, and a Scheduler chat sub-view to the original issue. Loop bounds and task-kind mode allocation have no production values or registry entries today. They must be owner-configured and fail closed when absent; this report does not assign modes or invent limits. The deterministic path remains unchanged, and loop mode must not be enabled until its bounded runtime and self-rearm approval gate are implemented. The chat surface and direct structured tool invocation remain incomplete until the MCP tool catalog exposes the existing governed capability with agent/principal attribution.
