/**
 * Issue #2339 (Agent Mesh S4, programme #2225 G7) — Agents SDK
 * conformance matrix, round 1: the classification data and its pins.
 *
 * The matrix doc (docs/architecture/agentic/agents-sdk-conformance-matrix.md)
 * is the human-readable record; the MATRIX below is the same
 * classification as data, and this suite pins the two together and
 * against the code:
 *
 *   - Roster: the matrix covers exactly the S1 registry roster
 *     (src/agents/registry.ts MESH_AGENTS), in registry order. A new
 *     registry entry with no matrix row fails here.
 *   - Doc agreement: the doc's per-agent tables and its summary
 *     counts must equal the data. Edit one without the other and
 *     this suite fails.
 *   - Round-1 aspect pins (identity, state, routing, sessions):
 *     static source-evidence checks that the code facts each
 *     classification rests on still hold — including the facts that
 *     make the GAP cells gaps, so closing a gap forces a matrix
 *     update in the same PR (gitops §7 pin rule).
 *
 * What these pins prove, honestly labelled: they prove SOURCE FACTS
 * (a guard exists, a fallback literal is present/absent, a binding
 * or hook is wired). They are not runtime proof. Where a behavioral
 * suite already pins the runtime behavior — S3's identity suite
 * (tests/mesh_identity_sweep_s3_2327.test.ts) for the research /
 * orchestrator / payments identity cells — this suite pins the
 * citation, not a copy of the checks. Eviction/resume behavior
 * is proven where S12's pins land
 * (tests/mesh_g6_workflow_conformance_2409.test.ts): the
 * recovery cells for OrchestratorAgent and TradingAgent are
 * IMPLEMENTED on that evidence, while ResearchAgent and
 * ScreenerAgent remain GAPs — re-dispositioned to the programme
 * backlog by #2409 with the evidence boundary named in their
 * cells.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { MESH_AGENTS, MESH_SURFACES } from "../src/agents/registry";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const DOC_PATH = "docs/architecture/agentic/agents-sdk-conformance-matrix.md";
const S3_SUITE = "tests/mesh_identity_sweep_s3_2327.test.ts";

// ---------------------------------------------------------------------------
// Aspects — G7's two sets (#2225; yardstick: the owner's Agents SDK
// reference set, #2225 comment 6491152513), plus Skills, added by
// S14 (#2417) from the owner's Agents SDK Skills addition (#2225
// comment 6517280689).
// Runtime: durable identity, state, connections, scheduling, recovery.
// Agent-class: State (SDK API), Sessions, Routing, WebSockets,
// Scheduling (SDK API), Fibers, Skills.
// ---------------------------------------------------------------------------

const ASPECTS = [
  "identity",
  "state",
  "connections",
  "scheduling",
  "recovery",
  "sdk-state",
  "sessions",
  "routing",
  "websockets",
  "sdk-scheduling",
  "fibers",
  "skills",
] as const;
type Aspect = (typeof ASPECTS)[number];

type CellState = "IMPLEMENTED" | "NOT-APPLICABLE" | "GAP";

interface MatrixCell {
  state: CellState;
  /** The evidence basis: file/line facts or a named pin suite. */
  evidence: string;
  /** Required on GAP cells: the programme slice that owns closing it. */
  gapOwner?: string;
  /** A known partial gap inside an otherwise IMPLEMENTED cell. */
  residual?: string;
}

interface MatrixRow {
  className: string;
  cells: Record<Aspect, MatrixCell>;
}

const IMPL = (evidence: string, residual?: string): MatrixCell => ({
  state: "IMPLEMENTED",
  evidence,
  ...(residual ? { residual } : {}),
});
const NA = (evidence: string): MatrixCell => ({
  state: "NOT-APPLICABLE",
  evidence,
});
const GAP = (gapOwner: string, evidence: string): MatrixCell => ({
  state: "GAP",
  gapOwner,
  evidence,
});

/** The SDK State cell for agents whose durable state rides the port facet. */
const SDK_STATE_DIVERGENT = IMPL(
  "Deliberate divergence, classified explicitly per the reference set (#2225 comment 6491152513): durable state is held through the actor-port state facet (createCfActorState over ctx.storage, src/actors/cfAgentsAdapter.ts:29-40) and Think's own storage use; the SDK setState API is unused (fleet pin below: zero this.setState in agent sources).",
);

/** The Fibers cell for every PortThink agent (survey contradiction 1). */
const FIBERS_GAP = GAP(
  "programme backlog (no slice yet)",
  "No agent uses the SDK/Think fiber primitive (fleet pin below: no runFiber/startFiber in agent sources). The only fiber surface, src/services/durableFibers.ts, is home-grown and NOT durable: live records sit in an in-memory Map (activeFibers, :32), checkpoints are written but never read back, and the onFiberRecovered hook its header advertises (:9) exists nowhere else in src/. Judged against the real SDK primitive per the reference set, this row is a GAP, never an implemented cell.",
);

/**
 * The Skills cell for the unadopted PortThink agents (S14, #2417;
 * owner addition #2225 comment 6517280689). The per-agent note
 * states the class's turn posture; the shared core states the
 * fleet fact. The GAP-vs-NOT-APPLICABLE call, per cell: every
 * PortThink class is a Think subclass and inherits the hook, so
 * the capability is available to the class and unadopted — GAP on
 * the fibers precedent, even where no turn runs on the class
 * today. The two non-Agent roster entries are NOT-APPLICABLE (no
 * harness exists for the aspect to apply to). OrchestratorAgent
 * left this group in #2705 (owner direction 2026-11-01): its cell
 * is IMPLEMENTED, with the conformance evidence and its residue
 * recorded in the cell.
 */
const SKILLS_GAP_CORE =
  "Exactly one agent class overrides getSkills() — OrchestratorAgent, adopted by #2705 (fleet pin below) — so a skill catalog exists on that class only; this class does not override the hook, so no catalog exists here and Think's skills tools (activate_skill / read_skill_resource) never appear in its turns. The adapter is present in the pinned SDK: @cloudflare/think 0.23.0's shipped types expose Think.getSkills() returning SkillSource[] (workspace / R2 / code-manifest sources; the default returns none), and PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source. For the adopted class, the port-conformance question is answered at the SDK seam (tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own catalog loader and turn tool factory and executes both tools; a live workerd model turn remains unobserved — the repo's Node harness stubs @cloudflare/think, #2003). For this class the hook is unexercised because unadopted.";
const SKILLS_GAP = (turnNote: string): MatrixCell =>
  GAP(
    "programme backlog (owner addition #2225 comment 6517280689 — first slice #2705 adopted OrchestratorAgent under the owner's 2026-11-01 direction; the remaining classes are per-class follow-up slices, owner-sequenced)",
    `${turnNote} ${SKILLS_GAP_CORE}`,
  );
const SKILLS_NO_TURN_NOTE =
  "so there is no live surface for skills tools today; the class is a Think subclass and inherits the hook — GAP, not NOT-APPLICABLE, on the fibers precedent: the capability is available to the class and unadopted.";

// ---------------------------------------------------------------------------
// The classification. Roster order == registry order (pinned).
// Facts verified against current main at the S4 base; the mesh
// survey (§2, base a71fca57) is the starting evidence, corrected
// where the fleet has moved (S1's roster, S3's identity sweep,
// TickerAgent's lifecycle hooks).
// ---------------------------------------------------------------------------

const MATRIX: MatrixRow[] = [
  {
    className: "OrchestratorAgent",
    cells: {
      identity: IMPL(
        "Per-login instances: server.ts resolves SEARCH_AGENT.idFromName(userLogin) (src/server.ts:364). Fixed names (shared_orchestrator, system_webhook_receiver) are addresses, never identities (src/security/serviceIdentity.ts); the legacy address default_trader survives only as the migration source + deny guard (#2681); unattended work acts under getServiceUserLogin (serviceIdentity.ts:45), fail-closed when unconfigured. S3 (#2327) retired the research-stub default; behavioral pins in tests/mesh_identity_sweep_s3_2327.test.ts.",
        "Chat-turn mas_* rows still partition by sessionKey() (the opaque DO id string) — an address doing partition duty. S16 (#2426) landed two-part attribution on the A2A door: the edge-authenticated caller rides into handleA2A and is recorded on the payments path, and mas payment rows carry proposer/agent + authorizer/principal DIDs, so sessionKey is no longer the sole attribution on any mesh door. Reworking chat-turn row attribution itself is a session-scoping change, not an identity gap.",
      ),
      state: IMPL(
        "Instance-local durable state: ctx.storage KV plus the SQLite mas_* tables (mas_messages/mas_events/mas_memory/mas_transactions) in the instance's own storage.",
      ),
      connections: IMPL(
        "The fleet's chat surface: routeAgentRequest (src/server.ts:488) with session gates, reached by the client's useAgent; the class also serves DO fetch forwards (its onRequest and mounted routes).",
      ),
      scheduling: IMPL(
        "Heavy self-scheduling for per-login machinery: the port schedule facets delegate to this.schedule/this.scheduleEvery (orchestrator.ts:448-495), ScheduledTasksService runs on the instance, and worker-cron forwards (research tick, sweeps) land here.",
      ),
      recovery: IMPL(
        "onStart (:703) runs real recovery mechanisms — queued async-job recovery, legacy schedule reconciliation, stale-task sweep arming — wired and pinned as source facts by tests/orchestrator_class_inventory.test.ts. S12 (#2409) added the behavioral proof for the load-bearing mechanism: tests/mesh_g6_workflow_conformance_2409.test.ts drives recoverQueuedAsyncJobs from a FRESH context over the same durable store (instance replacement at the module seam, node:sqlite) — each queued job is re-armed exactly once with the idempotent schedule identity, a deferred job keeps its remaining delay (C3 #1277), terminal jobs are untouched, and a second recovery pass re-arms identically (recovery is itself replay-safe); the same suite exercises C3's stageChain retry (retryAsyncJob) across the replacement — retryOf + stage/chain identity carried, the original stays failed, a double retry is refused.",
        "Simulation scope: instance replacement at the module seam over the surviving store, not live workerd eviction. Legacy schedule reconciliation and stale-task sweep arming remain source-fact pinned only.",
      ),
      "sdk-state": SDK_STATE_DIVERGENT,
      sessions: IMPL(
        "Dual store (src/actors/thinkAdapter.ts:69-75): the port's flat ActorSessionStore transcript and Think's tree session are separate stores in the same DO, and a turn writes to both; mas_messages is the durable SQL message log on top.",
      ),
      routing: IMPL(
        "Bindings SEARCH_AGENT + ORCHESTRATOR_AGENT (registry-pinned against wrangler.jsonc); routeAgentRequest name search-agent (the class rename is S2, owner-sequenced behind #2326); A2A surfaces orchestrator/search/tasks/memory plus dispatch-only nlq (registry MESH_SURFACES).",
      ),
      websockets: IMPL(
        "The SDK base WebSocket lifecycle behind routeAgentRequest, with onBeforeConnect/onBeforeRequest session gates in server.ts; the class defines no onConnect override (fleet pin below) — the SDK's hibernation-aware handling is the conformance posture.",
      ),
      "sdk-scheduling": IMPL(
        "this.schedule / this.scheduleEvery through the port schedule facets (orchestrator.ts:448-495).",
      ),
      fibers: FIBERS_GAP,
      skills: IMPL(
        "Adopted by #2705 (owner direction 2026-11-01, executing #2460's adopt-as-packaging recommendation): OrchestratorAgent overrides getSkills() — a thin delegation to src/agents/orchestrator/skillPacks.ts — serving ONE in-repo code-manifest source (the SDK's skills.manifest factory) with ONE pack, chat-screening-doors (the chat screening doors' playbook, #2488/#2581); Think re-lists the source before every turn and its catalog block lists the pack. Conformance evidence: tests/agent_skills_enablement_s1_2705.test.ts drives the class's real getSkills() output through the SDK's own loadSkillCatalog and createSkillTools (the exact modules and functions Think's turn assembly runs) — with the source the tool set is exactly activate_skill + read_skill_resource and both tools are executed against the pack; with no sources the catalog and the tool set are empty.",
        "A live workerd model turn is unobserved: the repo's Node harness stubs @cloudflare/think and its runTurn refuses (#2003), so the evidence boundary is the model invocation itself — the model's production choice to activate the pack is the follow-up observation, not a claim here. run_skill_script stays absent: no skill script runner is configured anywhere in the fleet.",
      ),
    },
  },
  {
    className: "ResearchAgent",
    cells: {
      identity: IMPL(
        "Identity arrives per request (ResearchRunRequest.userLogin). Post-S3, explicitResearchLogin (research-agent.ts:89) refuses a missing, blank, or retired-literal login in runResearch (:496) and runDiscovery (:594); evaluateRun/refreshIdeaQuotes resolve from the caller or the run record's recorded owner and decline when neither exists. Behavioral pins: tests/mesh_identity_sweep_s3_2327.test.ts.",
      ),
      state: IMPL(
        "Instance-local: ctx.storage KV (research:latest, research:history) plus SQLite via ctx.storage.sql; report PDFs via the report blob store.",
      ),
      connections: NA(
        "No connection surface terminates on this class: no client connects and it defines no onConnect. Work arrives by DO stub RPC and agent-as-a-tool dispatch, recorded under routing.",
      ),
      scheduling: NA(
        "No scheduling role of its own: its daily run is fired by the worker cron through the orchestrator's scheduled-tick route (identity-gated post-S3), and the file contains no schedule calls.",
      ),
      recovery: GAP(
        "Programme backlog (re-dispositioned by #2409 — no resumable record exists to pin; closing needs a design decision)",
        "No onStart; reads are read-through from storage (getLatest returns null honestly), so eviction loses nothing durable — but an interrupted run leaves no resumable record. S12 (#2409) disposition: the cell STAYS a GAP — no workflow runs this agent's work and there is no resumable record to pin against; closing it needs a design decision (a resumable run record), not a conformance pin.",
      ),
      "sdk-state": SDK_STATE_DIVERGENT,
      sessions: IMPL(
        "Turn-capable: portHooks are set in the constructor (:194) as identity pass-throughs of its own getModel/getSystemPrompt/getTools. Turns are driven remotely by the orchestrator (runAgentTool dispatch); the transcript lives in its own instance's port session store. Non-chat: no user-facing session continuity.",
      ),
      routing: IMPL(
        "Binding RESEARCH_AGENT; stub callers are the orchestrator and server.ts; A2A surface research (registry).",
      ),
      websockets: NA("No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin below: onConnect exists only in TickerAgent)."),
      "sdk-scheduling": NA("No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin below: such calls exist only in OrchestratorAgent and TickerAgent)."),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP("Turn-capable via portHooks; its turns are driven remotely by the orchestrator."),
    },
  },
  {
    className: "TradingAgent",
    cells: {
      identity: IMPL(
        "Name-derived acting identity: instanceUserLogin() (trading-agent.ts:1042) inverts tradingAgentName (:1254); the workflow door refuses a payload without userLogin (trading-trade-workflow.ts) and decideTradeApproval requires an authorizer DID. The fleet's fail-closed precedent (#1185/#291) that G8/G14 generalize from.",
      ),
      state: IMPL(
        "ctx.storage KV facade plus SQLite ORM over ctx.storage.sql in-instance; config resolved per call from env.",
      ),
      connections: NA(
        "No client connects and no connection surface exists; reachable via A2A dispatch and via stub RPC — since #2349 the orchestrator's chat turn is a production stub caller through the G1 door (proposals + reads, src/agents/orchestrator/meshDoors.ts), and since #2375 also through the approval door's workflow operations (start/decide).",
      ),
      scheduling: NA(
        "None in the agent: its durable timing lives in TradingTradeWorkflow's 24h waitForEvent, not in any schedule of its own.",
      ),
      recovery: IMPL(
        "No onStart; the recovery story is the workflow's, and S12 (#2409) pinned it against the REAL agent (tests/mesh_g6_workflow_conformance_2409.test.ts): a proposal drafts into the agent's own storage through the door; the TradingTradeWorkflow approval wait survives instance replacement (abandoned-wait model — the incarnation is discarded parked, the decision is journaled, a fresh incarnation's wait returns it) and the resumed incarnation settles through the agent's executeApprovedOrder exactly once; a commit-window replay of the settle step (execution landed, step memo lost) is refused by the shared settle core's claim-then-execute against the already-executed draft — one execution, an honest errored terminal state read back through the status door.",
        "Simulation scope: eviction is modeled at the flow/step seam (journaling step fake: instance restart + step-journal replay), not live workerd eviction. The settle refusal's error surface is genericized by the core's error classification.",
      ),
      "sdk-state": SDK_STATE_DIVERGENT,
      sessions: GAP(
        "Programme backlog (re-dispositioned by #2375 — S9 landed the door caller, not a turn)",
        "The mechanism is wired: portHooks are set lazily via tradingTurnHooks(). #2375 (S9/G4) made the chat turn the first production caller of this class's door surface — proposal → approval-workflow start → decision → settle — but that path is typed RPC from the orchestrator's turn and drives no turn ON this class, so no transcript has ever accumulated and claiming IMPLEMENTED would overclaim; NOT-APPLICABLE is barred because the hooks are set (the portHooks coherence pin below). Re-dispositioned by #2375: the GAP stays; conversion needs a slice that drives a real turn on this class.",
      ),
      routing: IMPL(
        "Binding TRADING_AGENT; A2A surface trading — handleA2A at :1236 dispatching to dispatchTradingA2A, pinned by tests/trading_agent.test.ts. The orchestrator's G1 chat door (#2349, src/agents/orchestrator/meshDoors.ts) is the first production stub caller: proposals and reads, addressed per-user via tradingAgentName. Since #2375 (S9/G4) the door also carries the approval door's workflow operations — startTradeApproval starts TradingTradeWorkflow, decideTradeApproval delivers the decision with the authorizer derived server-side — while executeApprovedOrder stays workflow-called only (the settle step), never door-called.",
      ),
      websockets: NA("No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin below: onConnect exists only in TickerAgent)."),
      "sdk-scheduling": NA("No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin below: such calls exist only in OrchestratorAgent and TickerAgent)."),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP("Its turn mechanism is wired (portHooks set lazily via tradingTurnHooks()), so a turn surface exists for the hook to serve."),
    },
  },
  {
    className: "PaymentsAgent",
    cells: {
      identity: IMPL(
        "Callers must name themselves: budgetCheck requires an explicit agentId and fails closed without one (payments-agent.ts, post-S3 — 'budget check requires an explicit agentId'); processPaidRequest likewise requires agentId. Recorded spend carries two-part attribution in the ledger (payments-agent:<agentId>). S16 (#2426) authenticated the second part: A2A callers are verified by the payments surface's per-agent mesh credential at the edge, and the edge-authenticated caller is recorded beside the agentId in the payments_agent.recorded audit payload — asserted + authenticated, not asserted alone. Behavioral pins: tests/mesh_identity_sweep_s3_2327.test.ts and tests/mesh_identity_s16_2426.test.ts.",
      ),
      state: IMPL(
        "Derived-state posture: live state is computed per call from the orchestrator-owned payments ledger (mas_transactions via src/payments/ledger.ts). Its own ctx.storage holds only the retired legacy blob (payments/budgetGuard keys), read solely by migrateLegacyLedger.",
      ),
      connections: NA(
        "RPC-only actor: portHooks deliberately unset, no turn, no WebSocket surface in practice.",
      ),
      scheduling: NA("No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row."),
      recovery: NA(
        "Nothing instance-local to recover: every read derives from the ledger of record, so eviction is a non-event; the legacy migration is explicit and idempotent, never auto-invoked.",
      ),
      "sdk-state": NA(
        "No agent-managed state through either API: live state is ledger-derived, and the only ctx.storage content is the retired legacy blob.",
      ),
      sessions: NA(
        "None by design: portHooks deliberately unset (class header), no transcript exists.",
      ),
      routing: IMPL(
        "Binding PAYMENTS_AGENT; production stub callers are ScheduledAgent, the orchestrator budget paths, and the G1 chat door (#2341: budgetCheck + the read side via src/agents/orchestrator/meshDoors.ts); A2A surface payments (registry).",
      ),
      websockets: NA("No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin below: onConnect exists only in TickerAgent)."),
      "sdk-scheduling": NA("No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin below: such calls exist only in OrchestratorAgent and TickerAgent)."),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP(`No turn runs on this class (portHooks deliberately unset), ${SKILLS_NO_TURN_NOTE}`),
    },
  },
  {
    className: "ScreenerAgent",
    cells: {
      identity: IMPL(
        "Recorded-owner identity: userLogin() returns the owner recorded at first run (OWNER_STORAGE_KEY, screener-agent.ts:407-436), else the login in a screener:-prefixed instance name, else the service identity for instance 'default' only — otherwise it throws ('ScreenerAgent has no owner identity recorded for this instance'). Name resolution also fails closed (src/agents/screenerAgentName.ts:28-38).",
        "S16 (#2426) retired the tenantId literal this cell recorded: both goal-gather paths (the gather run context and the enrichment) thread the run owner's login as tenantId — the owner is guaranteed present, since userLogin() throws without one (count pinned below: zero 'default' literals remain, both sites thread userLogin). Transition note: goal-gather captures written before S16 sit under the retired 'default' partition and are not visible to reads keyed by the owner's login; captures are run-scoped reproducible provider snapshots, not records of account.",
      ),
      state: IMPL(
        "Instance-local ctx.storage plus SQLite: the task ledger, run history, latest results, and provider config tables.",
      ),
      connections: NA("RPC-only in practice; no client, no connection surface."),
      scheduling: NA(
        "None of its own; fired by the orchestrator, server routes, ScheduledAgent goal chains, and workflow shards.",
      ),
      recovery: GAP(
        "Programme backlog (workflow layer proven by #2409; agent-level resume of an interrupted screen unowned)",
        "Runs are recorded in its task ledger and a concurrent-run lock reports the first run's age — an honest in-progress state, not a resume. S12 (#2409) proved the WORKFLOW layer above the agent (tests/mesh_g6_workflow_conformance_2409.test.ts: shard + parent eviction/resume, canonical-store convergence under replay, honest qualified partials) and the ledger suite pins the agent's records (tests/screener-task-ledger.test.ts: dedupe, lifecycle, stale sweep) — but the agent itself restarts an interrupted screen rather than resuming it, and no eviction/resume pin covers the agent class, so the cell stays GAP for the agent-level claim.",
      ),
      "sdk-state": SDK_STATE_DIVERGENT,
      sessions: NA("portHooks unset; no turn path, no transcript."),
      routing: IMPL(
        "Binding SCREENER_AGENT; A2A surface screener (registry); stub callers: orchestrator, the screener workflow's shard runner, server routes.",
      ),
      websockets: NA("No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin below: onConnect exists only in TickerAgent)."),
      "sdk-scheduling": NA("No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin below: such calls exist only in OrchestratorAgent and TickerAgent)."),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP(`No turn path (portHooks unset), ${SKILLS_NO_TURN_NOTE}`),
    },
  },
  {
    className: "ScheduledAgent",
    cells: {
      identity: IMPL(
        "Singleton instance 'default'; goals carry their owner login in the goal records and fired work acts as the goal owner. Post-S3 its budget checks name the spend bucket explicitly (AGENTIC_SPEND_AGENT_ID, scheduled-agent.ts:329 and the synthesized-schedule path).",
        "S16 (#2426) retired the 'system' audit actor this cell recorded: the reconciliation audit row in reconcileChainScheduleProjection carries the operator login the admin-gated route threads in, or SCHEDULED_AGENT_AUDIT_ACTOR ('scheduled-agent') when no actor is supplied — the agent's own named identity for its maintenance act (count pinned below: zero 'system' literals remain).",
      ),
      state: IMPL(
        "All instance-local ctx.storage: the goals key (seeded with DEFAULT_SCHEDULES on first read, :224-225), tick history, and synthesized schedules.",
      ),
      connections: NA(
        "No turn path and no port hooks by design (class header); reachable via stub RPC from server.ts and, since #2341, from the orchestrator's chat turn through the G1 door (src/agents/orchestrator/meshDoors.ts).",
      ),
      scheduling: IMPL(
        "It IS the user-visible goal catalogue (survey §4 ruling): the worker cron calls server.ts scheduled(), which invokes onCron() on the singleton; each due goal is budget-gated through PaymentsAgent before firing. The mechanism is the worker cron, deliberately not the SDK scheduler.",
      ),
      recovery: NA(
        "No in-flight work to resume: each tick re-reads durable goal state from ctx.storage, and fired work is tracked as jobs/chains by the orchestrator. The virgin-instance seeding hazard is an addressing hazard, recorded under routing.",
      ),
      "sdk-state": SDK_STATE_DIVERGENT,
      sessions: NA("None by design; it holds goal state, not conversations."),
      routing: IMPL(
        "Binding SCHEDULED_AGENT; singleton ('default') addressing from server.ts and the orchestrator's G1 chat door (#2341); A2A surface scheduled (registry), whose resolution pins the 'default' instance — dispatch to any other instance name would seed pristine default goals.",
      ),
      websockets: NA("No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin below: onConnect exists only in TickerAgent)."),
      "sdk-scheduling": NA(
        "Deliberately never the SDK scheduler (class header: driven by onCron(), 'never via the SDK scheduler'); the scheduling it owns is recorded under runtime scheduling.",
      ),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP(`No turn path and no port hooks by design, ${SKILLS_NO_TURN_NOTE}`),
    },
  },
  {
    className: "ReportAssetAgent",
    cells: {
      identity: IMPL(
        "Identity is carried in the request (AssetRequest.userLogin), never derived from the instance name; the name helper maps the service identity to instance 'default' and users to assets:<login> (reportAssetAgentName). Caller-asserted within capability RPC — attribution is exactly as trustworthy as the caller (survey §2.7).",
      ),
      state: IMPL(
        "Asset bytes via reportBlobStore (imported at report-asset-agent.ts:26): R2 (REPORTS_BUCKET) when bound, DO storage otherwise.",
      ),
      connections: NA("RPC-only; no hooks, no client, no connection surface."),
      scheduling: NA("No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row."),
      recovery: NA(
        "Assets live in R2/DO storage outside instance memory and reads are per-call, so eviction loses nothing; generateAsset returns null on failure instead of throwing, and callers translate that into an honest error.",
      ),
      "sdk-state": SDK_STATE_DIVERGENT,
      sessions: NA("No sessions: an RPC-only asset store with no turn path, so no transcript exists."),
      routing: IMPL(
        "Binding REPORT_ASSET_AGENT; A2A surface report-asset (registry — the survey-era hyphen concern is resolved on current main); stub callers: ScreenerAgent, the report pipeline helpers, and the orchestrator's G1 chat door (#2349: list/get via src/agents/orchestrator/meshDoors.ts, per-user assets:<login> addressing).",
      ),
      websockets: NA("No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin below: onConnect exists only in TickerAgent)."),
      "sdk-scheduling": NA("No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin below: such calls exist only in OrchestratorAgent and TickerAgent)."),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP(`RPC-only with no turn path, ${SKILLS_NO_TURN_NOTE}`),
    },
  },
  {
    className: "BrowserAgent",
    cells: {
      identity: NA(
        "Stateless: every method delegates to ETradeBrowserService built from env only; any instance name behaves identically and the class acts as nobody — there is no acting identity to make durable.",
      ),
      state: NA(
        "No state: zero ctx.storage use anywhere in the class (pinned below).",
      ),
      connections: NA(
        "No production connection terminates on the class: production use is in-process construction borrowing the caller's ctx (src/agents/routes/tradingIntegrations.ts); its onRequest (:133) is exercised only that way.",
      ),
      scheduling: NA("No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row."),
      recovery: NA("Stateless by construction (zero ctx.storage use in the class), so an eviction has nothing to recover."),
      "sdk-state": NA("No agent state to manage through any API."),
      sessions: NA(
        "portHooks deliberately unset (class header): no chat behavior was ever configured, so no session store is exercised.",
      ),
      routing: IMPL(
        "Binding BROWSER_AGENT; A2A surface browser (dispatch module src/agents/browserA2aDispatch.ts); production reachability is the in-process construction recorded under connections, and since #2351 the orchestrator's G1 chat door (src/agents/orchestrator/meshDoors.ts) is a production stub caller addressed to the fixed instance \"browser\": snap/capture/scrape with results verbatim. The survey §2.8 webhookUrl call is decided in #2351: the door never accepts or forwards a caller-supplied webhookUrl — delivery targets are env configuration only, the #2223 A2A precedent.",
      ),
      websockets: NA("No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin below: onConnect exists only in TickerAgent)."),
      "sdk-scheduling": NA("No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin below: such calls exist only in OrchestratorAgent and TickerAgent)."),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP(`portHooks deliberately unset — no chat behavior was ever configured, ${SKILLS_NO_TURN_NOTE}`),
    },
  },
  {
    className: "SlackAgent",
    cells: {
      identity: IMPL(
        "S13 (#2412) retired the synthetic fallback this cell cited: sessionKey() throws when ctx.id is absent instead of returning the retired master literal, and getSlackService no longer re-asserts it (absence pinned below; behavioral pin in tests/mesh_channels_s13_2412.test.ts). S16 (#2426) closed the G14 remainder: the class holds a registry identity record (MESH_IDENTITIES in src/agents/registry.ts — DID did:agent:openaimp:slack, identity source, attribution shape) and its A2A surface carries a per-agent mesh credential (A2A_TOKEN_SLACK, verified timing-safely at the edge; the shared token is its transitional fallback). Channel ingress keeps its own gate — the app-level Slack signing secret — which is the channel's credential, recorded as such in the registry's channel and identity records. Pins: tests/mesh_identity_s16_2426.test.ts.",
      ),
      state: IMPL(
        "SQLite via getOrm() over this.ctx.storage.sql — schema ensured by the store's designated initializer classes, not this class (the #2345 R-7 composition pin: this file deliberately carries no initializeSchema); the S13 suite (#2412) exercises the boot/ORM paths over a fresh store through the converged ingress. The class is instantiated in production via its A2A door and the G1 chat door (see routing).",
      ),
      connections: NA(
        "No connection surface of its own: its signature-gated onRequest ingress delegates Slack payloads to the shared channel handler (src/agents/routes/tradingIntegrations.ts) — since S13 (#2412) it is the same implementation the production server.ts forwarders terminate in on OrchestratorAgent instances named slack_<teamId>, not a parallel one (registry channel posture FORWARDER).",
      ),
      scheduling: NA("No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row."),
      recovery: IMPL(
        "S13 (#2412) exercised the boot/ORM paths with a behavioral pin (tests/mesh_channels_s13_2412.test.ts): a previewed draft in the instance store is executed by one SlackAgent incarnation through the converged ingress, and a fresh incarnation over the SAME store honors the recorded outcome — a second approval is answered by the shared engine's already-executed refusal and the broker placement runs exactly once. The class holds no in-flight work of its own between requests: every request rebuilds its service from env + durable storage, so instance replacement loses nothing.",
        "The simulation is instance replacement over the same durable store in the node:sqlite harness, not live workerd eviction (the S12 residual, fleet-wide).",
      ),
      "sdk-state": IMPL(
        "State goes through ctx.storage.sql directly (getOrm, slackAgent.ts:89-90) — the same ctx.storage posture as the fleet; the SDK setState API is unused (fleet pin below).",
      ),
      sessions: NA(
        "No chat transcript; its sessionKey-keyed service state is not an agent session store.",
      ),
      routing: IMPL(
        "Binding SLACK_AGENT exists (migration v10, #2215 — the class header's no-binding claim is stale, survey §6.4); A2A surface slack (registry); production stub callers: the A2A dispatcher (#2223) and, since #2351, the orchestrator's G1 chat door (src/agents/orchestrator/meshDoors.ts) addressed to the fixed instance \"slack\", serving only the two outbound helpers (approval ticket + transaction snap). Production ingress still bypasses the class (see connections), which S13 owns.",
      ),
      websockets: NA("No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin below: onConnect exists only in TickerAgent)."),
      "sdk-scheduling": NA("No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin below: such calls exist only in OrchestratorAgent and TickerAgent)."),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP(`No chat transcript and no turn runs on this class, ${SKILLS_NO_TURN_NOTE}`),
    },
  },
  {
    className: "AiSearchAgent",
    cells: {
      identity: IMPL(
        "The agent fronts a shared search instance and holds no identity of its own; the identity discipline lives in the runner: report-type results are served only to their owner's login and are withheld when the search carries no login or a mismatched one (src/agents/aiSearchPaths.ts, the #2246 report login discipline).",
        "Session login is not yet threaded into the turn-tool/RPC callers (aiSearchPaths.ts:168-172), so those callers get report results withheld — fail-safe, with the threading follow-up recorded under #2246.",
      ),
      state: NA(
        "No ctx.storage use in the class (pinned below); the three-path runner (namespace binding, instance MCP, REST) is stateless per call over env configuration.",
      ),
      connections: NA(
        "No connection terminates on the class; its MCP path is outbound consumption of the instance's endpoint via RemoteMcpClient, a client relationship recorded under routing.",
      ),
      scheduling: NA("No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row."),
      recovery: NA("Stateless per call over env configuration, so an eviction has nothing to recover."),
      "sdk-state": NA("No agent state to manage through any API."),
      sessions: IMPL(
        "Turn-capable: portHooks are set in the constructor (aiSearchAgent.ts:86-99) mirroring ResearchAgent's — the namespace search is a model turn tool as well as a direct method (the agents/tools/ai-search pattern from the reference set), exposed through the MCP door as ai_search_agent_search (#2250).",
      ),
      routing: IMPL(
        "Binding AI_SEARCH_AGENT (migration v12, #2223); A2A surface aisearch (registry). The ai_search_namespaces binding is dashboard-issued and not declared in wrangler.jsonc, so the primary path is config-gated and the agent degrades honestly to its MCP and REST paths (registry note).",
      ),
      websockets: NA("No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin below: onConnect exists only in TickerAgent)."),
      "sdk-scheduling": NA("No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin below: such calls exist only in OrchestratorAgent and TickerAgent)."),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP("Turn-capable via portHooks — the namespace search is already a model turn tool as well as a direct method."),
    },
  },
  {
    className: "TickerAgent",
    cells: {
      identity: IMPL(
        "A single shared instance, 'ticker' (TICKER_INSTANCE_NAME, ticker-agent.ts:109), addressed directly by server.ts (idFromName(TICKER_INSTANCE_NAME), src/server.ts:3113). No per-user identity by design: the tape is public, with no auth and no audit (the #2230 posture recorded in the class header).",
      ),
      state: NA(
        "No durable agent state: subscriptions live in per-connection state and quotes in an in-memory cache refreshed on demand; zero ctx.storage use in the class (pinned below).",
      ),
      connections: IMPL(
        "The public quotes WebSocket (/api/market/quotes/ws plus aliases): server.ts forwards the upgrade request to the shared instance's stub, which drives onConnect. Deliberately NOT routeAgentRequest — its onBeforeConnect would 401 the public tape (class header; src/server.ts:3107-3113).",
      ),
      scheduling: IMPL(
        "The tick cadence is a durable SDK schedule that follows listener presence (#2443): armed on first connect, cancelled on last disconnect, reconciled on start (armed with listeners present, cancelled with none — which retires schedules a pre-fix build armed). scheduleEvery is idempotent, so re-arming never duplicates; cadence from TICKER_PUSH_INTERVAL_S (default TICKER_PUSH_INTERVAL_SECONDS).",
      ),
      recovery: NA(
        "Nothing durable to recover: the tick schedule is reconciled on every wake (armed with listeners, cancelled without), per-connection state is restored by the SDK across hibernation, and the quote cache is refresh-on-demand.",
      ),
      "sdk-state": NA(
        "The Agent state API is unused. The Connection.setState calls (ticker-agent.ts:207+) are per-connection state — the SDK's connection-state mechanism, recorded under websockets — not agent state.",
      ),
      sessions: NA(
        "portHooks never set and no turn ever runs (class header); there is no transcript.",
      ),
      routing: IMPL(
        "Binding TICKER_AGENT (migration v11, #2230); direct stub addressing from server.ts; not routed through routeAgentRequest and no A2A surface (registry) — both deliberate, recorded in the class header.",
      ),
      websockets: IMPL(
        "The fleet's one real WebSocket lifecycle implementation: onConnect reads header carriers into per-connection state and arms the schedule, onMessage handles subscribe/unsubscribe/ping, onClose cancels on last disconnect (excluding the closing connection, which the SDK still counts during onClose); protocol messages are disabled (shouldSendProtocolMessages returns false) because clients are plain WebSockets, not useAgent clients.",
      ),
      "sdk-scheduling": IMPL("this.scheduleEvery in onConnect/onStart-reconcile and this.cancelSchedule in onClose/onStart-reconcile/pushTicks (ticker-agent.ts, #2443)."),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP(`portHooks never set and no turn ever runs (class header), ${SKILLS_NO_TURN_NOTE}`),
    },
  },
  {
    className: "SandboxAgent",
    cells: {
      identity: NA(
        "No acting identity: the class delegates to ETradeSandboxService constructed from env only, and adds no identity of its own.",
      ),
      state: NA(
        "No ctx.storage use in the class (pinned below); the service is constructed with no container backend and holds no per-instance durable state.",
      ),
      connections: NA(
        "Its doors are the domain methods plus the onRequest surface (:123); production call-site wiring through the agent is a recorded follow-up — the MCP run_sandbox_command still constructs the service directly (class header).",
      ),
      scheduling: NA("No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row."),
      recovery: NA(
        "Stateless; run results are honest non-executions (executed:false, #121) until an owner binds a container backend — there is no in-flight work to resume.",
      ),
      "sdk-state": NA("No agent state to manage through any API."),
      sessions: NA(
        "portHooks deliberately unset and no chat behavior defined (class header); no session store is exercised.",
      ),
      routing: IMPL(
        "Binding SANDBOX_AGENT (migration v13, #2253); the onRequest surface mirrors BrowserAgent. No A2A surface — a recorded follow-up in the registry notes, not part of this slice.",
      ),
      websockets: NA("No WebSocket surface of its own: it defines no onConnect/onMessage and no socket client connects to it (fleet pin below: onConnect exists only in TickerAgent)."),
      "sdk-scheduling": NA("No SDK scheduler use: the file contains no this.schedule/this.scheduleEvery call (fleet pin below: such calls exist only in OrchestratorAgent and TickerAgent)."),
      fibers: FIBERS_GAP,
      skills: SKILLS_GAP(`portHooks deliberately unset and no chat behavior defined, ${SKILLS_NO_TURN_NOTE}`),
    },
  },
  {
    className: "SessionStore",
    cells: {
      identity: IMPL(
        "This class is the fleet's identity substrate: the store holding app sessions and E*TRADE tokens (etrade:token:<env>:<login>) that every agent's identity story ultimately rests on (survey §2.11).",
      ),
      state: IMPL(
        "A kv_store SQLite table (ns/key/value/expires_at) created in its constructor over ctx.storage.sql (sessionStore.ts:134+).",
      ),
      connections: NA("A fetch op protocol only; no connection surface."),
      scheduling: NA("No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row."),
      recovery: NA(
        "Not an agent: per-call fetch operations over durable SQLite storage; no in-flight work to resume.",
      ),
      "sdk-state": NA(
        "Not an Agents SDK Agent subclass (extends plain DurableObject); the Agent-class State aspect does not apply.",
      ),
      sessions: NA("It stores the fleet's sessions; it holds none of its own."),
      routing: IMPL(
        "Binding SESSION_STORE (migration v6); reached by internal stub fetch only.",
      ),
      websockets: NA("No WebSocket surface: its only door is the fetch op protocol."),
      "sdk-scheduling": NA("Not an Agents SDK Agent, so the SDK scheduler aspect does not apply."),
      fibers: NA("Not an Agent class; the Fibers aspect does not apply."),
      skills: NA("Not an Agents SDK Agent subclass (extends plain DurableObject): the Skills aspect is defined for Think/Agent harnesses — there is no getSkills hook to override and no model turn for skills tools to serve."),
    },
  },
  {
    className: "OptionsScannerMCP",
    cells: {
      identity: IMPL(
        "The caller's x402 payer wallet, verified by the facilitator — the fleet's only externally credentialed surface (survey §2.10). No DID, no service-identity use; attribution is the payment receipt.",
      ),
      state: IMPL(
        "McpAgent protocol session state over ctx.storage; the one paid tool (screen_options) is stateless per call, executing in-process.",
      ),
      connections: IMPL(
        "MCP over HTTP/WebSocket via McpAgent.serve, addressed by an affinity id at /mcp/scanner (src/server.ts:2808-2814).",
      ),
      scheduling: NA("No scheduling role: it registers no schedules and owns no scheduled work; anything time-based reaches it from callers recorded elsewhere in this row."),
      recovery: NA("Stateless calls; protocol sessions belong to the MCP layer."),
      "sdk-state": NA(
        "An McpAgent, not an Agents SDK Agent; the SDK State aspect does not apply.",
      ),
      sessions: NA(
        "Its sessions are MCP protocol sessions (recorded under connections and state), not the Agent-class session store.",
      ),
      routing: IMPL(
        "Binding OPTIONS_SCANNER_MCP (migration v2), served at /mcp/scanner. Registered for completeness; out of mesh scope per #2225 (G3 leaves this class untouched).",
      ),
      websockets: NA("MCP transport, not the Agent WebSocket lifecycle."),
      "sdk-scheduling": NA("No SDK scheduler use: this surface has no scheduler role."),
      fibers: NA("Not an Agent class; the Fibers aspect does not apply."),
      skills: NA("An McpAgent server: it serves tools to other harnesses rather than consuming a harness tool set, and Think’s getSkills adapter does not apply to it. The class is also out of mesh scope per #2225."),
    },
  },
];

// ---------------------------------------------------------------------------
// Data integrity + doc agreement
// ---------------------------------------------------------------------------

const byClass = new Map(MATRIX.map((r) => [r.className, r]));
const agentSource = (className: string): string => {
  const entry = MESH_AGENTS.find((a) => a.className === className);
  if (!entry) throw new Error(`no registry entry for ${className}`);
  return read(entry.sourceFile);
};
const PORT_THINK_CLASSES = MESH_AGENTS.filter((a) => a.base === "PortThink").map(
  (a) => a.className,
);

function countByAspect(): Record<Aspect, Record<CellState, number>> {
  const counts = {} as Record<Aspect, Record<CellState, number>>;
  for (const aspect of ASPECTS) {
    counts[aspect] = { IMPLEMENTED: 0, "NOT-APPLICABLE": 0, GAP: 0 };
    for (const row of MATRIX) counts[aspect][row.cells[aspect].state]++;
  }
  return counts;
}

/** Parse the doc's summary table: `| \`aspect\` | I | N | G |` + Total row. */
function parseDocSummary(doc: string) {
  const rows = new Map<string, [number, number, number]>();
  for (const line of doc.split("\n")) {
    const m = line.match(/^\| `([a-z-]+)` \| (\d+) \| (\d+) \| (\d+) \|$/);
    if (m) rows.set(m[1], [Number(m[2]), Number(m[3]), Number(m[4])]);
    const t = line.match(/^\| Total \| (\d+) \| (\d+) \| (\d+) \|$/);
    if (t) rows.set("Total", [Number(t[1]), Number(t[2]), Number(t[3])]);
  }
  return rows;
}

/** Parse the doc's per-agent tables into className -> aspect -> state. */
function parseDocCells(doc: string) {
  const out = new Map<string, Map<string, string>>();
  let current: string | null = null;
  for (const line of doc.split("\n")) {
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) {
      const name = h[1].trim();
      current = byClass.has(name) ? name : null;
      if (current && !out.has(current)) out.set(current, new Map());
      continue;
    }
    if (!current) continue;
    const r = line.match(/^\| `([a-z-]+)` \| (IMPLEMENTED|NOT-APPLICABLE|GAP) \|/);
    if (r) out.get(current)!.set(r[1], r[2]);
  }
  return out;
}

describe("conformance matrix data integrity (#2339)", () => {
  it("covers exactly the S1 registry roster, in registry order", () => {
    expect(MATRIX.map((r) => r.className)).toEqual(
      MESH_AGENTS.map((a) => a.className),
    );
  });

  it("classifies every cell: valid state, evidence present, GAP always names its owning slice", () => {
    for (const row of MATRIX) {
      expect(Object.keys(row.cells).sort(), row.className).toEqual(
        [...ASPECTS].sort(),
      );
      for (const aspect of ASPECTS) {
        const cell = row.cells[aspect];
        expect(
          ["IMPLEMENTED", "NOT-APPLICABLE", "GAP"],
          `${row.className}.${aspect}`,
        ).toContain(cell.state);
        expect(cell.evidence.length, `${row.className}.${aspect}`).toBeGreaterThan(40);
        if (cell.state === "GAP") {
          expect(cell.gapOwner?.length, `${row.className}.${aspect}`).toBeGreaterThan(0);
        }
      }
    }
  });

  it("every A2A surface in the registry is owned by a matrix row", () => {
    for (const surface of MESH_SURFACES) {
      expect(byClass.has(surface.ownerClass), surface.name).toBe(true);
    }
  });
});

describe("conformance matrix doc agreement (#2339)", () => {
  // Read tolerantly: a missing doc fails these two tests with a
  // clear diff instead of taking the whole suite down at collection.
  const doc = existsSync(resolve(root, DOC_PATH)) ? read(DOC_PATH) : "";

  it("the doc's summary counts equal the classification data", () => {
    const summary = parseDocSummary(doc);
    const counts = countByAspect();
    for (const aspect of ASPECTS) {
      expect(summary.get(aspect), aspect).toEqual([
        counts[aspect].IMPLEMENTED,
        counts[aspect]["NOT-APPLICABLE"],
        counts[aspect].GAP,
      ]);
    }
    const totals: [number, number, number] = [0, 0, 0];
    for (const aspect of ASPECTS) {
      totals[0] += counts[aspect].IMPLEMENTED;
      totals[1] += counts[aspect]["NOT-APPLICABLE"];
      totals[2] += counts[aspect].GAP;
    }
    expect(summary.get("Total")).toEqual(totals);
    expect(totals[0] + totals[1] + totals[2]).toBe(MATRIX.length * ASPECTS.length);
  });

  it("the doc's per-agent tables match the classification data cell for cell", () => {
    const parsed = parseDocCells(doc);
    expect([...parsed.keys()].sort()).toEqual(
      MATRIX.map((r) => r.className).sort(),
    );
    for (const row of MATRIX) {
      const docRow = parsed.get(row.className)!;
      expect(docRow.size, row.className).toBe(ASPECTS.length);
      for (const aspect of ASPECTS) {
        expect(docRow.get(aspect), `${row.className}.${aspect}`).toBe(
          row.cells[aspect].state,
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Round-1 pins — identity (static source evidence; behavioral proof
// for the S3 paths lives in the S3 suite, cited and pinned here).
// ---------------------------------------------------------------------------

describe("identity pins — round 1 (#2339)", () => {
  it("the S3 behavioral identity suite this matrix cites still exists with its describes", () => {
    const s3 = read(S3_SUITE);
    for (const title of [
      "ResearchAgent identity discipline (#2327)",
      "orchestrator research publish entry (#2327)",
      "PaymentsAgent budgetCheck identity (#2327)",
    ]) {
      expect(s3, title).toContain(title);
    }
  });

  it("ResearchAgent's explicit-login guard is present (post-S3 identity cell)", () => {
    const src = agentSource("ResearchAgent");
    expect(src).toContain("explicitResearchLogin");
    expect(src).toContain("Research run requires an explicit userLogin");
  });

  it("PaymentsAgent requires an explicit agentId and carries no attribution default", () => {
    const src = agentSource("PaymentsAgent");
    expect(src).toContain("budget check requires an explicit agentId");
    expect(src).not.toContain('?? "orchestrator"');
  });

  it("OrchestratorAgent is resolved per login and the service identity helper exists", () => {
    expect(read("src/server.ts")).toContain("env.SEARCH_AGENT.idFromName(userLogin)");
    expect(read("src/security/serviceIdentity.ts")).toContain(
      "export function getServiceUserLogin",
    );
  });

  it("TradingAgent derives its acting identity from the instance name", () => {
    const src = agentSource("TradingAgent");
    expect(src).toContain("instanceUserLogin()");
    expect(src).toContain("tradingAgentName");
    expect(src).toContain("async handleA2A(");
  });

  it("ScreenerAgent fails closed on owner identity; the tenantId residual is retired (S16): zero 'default' literals, the owner login threaded at both gather sites", () => {
    const src = agentSource("ScreenerAgent");
    expect(src).toContain(
      "ScreenerAgent has no owner identity recorded for this instance",
    );
    expect(src.split('tenantId: "default"').length - 1).toBe(0);
    expect(src.split("tenantId: userLogin").length - 1).toBe(2);
    expect(read("src/agents/screenerAgentName.ts")).toContain(
      "resolveScreenerAgentName",
    );
  });

  it("ScheduledAgent names its budget bucket explicitly; the 'system' audit actor residual is retired (S16)", () => {
    const src = agentSource("ScheduledAgent");
    expect(src).toContain("AGENTIC_SPEND_AGENT_ID");
    expect(src.split('actor: "system"').length - 1).toBe(0);
    expect(src).toContain("SCHEDULED_AGENT_AUDIT_ACTOR");
  });

  it("SlackAgent's synthetic master fallback is retired (S13, #2412) — the literal is absent from the class and sessionKey fails closed", () => {
    expect(agentSource("SlackAgent")).not.toContain("slack_agent_master");
    expect(agentSource("SlackAgent")).toContain("refusing to invent a session identity");
  });

  it("TickerAgent's shared instance name is the one server.ts addresses", () => {
    expect(agentSource("TickerAgent")).toContain("TICKER_INSTANCE_NAME");
    expect(read("src/server.ts")).toContain("idFromName(TICKER_INSTANCE_NAME)");
  });

  it("AiSearchAgent's runner still enforces the report login discipline its identity cell cites", () => {
    expect(read("src/agents/aiSearchPaths.ts")).toContain(
      "report login discipline",
    );
  });
});

// ---------------------------------------------------------------------------
// Round-1 pins — state
// ---------------------------------------------------------------------------

describe("state pins — round 1 (#2339)", () => {
  it("agents whose state cell is IMPLEMENTED actually use ctx.storage; agents whose cell is NOT-APPLICABLE do not", () => {
    for (const row of MATRIX) {
      const uses = agentSource(row.className).includes("ctx.storage");
      if (row.cells.state.state === "IMPLEMENTED") {
        expect(uses, row.className).toBe(true);
      } else if (row.cells.state.state === "NOT-APPLICABLE") {
        expect(uses, row.className).toBe(false);
      }
    }
  });

  it("PaymentsAgent's derived-state posture: the ledger module and the legacy migration are both present", () => {
    const src = agentSource("PaymentsAgent");
    expect(src).toContain("payments/ledger");
    expect(src).toContain("migrateLegacyLedger");
  });

  it("ReportAssetAgent stores through the report blob store", () => {
    expect(agentSource("ReportAssetAgent")).toContain("reportBlobStore");
  });

  it("no agent source uses the SDK state API (this.setState) — the sdk-state divergence the matrix records", () => {
    for (const row of MATRIX) {
      expect(agentSource(row.className), row.className).not.toContain(
        "this.setState",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Round-1 pins — routing
// ---------------------------------------------------------------------------

describe("routing pins — round 1 (#2339)", () => {
  it("chat reaches the orchestrator through routeAgentRequest in server.ts", () => {
    expect(read("src/server.ts")).toContain("routeAgentRequest(request, env");
  });

  it("the OptionsScannerMCP surface is addressed from server.ts by its binding", () => {
    expect(read("src/server.ts")).toContain("OPTIONS_SCANNER_MCP");
  });

  it("every registry agent's source file exists (routing cells cite real classes)", () => {
    for (const agent of MESH_AGENTS) {
      expect(existsSync(resolve(root, agent.sourceFile)), agent.sourceFile).toBe(
        true,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// Round-1 pins — sessions
// ---------------------------------------------------------------------------

describe("sessions pins — round 1 (#2339)", () => {
  it("portHooks assignments match the sessions classification for every PortThink agent", () => {
    const assigns = (className: string) =>
      /this\.portHooks\s*=|portHooks\s*\?\?=/.test(agentSource(className));
    for (const className of PORT_THINK_CLASSES) {
      const state = byClass.get(className)!.cells.sessions.state;
      // Turn-capable cells (IMPLEMENTED, and TradingAgent's GAP whose
      // mechanism is wired) rest on a portHooks assignment; every
      // NOT-APPLICABLE cell rests on its absence.
      expect(assigns(className), className).toBe(state !== "NOT-APPLICABLE");
    }
  });

  it("the port session facet is the flat ActorSessionStore the sessions cells cite", () => {
    expect(read("src/actors/thinkAdapter.ts")).toContain("ActorSessionStore");
    expect(existsSync(resolve(root, "src/actors/actorSessionStore.ts"))).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Fleet fact pins for the non-round-1 aspects (static source evidence
// for the connections / websockets / scheduling / recovery / fibers
// classifications — these pin facts, not runtime behavior).
// ---------------------------------------------------------------------------

describe("fleet fact pins (#2339)", () => {
  const sourcesWith = (needle: string) =>
    MATRIX.filter((r) => agentSource(r.className).includes(needle)).map(
      (r) => r.className,
    );

  it("onConnect appears in exactly one agent source: TickerAgent's", () => {
    expect(sourcesWith("onConnect")).toEqual(["TickerAgent"]);
  });

  it("onStart is defined by exactly OrchestratorAgent and TickerAgent", () => {
    expect(sourcesWith("onStart(").sort()).toEqual([
      "OrchestratorAgent",
      "TickerAgent",
    ]);
  });

  it("SDK scheduler calls appear exactly in the agents whose sdk-scheduling cell is IMPLEMENTED", () => {
    const withCalls = MATRIX.filter((r) =>
      /this\.schedule\(|this\.scheduleEvery\(/.test(agentSource(r.className)),
    ).map((r) => r.className);
    const classified = MATRIX.filter(
      (r) => r.cells["sdk-scheduling"].state === "IMPLEMENTED",
    ).map((r) => r.className);
    expect(withCalls.sort()).toEqual(classified.sort());
  });

  it("no agent source references the SDK fiber primitives (runFiber/startFiber)", () => {
    for (const row of MATRIX) {
      const src = agentSource(row.className);
      expect(src.includes("runFiber"), row.className).toBe(false);
      expect(src.includes("startFiber"), row.className).toBe(false);
    }
  });

  it("durableFibers keeps its live records in an in-memory Map — the fibers GAP fact", () => {
    expect(read("src/services/durableFibers.ts")).toContain(
      "activeFibers = new Map",
    );
  });

  it("exactly one agent source overrides getSkills — OrchestratorAgent, the skills adoption boundary (#2705)", () => {
    for (const row of MATRIX) {
      const has = agentSource(row.className).includes("getSkills");
      expect(has, row.className).toBe(row.className === "OrchestratorAgent");
    }
  });
});
