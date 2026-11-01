# Agents SDK Conformance Matrix (G7)

Status: v1 (2026-10-29, #CAIO-quns) — Agent Mesh programme
(OpenAIMP/cfagent#2225), goal G7 round 1, landed via #2339.
Companion references: the S1 fleet registry (`src/agents/registry.ts`,
#2322), the mesh survey (§2, the evidence base at base `a71fca57`),
the owner's Agents SDK reference set (#2225 comment 6491152513 — the
yardstick this matrix is judged against), `doors-and-layers.md` in
this folder, and the pin suite
(`tests/mesh_conformance_s4_2339.test.ts`).

This document classifies every agent in the fleet against the Agents
SDK, per agent × per aspect, with **zero unclassified cells**. The
classification also lives as data in the pin suite; the suite fails
if this document and the data disagree, if the registry gains an
agent with no row here, or if a code fact a round-1 classification
rests on changes. Prose elsewhere (including the survey) loses to
this matrix on conformance questions; the matrix loses to the code,
and the pins exist to say so loudly when that happens.

## 1. How to read this matrix

**States.** Every cell is exactly one of:

- **IMPLEMENTED** — the capability is present, with the evidence
  basis named in the cell (a file/line fact or an existing pin
  suite). Where the mechanism deliberately diverges from the SDK
  surface the reference set names, the cell still reads IMPLEMENTED
  and the divergence is stated in the cell — a deliberate divergence
  is classified explicitly, never left unclassified and never
  silently passed off as the SDK mechanism (the reference set's
  rule for the `runWorkflow()` tracking cell, applied fleet-wide).
- **NOT-APPLICABLE** — the aspect does not apply to this agent, with
  the reason in the cell. N/A is a classification, not an omission.
- **GAP** — the capability is absent or unproven, with the
  programme slice that owns closing it named in the cell and in the
  GAP register (§4). Where no slice exists yet, the owner is
  recorded as the programme backlog — an honest unowned gap, not a
  hidden one.

**Aspects.** G7's two sets. Runtime aspects: `identity` (durable
identity — a durable, explicit acting identity: instance naming plus
identity source, no synthetic fallback), `state` (durable state
persistence), `connections` (connection-oriented surfaces —
WebSocket or protocol sessions — terminating on the instance; plain
DO stub RPC is recorded under `routing`, not here), `scheduling`
(scheduled work the agent owns, by whatever mechanism), `recovery`
(eviction/resume behavior). Agent-class aspects: `sdk-state` (the
SDK State API — `setState`/`this.state`), `sessions` (the agent
session store: the port's flat ActorSessionStore and, for
turn-capable agents, Think's tree session), `routing` (bindings,
names, and doors by which the class is reached), `websockets` (the
Agent WebSocket lifecycle), `sdk-scheduling` (the SDK scheduler —
`this.schedule`/`this.scheduleEvery`), `fibers` (durable execution
via the SDK/Think fiber primitive — `runFiber`/`startFiber`/`stash`),
`skills` (Agent Skills — `SKILL.md` packs loaded on demand through
the harness: Think's `getSkills()` sources and the
`activate_skill`/`read_skill_resource` tools; added by S14 (#2417)
from the owner's Agents SDK Skills addition, #2225 comment
6517280689).

**Roster.** Exactly the S1 registry roster, in registry order: the
12 PortThink agents, plus SessionStore (a plain Durable Object) and
OptionsScannerMCP (an McpAgent) — the two non-Agent entries are
classified too, with the Agent-class aspects marked NOT-APPLICABLE
where the aspect is defined only for Agent subclasses. The roster
has already outgrown the survey: AiSearchAgent (#2223), TickerAgent
(#2230), and SandboxAgent (#2253) landed after the survey base, and
S3 (#2327) changed the identity facts for ResearchAgent,
OrchestratorAgent, and PaymentsAgent after it. Cells state
current-main facts, not survey facts; §7 lists the corrections.

**What the pins prove.** Round-1 pins cover the `identity`, `state`,
`routing`, and `sessions` aspects, plus fleet facts underpinning the
other aspects (lifecycle-hook census, scheduler-call census, fiber
primitive absence). The pins are *static source evidence*: they prove
a guard exists, a fallback literal is present or absent, a hook or
binding is wired. They are not runtime proof. Where a behavioral
suite already pins runtime behavior — S3's identity suite for the
research/orchestrator/payments identity cells — the matrix cites
that suite and the pin here protects the citation. Eviction/resume
*behavior* is proven nowhere in the fleet today; that is why the
recovery column reads as it does.

## 2. Deliberate divergences (classified, fleet-wide)

- **SDK State API (`sdk-state`).** No agent uses `setState`. Durable
  state is held through the actor port's state facet
  (`createCfActorState` over `ctx.storage`,
  `src/actors/cfAgentsAdapter.ts:29-40`) and `ctx.storage` directly.
  This is the fleet's settled posture (ADR 0005's port discipline),
  classified IMPLEMENTED for stateful PortThink agents with the
  divergence named, and pinned: a `this.setState` appearing in any
  agent source fails the suite until the cell is re-classified.
- **Workflow run tracking.** `runWorkflow()` auto-tracks runs in the
  agent's own database; this repo deliberately tracks workflow runs
  in D1 projection rows + instance status instead (ADR 0003 M10).
  Workflows are not matrix rows (the registry records them
  separately); the divergence is recorded here because the reference
  set names it as a G7 classification, and G6's pins (S12) judge the
  D1-tracked posture on its own evidence.
- **Dual session stores.** For turn-capable agents, Think's tree
  session (branching/compaction/FTS) and the port's flat
  ActorSessionStore are separate stores in the same DO, and a turn
  writes to both (`src/actors/thinkAdapter.ts:69-75`). Sessions
  cells classify the pair, not either store alone.

## 3. Summary counts

| Aspect | IMPLEMENTED | NOT-APPLICABLE | GAP |
|---|---|---|---|
| `identity` | 12 | 2 | 0 |
| `state` | 10 | 4 | 0 |
| `connections` | 3 | 11 | 0 |
| `scheduling` | 3 | 11 | 0 |
| `recovery` | 3 | 9 | 2 |
| `sdk-state` | 7 | 7 | 0 |
| `sessions` | 3 | 10 | 1 |
| `routing` | 14 | 0 | 0 |
| `websockets` | 2 | 12 | 0 |
| `sdk-scheduling` | 2 | 12 | 0 |
| `fibers` | 0 | 2 | 12 |
| `skills` | 1 | 2 | 11 |
| Total | 60 | 82 | 26 |

168 cells (14 roster entries × 12 aspects), zero unclassified. The
two honest headlines: **recovery has its first IMPLEMENTED cells** —
S12 (#2409) proved OrchestratorAgent's queued-job recovery and
TradingAgent's workflow-mediated recovery with behavioral pins
(instance replacement + step-journal replay at the flow seam; not
live workerd eviction), and S13 (#2412) closed SlackAgent's
recovery cell the same way (instance replacement over the same
durable store; the replacement incarnation honors the executed
draft), while two recovery GAPs remain (ResearchAgent and
ScreenerAgent re-dispositioned to the programme backlog by #2409
with the evidence boundary named in their cells) — and **fibers
is a GAP for every PortThink agent**, judged against the real SDK
primitive. **Skills, added by S14 (#2417), was a GAP for every
PortThink agent at classification** — classified before any
adoption, per the owner's Agents SDK Skills addition (#2225
comment 6517280689) — **and is IMPLEMENTED for OrchestratorAgent
since #2705** (owner direction 2026-11-01): that class overrides
`getSkills()` to serve one in-repo code-manifest pack, with the
conformance evidence recorded in its cell; the other 11 PortThink
agents remain GAP, and the two non-Agent entries are
NOT-APPLICABLE because no harness exists for the aspect to apply
to.
**Identity closed its last GAP in S16 (#2426)**: SlackAgent
gained its registry identity record and its per-agent mesh
credential, and the column's three IMPLEMENTED-cell residuals
(ScreenerAgent's tenant literals, ScheduledAgent's audit actor,
OrchestratorAgent's sessionKey attribution) were dispositioned —
see §4 and the cells.

## 4. GAP register

| Agent | Aspect | Owning slice |
|---|---|---|
| ResearchAgent | `recovery` | Programme backlog (re-dispositioned by #2409 — no resumable record exists to pin; closing needs a design decision) |
| TradingAgent | `sessions` | Programme backlog (re-dispositioned by #2375 — S9 landed the door caller, not a turn) |
| ScreenerAgent | `recovery` | Programme backlog (workflow layer proven by #2409; agent-level resume of an interrupted screen unowned) |
| All 12 PortThink agents | `fibers` | Programme backlog (no slice yet) |
| 11 PortThink agents (all but OrchestratorAgent) | `skills` | Programme backlog (owner addition, #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced) |

Residuals recorded inside IMPLEMENTED cells (not GAPs, but tracked):
OrchestratorAgent's `sessionKey()` chat-turn partition (restated by
S16 (#2426): the opaque DO id does partition duty, and two-part
attribution landed on the A2A door — reworking chat-turn row
attribution itself is a session-scoping change, not an identity
gap); AiSearchAgent's unthreaded session login for turn-tool/RPC
callers (#2246 follow-up). Retired by S16 (#2426): ScreenerAgent's
two `tenantId: "default"` literals (the run owner's login is
threaded) and ScheduledAgent's `actor: "system"` literal (the
threaded operator login, or the named `SCHEDULED_AGENT_AUDIT_ACTOR`,
is recorded) — dispositions in their cells.

## 5. Per-agent matrix

### OrchestratorAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Per-login instances: server.ts resolves SEARCH_AGENT.idFromName(userLogin) (src/server.ts:364). Fixed names (shared_orchestrator, system_webhook_receiver) are addresses, never identities (src/security/serviceIdentity.ts); the legacy address default_trader survives only as the migration source + deny guard (#2681); unattended work acts under getServiceUserLogin (serviceIdentity.ts:45), fail-closed when unconfigured. S3 (#2327) retired the research-stub default; behavioral pins in tests/mesh_identity_sweep_s3_2327.test.ts. Residual: chat-turn mas_* rows still partition by sessionKey() (the opaque DO id string) — an address doing partition duty. S16 (#2426) landed two-part attribution on the A2A door: the edge-authenticated caller rides into handleA2A and is recorded on the payments path, and mas payment rows carry proposer/agent + authorizer/principal DIDs, so sessionKey is no longer the sole attribution on any mesh door. Reworking chat-turn row attribution itself is a session-scoping change, not an identity gap. |
| `state` | IMPLEMENTED | Instance-local durable state: ctx.storage KV plus the SQLite mas_* tables (mas_messages/mas_events/mas_memory/mas_transactions) in the instance's own storage. |
| `connections` | IMPLEMENTED | The fleet's chat surface: routeAgentRequest (src/server.ts:488) with session gates, reached by the client's useAgent; the class also serves DO fetch forwards (its onRequest and mounted routes). |
| `scheduling` | IMPLEMENTED | Heavy self-scheduling for per-login machinery: the port schedule facets delegate to this.schedule/this.scheduleEvery (orchestrator.ts:448-495), ScheduledTasksService runs on the instance, and worker-cron forwards (research tick, sweeps) land here. |
| `recovery` | IMPLEMENTED | onStart (:703) runs real recovery mechanisms — queued async-job recovery, legacy schedule reconciliation, stale-task sweep arming — wired and pinned as source facts by tests/orchestrator_class_inventory.test.ts. S12 (#2409) added the behavioral proof for the load-bearing mechanism: tests/mesh_g6_workflow_conformance_2409.test.ts drives recoverQueuedAsyncJobs from a FRESH context over the same durable store (instance replacement at the module seam, node:sqlite) — each queued job is re-armed exactly once with the idempotent schedule identity, a deferred job keeps its remaining delay (C3 #1277), terminal jobs are untouched, and a second recovery pass re-arms identically (recovery is itself replay-safe); the same suite exercises C3's stageChain retry (retryAsyncJob) across the replacement — retryOf + stage/chain identity carried, the original stays failed, a double retry is refused. Residual: the simulation is instance replacement at the module seam over the surviving store, not live workerd eviction; legacy schedule reconciliation and stale-task sweep arming remain source-fact pinned only. |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | IMPLEMENTED | Dual store (src/actors/thinkAdapter.ts:69-75): the port's flat ActorSessionStore transcript and Think's tree session are separate stores in the same DO, and a turn writes to both; mas_messages is the durable SQL message log on top. |
| `routing` | IMPLEMENTED | Bindings SEARCH_AGENT + ORCHESTRATOR_AGENT (registry-pinned against wrangler.jsonc); routeAgentRequest name search-agent (the class rename is S2, owner-sequenced behind #2326); A2A surfaces orchestrator/search/tasks/memory plus dispatch-only nlq (registry MESH_SURFACES). The class's handleA2A wiring to dispatchOrchestratorA2A was restored by #2421 (Agent Mesh S15) after #2178 removed it — the dispatch module had survived uncalled and every POST to the five surfaces 500'd at the edge; the wiring is source-pinned in tests/mesh_every_door_s15_2421.test.ts. |
| `websockets` | IMPLEMENTED | The SDK base WebSocket lifecycle behind routeAgentRequest, with onBeforeConnect/onBeforeRequest session gates in server.ts; the class defines no onConnect override (fleet pin) — the SDK's hibernation-aware handling is the conformance posture. |
| `sdk-scheduling` | IMPLEMENTED | this.schedule / this.scheduleEvery through the port schedule facets (orchestrator.ts:448-495). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | IMPLEMENTED | Adopted by #2705 (owner direction 2026-11-01, executing #2460's adopt-as-packaging recommendation): OrchestratorAgent overrides getSkills() — a thin delegation to src/agents/orchestrator/skillPacks.ts — serving ONE in-repo code-manifest source (the SDK's skills.manifest factory) with ONE pack, chat-screening-doors (the chat screening doors' playbook, #2488/#2581); Think re-lists the source before every turn and its catalog block lists the pack. Conformance evidence: tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own loadSkillCatalog and createSkillTools (the exact modules and functions Think's turn assembly runs) — with the source the tool set is exactly activate_skill + read_skill_resource and both tools are executed against the pack; with no sources the catalog and the tool set are empty. Residual: a live workerd model turn is unobserved: the repo's Node harness stubs @cloudflare/think and its runTurn refuses (#2003), so the evidence boundary is the model invocation itself — the model's production choice to activate the pack is the follow-up observation, not a claim here. run_skill_script stays absent: no skill script runner is configured anywhere in the fleet. |

### ResearchAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Identity arrives per request (ResearchRunRequest.userLogin). Post-S3, explicitResearchLogin (research-agent.ts:89) refuses a missing, blank, or retired-literal login in runResearch (:496) and runDiscovery (:594); evaluateRun/refreshIdeaQuotes resolve from the caller or the run record's recorded owner and decline when neither exists. Behavioral pins: tests/mesh_identity_sweep_s3_2327.test.ts. |
| `state` | IMPLEMENTED | Instance-local: ctx.storage KV (research:latest, research:history) plus SQLite via ctx.storage.sql; report PDFs via the report blob store. |
| `connections` | NOT-APPLICABLE | No connection surface terminates on this class: no client connects and it defines no onConnect. Work arrives by DO stub RPC and agent-as-a-tool dispatch, recorded under routing. |
| `scheduling` | NOT-APPLICABLE | No scheduling role of its own: its daily run is fired by the worker cron through the orchestrator's scheduled-tick route (identity-gated post-S3), and the file contains no schedule calls. |
| `recovery` | GAP | No onStart; reads are read-through from storage (getLatest returns null honestly), so eviction loses nothing durable — but an interrupted run leaves no resumable record. S12 (#2409) disposition: the cell STAYS a GAP — no workflow runs this agent's work and there is no resumable record to pin against; closing it needs a design decision (a resumable run record), not a conformance pin. Owner: programme backlog (re-dispositioned by #2409). |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | IMPLEMENTED | Turn-capable: portHooks are set in the constructor (:194) as identity pass-throughs of its own getModel/getSystemPrompt/getTools. Turns are driven remotely by the orchestrator (runAgentTool dispatch); the transcript lives in its own instance's port session store. Non-chat: no user-facing session continuity. |
| `routing` | IMPLEMENTED | Binding RESEARCH_AGENT; stub callers are the orchestrator and server.ts; A2A surface research (registry). |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | Turn-capable via portHooks; its turns are driven remotely by the orchestrator. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### TradingAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Name-derived acting identity: instanceUserLogin() (trading-agent.ts:1042) inverts tradingAgentName (:1254); the workflow door refuses a payload without userLogin (trading-trade-workflow.ts) and decideTradeApproval requires an authorizer DID. The fleet's fail-closed precedent (#1185/#291) that G8/G14 generalize from. |
| `state` | IMPLEMENTED | ctx.storage KV facade plus SQLite ORM over ctx.storage.sql in-instance; config resolved per call from env. |
| `connections` | NOT-APPLICABLE | No client connects and no connection surface exists; reachable via A2A dispatch and via stub RPC — since #2349 the orchestrator's chat turn is a production stub caller through the G1 door (proposals + reads, src/agents/orchestrator/meshDoors.ts), and since #2375 also through the approval door's workflow operations (start/decide). |
| `scheduling` | NOT-APPLICABLE | None in the agent: its durable timing lives in TradingTradeWorkflow's 24h waitForEvent, not in any schedule of its own. |
| `recovery` | IMPLEMENTED | No onStart; the recovery story is the workflow's, and S12 (#2409) pinned it against the REAL agent (tests/mesh_g6_workflow_conformance_2409.test.ts): a proposal drafts into the agent's own storage through the door; the TradingTradeWorkflow approval wait survives instance replacement (abandoned-wait model — the incarnation is discarded parked, the decision is journaled, a fresh incarnation's wait returns it) and the resumed incarnation settles through the agent's executeApprovedOrder exactly once; a commit-window replay of the settle step (execution landed, step memo lost) is refused by the shared settle core's claim-then-execute against the already-executed draft — one execution, an honest errored terminal state read back through the status door. Residual: eviction is modeled at the flow/step seam (journaling step fake: instance restart + step-journal replay), not live workerd eviction; the settle refusal's error surface is genericized by the core's error classification. |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | GAP | The mechanism is wired: portHooks are set lazily via tradingTurnHooks(). #2375 (S9/G4) made the chat turn the first production caller of this class's door surface — proposal → approval-workflow start → decision → settle — but that path is typed RPC from the orchestrator's turn and drives no turn ON this class, so no transcript has ever accumulated and claiming IMPLEMENTED would overclaim; NOT-APPLICABLE is barred because the hooks are set (the portHooks coherence pin). Re-dispositioned by #2375: the GAP stays; conversion needs a slice that drives a real turn on this class. |
| `routing` | IMPLEMENTED | Binding TRADING_AGENT; A2A surface trading — handleA2A at :1236 dispatching to dispatchTradingA2A, pinned by tests/trading_agent.test.ts. The orchestrator's G1 chat door (#2349, src/agents/orchestrator/meshDoors.ts) is the first production stub caller: proposals and reads, addressed per-user via tradingAgentName. Since #2375 (S9/G4) the door also carries the approval door's workflow operations — startTradeApproval starts TradingTradeWorkflow, decideTradeApproval delivers the decision with the authorizer derived server-side — while executeApprovedOrder stays workflow-called only (the settle step), never door-called. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | Its turn mechanism is wired (portHooks set lazily via tradingTurnHooks()), so a turn surface exists for the hook to serve. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### PaymentsAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Callers must name themselves: budgetCheck requires an explicit agentId and fails closed without one (payments-agent.ts, post-S3 — "budget check requires an explicit agentId"); processPaidRequest likewise requires agentId. Recorded spend carries two-part attribution in the ledger (payments-agent:<agentId>). S16 (#2426) authenticated the second part: A2A callers are verified by the payments surface's per-agent mesh credential at the edge, and the edge-authenticated caller is recorded beside the agentId in the payments_agent.recorded audit payload — asserted + authenticated, not asserted alone. Behavioral pins: tests/mesh_identity_sweep_s3_2327.test.ts and tests/mesh_identity_s16_2426.test.ts. |
| `state` | IMPLEMENTED | Derived-state posture: live state is computed per call from the orchestrator-owned payments ledger (mas_transactions via src/payments/ledger.ts). Its own ctx.storage holds only the retired legacy blob (payments/budgetGuard keys), read solely by migrateLegacyLedger. |
| `connections` | NOT-APPLICABLE | RPC-only actor: portHooks deliberately unset, no turn, no WebSocket surface in practice. |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Nothing instance-local to recover: every read derives from the ledger of record, so eviction is a non-event; the legacy migration is explicit and idempotent, never auto-invoked. |
| `sdk-state` | NOT-APPLICABLE | No agent-managed state through either API: live state is ledger-derived, and the only ctx.storage content is the retired legacy blob. |
| `sessions` | NOT-APPLICABLE | None by design: portHooks deliberately unset (class header), no transcript exists. |
| `routing` | IMPLEMENTED | Binding PAYMENTS_AGENT; production stub callers are ScheduledAgent, the orchestrator budget paths, and the G1 chat door (#2341: budgetCheck + the read side via src/agents/orchestrator/meshDoors.ts); A2A surface payments (registry). |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | No turn runs on this class (portHooks deliberately unset), so there is no live surface for skills tools today; the class is a Think subclass and inherits the hook — GAP, not NOT-APPLICABLE, on the fibers precedent: the capability is available to the class and unadopted. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### ScreenerAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Recorded-owner identity: userLogin() returns the owner recorded at first run (OWNER_STORAGE_KEY, screener-agent.ts:407-436), else the login in a screener:-prefixed instance name, else the service identity for instance "default" only — otherwise it throws ("ScreenerAgent has no owner identity recorded for this instance"). Name resolution also fails closed (src/agents/screenerAgentName.ts:28-38). Residual: S16 (#2426) retired the tenantId literal this cell recorded: both goal-gather paths (the gather run context and the enrichment) thread the run owner's login as tenantId — the owner is guaranteed present, since userLogin() throws without one (count pinned: zero "default" literals remain, both sites thread userLogin). Transition note: goal-gather captures written before S16 sit under the retired "default" partition and are not visible to reads keyed by the owner's login; captures are run-scoped reproducible provider snapshots, not records of account. |
| `state` | IMPLEMENTED | Instance-local ctx.storage plus SQLite: the task ledger, run history, latest results, and provider config tables. |
| `connections` | NOT-APPLICABLE | RPC-only in practice; no client, no connection surface. |
| `scheduling` | NOT-APPLICABLE | None of its own; fired by the orchestrator, server routes, ScheduledAgent goal chains, and workflow shards. |
| `recovery` | GAP | Runs are recorded in its task ledger and a concurrent-run lock reports the first run's age — an honest in-progress state, not a resume. S12 (#2409) proved the WORKFLOW layer above the agent (tests/mesh_g6_workflow_conformance_2409.test.ts: shard + parent eviction/resume, canonical-store convergence under replay, honest qualified partials) and the ledger suite pins the agent's records (tests/screener-task-ledger.test.ts: dedupe, lifecycle, stale sweep) — but the agent itself restarts an interrupted screen rather than resuming it, and no eviction/resume pin covers the agent class, so the cell stays GAP for the agent-level claim. Owner: programme backlog (workflow layer proven by #2409; agent-level resume unowned). |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | NOT-APPLICABLE | portHooks unset; no turn path, no transcript. |
| `routing` | IMPLEMENTED | Binding SCREENER_AGENT; A2A surface screener (registry); stub callers: orchestrator, the screener workflow's shard runner, server routes. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | No turn path (portHooks unset), so there is no live surface for skills tools today; the class is a Think subclass and inherits the hook — GAP, not NOT-APPLICABLE, on the fibers precedent: the capability is available to the class and unadopted. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### ScheduledAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Singleton instance "default"; goals carry their owner login in the goal records and fired work acts as the goal owner. Post-S3 its budget checks name the spend bucket explicitly (AGENTIC_SPEND_AGENT_ID, scheduled-agent.ts:329 and the synthesized-schedule path). Residual: S16 (#2426) retired the "system" audit actor this cell recorded: the reconciliation audit row in reconcileChainScheduleProjection carries the operator login the admin-gated route threads in, or SCHEDULED_AGENT_AUDIT_ACTOR ("scheduled-agent") when no actor is supplied — the agent's own named identity for its maintenance act (count pinned: zero "system" literals remain). |
| `state` | IMPLEMENTED | All instance-local ctx.storage: the goals key (seeded with DEFAULT_SCHEDULES on first read, :224-225), tick history, and synthesized schedules. |
| `connections` | NOT-APPLICABLE | No turn path and no port hooks by design (class header); reachable via stub RPC from server.ts and, since #2341, from the orchestrator's chat turn through the G1 door (src/agents/orchestrator/meshDoors.ts). |
| `scheduling` | IMPLEMENTED | It IS the user-visible goal catalogue (survey §4 ruling): the worker cron calls server.ts scheduled(), which invokes onCron() on the singleton; each due goal is budget-gated through PaymentsAgent before firing. The mechanism is the worker cron, deliberately not the SDK scheduler. |
| `recovery` | NOT-APPLICABLE | No in-flight work to resume: each tick re-reads durable goal state from ctx.storage, and fired work is tracked as jobs/chains by the orchestrator. The virgin-instance seeding hazard is an addressing hazard, recorded under routing. |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | NOT-APPLICABLE | None by design; it holds goal state, not conversations. |
| `routing` | IMPLEMENTED | Binding SCHEDULED_AGENT; singleton ('default') addressing from server.ts and the orchestrator's G1 chat door (#2341); A2A surface scheduled (registry), whose resolution pins the "default" instance — dispatch to any other instance name would seed pristine default goals. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | Deliberately never the SDK scheduler (class header: driven by onCron(), "never via the SDK scheduler"); the scheduling it owns is recorded under runtime scheduling. |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | No turn path and no port hooks by design, so there is no live surface for skills tools today; the class is a Think subclass and inherits the hook — GAP, not NOT-APPLICABLE, on the fibers precedent: the capability is available to the class and unadopted. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### ReportAssetAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | Identity is carried in the request (AssetRequest.userLogin), never derived from the instance name; the name helper maps the service identity to instance "default" and users to assets:<login> (reportAssetAgentName). Caller-asserted within capability RPC — attribution is exactly as trustworthy as the caller (survey §2.7). |
| `state` | IMPLEMENTED | Asset bytes via reportBlobStore (imported at report-asset-agent.ts:26): R2 (REPORTS_BUCKET) when bound, DO storage otherwise. |
| `connections` | NOT-APPLICABLE | RPC-only; no hooks, no client, no connection surface. |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Assets live in R2/DO storage outside instance memory and reads are per-call, so eviction loses nothing; generateAsset returns null on failure instead of throwing, and callers translate that into an honest error. |
| `sdk-state` | IMPLEMENTED | Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin: zero this.setState in agent sources). |
| `sessions` | NOT-APPLICABLE | No sessions: an RPC-only asset store with no turn path, so no transcript exists. |
| `routing` | IMPLEMENTED | Binding REPORT_ASSET_AGENT; A2A surface report-asset (registry — the survey-era hyphen concern is resolved on current main); stub callers: ScreenerAgent, the report pipeline helpers, and the orchestrator's G1 chat door (#2349: list/get via src/agents/orchestrator/meshDoors.ts, per-user assets:<login> addressing). |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | RPC-only with no turn path, so there is no live surface for skills tools today; the class is a Think subclass and inherits the hook — GAP, not NOT-APPLICABLE, on the fibers precedent: the capability is available to the class and unadopted. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### BrowserAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | NOT-APPLICABLE | Stateless: every method delegates to ETradeBrowserService built from env only; any instance name behaves identically and the class acts as nobody — there is no acting identity to make durable. |
| `state` | NOT-APPLICABLE | No state: zero ctx.storage use anywhere in the class (pinned). |
| `connections` | NOT-APPLICABLE | No production connection terminates on the class: production use is in-process construction borrowing the caller's ctx (src/agents/routes/tradingIntegrations.ts); its onRequest (:133) is exercised only that way. |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Stateless by construction (zero ctx.storage use in the class), so an eviction has nothing to recover. |
| `sdk-state` | NOT-APPLICABLE | No agent state to manage through any API. |
| `sessions` | NOT-APPLICABLE | portHooks deliberately unset (class header): no chat behavior was ever configured, so no session store is exercised. |
| `routing` | IMPLEMENTED | Binding BROWSER_AGENT; A2A surface browser (dispatch module src/agents/browserA2aDispatch.ts); production reachability is the in-process construction recorded under connections, and since #2351 the orchestrator's G1 chat door (src/agents/orchestrator/meshDoors.ts) is a production stub caller addressed to the fixed instance "browser": snap/capture/scrape with results verbatim. The survey §2.8 webhookUrl call is decided in #2351: the door never accepts or forwards a caller-supplied webhookUrl — delivery targets are env configuration only, the #2223 A2A precedent. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | portHooks deliberately unset — no chat behavior was ever configured, so there is no live surface for skills tools today; the class is a Think subclass and inherits the hook — GAP, not NOT-APPLICABLE, on the fibers precedent: the capability is available to the class and unadopted. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### SlackAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | S13 (#2412) retired the synthetic fallback this cell cited: sessionKey() throws when ctx.id is absent instead of returning the retired master literal, and getSlackService no longer re-asserts it (absence pinned below; behavioral pin in tests/mesh_channels_s13_2412.test.ts). S16 (#2426) closed the G14 remainder: the class holds a registry identity record (MESH_IDENTITIES in src/agents/registry.ts — DID did:agent:openaimp:slack, identity source, attribution shape) and its A2A surface carries a per-agent mesh credential (A2A_TOKEN_SLACK, verified timing-safely at the edge; the shared token is its transitional fallback). Channel ingress keeps its own gate — the app-level Slack signing secret — which is the channel's credential, recorded as such in the registry's channel and identity records. Pins: tests/mesh_identity_s16_2426.test.ts. |
| `state` | IMPLEMENTED | SQLite via getOrm() over this.ctx.storage.sql — schema ensured by the store's designated initializer classes, not this class (the #2345 R-7 composition pin: this file deliberately carries no initializeSchema); the S13 suite (#2412) exercises the boot/ORM paths over a fresh store through the converged ingress. The class is instantiated in production via its A2A door and the G1 chat door (see routing). |
| `connections` | NOT-APPLICABLE | No connection surface of its own: its signature-gated onRequest ingress delegates Slack payloads to the shared channel handler (src/agents/routes/tradingIntegrations.ts) — since S13 (#2412) it is the same implementation the production server.ts forwarders terminate in on OrchestratorAgent instances named slack_<teamId>, not a parallel one (registry channel posture FORWARDER). |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | IMPLEMENTED | S13 (#2412) exercised the boot/ORM paths with a behavioral pin (tests/mesh_channels_s13_2412.test.ts): a previewed draft in the instance store is executed by one SlackAgent incarnation through the converged ingress, and a fresh incarnation over the SAME store honors the recorded outcome — a second approval is answered by the shared engine's already-executed refusal and the broker placement runs exactly once. The class holds no in-flight work of its own between requests: every request rebuilds its service from env + durable storage, so instance replacement loses nothing. Residual: The simulation is instance replacement over the same durable store in the node:sqlite harness, not live workerd eviction (the S12 residual, fleet-wide). |
| `sdk-state` | IMPLEMENTED | State goes through ctx.storage.sql directly (getOrm, slackAgent.ts:89-90) — the same ctx.storage posture as the fleet; the SDK setState API is unused (fleet pin). |
| `sessions` | NOT-APPLICABLE | No chat transcript; its sessionKey-keyed service state is not an agent session store. |
| `routing` | IMPLEMENTED | Binding SLACK_AGENT exists (migration v10, #2215 — the class header's no-binding claim is stale, survey §6.4); A2A surface slack (registry); production stub callers: the A2A dispatcher (#2223) and, since #2351, the orchestrator's G1 chat door (src/agents/orchestrator/meshDoors.ts) addressed to the fixed instance "slack", serving only the two outbound helpers (approval ticket + transaction snap). Production ingress terminates on OrchestratorAgent instances, but since S13 (#2412) both hosts run the one shared channel handler (see connections). |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | No chat transcript and no turn runs on this class, so there is no live surface for skills tools today; the class is a Think subclass and inherits the hook — GAP, not NOT-APPLICABLE, on the fibers precedent: the capability is available to the class and unadopted. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### AiSearchAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | The agent fronts a shared search instance and holds no identity of its own; the identity discipline lives in the runner: report-type results are served only to their owner's login and are withheld when the search carries no login or a mismatched one (src/agents/aiSearchPaths.ts, the #2246 report login discipline). Residual: session login is not yet threaded into the turn-tool/RPC callers (aiSearchPaths.ts:168-172), so those callers get report results withheld — fail-safe, with the threading follow-up recorded under #2246. |
| `state` | NOT-APPLICABLE | No ctx.storage use in the class (pinned); the three-path runner (namespace binding, instance MCP, REST) is stateless per call over env configuration. |
| `connections` | NOT-APPLICABLE | No connection terminates on the class; its MCP path is outbound consumption of the instance's endpoint via RemoteMcpClient, a client relationship recorded under routing. |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Stateless per call over env configuration, so an eviction has nothing to recover. |
| `sdk-state` | NOT-APPLICABLE | No agent state to manage through any API. |
| `sessions` | IMPLEMENTED | Turn-capable: portHooks are set in the constructor (aiSearchAgent.ts:86-99) mirroring ResearchAgent's — the namespace search is a model turn tool as well as a direct method (the agents/tools/ai-search pattern from the reference set), exposed through the MCP door as ai_search_agent_search (#2250). |
| `routing` | IMPLEMENTED | Binding AI_SEARCH_AGENT (migration v12, #2223); A2A surface aisearch (registry). The ai_search_namespaces binding is dashboard-issued and not declared in wrangler.jsonc, so the primary path is config-gated and the agent degrades honestly to its MCP and REST paths (registry note). |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | Turn-capable via portHooks — the namespace search is already a model turn tool as well as a direct method. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### TickerAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | A single shared instance, "ticker" (TICKER_INSTANCE_NAME, ticker-agent.ts:109), addressed directly by server.ts (idFromName(TICKER_INSTANCE_NAME), src/server.ts:3113). No per-user identity by design: the tape is public, with no auth and no audit (the #2230 posture recorded in the class header). |
| `state` | NOT-APPLICABLE | No durable agent state: subscriptions live in per-connection state and quotes in an in-memory cache refreshed on demand; zero ctx.storage use in the class (pinned). |
| `connections` | IMPLEMENTED | The public quotes WebSocket (/api/market/quotes/ws plus aliases): server.ts forwards the upgrade request to the shared instance's stub, which drives onConnect. Deliberately NOT routeAgentRequest — its onBeforeConnect would 401 the public tape (class header; src/server.ts:3107-3113). |
| `scheduling` | IMPLEMENTED | The tick cadence is a durable SDK schedule that follows listener presence (#2443): armed on first connect, cancelled on last disconnect, reconciled on start (armed with listeners present, cancelled with none — which retires schedules a pre-fix build armed). scheduleEvery is idempotent, so re-arming never duplicates; cadence from TICKER_PUSH_INTERVAL_S (default TICKER_PUSH_INTERVAL_SECONDS). |
| `recovery` | NOT-APPLICABLE | Nothing durable to recover: the tick schedule is reconciled on every wake (armed with listeners, cancelled without), per-connection state is restored by the SDK across hibernation, and the quote cache is refresh-on-demand. |
| `sdk-state` | NOT-APPLICABLE | The Agent state API is unused. The Connection.setState calls (ticker-agent.ts:207+) are per-connection state — the SDK's connection-state mechanism, recorded under websockets — not agent state. |
| `sessions` | NOT-APPLICABLE | portHooks never set and no turn ever runs (class header); there is no transcript. |
| `routing` | IMPLEMENTED | Binding TICKER_AGENT (migration v11, #2230); direct stub addressing from server.ts; not routed through routeAgentRequest and no A2A surface (registry) — both deliberate, recorded in the class header. |
| `websockets` | IMPLEMENTED | The fleet's one real WebSocket lifecycle implementation: onConnect reads header carriers into per-connection state and arms the schedule, onMessage handles subscribe/unsubscribe/ping, onClose cancels on last disconnect (excluding the closing connection, which the SDK still counts during onClose); protocol messages are disabled (shouldSendProtocolMessages returns false) because clients are plain WebSockets, not useAgent clients. |
| `sdk-scheduling` | IMPLEMENTED | this.scheduleEvery in onConnect/onStart-reconcile and this.cancelSchedule in onClose/onStart-reconcile/pushTicks (ticker-agent.ts, #2443). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | portHooks never set and no turn ever runs (class header), so there is no live surface for skills tools today; the class is a Think subclass and inherits the hook — GAP, not NOT-APPLICABLE, on the fibers precedent: the capability is available to the class and unadopted. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### SandboxAgent

| Aspect | State | Evidence |
|---|---|---|
| `identity` | NOT-APPLICABLE | No acting identity: the class delegates to ETradeSandboxService constructed from env only, and adds no identity of its own. |
| `state` | NOT-APPLICABLE | No ctx.storage use in the class (pinned); the service is constructed with no container backend and holds no per-instance durable state. |
| `connections` | NOT-APPLICABLE | Its doors are the domain methods, the onRequest surface (:130), and — since #2421 — the A2A door (handleA2A → src/agents/sandboxA2aDispatch.ts); production call-site wiring through the agent is a recorded follow-up — the MCP run_sandbox_command still constructs the service directly (class header). |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Stateless; run results are honest non-executions (executed:false, #121) until an owner binds a container backend — there is no in-flight work to resume. |
| `sdk-state` | NOT-APPLICABLE | No agent state to manage through any API. |
| `sessions` | NOT-APPLICABLE | portHooks deliberately unset and no chat behavior defined (class header); no session store is exercised. |
| `routing` | IMPLEMENTED | Binding SANDBOX_AGENT (migration v13, #2253); the onRequest surface mirrors BrowserAgent. A2A surface sandbox since #2421 (Agent Mesh S15): card + resolution + dispatch module, census-pinned in tests/mesh_every_door_s15_2421.test.ts. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin: onConnect exists only in TickerAgent). |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin: such calls exist only in OrchestratorAgent and TickerAgent). |
| `fibers` | GAP | No agent uses the SDK/Think fiber primitive (fleet pin: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Owner: programme backlog (no slice yet). |
| `skills` | GAP | portHooks deliberately unset and no chat behavior defined, so there is no live surface for skills tools today; the class is a Think subclass and inherits the hook — GAP, not NOT-APPLICABLE, on the fibers precedent: the capability is available to the class and unadopted. Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin in the S4 suite) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted. Owner: programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced). |

### SessionStore

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | This class is the fleet's identity substrate: the store holding app sessions and E*TRADE tokens (etrade:token:<env>:<login>) that every agent's identity story ultimately rests on (survey §2.11). |
| `state` | IMPLEMENTED | A kv_store SQLite table (ns/key/value/expires_at) created in its constructor over ctx.storage.sql (sessionStore.ts:134+). |
| `connections` | NOT-APPLICABLE | A fetch op protocol only; no connection surface. |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Not an agent: per-call fetch operations over durable SQLite storage; no in-flight work to resume. |
| `sdk-state` | NOT-APPLICABLE | Not an Agents SDK Agent subclass (extends plain DurableObject); the Agent-class State aspect does not apply. |
| `sessions` | NOT-APPLICABLE | It stores the fleet's sessions; it holds none of its own. |
| `routing` | IMPLEMENTED | Binding SESSION_STORE (migration v6); reached by internal stub fetch only. |
| `websockets` | NOT-APPLICABLE | No WebSocket surface: its only door is the fetch op protocol. |
| `sdk-scheduling` | NOT-APPLICABLE | Not an Agents SDK Agent, so the SDK scheduler aspect does not apply. |
| `fibers` | NOT-APPLICABLE | Not an Agent class; the Fibers aspect does not apply. |
| `skills` | NOT-APPLICABLE | Not an Agents SDK Agent subclass (extends plain DurableObject): the Skills aspect is defined for Think/Agent harnesses — there is no getSkills hook to override and no model turn for skills tools to serve. |

### OptionsScannerMCP

| Aspect | State | Evidence |
|---|---|---|
| `identity` | IMPLEMENTED | The caller's x402 payer wallet, verified by the facilitator — the fleet's only externally credentialed surface (survey §2.10). No DID, no service-identity use; attribution is the payment receipt. |
| `state` | IMPLEMENTED | McpAgent protocol session state over ctx.storage; the one paid tool (screen_options) is stateless per call, executing in-process. |
| `connections` | IMPLEMENTED | MCP over HTTP/WebSocket via McpAgent.serve, addressed by an affinity id at /mcp/scanner (src/server.ts:2808-2814). |
| `scheduling` | NOT-APPLICABLE | No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row. |
| `recovery` | NOT-APPLICABLE | Stateless calls; protocol sessions belong to the MCP layer. |
| `sdk-state` | NOT-APPLICABLE | An McpAgent, not an Agents SDK Agent; the SDK State aspect does not apply. |
| `sessions` | NOT-APPLICABLE | Its sessions are MCP protocol sessions (recorded under connections and state), not the Agent-class session store. |
| `routing` | IMPLEMENTED | Binding OPTIONS_SCANNER_MCP (migration v2), served at /mcp/scanner. Registered for completeness; out of mesh scope per #2225 (G3 leaves this class untouched). |
| `websockets` | NOT-APPLICABLE | MCP transport, not the Agent WebSocket lifecycle. |
| `sdk-scheduling` | NOT-APPLICABLE | No SDK scheduler use: this surface has no scheduler role. |
| `fibers` | NOT-APPLICABLE | Not an Agent class; the Fibers aspect does not apply. |
| `skills` | NOT-APPLICABLE | An McpAgent server: it serves tools to other harnesses rather than consuming a harness tool set, and Think's getSkills adapter does not apply to it. The class is also out of mesh scope per #2225. |

## 6. Coverage: what round 1 pins, and what later rounds add

Round 1 (this document + `tests/mesh_conformance_s4_2339.test.ts`)
pins the classification itself (roster, doc agreement) and the code
facts under the `identity`, `state`, `routing`, and `sessions`
aspects, plus the fleet censuses (lifecycle hooks, scheduler calls,
fiber primitives, `this.setState`) that the remaining aspects rest
on. Later rounds should add, in owning-slice order:

- Behavioral eviction/resume pins per agent and workflow — S12
  (#2409) landed them for the three workflows and dispositioned
  the four S12-owned recovery cells: OrchestratorAgent and
  TradingAgent converted to IMPLEMENTED; ResearchAgent and
  ScreenerAgent stay GAP, re-dispositioned to the programme
  backlog with the evidence boundary named in their cells.
- A first-turn proof for TradingAgent — re-dispositioned by #2375:
  S9 landed the first production door caller (chat trade via the
  approval door + TradingTradeWorkflow) but drives no turn on the
  class, so its sessions GAP stays in the programme backlog until a
  slice drives a real turn on it.
- SlackAgent's identity remainder — landed by S16 (#2426). S13
  (#2412) landed the first-instantiation work: ingress converged
  onto the shared channel handler, the synthetic session fallback
  retired fail-closed, and the recovery GAP converted (see its
  row); S16 closed the identity GAP with the registry identity
  record and the surface's per-agent mesh credential.
- A fibers adoption decision (SDK primitive behind the actor port,
  or an explicit programme decision to keep the GAP) — currently
  unowned in the backlog; the matrix keeps it visible until a slice
  claims it.
- The `skills` aspect (S14, #2417): classified from source facts —
  no `getSkills` override anywhere in `src/` (fleet pin in the S4
  suite), and the adapter's presence in the pinned Think pinned
  against the package's shipped type declarations in
  `tests/mesh_tool_registry_s14_2417.test.ts` (the Node harness
  stubs the package, #2003, so no runtime pin can load the real
  hook). Adoption, if the owner sequences it, re-classifies these
  cells in that slice's PR; the registry's `agent-skills` family
  carries the matching tool-inventory record. — The owner
  sequenced it: #2705 (2026-11-01) adopted OrchestratorAgent and
  re-classified its cell and the family record in that slice's
  PR, and the conformance evidence runs the real `agents/skills`
  modules under Node (they load without workerd); a live workerd
  turn remains the named residue.

## 7. Corrections to the survey §2 (recorded so the survey is not cited stale)

- The fleet is 14 registry entries, not the survey's 11 sections:
  AiSearchAgent, TickerAgent, and SandboxAgent landed after the
  survey base (S1, #2322).
- "Zero `onConnect` in `src/`" and "only OrchestratorAgent defines
  `onStart`" were true at the survey base and are false now:
  TickerAgent defines `onStart`, `onConnect`, and `onMessage`
  overrides and uses per-connection `Connection.setState` (the
  connection-state mechanism — not the Agent state API, which
  remains unused fleet-wide).
- A2A dispatch, which the survey recorded as failing for every name
  but trading, is built out (#2223): 13 cards and 14 resolutions,
  with per-agent dispatch modules; the registry pins the current
  shape and the routing cells state it.
- The Browser Rendering binding, absent at the survey base, is
  declared in wrangler.jsonc now (#2253); BrowserAgent's cells are
  unchanged because its production path is still in-process
  construction.
- `durableFibers` moved from `src/agents/` to
  `src/services/durableFibers.ts`; its durability posture is
  unchanged (checkpoints written, never read).
- MAS tools are `createMAS` in `src/agents/mas.ts` (the survey's
  `masTools.ts` references are stale); this does not change any cell.
- Identity facts for ResearchAgent, OrchestratorAgent, and
  PaymentsAgent are post-S3 (#2327): the `"default"` fallback family
  the survey catalogued on those paths is retired and fail-closed,
  and ScheduledAgent's budget calls now name their bucket
  explicitly. Of the remaining family members the survey found,
  S13 (#2412) dispositioned two: SlackAgent's synthetic master
  fallback is retired fail-closed (its identity cell keeps the
  G14 remainder for S16), and the NLQ webhook's fallback login is
  named in code and in the channel registry as the channel's
  service identity (an HMAC-authenticated system caller, not a
  user login). The rest — ScreenerAgent's `tenantId` literals,
  ScheduledAgent's `actor: "system"`, the DID `"anonymous"`
  derivations — were recorded in this matrix as GAPs or residuals
  with their owning slice (S16), not silently dropped, and S16
  (#2426) dispositioned all three: the tenant literals now thread
  the run owner's login; the audit actor is the threaded operator
  login or the named `SCHEDULED_AGENT_AUDIT_ACTOR`; and a DID is
  never derived from an empty login (both derivations fail
  closed). Attestation is likewise keyed-or-labelled since S16:
  a real HMAC-SHA256 with a verify function when
  `DID_ATTESTATION_KEY` is bound, an explicitly unkeyed content
  label (`UnkeyedContentLabel2026`) otherwise — no surface calls
  the unkeyed value a proof.

**S17 note (#2428, G13a — unified traces).** The matrix's
subject is SDK conformance per agent × aspect; the trace spine
is a programme-level (G13) substrate, not an SDK aspect, so no
cells change and the totals stand (168 cells: 58 IMPLEMENTED /
82 NOT-APPLICABLE / 28 GAP). What S17 adds is the evidence
layer S18's golden tasks and S19's proposal pipeline consume:
one W3C trace id carried from ingress through turn, doors,
jobs, workflow starts/steps, projections, the A2A edge, and
the payments ledger, recorded in `agent_mesh_trace_hops`
(migration 0023) and assembled by `agentdb.trace.get`. The
spine's carried hops and its four named breaks (Trading and
Payment workflow step spans, route-originated workflow
starts, direct channel-ingress paths) are recorded in the
registry's `MESH_TRACE_SPINE`, not in this matrix.
