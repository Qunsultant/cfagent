# #2494 Think adoption — payment domain survey

SURVEY ONLY. No code changed, no issue/PR created. Base: `Qunsultant/cfagent` main
`ad6b4abfb5a0c8fb301d791f51243769a6d34339` (2026-11-01, fresh shallow clone
`~/workspace/cfagent-think-survey-pay`). SDK surface read from the installed
packages (agents 0.32.0, @cloudflare/think 0.23.0 — matches `package.json`
pins), typings at `node_modules/@cloudflare/think/dist/index-DDnny6kt.d.ts`
(cited below as `think.d.ts` by line, per the screener survey's convention),
`node_modules/@cloudflare/think/dist/workflows.d.ts` (cited as
`think-workflows.d.ts`), and `node_modules/agents/dist/workflows.d.ts` +
`agent-routing-vVMA7m8Y.d.ts` (cited as `agents-workflows.d.ts` /
`agent-routing.d.ts`).

Method and honesty standard follow the screener survey
(`think-adoption-screener-survey.md`, slice #2693). Starting point is the same
2026-10-30 Think harness audit (#2225 comment 6519999987): Actions / client
tools / messengers / configureChannels / getScheduledTasks / Think sub-agents
NOT USED, lifecycle hooks PARTIAL, workflows MIXED, configure()/getConfig()
essentially unused. This survey covers the payment domain only, second in the
owner's screener → payment → trading order.

**Outcome up front: no adoption slice is recommended for this domain.** Every
candidate capability is either already native, a genuine no-fit, or — for the
one arguable candidate (agent-hosted workflows, §2.2/§2.3) — a topology change
that cannot produce production-surface evidence while the paid path is dark
(§2.11). §4 drafts the #2494 comment recording surveyed-no-adoption.

## 1. Inventory — payment domain on current main

| Component | Think surface touched today | Hand-rolled equivalents of Think-native capabilities |
|---|---|---|
| `PaymentWorkflow` (`src/workflows/paymentWorkflow.ts`, flow in `paymentWorkflowFlow.ts`) | `ThinkWorkflow` base (ADR 0004 W13) — the class only. `run()` validates identity/tenant, builds the gate + deps from env, delegates to the flow. Agent type is `any` **by recorded design**: the class header states the `ThinkWorkflow<PaymentsAgent, …>` alternative is justified ONLY if the workflow actually uses `this.agent`, and that changing it needs CTO review. `this.agent`, `reportProgress`, `notifyAgent` are never used. | The flow programs against a hand-rolled minimal step port `PaymentWorkflowStep { do, waitForEvent }` (flow file), satisfied by the platform `WorkflowStep` via cast. Money ops are `step.do()`; the human gate is `step.waitForEvent("await-payment-approval", { type: "approval", timeout: 24h })` and the payment wake-up is a second `waitForEvent` (`payment_verified`, 24h) — the flow header records both as "AgentWorkflow approval support" used through the raw platform step, not the SDK wrappers (§2.3). No `step.sleep`, no prompt step (forbidden, §2.1). |
| Flow steps, in order | — | `gate-check` (step.do) → checkout or `coverage_required` → approval wait (or `payment.approved_at_submission` record for one-off scheduled runs authorized at submission, #2550) → verified-payment wait → `confirm-paid` (step.do; re-reads provider state — an event is a wake-up, never proof) → `record-payment` → `start-screener`; starter failure → one failure credit, never a cash refund (#2549). Every branch records a `mas_events` audit event; confirmed charges write one deduped ledger row + best-effort D1 journal projection. |
| Gates | None. Plain services constructed per workflow run in the adapter. | `NativeMonetizationGate` (Stripe + x402 via CheckoutPort bundle; composition root `createCheckoutPorts.ts` is the only env reader). Prices resolve ONLY via `catalogue.getApprovedPrice` (#2547, migration 0027): a proposed price fails closed exactly like a missing one; **no price is approved in production, and the monetization flag is default OFF** — see §2.11. Durable x402 proof redemption #2548 (migration 0029): confirm checks/records redemption keys (`claim:`, `x402:<nonce>:<payer>`, proof hash) in D1, so a proof redeems exactly once across instances/restarts. `CfPayMonetizationGate` is deprecated in place (draining in-flight runs; names the native gate as successor). |
| `PaymentsAgent` (`src/agents/payments-agent.ts`) | `PortThink` base only (#1957, fleet shape (a)) — the workflow's *neighbour*, not its owner. RPC-only: `budgetCheck` / `processPaidRequest` / `todaySpent` / `listPayments` / `migrateLegacyLedger` + `handleA2A`. Header is explicit: non-chat, drives no turns, registers no scheduler callbacks, `portHooks` deliberately unset. | BudgetGuard state is derived from the ledger of record (`mas_transactions`) on every check — no local copy to adopt into anything. `budgetCheck` fails closed and requires an explicit caller `agentId` (#2327). Nothing here is a hand-rolled version of a Think capability; it is a deterministic RPC actor wearing the fleet base, same shape as `ScreenerAgent`. |
| Owning agent | **None — deliberately.** Recorded twice: the workflow class header (above) and the flow header's 2026-10-27 correction ("there is NO new payment agent here… OrchestratorAgent is a CALLER, not a base class"). | The submission seam (`src/services/paymentWorkflowSubmission.ts`) documents two start paths: the **binding path** (`env.PAYMENT_WORKFLOW.create({ id: runRequestId, params })`, create-or-adopt #2409) — the production path — and a **host-agent path** (`runWorkflow`/`sendWorkflowEvent`) that is structural only, never wired, with a stale note to "confirm its exact signature against @cloudflare/think 0.19.0". §2.2 confirms the signature against the installed 0.23.0 typings and explains why confirming it does not create a fit. |
| How runs are started (all binding path) | — | Chat paid door: `meshScreenDoor.ts` paid branch (budget check via PaymentsAgent → seam → binding start → instance-status polling), mirrored in `nlqPorts.ts` for the NLQ surface. HTTP routes: `agenticPayments.ts` (×2), `screenerResearch.ts`, `paymentAssuranceLive.ts` (live-test surface). Schedule service: `src/services/scheduledTasks.ts`. Approval / verified-payment delivery: #1262 shared approval engine → routes → binding `instance.sendEvent(...)`; the routes wrap the binding in a `bindingHost()` shim to reuse the seam's host-shaped delivery helpers (`paymentAssuranceLive.ts:179`) — a shim over the binding, not a Think agent. |
| Scheduling / recurring elements | None owned by this domain. | PaymentWorkflow declares no schedules. Recurring-ness is a per-run gate rule, not a schedule: scheduled runs are coverage-only (never unattended card), unstated `scheduleKind` = recurring, recurring stays `coverage_required` until the subscription/credits store (#2015/#1623) exists. Scheduling itself lives in the screener domain (OrchestratorAgent callbacks / schedule service). |
| Domain config | None via Think. | Four existing homes, each deliberate: env (checkout keys, composition root only); the Flagship `monetization` flag via `createFeatureFlagPort` (fail-closed OFF; the workflow re-evaluates it per run); the D1 price catalogue (operator data with set/approve workflow + audit, `agenticPayments.ts` routes); `PAYMENTS_FLOW_MODE` resolved by a pure scoped resolver (run > session > user > global env > `hitl`, fail-closed; #1735 — the run level is explicitly NOT request input). |
| Golden tasks already covering this domain (`src/services/meshGoldenTasks.ts`) | — | `chat-paid-screen`, `chat-paid-budget-refusal` (NLQ surface), `door-chat-paid-screen`, `door-chat-paid-budget-refusal` (mesh door), `chat-budget-check`. All five exercise the budget door + coverage path (`coverageConsumed` facts); none executes a real charge — consistent with §2.11. |

## 2. Capability-by-capability assessment

Cross-cutting MUST-NOT-CHANGE list for this domain (applies to every row):
determinism — money paths are `step.do()` + approval waits, never a prompt
step, and prompt output never crosses into payment execution; one charge per
run-request; identity discipline (verified login in params, fail-closed on
missing identity, caller-named `agentId` on budget checks); approval binding
(the #1262 engine is the approval source of truth; the approval audit names
the approver, #2550); fail-closed gates (approved prices only, durable proof
redemption, refund XOR guard).

### 2.1 Workflows — `step.prompt()` — FORBIDDEN, permanently

SDK offer (`think-workflows.d.ts`): `ThinkWorkflowStep extends
AgentWorkflowStep` and adds exactly one method, `prompt(name, { prompt,
output: zodSchema, … })`. That is the *entire* Think delta over the Agents SDK
workflow surface — and it is the one capability the §8 determinism doctrine
excludes from money paths absolutely: no model chooses an amount, a
recipient, or whether to pay, and no prompt output crosses into payment
execution. The flow already uses the platform step's `do`/`waitForEvent`
directly. Verdict: **rejected by doctrine, not by fit** — recorded so the
trading survey does not have to re-derive it. Risk if done anyway: critical.

### 2.2 Agent-hosted workflows (`runWorkflow`, `this.agent`, tracking, callbacks) — the arguable candidate; REJECTED

SDK offer (agents SDK, inherited by Think): `Agent.runWorkflow(name, params,
options?)` injects `__agentName` / `__agentBinding` / `__workflowName` into
the workflow params (`agent-routing.d.ts`, AgentWorkflowInternalParams) and
tracks the instance in the host's `cf_agents_workflows` table, queryable via
`getWorkflows()`; the workflow gains `this.agent` (typed stub),
`reportProgress` / `notifyAgent` callbacks (`onWorkflowProgress` /
`onWorkflowComplete` / `onWorkflowError` on the agent), and durable step
methods `reportComplete` / `reportError` / `sendEvent` / `updateAgentState`
(`agents-workflows.d.ts`; `agent-routing.d.ts:2875–2923`). The submission
seam's open factual question is now answerable from the installed typings:
`runWorkflow` / `sendWorkflowEvent` exist with the shapes the seam assumed
(`agent-routing.d.ts:5785`, `:5807`). Confirmation does not create a fit:

1. **No host exists, by recorded decision.** Both candidate hosts fail.
   PaymentsAgent is the budget/ledger actor, addressed as a URL-name
   singleton — hosting there would aggregate *every tenant's* payment
   workflows into one instance's tracking table (a tenant-isolation smell
   on a money path) and conflate the ledger owner with run orchestration,
   against the #2014 correction. OrchestratorAgent is per-login and
   name-addressed (callbacks re-resolve by name, so they would work), but
   it hosts only the chat-door and NLQ starts.
2. **Starters span non-agent contexts.** HTTP routes (`agenticPayments.ts`,
   `screenerResearch.ts`, `paymentAssuranceLive.ts`) and the schedule
   service (`scheduledTasks.ts`) start runs with no agent instance in hand.
   Host-adopting only the agent-side starts splits the start topology in
   two; routing route/schedule starts through an agent stub is a topology
   change across five-plus call sites on a money path — not one PR, and
   not justified by the return (next point).
3. **The return is bookkeeping the domain already has.** Tracking rows
   duplicate what the domain already records durably: D1 projection rows,
   the `mas_transactions` ledger, and the `mas_events` audit trail — the
   class header's stated reason for agent type `any`. Progress callbacks
   have no consumer: outcomes are read by instance-status polling at the
   doors and by the ledger/audit surfaces, not pushed to a host.
4. **Unprovable while dark** — §2.11 applies with full force.

Would change: start path, params shape (agent-internal fields in a money
payload), status/read surfaces. Must NOT change: everything on the
cross-cutting list. Risk class: **high** (topology change on a money path).
Verdict: rejected for this domain at this time; revisit triggers in §3.

### 2.3 `waitForApproval` / `approveWorkflow` — REJECTED (depends on §2.2, and weaker than the incumbent)

SDK offer (`agents-workflows.d.ts`): `AgentWorkflow.waitForApproval(step, {
stepName?, timeout?, eventType? })` waits for an approval delivered by the
host agent's `approveWorkflow(workflowId, { reason?, metadata? })`; rejection
throws `WorkflowRejectedError` and is *reported to the agent as an error*
(durably). The standard payload is `ApprovalEventPayload { approved,
reason?, metadata? }` (`agent-routing.d.ts:3071–3081`) — **there is no
approverId field**; the approver would have to ride in `metadata` (the
typings' own example uses `metadata: { approvedBy: userId }`).

Why the incumbent is better here: the flow's hand-rolled wait distinguishes
three outcomes the audit trail treats differently — rejection
(`payment.approved` absent, `payment.approval_rejected` recorded), timeout
(`payment.approval_expired`), and approval **naming the approver**
(`payment.approved` with `approverId`, #2550) — from an event the #1262
engine delivers through HTTP routes to the binding. `waitForApproval`
collapses rejection into an exception plus an agent error report (rejection
is a normal business outcome here, not a workflow error), has no typed
approver channel, and presupposes the §2.2 host topology for delivery —
routes would have to RPC into an agent stub to approve. Adopting it changes
the human-gate contract of a money path to gain a wrapper around
`waitForEvent`. Verdict: rejected. Risk if done anyway: high.

### 2.4 Actions (`getActions()` / `action()`) — NO FIT

SDK offer (think.d.ts:2452, 802–838): descriptors compiled into tools for one
agent's turn, with an approval policy (`approvalRisk`, pending-approval
flow). PaymentsAgent runs no turns, so there is no turn surface to compile
into; and the paid commands' canonical home is the MCP catalog
(`src/mcps/openaimp/agenticPaymentCommands.ts`), consumed through #2496's
runtime discovery — the single-catalog decision the screener survey (§2.2
there) already applied. The Action approval policy is additionally the wrong
approval: payment approval is the workflow's durable wait backed by the
#1262 engine, not a turn-level prompt. Verdict: no fit; the reasoning is the
screener survey's and should be answered the same way for trading.

### 2.5 Client tools — NO FIT

SDK offer (think.d.ts:599–610, 1096–1099): tool schemas executed on the
connected client over the WebSocket chat protocol. The domain's client-side
payment code — `src/client/x402Pay.ts`, `PaymentsPage.tsx` — is browser
checkout code for an HTTP/UI flow (Stripe-hosted checkout, x402 wallet
signing), not chat-turn client execution, and no payment step may depend on
a chat client being connected: runs are started from routes and schedules
with no turn at all. Verdict: not applicable; do not invent one.

### 2.6 Messengers / `configureChannels()` / `deliverNotice` — NO FIT

SDK offer (think.d.ts:2450–2463, 1895): inbound chat-channel integrations
routed into an agent as turns, plus `deliverNotice` for no-turn notices
routed to the channel a turn came from. The domain's notification reality is
the opposite shape: receipts and status live on the ledger/audit surfaces
and the Payments UI; checkout is a provider-hosted page reached by redirect;
approval requests travel as #1262 signed links over HTTP. Most paid runs
have no originating turn to route a notice back to (route- and
schedule-started runs), and chat-started runs already return their outcome
through the door's status polling. Verdict: wrong layer for this domain.

### 2.7 Think sub-agents / agent-as-tool — NO FIT

SDK offer (think.d.ts:5516, 903–919): child-DO addressing and agent-tool
runs — which are chat turns, a model in the loop. Every payment interaction
is deterministic RPC: the doors and scheduler call `PaymentsAgent`'s
`budgetCheck` / `processPaidRequest` by stub, and the workflow starts the
screener through the workflow port. Putting a model turn anywhere in a
money path violates the determinism boundary (§2.1). Verdict: rejected;
the hand-rolled shape (RPC + workflow port) is the sanctioned one.

### 2.8 `getScheduledTasks()` — NO FIT

SDK offer (think.d.ts:2575, 924–975): code-declared tasks reconciled on
agent startup. The payment domain declares no schedules and owns no agent
that could declare them (PaymentsAgent registers no scheduler callbacks by
design). Recurring billing does not exist yet as a mechanism — recurring
runs are coverage-gated per run pending the #2015/#1623 store — so there is
no recurring payment job for a task declaration to arm. The screener
domain's schedules are a different domain's survey result (#2693).
Verdict: not applicable.

### 2.9 `configure()` / `getConfig()` — NO FIT

SDK offer (think.d.ts:2338–2347): per-instance JSON config persisted in the
`think_config` table of one agent instance. This domain has no per-instance
config dimension: the workflow has no owning instance, PaymentsAgent is
instance-agnostic (all state derives from the ledger), and every actual
config need already has a deliberate home (§1: env, Flagship flag, D1
operator catalogue with its own approval workflow, the pure scoped
`PAYMENTS_FLOW_MODE` resolver). A writable per-instance config blob on a
money path would be a new authority surface — e.g. anything resembling the
flow-mode switch must stay execution-context-scoped and never
request-writable (#1735 guard) — not an adoption. Verdict: no adoption
target in this domain today.

### 2.10 Lifecycle hooks — NO FIT (the audit's PARTIAL has no payment remainder)

Think's turn hooks run on turns. PaymentsAgent is deliberately turnless
(#1957 header: `portHooks` unset because "a turn driven against this class
would have no hooks to run"), and PaymentWorkflow is a workflow, not a turn
surface. The hooks the paid chat path does exercise are the orchestrator's,
through PortThink — orchestrator-domain, covered by the fleet, not a
payment slice. Verdict: nothing to adopt.

### 2.11 The decisive fact: the paid path is dark in production

Independent of every fit question above: the monetization flag is default
OFF (fail-closed; the workflow is only started when a caller evaluates it
ON, and flag-OFF callers never use the seam); **no catalogue price is
approved**, so with the flag ON the native gate still fails closed at
`priceFor` before any checkout or coverage spend; and the chat door
additionally refuses monetization-on paid requests with
`checkout_email_required` because no checkout-email source is composed for
chat turns (the S10 gap, still present on current main —
`meshScreenDoor.ts` header and paid branch). Consequence, by the owner's
standard the screener survey applied to `step.prompt` (§2.8 there): any
adoption in this domain today would be wiring-only — zero production runs
exist to evidence it. That disqualifies even a clean-fit candidate, and it
is the main reason §2.2/§2.3 are rejections rather than a sequenced plan.
Note the S10 gap itself is a composition/wiring gap (an email seam), not a
Think-capability gap; it belongs to its own track, not this programme.

### 2.12 Already adopted / native (for the record)

- `ThinkWorkflow` base class (ADR 0004 W13) — adopted; the workflow is a
  Think workflow in name and base, with the platform step used directly.
- Durable waits and journaled steps — platform-native (`step.do`,
  `step.waitForEvent`), already the execution model; nothing hand-rolled
  substitutes for them.
- MCP catalog for paid commands + #2496 runtime discovery on the chat
  turn — adopted (S10/S11); the budget door the golden tasks exercise.
- Durable turn submissions (#2566) — orchestrator chat turns; the payment
  workflow is itself the durable unit for money, so no submission-queue
  adoption applies to it.

## 3. Recommendation — surveyed, no adoption; revisit triggers

**No slice is recommended.** The payment domain's Think surface is: base
class adopted, the one Think-specific step capability (`prompt`)
doctrinally forbidden, every agent-shaped capability (hosting, approval
wrappers, Actions, sub-agents, scheduled tasks, per-instance config,
messengers, hooks) presupposing a turn or an owning agent this domain
deliberately does not have — and the whole paid path dark in production,
so no adoption could be evidenced at the production surface regardless.

Record the domain as **surveyed-no-adoption** on #2494 (draft comment in
§4), with two explicit revisit triggers:

1. **Monetization activation** — the first operator price approval (#2547's
   gate is built; approval is the CPO/operator action) plus the flag flip.
   Once real paid runs execute, §2.2/§2.3 can be re-evaluated against live
   run evidence instead of a dark path.
2. **An owner/CTO owning-agent decision** — the workflow's class header
   already names the precondition for `ThinkWorkflow<PaymentsAgent, …>`:
   the workflow actually using `this.agent`, with CTO review. If that
   decision is ever taken, §2.2/§2.3 are the survey's re-entry point, and
   the approverId-in-metadata gap (§2.3) is a known contract cost to price
   in advance.

Explicitly NOT recommended as consolation work: host-path wiring "to
confirm it works" (the typings already confirm the shape; wiring it would
split the start topology for no consumer), an observe-only variant of
§2.2 (there are no production runs to observe), and folding the S10
checkout-email gap into this programme (real gap, wrong programme — it is
composition wiring, and it gates activation, not adoption).

## 4. DRAFT comment for #2494 — DRAFT, not posted

---

**Payment domain Think-adoption survey — complete: surveyed, no adoption
(#2494, second domain after screener #2693)**

Survey: `think-adoption-payment-survey.md` in the programme files
(base main `ad6b4abf`, installed typings agents 0.32.0 / think 0.23.0 read
directly). Findings, briefly:

- `PaymentWorkflow` is `ThinkWorkflow` (ADR 0004 W13) with agent type `any`
  by recorded design — no owning agent, deliberately (#2014 correction);
  `PaymentsAgent` is a turnless PortThink RPC actor beside it, not its
  owner. All production starts use the Workflows binding path
  (create-or-adopt on runRequestId) from doors, routes, and the schedule
  service.
- The only Think-specific workflow capability, `step.prompt()`, is
  doctrinally forbidden on money paths. Actions, client tools,
  messengers/`deliverNotice`, sub-agents, `getScheduledTasks()`,
  `configure()`/`getConfig()`, and lifecycle hooks are each genuine
  no-fits (no turns, no schedules, no per-instance config dimension in
  this domain) — evidence per capability in the survey.
- The one arguable candidate — agent-hosted workflows (`runWorkflow` +
  `waitForApproval`) — is rejected on evidence: no host exists by design
  (PaymentsAgent hosting would aggregate all tenants' payment runs in one
  singleton's tracking table; OrchestratorAgent covers only chat starts,
  while routes/schedules also start runs), the tracking it adds duplicates
  the existing ledger/audit/D1 surfaces, and the standard approval payload
  has no `approverId` channel, which the #2550 audit contract requires.
  The submission seam's open question — the host signatures against the
  current SDK — is answered from the 0.23.0 typings in the survey; the
  shapes exist, the fit does not.
- Decisive context: the paid path is dark in production (monetization
  flag default OFF, no approved catalogue price, chat door refusing with
  `checkout_email_required` while the S10 email seam is uncomposed), so
  no adoption here could produce production-surface evidence today.

Disposition: payment domain recorded as **surveyed-no-adoption**. Revisit
triggers: (1) monetization activation (first approved price + flag on),
after which the hosting/approval assessment re-opens against live runs;
(2) an owner/CTO decision to give PaymentWorkflow an owning agent — the
precondition the class header already names. The S10 checkout-email gap
is noted as a composition gap belonging to its own track, not a
Think-adoption item.

Reused surfaces: the screener survey's method and capability taxonomy;
ADR 0004 W13; the #2496 single-catalog decision; the #2550 approval-audit
contract; the S18 paid-path golden tasks (`chat-paid-screen`,
`door-chat-paid-screen` + refusal pairs, `chat-budget-check`) as the
domain's standing proof surface.

## Agent

#CAIO-quns

---

*Survey ends. Recommendation and top risk are in the accompanying report.*
