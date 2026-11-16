# #2494 Think adoption — trading domain survey

SURVEY ONLY. No code changed, no issue/PR created. Base: `Qunsultant/cfagent` main
`ad6b4abfb5a0c8fb301d791f51243769a6d34339` (2026-11-01, fresh shallow clone
`~/workspace/cfagent-think-survey-trade`). SDK surface read from the installed
packages (agents 0.32.0, @cloudflare/think 0.23.0 — matches `package.json`
pins), typings at `node_modules/@cloudflare/think/dist/index-DDnny6kt.d.ts`
(cited below as `think.d.ts` by line, per the earlier surveys' convention) and
`node_modules/agents/dist/agent-routing-vVMA7m8Y.d.ts` (cited as
`agent-routing.d.ts`).

Method and honesty standard follow the screener survey
(`think-adoption-screener-survey.md`, slice #2693) and the payment survey
(`think-adoption-payment-survey.md`, surveyed-no-adoption). Starting point is
the same 2026-10-30 Think harness audit (#2225 comment 6519999987): Actions /
client tools / messengers / configureChannels / getScheduledTasks / Think
sub-agents NOT USED, lifecycle hooks PARTIAL, workflows MIXED,
configure()/getConfig() essentially unused. This survey covers the trading
domain only, third in the owner's screener → payment → trading order.

**Outcome up front: no adoption slice is recommended for this domain.** The
domain's one agent-shaped Think capability that matters — agent-hosted
workflows — is *already adopted* (§2.2), which inverts the payment survey's
central rejection. Everything else is forbidden by doctrine (§2.1), a genuine
no-fit, or — for `waitForApproval` (§2.3) — a contract downgrade against the
incumbent. The recorded TradingAgent sessions GAP is addressed in §2.11: it
is neither closed by #2566 nor a Think-adoption item. §4 drafts the #2494
comment recording surveyed-no-adoption.

## 1. Inventory — trading domain on current main

| Component | Think surface touched today | Hand-rolled equivalents of Think-native capabilities |
|---|---|---|
| `TradingAgent` (`src/agents/trading-agent.ts`, 1,375 lines) | `PortThink` base (#1954, fleet shape (a)). **Full turn surface defined**: `getModel` / `getSystemPrompt` / `getTools` (a `ToolSet` generated from `TRADING_SERVICE_REGISTRY`), an actor-port hooks object (`tradingTurnHooks`), `runThinkTurn` through the port. Workflow doors on the base are used in production: `startTradeApproval` calls `this.runWorkflow(TRADE_WORKFLOW_BINDING, params)` and `decideTradeApproval` calls `this.sendWorkflowEvent(...)` (§2.2). | The turn surface has **no production caller** — `runThinkTurn` has zero call sites outside the class (grep-verified); every production door consumes the class as deterministic RPC (`executeService`), A2A (`handleA2A`), or the approval door, never as a turn. Config is a hand-rolled env-resolved module (`src/config/tradingAgentConfig.ts`: enabled providers / default provider / enabled services, env-overridable, resolved per call) — fleet-uniform by design, not per-instance (§2.9). Instance identity is name-derived: `trading:<login>`, bare `trading` for the configured service identity (#1185). The class schedules nothing (its own header: no scheduler callbacks, by design). |
| `TradingTradeWorkflow` (`src/agents/trading-trade-workflow.ts`) | `ThinkWorkflow` base (ADR 0004 W13), agent type `any` (recorded: TradingAgent cannot satisfy the agent-type constraint, #1738; the workflow settles through the agent's approval door over the DO binding, not an agent-class method call). Started **only** by `TradingAgent.startTradeApproval` via the SDK `runWorkflow` (registry workflow record: starters = `["TradingAgent (SDK runWorkflow, after the approval door)"]`). | The flow programs against a hand-rolled minimal step port `TradeApprovalStep { waitForEvent, do }` (same pattern as the screener/payment flows). Flow: `step.waitForEvent("await-approval", { type: "approval", timeout: 24h })` → `step.do("settle-trade")` → settle through the **order owner's** TradingAgent approval door (`executeApprovedOrder` → `settleTradingOrder`), because the draft lives in that instance's store (#2375 — a workflow-side ORM-less settle could not see real drafts). No decision within 24h ⇒ `expired`, settles nothing. No prompt step (forbidden, §2.1). |
| The approval door + settle/execute path | None directly (RPC methods on the agent). | `executeApprovedOrder` is deliberately **not** a registry service: no Think tool and no A2A operation reaches it. It validates the decision triple (orderId, authorizerDid, decision) fail-closed, writes a blocking hash-chained audit (`trade.approval_decision`, #2178) *before* settling, then `settleTradingOrder` re-validates through the platform's `executeOrder` (claim-then-execute; the platform refuses if the live draft no longer matches the approval's frozen `expectedTerms`, #1393 invariant 5), then a post-settle `trade.order_executed` audit whose failure surfaces as a throw naming the possibly-unrecorded execution. Anonymous authorizers are refused at every layer. The proposal services (`stock_trading` / `options_trading`) are preview-only on every surface. |
| Chat door (mesh S9/G4, #2375) | None directly; commands reach the orchestrator's turn via the MCP catalog + #2496 discovery. | `src/agents/orchestrator/meshDoors.ts` typed doors → catalog commands (`propose_stock_trade`, `propose_options_trade`, reads, `start_trade_approval`, `decide_trade_approval`, `get_trade_approval_status`): acting-login carrier required (fail-closed), addressed to the acting user's own instance, authorizer DID derived server-side from the acting login; the synchronous settle is never a door operation. Status reads go to the **workflow binding's instance status** — the door header records that trading writes no D1 projection, so the binding status *is* the status surface (§2.2). |
| Channel ingresses (chat / email / Slack / voice / NLQ webhook) | None. | All terminate at the shared channel handler (`src/agents/routes/tradingIntegrations.ts`) hosted on per-login OrchestratorAgent routes + `src/server.ts` forwarders — the S13/#1262 convergence; **not** on TradingAgent, and must not be re-hosted (§2.6). Identity: #1262 tiers — Slack connect-code mapping to a session login at tier trade (unlinked ⇒ explicit refusal), DKIM/SPF-gated email with signed approval links (bare APPROVE refused), session-checked voice. Trade execution from channels runs through the shared approval engine. |
| HTTP routes + approvals UI | None. | Session-authenticated trading routes reach `executeService` per login (registry census, http-routes cell). `src/client/TradingApprovalsQueue.tsx` is the human approval surface over the same engine. |
| Scheduled trading jobs | None. | **None exist, by design**: no trade executes unattended — every execution requires an explicit human decision event, so there is no scheduled-trading job for any scheduler capability to arm. The only trading-adjacent scheduled job is E*TRADE token auto-renewal (an OrchestratorAgent callback — screener-survey territory, not this domain's). |
| Cross-domain saga trade leg (`src/workflows/sagaTradeLeg.ts`, `CrossDomainSagaWorkflow`) | None. | Preview-only proposal via `stub.executeService` + a `TradingTradeWorkflow` child, per-order approval preserved (#2041, CDO lane). Deterministic composition; no Think delta applies. |
| Golden tasks already covering this domain (`src/services/meshGoldenTasks.ts`) | — | `chat-trade-approval` (door → workflow → exactly one broker execution on approval; facts `workflowRuns: 1, brokerExecutions: 1`) and `chat-trade-identity-refusal` (no acting identity ⇒ refused before the door; zero runs, zero executions). These already prove the production chat-trade path end to end at the door surface. |

Providers: E*TRADE is the only full brokerage connector behind the
provider-neutral `TradingPlatformRegistry` seam. Public.com order execution
does not exist and is parked by owner direction — nothing in this survey
proposes building it; provider onboarding is a registry + config act, not a
Think-adoption act.

## 2. Capability-by-capability assessment

Cross-cutting MUST-NOT-CHANGE list for this domain (applies to every row):
determinism — proposal/settle/execute paths are deterministic service and
step logic plus human approval waits; no prompt step and no model turn may
enter execution or settlement; approval binding — a decision binds to the
exact previewed draft via the frozen `expectedTerms` check at the platform,
with a named authorizer DID, and rejection/timeout settle nothing; identity
discipline — trades execute under the explicitly resolved acting login
(#1185: no default identity anywhere in the chain), channel tiers per #1262;
one-execution semantics — claim-then-execute at the platform, exactly one
broker execution per approved order (pinned by `chat-trade-approval`).

### 2.1 Workflows — `step.prompt()` — FORBIDDEN, permanently

Same verdict and reasoning as the payment survey §2.1, recorded there so this
survey would not re-derive it: the only Think-specific step capability is the
one the §8 determinism doctrine excludes from trading execution absolutely.
No model proposes terms that execute; proposals are broker previews of
caller-specified orders, and the human decision — not a model — is the gate.
Risk if done anyway: critical.

### 2.2 Agent-hosted workflows (`runWorkflow` / `sendWorkflowEvent` / tracking) — ALREADY ADOPTED; no delta

SDK offer (agents SDK, inherited by Think): `Agent.runWorkflow(name, params,
options?)` (`agent-routing.d.ts:5785`) injects the agent-internal params,
tracks the instance in the host's `cf_agents_workflows` table queryable via
`getWorkflows()` (`agent-routing.d.ts:5971`), and `sendWorkflowEvent`
(`agent-routing.d.ts:5807`) delivers events to a running instance.

This is the point where the trading domain differs from payment: **the
hosted shape the payment survey rejected is already the trading shape, in
production.** `TradingAgent.startTradeApproval` starts
`TradingTradeWorkflow` via `this.runWorkflow`; `decideTradeApproval`
delivers the decision via `this.sendWorkflowEvent`; the registry's workflow
record names exactly this starter. The preconditions that made hosting a
rejection for payment are absent here: a host exists and is the natural one
(the per-login TradingAgent instance that holds the draft store the settle
must read, #2375), and *all* starts funnel through it — routes and channels
reach the workflow via the agent or the shared approval engine, not via five
independent binding call sites.

The one unused piece is the tracking read side: nothing calls
`getWorkflows()`. Status is read from the workflow binding's instance status
at the door, a recorded design ("trading writes no D1 projection… the
workflow's own status IS the status surface"). Considered and rejected as a
slice: the tracking table would be a second status surface for the same
runs, with no unmet consumer — the approvals queue and the door read what
they need today. Verdict: **adopted where it fits; the remainder is not a
gap.** Revisit only if a consumer appears that the binding status cannot
serve (e.g. a per-instance run listing the queue cannot otherwise build).

### 2.3 `waitForApproval` / `approveWorkflow` — REJECTED (weaker than the incumbent)

SDK offer (`agent-routing.d.ts:3079–3081`, `:5814`): `AgentWorkflow.waitForApproval(step, …)`
waits for an approval delivered through the host agent; the standard payload
is `ApprovalEventPayload { approved, reason?, metadata? }` — **no
approverId field** (the payment survey §2.3 established this from the same
typings), and rejection surfaces as a thrown `WorkflowRejectedError`
reported to the agent as an error.

Why the incumbent is better here, on trading-specific evidence:

1. **The decision payload is the contract.** The flow's hand-rolled
   `waitForEvent` carries `TradeApprovalDecision { decision, authorizerDid,
   reason?, expectedTerms? }` — the authorizer DID and the approval's frozen
   terms (#1393) ride *in the event, typed*, and the settle core refuses a
   missing authorizer and the platform refuses a terms mismatch. Under the
   SDK wrapper both would have to ride in untyped `metadata`, weakening the
   exact binding the MUST-NOT-CHANGE list protects.
2. **Rejection is a business outcome, not an error.** A rejected decision
   settles through the same door (the platform records the rejection);
   the wrapper models rejection as an exception + agent error report.
3. **Audit-before-delivery is hand-rolled around the incumbent.**
   `decideTradeApproval` writes the blocking #2178 audit *before*
   `sendWorkflowEvent` — an unaudited decision never takes effect. That
   discipline attaches to the delivery method the class already uses;
   re-plumbing delivery through an approval wrapper re-opens it for no
   return.

Verdict: rejected. Risk if done anyway: high (approval-contract change on
an execution path).

### 2.4 Actions (`getActions()` / `action()`) — NO FIT

SDK offer (think.d.ts:2452, 802–838): descriptors compiled into tools for
one agent's turn, with an approval policy. Two independent reasons, either
sufficient: (a) the single-catalog decision — trade commands' canonical
home is the MCP catalog, consumed via #2496 discovery (screener survey
§2.2; payment survey §2.4 answered the same way); (b) this domain's tool
surface is *already unified by generation* — Think-tool shape, A2A
operations, and RPC all generate from `TRADING_SERVICE_REGISTRY` + config
so the surfaces cannot drift (class header, #291). Actions would be a
fourth, hand-maintained surface — and TradingAgent runs no production
turns for them to compile into anyway (§2.7). The Action approval policy
is additionally the wrong approval: trade approval is the durable door +
workflow discipline, not a turn-level prompt. Verdict: no fit.

### 2.5 Client tools — NO FIT

SDK offer (think.d.ts:599–610, 1096–1099): tool schemas executed on the
connected client over the WebSocket chat protocol. Trading is server-side
broker work; approvals are collected through the approvals queue UI and
#1262 signed channel links over HTTP, not through a chat client's tool
execution, and executions must not depend on any client being connected —
decisions arrive up to 24h after the proposal, through whichever surface
the human uses. Verdict: not applicable; do not invent one.

### 2.6 Messengers / `configureChannels()` / `deliverNotice` — NO FIT

SDK offer (think.d.ts:2450–2463, 2540): inbound channel integrations routed
into an agent as turns, plus `deliverNotice` for no-turn notices routed to
the channel a turn came from. The domain's channel reality is settled
elsewhere: Slack/email/voice/NLQ ingress converged at the implementation
layer in #1262/S13 onto the shared handler hosted by OrchestratorAgent
routes and server forwarders, with the channel services in `src/trading/*`
and identity tiers the messenger layer does not model (connect-code trade
tier, DKIM/SPF gating, signed approval links). Re-hosting any of it on
TradingAgent as messenger turns would un-converge S13 and put model turns
on channel trade paths. Approval *notification* is likewise already owned:
the approvals queue, the Slack pre-trade approval ticket via the Slack
door, and signed email links — none of which has an originating TradingAgent
turn for `deliverNotice` to route back to. Verdict: wrong layer; rejected.

### 2.7 Think sub-agents / agent-as-tool — NO FIT (and the turn surface is the point)

SDK offer (think.d.ts:5516, 903–919): child-DO addressing and agent-tool
runs — which are chat turns, a model in the loop. TradingAgent is unusual
in the fleet: it *defines* the full turn apparatus (model, system prompt,
registry-generated tools, port hooks, `runThinkTurn`) — and no production
caller drives it. Every real consumer uses the deterministic surfaces
(RPC `executeService`, A2A, the approval door). Making the orchestrator
reach trading through an agent-tool run would insert a model turn into the
proposal path, duplicate the catalog door that already serves chat
(S9/G4), and buy nothing the RPC door lacks. The class's own design states
the discipline: services are door-blind — "a service cannot tell which door
it was called through" — and the execution path is shared. Verdict:
rejected; the RPC/A2A shape is the sanctioned one. The unused turn surface
itself is dispositioned in §2.11.

### 2.8 `getScheduledTasks()` — NO FIT

SDK offer (think.d.ts:2575, 924–975): code-declared tasks reconciled on
agent startup. TradingAgent declares no schedules and registers no
scheduler callbacks, by design (class header). There is no recurring
trading job to declare: unattended trade execution is exactly what the
approval discipline forbids, and inventing a scheduled trading task to
give this capability a home would invert the domain's safety posture.
The screener domain's result (#2693) belongs to that domain. Verdict: not
applicable.

### 2.9 `configure()` / `getConfig()` — NO FIT

SDK offer (think.d.ts:2338–2347): per-instance JSON config persisted in
the `think_config` table of one agent instance. The domain's config need
is real but the shape is wrong for it: `getTradingAgentConfig(env)` is
fleet-uniform operator configuration (enabled providers, default
provider, enabled services) with env overrides, resolved per call. Making
any of it per-instance-writable would let provider/service enablement
diverge per user instance — a new authority surface on a trading agent
(provider enablement is an operator decision; the CISO/config gates treat
it as such), and the one genuinely per-instance dimension, identity, is
already carried by the instance name, not by config. Verdict: no adoption
target in this domain today.

### 2.10 Lifecycle hooks — PARTIAL, no trading-domain delta

Think's turn hooks are defined on TradingAgent only as the actor-port
hooks object (`tradingTurnHooks`: identity facet — model/prompt/tools —
plus a no-op `onChatResponse`, the class never having had chat side
effects). Because no production caller drives a turn (§2.7), the hooks
never fire in production. The audit's "PARTIAL" remainder for this domain
is exactly the sessions question, dispositioned next — not a hooks slice.

### 2.11 The recorded TradingAgent sessions GAP — explicit disposition

What the GAP is, on code evidence: TradingAgent carries Think session
machinery it never exercises. Its #1954 class comment records that "the
flat port session and Think's tree session coexist (dual stores); tree
operations (branching, compaction, FTS) have no port equivalent and stay
outside the port" — i.e. the class maintains *two* session stores behind a
turn surface (`runThinkTurn` + port session) with **zero production turn
callers** (grep-verified on current main). Unlike OrchestratorAgent —
whose sessions are the product's chat transcripts — no TradingAgent
session has ever carried a production conversation, so session durability,
recovery, and re-attach for this class are unproven and, today, unusable:
there is nothing to recover because nothing runs.

Is it closed by #2566? **No.** #2566 (durable turn submissions) changed
exactly one class's turn driving: OrchestratorAgent's. Its module
(`src/agents/orchestrator/durableTurnSubmission.ts`) is extracted from
OrchestratorAgent, submits *the orchestrator's* chat turns through
`submitMessages`, and mirrors them into *the orchestrator's* port session.
It neither drives a TradingAgent turn nor touches TradingAgent's stores;
claiming it closes this GAP would be exactly the wiring-diagram-as-done
error the programme's production standard exists to catch.

Is it a Think-adoption item? **No — it is a disposition item.** Adoption
presupposes a turn caller to adopt *for*; none exists and none is proposed
by any programme item (the doors deliberately consume RPC). The honest
options are (a) record the turn surface as vestigial-by-design — kept for
fleet shape (a) uniformity (#1951) and available if a future owner
decision gives TradingAgent a real turn caller — or (b) that future
decision itself, at which point session durability for TradingAgent turns
becomes a real slice modelled on #2566. Either way the decision is an
owner/CTO disposition recorded on #2494, not buildable work in this
programme. This survey recommends (a), recorded in the §4 comment.

### 2.12 Already adopted / native (for the record)

- `ThinkWorkflow` base class (ADR 0004 W13) — adopted.
- Agent-hosted workflow start + event delivery (`runWorkflow` /
  `sendWorkflowEvent` from TradingAgent) — adopted, in production (§2.2);
  the only domain of the three where this is true.
- Durable waits and journaled steps — platform-native (`step.waitForEvent`,
  `step.do`), already the execution model; the 24h approval wait survives
  restarts and settles exactly once inside the journaled settle step.
- MCP catalog for trade commands + #2496 runtime discovery on the chat
  turn — adopted (S9/G4); golden tasks `chat-trade-approval` /
  `chat-trade-identity-refusal` are the standing proof surface.
- Durable turn submissions (#2566) — adopted for *orchestrator* chat
  turns; not applicable to TradingAgent (no turns) and not a trading
  execution mechanism (the workflow is the durable unit for trades).

## 3. Recommendation — surveyed, no adoption; revisit triggers

**No slice is recommended.** The trading domain's Think posture is:
workflow base adopted; agent-hosting adopted (uniquely among the three
domains); the one Think-specific step capability (`prompt`) doctrinally
forbidden; the SDK approval wrapper weaker than the incumbent
approval contract; Actions / client tools / messengers / sub-agents /
scheduled tasks / per-instance config each genuine no-fits against how
this domain is actually reached (RPC + A2A + catalog doors + converged
channel handler, per-login instances, fleet-uniform operator config, no
unattended execution). And unlike payment, unprovability is *not* among
the reasons: the trade path is live in production and its golden tasks
pass — there is simply no unused capability whose adoption would change
production behavior for the better.

Record the domain as **surveyed-no-adoption** on #2494 (draft comment in
§4), with three explicit revisit triggers:

1. **A turn caller for TradingAgent is ever approved** — if an owner/CTO
   decision gives TradingAgent real turns, §2.11 flips from disposition
   to work: session durability modelled on #2566 (submitMessages driving
   + port-session parity) becomes the first slice, and §2.4/§2.7 are
   re-evaluated against that caller.
2. **A tracking consumer appears** — a per-instance run listing or queue
   read model that the workflow binding's instance status cannot serve
   re-opens the `getWorkflows()` read side of §2.2 (the data is already
   being written by `runWorkflow`; only the read is unadopted).
3. **Provider expansion** — if Public.com is ever un-parked by the owner,
   it lands as a registry platform + config enablement (the #291 seam),
   not as a Think change; this survey should not be cited as either
   blocking or enabling it.

Explicitly NOT recommended as consolation work: driving a synthetic
TradingAgent turn "to exercise the sessions" (a caller invented to
justify machinery — the failure mode the screener survey's §2.5 verdict
names), `waitForApproval` migration for SDK-conformance's sake (§2.3:
a contract downgrade on an execution path), and any observe-only variant
(the production path is already observable through the golden tasks and
the audit chain; there is nothing dark to observe into existence).

With this survey, the #2494 Think-adoption assessment is complete for all
three domains: screener — one bounded slice (#2693, observe-only
`getScheduledTasks`); payment — surveyed-no-adoption; trading —
surveyed-no-adoption.

## 4. DRAFT comment for #2494 — DRAFT, not posted

---

**Trading domain Think-adoption survey — complete: surveyed, no adoption
(#2494, third domain after screener #2693 and payment)**

Survey: `think-adoption-trading-survey.md` in the programme files
(base main `ad6b4abf`, installed typings agents 0.32.0 / think 0.23.0 read
directly). Findings, briefly:

- The domain's shape: `TradingAgent` (PortThink, per-login instances,
  name-derived identity) exposes provider-neutral services generated from
  one registry across RPC / A2A / tool-shaped surfaces — all preview-only
  for orders; placement exists only behind the approval door
  (`executeApprovedOrder` → `settleTradingOrder`, blocking audit before
  and after, frozen-terms check at the platform). `TradingTradeWorkflow`
  (ThinkWorkflow, agent `any` per ADR 0004 W13) waits 24h for a decision
  event, then settles exactly once through the order owner's approval
  door (#2375). Chat reaches the full path through the S9/G4 door;
  channels run through the converged #1262/S13 handler; no scheduled
  trading exists, by design.
- The headline difference from payment: **agent-hosted workflows are
  already adopted here** — `startTradeApproval` uses the SDK
  `runWorkflow`, `decideTradeApproval` uses `sendWorkflowEvent`, all
  starts funnel through the per-login instance that holds the draft
  store. The tracking read side (`getWorkflows()`) is unused by recorded
  design — the door reads the workflow binding's status because trading
  writes no D1 projection — and has no unmet consumer.
- `step.prompt()` is doctrinally forbidden on execution paths (as
  payment). `waitForApproval` is rejected on evidence: its standard
  payload has no authorizer channel and no frozen-terms field — both are
  typed, load-bearing parts of the incumbent `TradeApprovalDecision` —
  and it models rejection as an error where this domain treats it as a
  settleable business outcome. Actions, client tools, messengers /
  `deliverNotice`, sub-agents, `getScheduledTasks()`, and
  `configure()`/`getConfig()` are each genuine no-fits (single catalog;
  converged channel layer; no unattended execution; fleet-uniform
  operator config) — per-capability evidence in the survey.
- The recorded **TradingAgent sessions GAP** is dispositioned, not
  adopted: the class carries dual session stores (flat port session +
  Think tree session, #1954) behind a turn surface with zero production
  callers, so its sessions are unexercised machinery. #2566 did **not**
  close it — #2566 made OrchestratorAgent's chat turns durable and
  touches no TradingAgent store. With no turn caller existing or
  proposed, the GAP is recorded as vestigial-by-design (kept for fleet
  shape (a) uniformity); it converts to real work — #2566-modelled
  session durability — only if an owner/CTO decision ever gives
  TradingAgent turns.

Disposition: trading domain recorded as **surveyed-no-adoption**.
Revisit triggers: (1) an approved turn caller for TradingAgent;
(2) a tracking consumer the binding status cannot serve; (3) provider
expansion remains a registry/config act (Public.com stays parked unless
the owner un-parks it) and is not a Think item. This completes the
three-domain Think-adoption assessment: screener slice #2693, payment
surveyed-no-adoption, trading surveyed-no-adoption.

Reused surfaces: the screener and payment surveys' method and capability
taxonomy (including payment §2.1's `step.prompt` verdict and §2.3's
approver-payload finding, applied rather than re-derived); ADR 0004 W13;
the #2496 single-catalog decision; the S9/G4 chat-trade golden tasks
(`chat-trade-approval`, `chat-trade-identity-refusal`) as the domain's
standing proof surface.

## Agent

#CAIO-quns

---

*Survey ends. Recommendation and top risk are in the accompanying report.*
