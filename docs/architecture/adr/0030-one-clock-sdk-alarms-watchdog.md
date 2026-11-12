# 0030. One clock for scheduled work: SDK alarms on the agent, one Worker-cron watchdog

- Status: Accepted
- Date: 2026-11-12
- Deciders: owner (direction in main chat 2026-11-12 ~08:20 EST, "document all the options and recommendation as an ADR ... the decision to use SDK alarms with one watchdog")
- Issue: Qunsultant/cfagent#4234 (sub-issue of Qunsultant/cfagent#3121)
- Implementing PR: Qunsultant/cfagent#4234 build PR (not yet opened — this PR lands the ADR only)

## Context

The scheduler has no heartbeat. Worker crons are OFF on current main (`wrangler.jsonc`, #4112): all three triggers are commented out, "nothing fires". The tick never fires while SDK alarms fire independently (user schedules, follow-up chains, the strategy-scan baseline, sweeps, the ticker push). The owner asked, in order: why we need Worker crons at all; what SDK alarms are; how many alarms and how many cron triggers we need; where SDK alarms live (workflow or agent); how jobs and workflows execute without an agent; which uses less Durable Object resource; the recommendation; and why Workflow schedules were not used. This ADR records the inventory, the options, and the decision.

Verified inventory (main, 2026-11-12):

- Clock mechanisms: three exist, two in play. (1) Durable Object alarms / Agents SDK scheduler — ONE mechanism, not two: the SDK `schedule` / `scheduleEvery` wraps the raw DO alarm; the alarm is recorded in the framework jobs table `cf_agents_jobs` (framework-owned substrate) and, when it fires, the agent wakes and runs the named callback method. (2) Worker crons — one mechanism, three entries defined (tick `*/30`, token renewal `0 3`, retention `0 4`), zero active. (3) Workflow schedules — one mechanism, zero active (the screener workflow's schedule was removed by #4112).
- What is NOT a clock: Cloudflare Queues (delivery, not a clock — a queue needs a producer to enqueue the tick); an external scheduler (not in use); manual triggers and routes (on-demand, not clocks).
- Where the alarms live: on the AGENT (the Durable Object instance), not on a workflow. Today on the shared platform OrchestratorAgent instance (`SHARED_ORCHESTRATOR_INSTANCE` — orchestrator, search, tasks, memory, NLQ all resolve to it): the strategy-scan baseline, follow-up chains, and the three sweeps/watchdog alarms. The ticker push alarm lives on the TickerAgent. A workflow cannot hold an alarm — workflows are execution (they run when invoked); they do not self-schedule.
- How many: cron triggers, three (tick, renewal, retention) + the nightly research run, undefined, a fourth once defined. Recurring SDK alarms, five platform alarms (3 sweeps/watchdog + ticker push + strategy-scan baseline) + one per user schedule and one per follow-up chain (unbounded, user-driven).
- Jobs and workflows without an agent: workflows CAN execute without an agent — a route handler starts a workflow instance via its binding (`POST /api/saga/start` → `SAGA_WORKFLOW`; the payment workflow from payment routes; the screener workflow on-demand), and the workflow then runs in the Workflows runtime, no agent DO involved. Async jobs CANNOT today — `executeAsyncJob` is a method on the OrchestratorAgent, armed by an SDK alarm; there is no standalone job runner. Sync/manual work runs inline in the route handler.
- DO usage (reasoned from code, not measured live): SDK alarms use slightly less DO — the trigger colocates with the work (one DO instance instead of two plus a Worker; placed on the ScheduledAgent, `onCron` runs in-process, no RPC). The saving is a couple of DO requests per firing against the seven dispatches the tick already makes; the work (evaluation, dispatches, model/API calls) is identical under both and dominates. The bigger DO win is the shape (one alarm, in-process due-checks), not the mechanism. #1819 tracks DO resource use.
- Not everything is a workflow. Workflows are the execution units (screener, goal screen, payment, saga, trade — four in `wrangler.jsonc`). The scheduling layer is agents (tick, async-job runner, sweeps, sync screens inline in routes).

## Decision

- **SDK alarms are the clock.** One recurring alarm on the ScheduledAgent runs the tick in-process (`onCron`, no RPC). The tick's cadence follows #4235's granularity (default at most once per day). Token renewal, retention, and the nightly research run become due-checks inside the one tick, not their own triggers. The heartbeat is a worker-duty record in the unified store (ADR 0029) — visible in the schedules home (list/pause/cancel), its firings in the one run ledger (#4262).
- **One Worker cron is the watchdog — and the only cron.** It fires hourly and does no work itself: no tick evaluation, no dispatches. It only checks the heartbeat and restarts it if it is missing or stale. All alarms live in the agent; nothing lives outside except the watchdog.
- **The watchdog's purpose (and why it must live outside the agent):** the agent's alarms are STATE (the DO alarm state / `cf_agents_jobs`). State can be lost or never armed — DO storage wiped or reset, a deploy that changes the arming path, the alarm cancelled or paused and never resumed, or the alarm existing but wedged (not firing). When that happens the heartbeat silently stops — the exact "no heartbeat" problem. The agent cannot reliably watch itself: its own watchdog (`watchdogMissedSchedules`) is itself an SDK alarm in the same substrate, so if the substrate is lost, both are gone. The watchdog must live outside what it watches, and the Worker cron is the one mechanism independent of the DO alarm state. What the watchdog does: (1) check the heartbeat alarm exists (listSchedules / the worker-duty record); (2) check freshness — the ledger for a recent heartbeat firing (the alarm exists but has not fired = wedged); (3) if missing or stale, re-arm the alarm (`scheduleEvery` on the ScheduledAgent) and write an audit/ledger row; (4) if re-arming fails repeatedly, it records the failure (visible in the ledger/audit) — it cannot fix everything. It does no work itself.
- **The tick's provisioning guard still applies** (#2331 slice 2): the tick skips with a logged reason if the platform-tier service user is not provisioned; the alarm runs as the provisioned platform-tier service identity.

## Consequences

- One clock mechanism for all scheduled work (user schedules + platform duties all use the SDK scheduler) — the "one schedule" the owner requires. The three duty crons are replaced, not restored; the single watchdog cron is the only Worker cron entry.
- The heartbeat is visible and manageable in the app (a worker-duty record — list/pause/cancel in the schedules home; firings in the ledger), unlike a Worker cron, which is invisible in the app.
- Less DO than the cron path (the trigger colocates with the work; one DO instance instead of two plus a Worker), and one alarm instead of three with in-process due-checks.
- Silent loss of the heartbeat is covered by an independent watchdog (the cron), not by another alarm in the same substrate.
- The watchdog cron is a deliberate, named exception to "nothing outside the agent" — one cron, one job (re-arm the heartbeat), no work. Its existence is recorded here, not hidden.
- No change to the work itself: the tick's evaluation, the seven dispatches, and the workflow/agent execution paths are unchanged; only the trigger changes.

## Alternatives considered

- **Pure Worker crons (restore the three):** rejected. A second clock mechanism (violates one-of-everything); the heartbeat is invisible in the app (cannot be listed/paused from the schedules home); the outside hop costs more DO; and restoring them reverses #4112 without answering "why we need them" — the answer is the watchdog role, not the clock role.
- **Pure SDK alarms (no watchdog):** rejected. Silent loss: if the alarm is lost, nothing fires and nothing notices — the exact failure mode this ADR exists to end. It needs a watchdog, and the cron is the one independent of the DO alarm state.
- **External scheduler (a third-party cron calling an endpoint):** rejected. Adds an external dependency outside the platform; violates one-of-everything. Not recommended.
- **Cloudflare Queues as the clock:** rejected as a clock. A queue is delivery, not a clock — it still needs a cron or alarm to produce the tick. Useful for the fan-out, not the heartbeat.
- **Drop the clock (per duty):** rejected for the tick. Dropping the tick means tick-polled goals never evaluate — a product regression. Drop remains a per-duty verdict inside #4234 (a duty can be dropped or moved to a user schedule; the tick cannot).
- **Workflow schedules:** rejected. Per-workflow only — a schedule starts its own workflow and nothing else, so it cannot be the one clock for the tick, goals, renewal, retention, and user schedules. Deploy-time config in `wrangler.jsonc` (not manageable from the app: no list/pause/cancel in the schedules home, no ledger record, users cannot create one). A schedule starts a whole workflow instance just to check what is due — heavier than an alarm's in-process due-check. The one Workflow schedule we had (screener) was removed by owner direction (#4112). The 1-concurrency cap (#4213) means a tick-workflow could queue behind a long run.
- **Raw DO alarms:** not a separate option — the SDK scheduler wraps them; the same mechanism at a lower level.
