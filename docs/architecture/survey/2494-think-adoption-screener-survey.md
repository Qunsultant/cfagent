# #2494 Think adoption — screener domain survey

SURVEY ONLY. No code changed, no issue/PR created. Base: `Qunsultant/cfagent` main
`798dec393d9c8b9158fc9b6c4d53548295e53c8c` (2026-11-01, fresh shallow clone
`~/workspace/cfagent-think-survey`). SDK surface read from the installed packages
(agents 0.32.0, @cloudflare/think 0.23.0 — matches `package.json` pins), typings at
`node_modules/@cloudflare/think/dist/index-DDnny6kt.d.ts` (cited below as `think.d.ts`
by line) and `dist/workflows.d.ts`.

Starting point: the 2026-10-30 Think harness audit (#2225 comment 6519999987) —
Actions / client tools / messengers / configureChannels / getScheduledTasks /
Think sub-agents NOT USED, lifecycle hooks PARTIAL, workflows MIXED,
configure()/getConfig() essentially unused. The MCP-client gap from that audit is
already closed (#2496, `this.mcp`); the /mcp server deliberately does not use
`createMcpHandler` (parity contract). This survey covers the remaining capabilities
for the screener domain only, per the owner's screener → payment → trading order.

One correction to the brief's citation: in-repo, ADR 0003 is the messaging port;
the records that govern this domain are ADR 0004 (screener workflows; W13 =
ThinkWorkflow base) and ADR 0005 (actor port), plus the §8 determinism doctrine in
`docs/agents/agentic-architecture.md` as restated in `src/config/screenerModes.ts`.

## 1. Inventory — screener domain on current main

| Component | Think surface touched today | Hand-rolled equivalents of Think-native capabilities |
|---|---|---|
| `ScreenerScreenWorkflow` (`src/workflows/screenerWorkflow.ts`, flow in `screenerWorkflowFlow.ts`) | `ThinkWorkflow` base (ADR 0004 W13). Nothing else: agent type is `any` by design — runs are tracked via D1 projection rows + instance status, never agent tracking (class header). | Flow programs against a hand-rolled minimal step port `ScreenerWorkflowStep { do, sleep }` (flow file line 100), not `ThinkWorkflowStep`. ND-mode interpretation is a hand-rolled gateway `generate()` (zod-constrained) injected as a port and run inside `step.do("interpret-screen-intent")` (`src/workflows/screenIntentInterpreter.ts`) — the job `ThinkWorkflowStep.prompt()` exists for. Parent polls child workflow statuses on a `step.sleep` loop (platform pattern; no native await-child exists). |
| `ScreenerAgent` (`src/agents/screener-agent.ts`, 1,912 lines) | `PortThink` base only (fleet shape (a), #1951). Defines **no** Think turn surface: no `getModel`/`getTools`/`getActions`/`beforeTurn` — it is an RPC service (`runScreen`, `runGoalScreen`) wearing the Think base for fleet uniformity. | Hand-rolled run lock (screen-run-lock ports, DO-sqlite/in-memory adapters) and hand-rolled scheduled-execution dedup: `claimScheduledExecution` storage keys (`screening:scheduled:last-slot:<env>:<jobKey>`) with minute-slot idempotency keys for scheduled runs. No Think/Agents-SDK native equivalent exists for cross-instance run locks — this is not a gap. |
| Scheduled screen jobs — `OrchestratorAgent` callbacks (`src/agents/orchestrator/scheduledCallbacks.ts`, maintenance in `scheduleMaintenance.ts`) | None. Arming is the **Agents SDK** scheduler (`this.schedule` / `this.scheduleEvery`, cron strings + intervals) on per-login orchestrator instances; the orchestrator's Think surface is the chat turn only. | Hand-rolled schedule lifecycle around raw SDK rows: `migrateLegacyScreenSchedules` (retires legacy token-renewal / IV-collection rows), `removeUnownedBaselineSchedules`, and a hand-rolled baseline arm for the options strategy scan: `ctx.schedule(STRATEGY_SCAN_CRON, "autonomousOptionsAnalysis", …, { idempotent: true })` with `STRATEGY_SCAN_CRON = "35 * * * *"` (orchestrator.ts:219). Identity resolution is hand-rolled and load-bearing (#1965: payload login wins, saved execution context is the legacy fallback). This is the surface `Think.getScheduledTasks()` addresses — see §2.1 for why it only partly fits. |
| `ScheduledAgent` (`src/agents/scheduled-agent.ts`) | `PortThink` base (#1956). | Hand-rolled goal store in `ctx.storage` + own 5-field cron parser (`isDue`/`isValidCron`) driven by Worker Cron Trigger RPC ticks. **Explicitly out of this domain**: its header (issue #959, survey D10) states it is NOT a screening scheduler and screening callbacks must not be added there. Listed here to prevent mis-scoping. |
| Chat doors (`src/agents/orchestrator/meshScreenDoor.ts`, `meshOptionsStrategyDoor.ts`) | None directly. The commands (`run_stock_screen`, `run_options_strategy_screen`) reach the orchestrator's turn as MCP-catalog tools via #2496's `this.mcp` discovery. | Doors are hand-rolled tool functions behind the catalog: identity stamped from turn resolvers (never tool args), workflow start + status polling against instance status / D1 collation. Functionally adjacent to what Think **Actions** compile into — see §2.2 for why they must stay catalog commands. |
| Screeners UI routes (`src/workflows/screenerWorkflowRoutes.ts`, `src/agents/routes/*`) | None. HTTP routes → `tryStartScreenerWorkflow` with a synchronous fallback run; ND commands are refused outright when the gate is closed (no silent downgrade). | Static env/code config throughout (flags in `src/config/screenerModes.ts`, `src/services/screeningFlags.ts`). No per-instance dynamic config need exists that `configure()/getConfig()` fits (§2.6). |

Golden tasks already covering this domain (`src/services/meshGoldenTasks.ts`):
`chat-screen-run`, `chat-screen-identity-refusal`, `door-chat-screen-run`,
`door-chat-screen-identity-refusal`, `door-chat-screen-run-deterministic`,
`door-chat-screen-run-non-deterministic`, `door-chat-options-strategy-screen`,
`chat-paid-screen`, `door-chat-paid-screen` (+ budget-refusal pair),
`scheduled-goal-trigger` and `http-schedule-goals` (ScheduledAgent — out of domain,
must stay green but prove nothing here).

## 2. Capability-by-capability assessment

### 2.1 `getScheduledTasks()` — PARTIAL FIT; the only real adoption surface in this domain

SDK offer (think.d.ts:2575, 962–975): the agent returns a code-declared task record;
Think reconciles it on startup (`internal_reconcileScheduledTasks`, think.d.ts:2599).
Each task is `{ schedule, retry?, metadata? }` plus exactly one of `prompt` (starts a
turn) or `handler(ctx)` (deterministic callback). `ThinkScheduledTaskContext`
(think.d.ts:940–951) carries `scheduledFor`, `occurrenceKey`, and `idempotencyKey`.
Schedule grammar is narrow by type: `every N minutes|hours`, or wall-clock
`every day|weekday|week on <day> at HH:MM` with optional `in <timezone>`
(think.d.ts:924–937). `getScheduledTasksScope()` defaults to `"root"` — tasks arm on
the top-level instance only, not per sub-agent facet (think.d.ts:2578–2595).

Fit against this domain's jobs:

- The options strategy-scan baseline is cron `"35 * * * *"` — **inexpressible** in
  the grammar. `every 1 hour` is an interval anchored at reconcile time; its firing
  phase is not `:35` and is not specified anywhere in the typings. Adopting it for
  this job changes when a flagship production job fires, on evidence the typings
  don't provide.
- User/system screen schedules created through the Schedules surface are **data**
  (arbitrary cron strings + payloads in SDK rows, validated by
  `src/trading/screeningSchemas.ts`). Code-declared tasks cannot replace data-owned
  schedules; the Schedules UI contract forbids it.
- The handler form is determinism-clean (no model in the loop) and its
  `idempotencyKey`/`occurrenceKey` map onto the domain's existing slot-dedup
  discipline. The mechanism fits; the cadence grammar is the blocker.

Would change: arming/reconciliation for any adopted job moves from hand-maintained
SDK rows + maintenance functions to startup reconciliation. Must NOT change: the
callbacks themselves, #1965 identity resolution, audit events, user schedule rows,
`ScheduledAgent`, `CHAT_NLQ_MODE`, `SCREENER_ND_MODE`. Risk class: **moderate** for
a dispatch flip (double-fire / missed-fire on a production job); **low** for
observe-only arming (see §3).

### 2.2 Actions (`getActions()` / `action()`) — NO FIT for the screen doors

SDK offer (think.d.ts:2452, 802–838): descriptors compiled into tools for the
assistant, with stable `idempotencyKey` replay of settled results, a permissions
spec, and an approval policy (`approvalRisk`, pending-approval flow). This is a
Think-local tool surface on one agent's turn.

Why not here: the screen commands' canonical home is the MCP catalog (82→83 tools),
consumed by the turn through #2496's runtime discovery — a landed, owner-approved
decision (single catalog; S14 conformance matrix pins the cells). Re-expressing
`run_stock_screen` as an orchestrator Action would create a second, divergent tool
surface for the same capability and break the catalog pins. The doors' contracts
(identity from turn resolvers, MeshDoorError codes, async-job carriage) are
catalog-level, not turn-local. Verdict: evaluated, **rejected for this domain**;
the same question will recur for payment/trading and should be answered the same
way unless the single-catalog decision is reopened. Risk if done anyway: high
(contract duplication).

### 2.3 Client tools — NO FIT

SDK offer (think.d.ts:599–610, 1096–1099): tool schemas executed on the connected
client over the WebSocket chat protocol. Screening is server-side data work
(providers, workflows, report generation); no step needs browser-side execution,
and the Screeners UI already drives the domain over HTTP routes. No job exists for
this capability in the domain. Verdict: not applicable; do not invent one.

### 2.4 Messengers / `configureChannels()` / `deliverNotice` — NO FIT

SDK offer (think.d.ts:2450–2463, 1895): inbound channel integrations (chat-SDK
messengers; `messengers/telegram.d.ts` ships) routed into the agent as turns, plus
`deliverNotice` for no-turn, channel-routed notices to the channel a turn came
from. The screener domain's channel need is the opposite direction: deterministic,
audited, delivery-id-idempotent **outbound** result delivery owned by workflow
steps (`screeningDelivery.ts`, `screenerSlackDelivery.ts`, follow-up delivery).
Slack **ingress** already converged at the implementation layer in #1262/S13 and
must not be re-hosted. Verdict: wrong layer for this domain; rejected.

### 2.5 Think sub-agents / agent-as-tool — NO FIT for screen execution

SDK offer (think.d.ts:5516, 903–919): `subAgent(cls, runId)` addresses a child DO;
agent-tool runs persist child-run rows (`AgentToolRunInspection`: status, progress,
output) with re-attach after eviction. But an agent-tool run is a **chat turn** —
a model in the loop. Screen execution is deterministic RPC (`runScreen`) fanned
out by child **workflows** under claim-check discipline (ADR 0004). Routing shards
through model turns would violate the determinism boundary and add model cost to a
data pipeline. The existing agent-as-tool golden task (`agent-as-tool-research`)
belongs to the research domain. Verdict: rejected for screen execution; the
hand-rolled shape (child workflows + RPC) is the sanctioned one.

### 2.6 `configure()` / `getConfig()` — NO CURRENT FIT

SDK offer (think.d.ts:2338–2347): per-instance JSON config persisted in the
`think_config` table, server-side, survives restart/hibernation. The domain's
config is either global env switches (`SCREENER_ND_MODE`, `CHAT_NLQ_MODE` — env by
design; making the ND gate per-instance would break its fail-closed, CISO-gated
semantics) or per-user **collections** with CRUD + UI (screener presets, via
DO-sqlite adapters) — a single config blob is the wrong shape for both. Verdict:
no adoption target in this domain today.

### 2.7 Lifecycle hooks — PARTIAL, no screener-domain delta

Think's turn hooks (`beforeTurn`, `onChatResponse`, `onChatError`,
`beforeToolCall`; think.d.ts:1112–1524) are exercised through PortThink's port
translation — by the **orchestrator's** turns, not by anything screener-specific.
`ScreenerAgent` runs no turns, so there is nothing to adopt on it; the
audit's "PARTIAL" is a fleet-level statement whose screener-domain remainder is
nil. No slice.

### 2.8 Workflows — `step.prompt()` is the real item, and it is NOT slice-sized

SDK offer (`workflows.d.ts`): `ThinkWorkflow.extendStep` adds
`step.prompt(name, { prompt, output: zodSchema, timeout?, key?, cancelOnTimeout? })`
returning schema-validated output, submitted through the **owning agent's**
submission queue with a derived idempotency key; terminal states surface as
`ThinkPromptError` subclasses. This is the native form of the ND interpreter the
domain currently hand-rolls (gateway `generate()` inside `step.do`).

Two blockers, both structural:

1. **No owning agent.** `ScreenerScreenWorkflow` is started via the workflow
   binding from doors/routes/callbacks, not by an agent — hence agent type `any`
   and no agent tracking, by design (class header). `step.prompt` needs an owning
   Think agent's submission queue; adopting it means re-routing every start path
   through an agent (e.g. OrchestratorAgent `startWorkflow`) — a topology change
   across doors, routes, scheduled callbacks, and goal dispatch. Not one PR.
2. **Unprovable while dark.** `SCREENER_ND_MODE` is OFF and its flip is
   CISO-gated (#2530). The interpreter only runs in ND mode, so a `step.prompt`
   swap would have zero production-surface evidence — wiring-only by the owner's
   standard.

Must NOT change when it is eventually done: the validated-data crossing
(`validateScreenCriteriaArtifact` stays the gate; the prompt step's zod output is
a generation constraint, not the gate), the audit step before execution, the
journaled-replay rule (replay never re-calls the model), the interpreter's
prompt-injection hardening text, and the flag semantics. Risk class: **high**
(topology + model-path change). Verdict: the programme's real workflow-adoption
item for this domain — sequenced after an owner/ADR decision on workflow start
topology, not as slice 1.

### 2.9 Already adopted / out of scope

- Durable submissions (`submitMessages` etc.) — adopted by #2566 for chat turns
  (orchestrator, not screener execution).
- MCP client (`this.mcp`) — adopted by #2496.
- Skills (think.d.ts `Skill`/`SkillCatalog` exports) — disposition already
  recorded in the mesh programme: adopt-as-packaging, deferred (S19). Not
  re-opened here.

## 3. Recommended first slice

**Adopt `getScheduledTasks()` in observe-only mode for the options strategy-scan
baseline** — the #1078 observe → enforce pattern applied to schedule arming.

Scope IN:

- `OrchestratorAgent.getScheduledTasks()` declares exactly one task,
  `options-strategy-scan-observe`, schedule `every 1 hour`, **handler form**
  (deterministic; no prompt action).
- The task is declared only on instances holding a screener execution context
  (the same instances where the baseline SDK row exists today — the declaration
  reads the stored context; per-instance variance is the documented legitimate
  case for non-static declarations).
- The handler **never dispatches**. It records the occurrence — taskId,
  `scheduledFor`, `occurrenceKey`, `idempotencyKey`, observed phase (minute of
  hour) — to the existing audit surface plus a capped DO-storage occurrence
  ledger (last ~50, mirroring `tickHistory`).
- Think types reach the class through `src/actors/thinkAdapter.ts` re-exports
  (the agent-conformance pin allows bare `@cloudflare/think` imports only in
  `src/actors/thinkAdapter.ts` / `thinkPortMapping.ts` — orchestrator.ts must not
  import Think directly). Class-inventory budget pin for `orchestrator.ts`
  recomputed.
- Everything else untouched: the `"35 * * * *"` SDK row keeps firing the real
  scan; callbacks, #1965 identity resolution, maintenance functions, user
  schedules, `ScheduledAgent`, both mode flags.

Scope OUT: any dispatch change; any schedule-row change; `step.prompt`; Actions;
ScheduledAgent; payment/trading domains.

Why this slice: it is the only adoption in the domain that is (a) a real Think
capability replacing a hand-rolled mechanism (hand-armed row + maintenance),
(b) determinism-clean (handler form), and (c) production-provable without
touching a production job's behavior. Its output is the missing evidence for the
real decision: the observed firing phase and cadence stability of an
interval-declared task in the production runtime, which the typings do not
specify. The follow-up flip slice (dispatch from the Think task, retire the SDK
row) is then an evidence-based owner decision — including the explicit cadence
question (`:35` cron vs interval phase) — instead of a guess.

Tests / proof:

- Unit: declaration shape pin (exactly one task, handler form, interval grammar);
  handler records-and-never-dispatches (spy on `autonomousOptionsAnalysis` —
  zero calls); declaration absent on instances without an execution context;
  reconcile idempotence (re-declaring changes nothing).
- Regression: existing schedule-maintenance, scheduled-callback, and
  class-inventory suites green; golden tasks `door-chat-screen-run-deterministic`
  and `door-chat-screen-run-non-deterministic` still pass (doors untouched).
- Production-surface evidence (the acceptance that matters): within ~2 hours of
  deploy, the occurrence ledger on the production orchestrator instance shows
  ≥2 hourly occurrences with their phase timestamps, **and** job history shows
  the real options scans still originating from the cron row exactly once per
  hour — mechanism live in production, job behavior unchanged, no duplicates.

## 4. DRAFT issue body (gitops §5) — DRAFT, not filed

---

**Title:** feat(think-adoption): observe-only Think getScheduledTasks arming for the options strategy-scan baseline (#2494 screener slice 1)

## Problem

The screener domain's scheduled jobs are armed by hand-maintained Agents SDK
schedule rows plus hand-rolled maintenance (`migrateLegacyScreenSchedules`,
`removeUnownedBaselineSchedules`, a manual baseline arm in
`src/agents/orchestrator/scheduleMaintenance.ts`). Think 0.23.0 offers
code-declared scheduled tasks reconciled on startup (`getScheduledTasks()`), the
#2494 adoption programme's screener-domain surface — but the SDK's schedule
grammar cannot express the baseline's cron (`STRATEGY_SCAN_CRON = "35 * * * *"`,
orchestrator.ts:219), and the typings do not specify an interval task's firing
phase. Flipping dispatch on that evidence gap risks double-firing or
phase-shifting a flagship hourly production job.

## Evidence

- Survey: `think-adoption-screener-survey.md` (#2494 programme files) — full
  capability-by-capability assessment against the installed 0.23.0 typings.
- `ThinkScheduledTask` grammar (think.d.ts:924–975): intervals and
  daily/weekday/weekly wall-clock only; handler form is deterministic and
  carries `occurrenceKey`/`idempotencyKey` in its context.
- Precedent for observe-first adoption: #1078 ExecutionContext observe →
  enforcement split.
- The baseline scan's dispatch, identity resolution (#1965), and dedup
  (`ScreenerAgent.claimScheduledExecution`) are independent of the arming
  mechanism and remain untouched by this slice.

## Scope

IN: one observe-only Think scheduled task on OrchestratorAgent (`every 1 hour`,
handler form, declared only on instances holding a screener execution context);
occurrence recording to audit + capped DO-storage ledger; Think type re-exports
via `src/actors/thinkAdapter.ts`; class-inventory budget pin recompute.
OUT: any dispatch change; any existing schedule row, callback, or maintenance
function; user schedules; ScheduledAgent; `step.prompt`; Actions;
`SCREENER_ND_MODE` / `CHAT_NLQ_MODE`; payment and trading domains.

## Acceptance criteria

1. `getScheduledTasks()` on OrchestratorAgent declares exactly one task
   (`options-strategy-scan-observe`, `every 1 hour`, handler form), and only on
   instances holding a screener execution context.
2. The handler records each occurrence (taskId, scheduledFor, occurrenceKey,
   idempotencyKey, phase) and provably never dispatches a screen (callback spy
   at zero across the test suite).
3. No bare `@cloudflare/think` import outside the conformance pin's allowlist;
   class-inventory pins updated from the composed measurement.
4. Full verify green; existing schedule-maintenance / scheduled-callback suites
   and golden tasks `door-chat-screen-run-deterministic`,
   `door-chat-screen-run-non-deterministic` pass unchanged.
5. Post-merge production evidence: within ~2 hours of deploy, the production
   occurrence ledger shows ≥2 hourly occurrences, and job history shows the
   real options strategy scans still firing exactly once per hour from the
   existing cron row — reported in the §15 with the observed interval phase,
   as the evidence base for the follow-up flip decision.

Reused surfaces: the existing `autonomousOptionsAnalysis` callback and its
identity resolution (unchanged, not invoked); ScreenerAgent's
`claimScheduledExecution` dedup discipline (referenced, not modified);
ScheduledAgent's capped `tickHistory` ledger pattern; the #1078 observe-mode
precedent; PortThink / `src/actors/thinkAdapter.ts` as the sole Think seam.

## Agent

#CAIO-quns

---

*Survey ends. Recommendation and top risk are in the accompanying report.*
