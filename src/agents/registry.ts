/**
 * Agent Mesh G0 fleet registry (issue #2322, programme #2225).
 *
 * A code-derived, drift-pinned inventory of the mesh: agent classes,
 * their A2A surfaces, channels, tool families, doors, and workflows.
 * This module is a CHECKED PROJECTION, not a source of truth — the
 * facts live in wrangler.jsonc (bindings), src/a2a/ (cards and
 * resolutions), src/mcps/openaimp/ (the command catalog), and the class
 * declarations under src/. tests/mesh_registry_s1_2322.test.ts pins
 * every section below against those sources; if a source moves, the
 * pin fails and this file is updated in the same PR (gitops §7).
 *
 * Vocabulary follows docs/architecture/agentic/doors-and-layers.md:
 * an A2A card is a SURFACE of its owning agent class, not an agent
 * (mesh survey contradiction 9); a channel is an ingress a person or
 * external system starts from; a door is an invocation surface with
 * its own enforcement point.
 *
 * Consumers: later mesh slices — the S4 conformance-matrix doc and
 * the S20 Agents view — read the typed accessors at the bottom.
 * Nothing at runtime depends on this module in this slice; it makes
 * no decisions and changes no behavior.
 */

export type MeshAgentKind = "agent" | "durable-object" | "mcp-agent";

/**
 * Recorded capability posture of a fleet class (S20, #2469 — the
 * status the Agents view renders). "live": bound, routed, and no
 * recorded degradation. "degraded": the class runs, but a named
 * capability fact recorded in `notes` limits it — the reason is
 * carried in `statusReason` and evidenced in repo facts, pinned by
 * tests/mesh_agents_view_s20_2469.test.ts. (The third posture of
 * the tool-family vocabulary, "absent", has no instance among the
 * classes: every registered class exists and is bound.)
 */
export type MeshAgentStatus = "live" | "degraded";

export interface MeshAgentEntry {
  className: string;
  kind: MeshAgentKind;
  /** Declared base class the drift pin verifies in source. */
  base: "PortThink" | "DurableObject" | "McpAgent";
  /** wrangler.jsonc durable_objects binding names for this class. */
  bindings: string[];
  sourceFile: string;
  role: string;
  /** Recorded capability posture (S20, #2469). */
  status: MeshAgentStatus;
  /** Why the status is what it is — recorded evidence, not inference. */
  statusReason: string;
  notes?: string;
}

export interface MeshSurfaceEntry {
  /** A2A surface name (card name / dispatch name). */
  name: string;
  /** The agent class that owns this surface. */
  ownerClass: string;
  /** Published in AGENT_CARDS (src/a2a/agent-cards.ts). */
  card: boolean;
  /** Reachable through A2A_RESOLUTIONS (src/a2a/resolution.ts). */
  dispatch: boolean;
}

export interface MeshChannelEntry {
  id: "web-chat" | "slack" | "email" | "voice" | "webhook" | "nlq-webhook";
  name: string;
  /** Where the channel enters the Worker. */
  ingress: string;
  /** What the channel terminates at. */
  terminatesAt: string;
  /** Survey §7 posture vocabulary. */
  posture: "FORWARDER" | "MIXED";
  /**
   * How a channel principal becomes a login — or, honestly, that no
   * mapping exists / the caller is a system identity (S13, #2412).
   */
  identity: string;
  /** The channel's gate: signature / session / approval discipline. */
  gate: string;
  /** Parity state vs the shared NLQ + approval pipeline (#1262). */
  parity: string;
  /**
   * The named adapter: the module that implements the ingress
   * (leading token is the file path; drift-pinned to exist).
   */
  adapter: string;
  notes?: string;
}

export interface MeshCommandSource {
  file: string;
  kind: "readonly-name" | "deprecated-alias";
}

export type MeshToolFamilyStatus = "live" | "degraded" | "absent";

export interface MeshToolFamilyEntry {
  id: string;
  name: string;
  /** Defining module or owning surface. */
  source: string;
  status: MeshToolFamilyStatus;
  /**
   * McpToolFactory command names this family accounts for. Only the
   * seven factory-module families carry commands; every factory tool
   * is accounted for by exactly one family (pinned).
   */
  commands: string[];
  /** Where the test reads this family's command-name literals. */
  commandSources?: MeshCommandSource[];
  /** Non-factory tool sets (the MAS family) list their tool names. */
  toolNames?: string[];
  notes?: string;
}

export interface MeshDoorEntry {
  id: "chat-turn" | "http-routes" | "mcp" | "a2a" | "agent-as-a-tool";
  name: string;
  entryPoint: string;
  /** The door's own enforcement point. */
  gate: string;
}

export interface MeshWorkflowEntry {
  className: string;
  /** wrangler.jsonc workflows binding name. */
  binding: string;
  sourceFile: string;
  /** Who starts the workflow (modules/callers). */
  starters: string[];
  role: string;
}

export interface MeshNonRenameEntry {
  names: string[];
  decision: string;
  source: string;
}

// ---------------------------------------------------------------------------
// Agents — every Durable Object class behind a wrangler DO binding.
// ---------------------------------------------------------------------------

export const MESH_AGENTS: MeshAgentEntry[] = [
  {
    className: "OrchestratorAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["SEARCH_AGENT"],
    sourceFile: "src/agents/orchestrator.ts",
    role: "Primary conversational agent: chat turns, the MAS tool surface, NLQ and goal/chain execution; owns the mas_* SQL ledger the fleet reads from.",
    status: "live",
    statusReason:
      "Bound on SEARCH_AGENT (class OrchestratorAgent since migration v15, #2523) and routed for every chat turn; no recorded degradation.",
    notes:
      "Exported from src/server.ts under its own name, OrchestratorAgent (the SEARCH_AGENT binding's class_name since migration v15). Service and A2A addressing uses the shared orchestrator instance. The G0 rename (Agent Mesh S2 two-deploy rename, gate record #2326) is complete: migration v14 (#2330, Deploy A) tombstoned the colliding v9 own-name namespace — the registration created for #1387 sub-agent root resolution — and migration v15 (#2523, Deploy B) renamed this SEARCH_AGENT namespace onto OrchestratorAgent via renamed_classes, so the class's own-name namespace is the renamed namespace, instance names (logins) and stored state carried over, the SearchAgent export alias is retired, and ctx.exports[\"OrchestratorAgent\"] root resolution is restored.",
  },
  {
    className: "ResearchAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["RESEARCH_AGENT"],
    sourceFile: "src/agents/research-agent.ts",
    role: "Deep-research runs: discovery, source gathering, synthesis, optional publication.",
    status: "live",
    statusReason:
      "Bound on RESEARCH_AGENT and reachable through the chat door and agent-as-a-tool; no recorded degradation.",
  },
  {
    className: "TradingAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["TRADING_AGENT"],
    sourceFile: "src/agents/trading-agent.ts",
    role: "E*TRADE trading agent: quotes, previews, and the human approval door; starts TradingTradeWorkflow for approved executions.",
    status: "live",
    statusReason:
      "Bound on TRADING_AGENT; proposals and the approval door are live (executions stay behind the human approval door by design, S9).",
    notes:
      "Chat reaches the proposal side through the G1 door (#2349, src/agents/orchestrator/meshDoors.ts), addressed to the acting user's own instance (trading:<login>): trade proposals via the preview-only stock_trading/options_trading services plus the accounts/positions/quote reads. Since S9/G4 (#2375) the chat turn also reaches the approval door through the same door: startTradeApproval starts the TradingTradeWorkflow run for a proposal and decideTradeApproval delivers the human's decision (authorizer DID derived server-side from the acting login), and the workflow's settle step calls executeApprovedOrder — which remains the one approval-door method with no direct chat caller.",
  },
  {
    className: "PaymentsAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["PAYMENTS_AGENT"],
    sourceFile: "src/agents/payments-agent.ts",
    role: "Payments agent: DID-attested drafts and x402/MPP premium legs over the payments ledger.",
    status: "live",
    statusReason:
      "Bound on PAYMENTS_AGENT; budget checks and paid-request processing live behind the BudgetGuard; no recorded degradation.",
    notes:
      "Chat reaches budgetCheck + the read side (todaySpent/listPayments) through the G1 door (#2341, src/agents/orchestrator/meshDoors.ts), checks attributed to AGENTIC_SPEND_AGENT_ID; processPaidRequest has no chat caller by design — the chat paid-request flow is S10/G5 (PaymentWorkflow).",
  },
  {
    className: "ScreenerAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["SCREENER_AGENT"],
    sourceFile: "src/agents/screener-agent.ts",
    role: "Screening execution agent: stock and options screens; hosts ScreenerScreenWorkflow steps.",
    status: "live",
    statusReason:
      "Bound on SCREENER_AGENT and hosting ScreenerScreenWorkflow steps; no recorded degradation.",
  },
  {
    className: "ScheduledAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["SCHEDULED_AGENT"],
    sourceFile: "src/agents/scheduled-agent.ts",
    role: "Schedule catalogue and synthesized schedules/goals; singleton instance \"default\"; fires screens, research, and QA runs.",
    status: "live",
    statusReason:
      "Bound on SCHEDULED_AGENT; catalogue and triggers live; no recorded degradation.",
    notes:
      "Chat reaches the goal catalogue through the G1 door (#2341, src/agents/orchestrator/meshDoors.ts): list/inspect + trigger, acting identity required. Add/remove/enable stay on the session-gated /api/schedule/* routes.",
  },
  {
    className: "ReportAssetAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["REPORT_ASSET_AGENT"],
    sourceFile: "src/agents/report-asset-agent.ts",
    role: "Report asset storage and serving; blobs in R2 (REPORTS_BUCKET) when bound, metadata in DO storage.",
    status: "live",
    statusReason:
      "Bound on REPORT_ASSET_AGENT; list/get/generation paths live; no recorded degradation.",
    notes:
      "Chat reaches the user's assets through the G1 door (#2349, src/agents/orchestrator/meshDoors.ts), addressed to the acting user's own instance (assets:<login>): list (listAssets metadata) + get, replacing the turn's indirect reach through the report pipeline. Generation stays with the pipeline/A2A callers.",
  },
  {
    className: "BrowserAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["BROWSER_AGENT"],
    sourceFile: "src/agents/browserAgent.ts",
    role: "Browser fetch, inspect, and screenshot over the Browser Rendering binding (BROWSER, declared in wrangler.jsonc).",
    status: "live",
    statusReason:
      "Bound on BROWSER_AGENT with the BROWSER rendering binding declared in wrangler.jsonc (#2253); no recorded degradation.",
    notes:
      "Chat reaches it through the G1 door (#2351, src/agents/orchestrator/meshDoors.ts), addressed to the fixed instance \"browser\" (A2A parity — the class is stateless/env-driven): transaction snap, page capture, and table scrape, results verbatim (a placeholder-labelled screenshot or a not-delivered outcome stays labelled). The door takes no caller-supplied webhookUrl — delivery targets are env configuration only (the survey §2.8 call, decided in #2351 following the #2223 A2A precedent).",
  },
  {
    className: "SlackAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["SLACK_AGENT"],
    sourceFile: "src/agents/slackAgent.ts",
    role: "Slack app agent: slash commands, events, interactions, approval buttons.",
    status: "live",
    statusReason:
      "Bound on SLACK_AGENT; ingress converged onto the shared channel handler (S13); no recorded degradation.",
    notes:
      "Production Slack ingress arrives via the src/server.ts forwarder routes onto per-team OrchestratorAgent instances. Since S13/G10 (#2412) the agent's own gated ingress is no longer a parallel implementation: onRequest delegates to the same shared channel handler (src/agents/routes/tradingIntegrations.ts) with an agent-hosted context, so the gate, principal resolution, NLQ dep set, event dedup, and service are identical on both hosts (the channel record carries the full posture). Chat reaches its outbound side through the G1 door (#2351, src/agents/orchestrator/meshDoors.ts), addressed to the fixed instance \"slack\" (A2A parity): the pre-trade approval ticket (posts the HITL gate; approves/executes nothing) and the transaction snap, with no caller-supplied webhookUrl.",
  },
  {
    className: "AiSearchAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["AI_SEARCH_AGENT"],
    sourceFile: "src/agents/aiSearchAgent.ts",
    role: "AI Search agent (#2223): three-path search — Cloudflare AI Search namespace binding, the shared instance's MCP endpoint, REST fallback (src/agents/aiSearchPaths.ts).",
    status: "degraded",
    statusReason:
      "Degraded: the ai_search_namespaces binding is dashboard-issued and NOT declared in wrangler.jsonc, so the namespace path is config-gated; the class degrades honestly to its MCP-endpoint and REST paths (see notes).",
    notes:
      "Landed after the mesh survey base (migration v12). The ai_search_namespaces binding is NOT declared in wrangler.jsonc — its namespace value is dashboard-issued (see src/types.ts) — so the namespace path is config-gated and degrades honestly to the other two paths. Chat reach (G1, verified in #2351): the chat turn already reaches this agent through the ai_search_agent_search command (#2250, src/mcps/openaimp/cloudflareAgentCommands.ts) — a typed stub over the AI_SEARCH_AGENT binding on the fixed service instance \"aisearch\", threading the turn's session login as callerLogin so report-type results are served only to their owner. No mesh-door command is added for it: a second door to the same agent would be a parallel implementation.",
  },
  {
    className: "TickerAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["TICKER_AGENT"],
    sourceFile: "src/agents/ticker-agent.ts",
    role: "Public market-quotes tape: one shared instance (\"ticker\") broadcasting quote ticks over WebSocket (#2230).",
    status: "live",
    statusReason:
      "Bound on TICKER_AGENT; the public quotes tape broadcast is live; no recorded degradation.",
    notes: "Landed after the mesh survey base (migration v11). Not routed through routeAgentRequest; no A2A surface.",
  },
  {
    className: "SandboxAgent",
    kind: "agent",
    base: "PortThink",
    bindings: ["SANDBOX_AGENT"],
    sourceFile: "src/agents/sandbox-agent.ts",
    role: "Sandbox command agent (#2253): delegates execution to ETradeSandboxService.",
    status: "degraded",
    statusReason:
      "Degraded: no container backend is configured (no containers declared in wrangler.jsonc), so run_command honestly returns executed:false; the class and its A2A surface are live, the execution backend is absent (see notes).",
    notes:
      "Landed after the mesh survey base (migration v13). No container backend is configured, so runs honestly return executed:false. The A2A surface recorded as a follow-up landed in S15 (#2421): card + resolution + src/agents/sandboxA2aDispatch.ts (sandbox.status, sandbox.run_command) on the A2A edge gate; S16 (#2426) gave the surface its own mesh credential (A2A_TOKEN_SANDBOX — see the identity records), with the shared token as its transitional fallback. Chat/MCP still reach the sandbox capability by constructing the service directly, not through this class (the #2253 wiring follow-up; see the census).",
  },
  {
    className: "SessionStore",
    kind: "durable-object",
    base: "DurableObject",
    bindings: ["SESSION_STORE"],
    sourceFile: "src/security/sessionStore.ts",
    role: "Session, identity, and broker-token store: app sessions, OAuth tokens, channel identity mappings. A plain Durable Object, not an agent.",
    status: "live",
    statusReason:
      "Bound on SESSION_STORE; the session/identity store every door authenticates against; no recorded degradation.",
  },
  {
    className: "OptionsScannerMCP",
    kind: "mcp-agent",
    base: "McpAgent",
    bindings: ["OPTIONS_SCANNER_MCP"],
    sourceFile: "src/mcps/scanner/cloudflareWalletsScanner.ts",
    role: "Paid options-scanner MCP server (x402).",
    status: "live",
    statusReason:
      "Bound on OPTIONS_SCANNER_MCP; the paid scanner surface is live. Registered for binding completeness — OUT of mesh scope per #2225.",
    notes: "Registered for binding completeness; OUT of mesh scope per #2225 (no changes to this class in the programme).",
  },
];

// ---------------------------------------------------------------------------
// A2A surfaces — names an A2A caller can address, each owned by a class.
// ---------------------------------------------------------------------------

export const MESH_SURFACES: MeshSurfaceEntry[] = [
  { name: "orchestrator", ownerClass: "OrchestratorAgent", card: true, dispatch: true },
  { name: "search", ownerClass: "OrchestratorAgent", card: true, dispatch: true },
  { name: "tasks", ownerClass: "OrchestratorAgent", card: true, dispatch: true },
  { name: "memory", ownerClass: "OrchestratorAgent", card: true, dispatch: true },
  // Dispatch-only surface: resolvable via A2A_RESOLUTIONS but no card
  // is published for it in AGENT_CARDS.
  { name: "nlq", ownerClass: "OrchestratorAgent", card: false, dispatch: true },
  { name: "payments", ownerClass: "PaymentsAgent", card: true, dispatch: true },
  { name: "trading", ownerClass: "TradingAgent", card: true, dispatch: true },
  { name: "aisearch", ownerClass: "AiSearchAgent", card: true, dispatch: true },
  { name: "screener", ownerClass: "ScreenerAgent", card: true, dispatch: true },
  { name: "scheduled", ownerClass: "ScheduledAgent", card: true, dispatch: true },
  { name: "research", ownerClass: "ResearchAgent", card: true, dispatch: true },
  { name: "report-asset", ownerClass: "ReportAssetAgent", card: true, dispatch: true },
  { name: "browser", ownerClass: "BrowserAgent", card: true, dispatch: true },
  { name: "slack", ownerClass: "SlackAgent", card: true, dispatch: true },
  { name: "sandbox", ownerClass: "SandboxAgent", card: true, dispatch: true },
];

// ---------------------------------------------------------------------------
// Identity records (S16, #2426, programme G14) — one per fleet
// class: the DID or identity derivation the class acts under, how
// its acting identity is established, the per-agent mesh
// credentials for its A2A surfaces, and the attribution shape its
// records carry. Drift-pinned against MESH_SURFACES,
// A2A_RESOLUTIONS, and the credential module
// (src/a2a/meshCredentials.ts) by
// tests/mesh_identity_s16_2426.test.ts.
// ---------------------------------------------------------------------------

export interface MeshIdentityRecord {
  className: string;
  /** The AGENT_DIDS identity the class acts under, or null when no
   *  DID is registered for the class (its identitySource then
   *  states the derivation it uses instead). */
  did: string | null;
  /** How the class's acting identity is established — and how it
   *  fails closed when no identity can be named. */
  identitySource: string;
  /** A2A dispatch surfaces this class owns (its MESH_SURFACES entries). */
  a2aSurfaces: string[];
  /** Per-agent mesh credential env vars for those surfaces. */
  meshCredentials: string[];
  /** Per-agent posture, transitional fallback, or no A2A reach. */
  credentialPosture: string;
  /** The attribution shape the records this class writes carry. */
  attribution: string;
  notes?: string;
}

const PER_AGENT_CREDENTIAL_POSTURE =
  "Per-agent mesh credential (env names in meshCredentials), verified timing-safely at the A2A edge (src/a2a/meshCredentials.ts). While a surface's per-agent secret is unset, the shared A2A_API_TOKEN authenticates it TRANSITIONALLY — removal condition: every surface carries its own secret, then the fallback is deleted (S16, #2426).";
const NO_A2A_CREDENTIAL_POSTURE =
  "No A2A surface — no mesh credential; this class is not reachable through the A2A door.";

export const MESH_IDENTITIES: MeshIdentityRecord[] = [
  {
    className: "OrchestratorAgent",
    did: "did:agent:openaimp:orchestrator",
    identitySource:
      "Per-login instances: server.ts resolves SEARCH_AGENT.idFromName(userLogin); unattended work acts under getServiceUserLogin, fail-closed when unconfigured. Its five A2A surfaces act under the role DIDs did:agent:openaimp:{orchestrator, search, tasks, memory, nlq} (AGENT_DIDS).",
    a2aSurfaces: ["orchestrator", "search", "tasks", "memory", "nlq"],
    meshCredentials: [
      "A2A_TOKEN_ORCHESTRATOR",
      "A2A_TOKEN_SEARCH",
      "A2A_TOKEN_TASKS",
      "A2A_TOKEN_MEMORY",
      "A2A_TOKEN_NLQ",
    ],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "mas_* payment rows carry proposerDid (this agent) + authorizerDid (the user DID); A2A-originated payments records additionally carry the edge-authenticated caller in the audit record (S16). Chat-turn rows partition by sessionKey — the opaque DO id, an address doing partition duty, not an identity.",
  },
  {
    className: "ResearchAgent",
    did: "did:agent:openaimp:research",
    identitySource:
      "Acting identity arrives per request (ResearchRunRequest.userLogin) and fails closed when missing or blank (S3, #2327); A2A dispatches to the service identity's instance research:<service-login> and refuses to start one without a configured service identity.",
    a2aSurfaces: ["research"],
    meshCredentials: ["A2A_TOKEN_RESEARCH"],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "Run records carry their owner login (report.userLogin); evaluations resolve identity from the caller or the run record's recorded owner and decline when neither exists — never a default.",
  },
  {
    className: "TradingAgent",
    did: "did:agent:openaimp:trading",
    identitySource:
      "Name-derived acting identity: instanceUserLogin() inverts tradingAgentName(login); approval decisions require an authorizer DID derived server-side from the acting login (S9), and anonymous authorizers are refused.",
    a2aSurfaces: ["trading"],
    meshCredentials: ["A2A_TOKEN_TRADING"],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "Order drafts, approvals, and settlements record userLogin + authorizerDid; the settle path refuses a missing authorizer DID.",
  },
  {
    className: "PaymentsAgent",
    did: "did:agent:openaimp:payments",
    identitySource:
      "Callers must name themselves: budgetCheck and processPaidRequest require an explicit agentId and fail closed without one (S3, #2327); A2A callers are additionally authenticated by the surface's mesh credential at the edge (S16).",
    a2aSurfaces: ["payments"],
    meshCredentials: ["A2A_TOKEN_PAYMENTS"],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "Two-part: ledger rows are attributed payments-agent:<agentId> with the payer as authorizerDid, and A2A-originated records carry the edge-authenticated caller in the payments_agent.recorded audit payload (S16).",
  },
  {
    className: "ScreenerAgent",
    did: null,
    identitySource:
      "Recorded-owner identity: userLogin() returns the owner recorded at first run, else the login in a screener:-prefixed instance name, else the service identity for instance \"default\" only — otherwise it throws. No AGENT_DIDS entry is registered for this class.",
    a2aSurfaces: ["screener"],
    meshCredentials: ["A2A_TOKEN_SCREENER"],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "Runs record their owner login; goal-gather captures partition by the owner's login as tenantId (S16 — the shared \"default\" tenant literal is retired).",
  },
  {
    className: "ScheduledAgent",
    did: null,
    identitySource:
      "Singleton instance \"default\"; goals carry their owner login in the goal records and fired work acts as the goal owner; unattended spend names AGENTIC_SPEND_AGENT_ID explicitly (S3, #2327). No AGENT_DIDS entry is registered for this class.",
    a2aSurfaces: ["scheduled"],
    meshCredentials: ["A2A_TOKEN_SCHEDULED"],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "Audit rows name their actor: the acting login for fired work; the reconciliation row carries the operator the route threaded, or SCHEDULED_AGENT_AUDIT_ACTOR when none was supplied (S16 — the \"system\" literal is retired).",
  },
  {
    className: "ReportAssetAgent",
    did: null,
    identitySource:
      "Identity is carried in the request (AssetRequest.userLogin), never derived from the instance name; the name helper maps the service identity to instance \"default\" and users to assets:<login>. No AGENT_DIDS entry is registered for this class.",
    a2aSurfaces: ["report-asset"],
    meshCredentials: ["A2A_TOKEN_REPORT_ASSET"],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "Assets are recorded under their owner login; attribution is exactly as trustworthy as the capability-RPC caller (survey §2.7).",
  },
  {
    className: "BrowserAgent",
    did: "did:agent:openaimp:browser",
    identitySource:
      "Stateless and env-driven: every method delegates to ETradeBrowserService built from env only; any instance name behaves identically and the class acts as nobody — there is no acting identity to make durable.",
    a2aSurfaces: ["browser"],
    meshCredentials: ["A2A_TOKEN_BROWSER"],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "Writes no identity records of its own; delivery targets are env configuration only (no caller-supplied webhookUrl on any door).",
  },
  {
    className: "SlackAgent",
    did: "did:agent:openaimp:slack",
    identitySource:
      "Channel principals resolve through the shared channel handler: the #1262 connect-code link store binds Slack users to logins, and unlinked users are refused into the link flow; sessionKey() fails closed without a DO instance id (S13, #2412). Its A2A surface sits on the fixed instance \"slack\" behind the surface's mesh credential (S16).",
    a2aSurfaces: ["slack"],
    meshCredentials: ["A2A_TOKEN_SLACK"],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "Approval drafts and executions record the resolved login through the shared approval engine; A2A calls to this surface are attributed by the edge credential (a2a-credential:slack, or the transitional shared caller).",
  },
  {
    className: "AiSearchAgent",
    did: null,
    identitySource:
      "Fronts a shared search instance and holds no identity of its own; the runner threads the caller's login as callerLogin and serves report-type results only to their owner (the #2246 discipline). No AGENT_DIDS entry is registered for this class.",
    a2aSurfaces: ["aisearch"],
    meshCredentials: ["A2A_TOKEN_AISEARCH"],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "Results are labelled with their serving path; report-type results are owner-bound to the caller's login and withheld on a missing or mismatched login (fail-safe).",
  },
  {
    className: "TickerAgent",
    did: null,
    identitySource:
      "A single shared instance (\"ticker\") addressed directly by server.ts. No per-user identity by design: the tape is public, with no auth and no audit (the #2230 posture).",
    a2aSurfaces: [],
    meshCredentials: [],
    credentialPosture: NO_A2A_CREDENTIAL_POSTURE,
    attribution:
      "No attribution: the class keeps no audit and asserts no identity.",
  },
  {
    className: "SandboxAgent",
    did: null,
    identitySource:
      "No acting identity: the class delegates to ETradeSandboxService constructed from env only, and adds no identity of its own.",
    a2aSurfaces: ["sandbox"],
    meshCredentials: ["A2A_TOKEN_SANDBOX"],
    credentialPosture: PER_AGENT_CREDENTIAL_POSTURE,
    attribution:
      "Run results carry the sandbox's honest posture (executed:false while no container backend is bound); no identity is asserted.",
  },
  {
    className: "SessionStore",
    did: null,
    identitySource:
      "Not an agent: this class is the fleet's identity substrate — the store holding app sessions, broker tokens, and channel identity mappings that every other class's identity story ultimately rests on.",
    a2aSurfaces: [],
    meshCredentials: [],
    credentialPosture: NO_A2A_CREDENTIAL_POSTURE,
    attribution:
      "Records are keyed by the identities it stores (sessions and tokens per login); it asserts no identity of its own.",
  },
  {
    className: "OptionsScannerMCP",
    did: null,
    identitySource:
      "The caller's x402 payer wallet, verified by the facilitator — the fleet's only externally credentialed surface. Registered for completeness; out of mesh scope per #2225.",
    a2aSurfaces: [],
    meshCredentials: [],
    credentialPosture: NO_A2A_CREDENTIAL_POSTURE,
    attribution:
      "Attribution is the payment receipt: payer wallet + facilitator verification.",
  },
];

// ---------------------------------------------------------------------------
// Channels — ingresses a person or external system starts from (§7).
//
// Reconciliation (S13, #2412): survey §7 tables NINE channels. Six of
// them are channels in this registry's vocabulary (an ingress a
// person or external system starts from, terminating on an agent);
// MCP and A2A are DOORS (recorded in MESH_DOORS — they are
// invocation surfaces, not ingresses), and cron/scheduler is a
// TRIGGER (recorded with the doors section's scheduling note). S1
// recorded five channels and omitted the NLQ webhook; S13 adds it
// and completes every record with identity / gate / parity /
// adapter, drift-pinned by tests/mesh_channels_s13_2412.test.ts.
// ---------------------------------------------------------------------------

export const MESH_CHANNELS: MeshChannelEntry[] = [
  {
    id: "web-chat",
    name: "Web chat (SPA)",
    ingress: "Agents SDK routing (routeAgentRequest) in src/server.ts",
    terminatesAt: "OrchestratorAgent (per-login instance)",
    posture: "FORWARDER",
    identity:
      "App session: the verified session login names the instance (idFromName(userLogin)) — the instance name IS the session login; no channel mapping exists or is needed.",
    gate:
      "App session required before the socket is accepted (onBeforeConnect: origin check + session → 403/401; onBeforeRequest: session → 401).",
    parity:
      "Reference channel: the shared NLQ pipeline and the approval discipline are native here; channel parity is measured against this channel.",
    adapter:
      "src/server.ts — Agents SDK routing (routeAgentRequest); no adapter code of ours.",
  },
  {
    id: "slack",
    name: "Slack",
    ingress:
      "POST /slack/commands, /slack, /slack/events, /slack/interactions routes in src/server.ts; SDK-routed /agents/slack-agent/* reaches the same handler hosted by SlackAgent",
    terminatesAt:
      "OrchestratorAgent (per-team instance slack_<teamId>) in production; SlackAgent when SDK-routed — both hosts run the one shared channel handler",
    posture: "FORWARDER",
    identity:
      "Connect-code link store (#1262): Slack team+user → session login at tier trade, confirmed in an authenticated web session (POST /api/trading/slack/link); an unlinked Slack user gets an explicit refusal and can run the `link` DM command — workspace membership alone grants no tier. The session-authenticated simulator (/api/trading/slack/test) asserts the verified session login instead.",
    gate:
      "gateSlackRequest (src/security/webhookSecurity.ts) at the worker routes AND inside SlackAgent.onRequest — the Slack signing secret is mandatory (unconfigured → loud 503, bad signature → 401, 5-minute timestamp replay window); event deliveries are deduped on event_id in the shared handler (#2412); trade executions run through the shared approval engine.",
    parity:
      "Full: the channel runs the shared NLQ dependency set and the shared approval engine (#1262); channel NLQ is flagged untrustedContent unconditionally (#880).",
    adapter:
      "src/agents/routes/tradingIntegrations.ts — the shared channel handler (handleTradingIntegrationsRoutes) both the production forward and SlackAgent.onRequest delegate to; the service is ETradeSlackTradingService (src/trading/slack/agent.ts).",
    notes:
      "Converged in S13 (#2412): SlackAgent.onRequest previously carried a parallel ingress (own principal resolution, service built with no NLQ deps); it now delegates to the shared handler with an agent-hosted context, so behavior cannot differ by entry point. The production host stays the per-team orchestrator instance because the NLQ dep set is host-bound (scheduling callbacks live on OrchestratorAgent; the draft ledger lives in the host instance's ORM).",
  },
  {
    id: "email",
    name: "Email",
    ingress:
      "Worker email() handler in src/server.ts → handleCloudflareEmailMessage; HTTP variant POST /api/trading/email/inbound forwards to the same DO route",
    terminatesAt: "OrchestratorAgent (shared inbound-email instance; DO route /trading/email/inbound)",
    posture: "FORWARDER",
    identity:
      "Sender → login via CHANNEL_EMAIL_PRINCIPALS, gated by Authentication-Results (DKIM/SPF) — the parsed sender address is never used for routing; the session-authenticated simulator asserts the verified session login. An unmapped sender still constructs the service so it receives an explicit refusal; it runs nothing.",
    gate:
      "Order execution only via signed approval links (#1262 Phase 5: token signature + expiry + principal-map re-check inside the DO); trade actions through the shared approval engine — a bare APPROVE reply executes nothing on the production path.",
    parity:
      "Full: shared NLQ pipeline + shared approval engine (#1262), with the social-brief port withheld from untrusted-origin NLQ.",
    adapter:
      "src/trading/email/agent.ts — handleCloudflareEmailMessage + ETradeEmailTradingService; DO-side route in src/agents/routes/tradingIntegrations.ts.",
    notes: "Trading actions over email are identity-hardened (#1262): sender-to-login mapping plus signed approval links.",
  },
  {
    id: "voice",
    name: "Voice",
    ingress:
      "WebSocket GET /voice/trade and /api/trading/voice/ws in src/server.ts — the socket terminates at the worker and each turn is forwarded per-turn",
    terminatesAt: "OrchestratorAgent (per-login instance, POST /trading/voice/turn)",
    posture: "FORWARDER",
    identity:
      "App session: identity is the verified session login end-to-end; the turn forwarder sets the identity header from the session, never from caller input.",
    gate:
      "App session checked BEFORE the socket is accepted (a null session never proceeds); handshake/interrupt/end_call stay worker-local; trade actions through the shared approval engine.",
    parity:
      "Full: same channel services and shared approval engine (#1262); voice adopted the ChannelIntake principal contract in Phase 1.",
    adapter:
      "src/trading/voice/agent.ts — createOrchestratorVoiceTurnForwarder + ETradeVoiceTradingService; DO-side route in src/agents/routes/tradingIntegrations.ts.",
  },
  {
    id: "webhook",
    name: "Webhooks (payments + trading)",
    ingress:
      "POST /api/payments/webhook (+ /payments/webhook) and the trading report webhook routes in src/server.ts",
    terminatesAt:
      "OrchestratorAgent (the system_webhook_receiver instance receives; settlement re-routes to the draft's owning instance)",
    posture: "FORWARDER",
    identity:
      "No edge session by design and no identity taken from the payload: settlement routing derives only from the server-written draft-owner registry (src/payments/draftOwners.ts) — the payload contributes nothing but the draftId to routing.",
    gate:
      "Per-gateway HMAC verification inside the DO listener (Stripe / PayPal / Lemon Squeezy); verification fails closed when a secret is unconfigured (#140). Trading webhooks verify via ETradeWebhookService (unconfigured → 503).",
    parity:
      "Not an NLQ channel: terminates on the payments settlement pipeline, not the NLQ/approval pipeline.",
    adapter:
      "src/server.ts — webhook routes; settlement routing via src/payments/draftOwners.ts.",
  },
  {
    id: "nlq-webhook",
    name: "NLQ webhook",
    ingress:
      "POST /nlq/webhook (+ /api/trading/nlq/webhook, /api/nlq/webhook) in src/server.ts — all three spellings delegate to the single-owner handler handleNlqWebhookRequest (#313)",
    terminatesAt:
      "OrchestratorAgent (the asserted user's nlq_webhook_<userId> instance, or the channel's service-identity instance when no userId is asserted)",
    posture: "FORWARDER",
    identity:
      "HMAC-authenticated SYSTEM caller, not a user session: a well-formed caller-asserted userId attributes the run to the namespaced principal nlq_webhook_<userId>; with no userId the run lands on the channel's named service identity NLQ_WEBHOOK_SERVICE_LOGIN (\"nlq_webhook\") — a service identity, not a person's login (#2412).",
    gate:
      "HMAC signature over the raw body (INBOUND_NLQ_WEBHOOK_SECRET — unconfigured → 503, invalid → 401), 5-minute timestamp window, nonce replay claim, per-source-IP throttle, 128 KB body cap, query sanitized at entry (#1763).",
    parity:
      "Shared NLQ pipeline with the social brief port withheld — webhook bodies are untrusted external content (#1077); scheduling and discovery ports stand. Email delivery of action results is refused at the route.",
    adapter:
      "src/server.ts — handleNlqWebhookRequest (single-owner handler for all three spellings).",
  },
];

// ---------------------------------------------------------------------------
// Tool families — survey §8's fifteen, plus the three families the
// #2225 reference-set update added (web_search, web_fetch, AI Search
// platform), plus the mesh-door family the G1 slices add (#2341),
// plus the Agent Skills family the owner's Agents SDK Skills
// addition names (#2225 comment 6517280689, recorded by S14/#2417).
// The McpToolFactory module families carry the catalog's command
// names; the rest describe their surface in notes. Every family's
// status is drift-pinned against its evidence by
// tests/mesh_tool_registry_s14_2417.test.ts.
// ---------------------------------------------------------------------------

export const MESH_TOOL_FAMILIES: MeshToolFamilyEntry[] = [
  {
    id: "core-mcp-commands",
    name: "Core MCP commands",
    source: "src/mcps/openaimp/commands.ts",
    status: "live",
    commands: [
      "knowledge_search",
      "query_platform_knowledge",
      "draft_payment",
      "confirm_payment_draft",
      "get_payment_gateways",
      "get_transactions",
      "execute_nlq",
      "get_async_job",
      "list_async_jobs",
      "list_database_tables",
      "query_table_data",
      "manage_categories",
      "manage_referrals",
      "manage_external_ads",
      "get_revenue_summary",
      "manage_session_memory",
      "get_audit_events",
    ],
    commandSources: [{ file: "src/mcps/openaimp/commands.ts", kind: "readonly-name" }],
    notes:
      "Grounding caveat (survey §8 row 1, verified by S14/#2417): knowledge_search and query_platform_knowledge ground on the in-repo platform-knowledge corpus (src/services/platformKnowledge.ts) — a shipped, structured knowledge base of the platform's own capabilities, not the AI Search instance. The survey's caution stands: that grounding must not be counted as a search surface. The AI Search surfaces are the ai-search-service and ai-search-platform families.",
  },
  {
    id: "cloudflare-agent-mcp-commands",
    name: "Cloudflare-agent MCP commands",
    source: "src/mcps/openaimp/cloudflareAgentCommands.ts",
    status: "live",
    commands: [
      "browser_inspect_page",
      "browser_screenshot",
      "dispatch_trading_webhook",
      "run_sandbox_command",
      "run_quant_backtest",
      "think_trade_validation",
      "ai_search_financial_docs",
      "execute_durable_twap",
      "ai_search_agent_search",
    ],
    commandSources: [{ file: "src/mcps/openaimp/cloudflareAgentCommands.ts", kind: "readonly-name" }],
  },
  {
    id: "etrade-mcp-commands",
    name: "E*TRADE MCP commands",
    source: "src/mcps/openaimp/etradeCommands.ts",
    status: "live",
    commands: [
      "etrade_market_scan",
      "etrade_get_quote",
      "etrade_preview_order",
      "etrade_execute_order",
      "etrade_get_positions",
      "etrade_auth_status",
      "etrade_account_discovery",
    ],
    commandSources: [{ file: "src/mcps/openaimp/etradeCommands.ts", kind: "readonly-name" }],
  },
  {
    id: "agentic-payment-mcp-commands",
    name: "Agentic-payment MCP commands",
    source: "src/mcps/openaimp/agenticPaymentCommands.ts",
    status: "live",
    commands: ["paid_options_screener", "paid_market_research", "agentic_wallet_status"],
    commandSources: [{ file: "src/mcps/openaimp/agenticPaymentCommands.ts", kind: "readonly-name" }],
  },
  {
    id: "goal-chain-mcp-commands",
    name: "Goal/chain MCP commands",
    source: "src/mcps/openaimp/goalChainCommands.ts",
    status: "live",
    commands: ["goal.compile", "goal.schedule", "chain.run"],
    commandSources: [{ file: "src/mcps/openaimp/goalChainCommands.ts", kind: "readonly-name" }],
    notes: "chain.run reports unimplemented in the MCP context; the server-route binding is the recorded follow-up.",
  },
  {
    id: "market-data-mcp-commands",
    name: "Market-data MCP commands",
    source: "src/mcps/openaimp/marketDataCommands.ts",
    status: "live",
    commands: [
      "market_data_get_quote",
      "market_data_company_fundamentals",
      "market_data_historical_bars",
      "market_data_research",
      "alpaca_snapshot",
      "alpaca_account",
      "alpaca_positions",
      "alpaca_orders",
      "alpaca_place_order",
      "foss_get_quote",
      "foss_company_fundamentals",
      "foss_historical_bars",
      "foss_market_research",
      "foss_alpaca_snapshot",
      "foss_alpaca_account",
      "foss_alpaca_positions",
      "foss_alpaca_orders",
      "foss_alpaca_place_order",
    ],
    commandSources: [
      { file: "src/mcps/openaimp/marketDataCommands.ts", kind: "readonly-name" },
      { file: "src/mcps/openaimp/commands.ts", kind: "deprecated-alias" }, // each alias superseded by its canonical command (see notes)
    ],
    notes:
      "The foss_* names are deprecated aliases (#1906) wrapping the canonical commands; each foss_* alias is superseded by the canonical market_data_*/alpaca_* name for the same command. Alias removal is a follow-up slice.",
  },
  {
    id: "agentdb-read-mcp-commands",
    name: "AgentDB read MCP commands",
    source: "src/mcps/openaimp/agentDbReadCommands.ts",
    status: "live",
    commands: [
      "agentdb.chain.status",
      "agentdb.jobs.history",
      "agentdb.audit.history",
      "agentdb.reports.list",
      "agentdb.trace.get",
    ],
    commandSources: [{ file: "src/mcps/openaimp/agentDbReadCommands.ts", kind: "readonly-name" }],
  },
  {
    id: "mesh-door-mcp-commands",
    name: "Mesh door MCP commands (G1)",
    source: "src/mcps/openaimp/meshDoorCommands.ts",
    status: "live",
    commands: [
      "list_scheduled_goals",
      "trigger_scheduled_goal",
      "check_payment_budget",
      "get_payments_overview",
      "propose_stock_trade",
      "propose_options_trade",
      "get_trading_accounts",
      "get_trading_positions",
      "get_trading_quote",
      "list_report_assets",
      "get_report_asset",
      "browser_snap_transaction",
      "browser_capture_page",
      "browser_scrape_tables",
      "slack_send_pre_trade_approval",
      "slack_dispatch_transaction_snap",
      "start_trade_approval",
      "decide_trade_approval",
      "get_trade_approval_status",
      "run_stock_screen",
    ],
    commandSources: [{ file: "src/mcps/openaimp/meshDoorCommands.ts", kind: "readonly-name" }],
    notes:
      "G1 outbound doors, batches A (#2341) + B (#2349) + C (#2351), plus S9/G4 batch D (#2375): the chat turn reaches ScheduledAgent, PaymentsAgent, TradingAgent, ReportAssetAgent, BrowserAgent, and SlackAgent through the typed doors in src/agents/orchestrator/meshDoors.ts. The commands require the caller's acting identity (the context actingLogin carrier) and fail closed without one, so they serve the chat door; since #2496 they also serve identified external MCP callers — the /mcp route threads the edge-verified login into the same carrier — while anonymous MCP callers still fail closed, and the A2A doors remain the cross-instance surface for these agents. The TradingAgent door exposes proposals (preview only) and reads, and — since #2375 — the approval door's workflow operations (start_trade_approval / decide_trade_approval / get_trade_approval_status): a chat trade runs as a TradingTradeWorkflow through the approval door, with the authorizer derived server-side; the synchronous settle (executeApprovedOrder) is never on the door. The Browser/Slack doors take no caller-supplied webhookUrl: delivery targets are env configuration only. AiSearchAgent is deliberately not in this family — the chat turn already reaches it through ai_search_agent_search (#2250, see its agent record). Batch E (#2488) adds run_stock_screen over the mesh screen door (src/agents/orchestrator/meshScreenDoor.ts): the chat turn's universe stock screen as a ScreenerScreenWorkflow run, executed by the door layer's own NLQ-free service — the screen path no longer depends on the NLQ stock-screen port, and the door has no direct-ScreenerAgent fallback.",
  },
  {
    id: "mas-tools",
    name: "MAS tools",
    source: "src/agents/mas.ts (createMAS)",
    status: "live",
    commands: [],
    toolNames: [
      "searchKnowledge",
      "draftPayment",
      "createTaskDraft",
      "confirmDraft",
      "rememberFact",
      "recallFacts",
    ],
    notes:
      "AI-SDK tool set, not McpToolFactory-registered. The production route caller is POST /search/mas (src/agents/routes/searchHub.ts), which invokes searchKnowledge; the same set serves the orchestrator turn.",
  },
  {
    id: "remote-mcp-servers",
    name: "Remotely consumed MCP servers",
    source: "src/mcps/client/mcpClient.ts (RemoteMcpClient) + src/mcps/public/publicMcp.ts (PublicMcpClient)",
    status: "live",
    commands: [],
    notes:
      "Outbound MCP consumption: AiSearchAgent's instance-MCP path (src/agents/aiSearchPaths.ts) and the payment strategies call remote MCP servers through RemoteMcpClient. A second client, PublicMcpClient, serves Public.com's hosted MCP (PUBLIC_MCP_URL) for src/services/publicData.ts and src/security/publicOAuth.ts under a recorded tool allowlist (PUBLIC_DATA_TOOL_ALLOWLIST); it was unrecorded before S14 (#2417) completed this family.",
  },
  {
    id: "sandbox-tools",
    name: "Sandbox execution",
    source: "src/agents/sandbox-agent.ts + ETradeSandboxService",
    status: "degraded",
    commands: [],
    notes:
      "No container backend is configured: runs return executed:false (honest degradation). The run_sandbox_command MCP command lives in the cloudflare-agent-mcp-commands family. Making this family live is a named OWNER DECISION, not a code gap: add a Cloudflare Containers configuration for SandboxAgent to wrangler.jsonc and construct the service with the bound container (this.ctx.container) — the enablement steps are recorded in src/agents/sandbox-agent.ts and in the SANDBOX_AGENT binding comment in wrangler.jsonc. Owner-gated in this programme; the registry slices record it and do not make it (S14, #2417).",
  },
  {
    id: "browser-tools",
    name: "Browser tools",
    source: "src/agents/browserAgent.ts + Browser Rendering binding BROWSER",
    status: "live",
    commands: [],
    notes:
      "The BROWSER binding is declared in wrangler.jsonc (#2253); the survey-era finding 'no Browser Rendering binding in deployed config' is superseded on current main (re-verified by S14, #2417). The browser_* MCP commands live in the cloudflare-agent-mcp-commands family. Failure-path honesty is unchanged from the survey: a capture that cannot run returns a clearly labelled placeholder (screenshotKind: \"placeholder\") rather than a fabricated image.",
  },
  {
    id: "ai-search-service",
    name: "AI Search service (REST path)",
    source: "src/services/aiSearch.ts (ETradeAISearchService)",
    status: "live",
    commands: [],
    notes:
      "Direct REST search over the AI Search instance (AI_SEARCH_ENDPOINT, declared in wrangler.jsonc vars); backs the ai_search_financial_docs MCP command and AiSearchAgent's REST fallback path. Failure honesty (survey §8 row 12's fabricated-fallback caveat, verified still live by S14/#2417): when the primary path fails, the service falls back to a local matcher over a built-in five-document corpus (FINANCIAL_KNOWLEDGE_BASE in the same module) and labels the response provider \"semantic_cache\" — those results are the in-repo corpus, not the instance. The family's live status is its primary-path posture; the substitution is labelled in-band and recorded here, never silent.",
  },
  {
    id: "payments-tools",
    name: "Payments tools and services",
    source: "src/services/payments.ts + src/agents/payments-agent.ts",
    status: "live",
    commands: [],
    notes:
      "Draft/confirm/gateway/transaction MCP commands live in the core-mcp-commands family; paid legs live in the agentic-payment-mcp-commands family.",
  },
  {
    id: "screening-research-services",
    name: "Screening and research services",
    source: "src/agents/screener-agent.ts + src/agents/research-agent.ts + src/trading/",
    status: "live",
    commands: [],
    notes: "The deterministic screening/research engines the agents and workflows execute; not a command surface of their own.",
  },
  {
    id: "durable-fibers",
    name: "Durable fibers",
    source: "src/services/durableFibers.ts",
    status: "degraded",
    commands: [],
    notes:
      "Home-grown fiber helper: in-memory registry, checkpoints written but never read — NOT durable across eviction (survey §3). Moved from src/agents/durableFibers.ts since the survey base. The execute_durable_twap command lives in the cloudflare-agent-mcp-commands family.",
  },
  {
    id: "web-search",
    name: "Web search (reference-set family)",
    source: "no defining module on main",
    status: "absent",
    commands: [],
    notes:
      "Named by the #2225 reference-set update as a G11 inventory family. No web_search tool exists in src/ on current main (verified by source scan for #2322); recorded as an honest gap for a later slice.",
  },
  {
    id: "web-fetch",
    name: "Web fetch (reference-set family)",
    source: "no defining module on main",
    status: "absent",
    commands: [],
    notes:
      "No standalone web_fetch tool exists on current main; BrowserAgent (browser-tools family) is the current fetch surface. Recorded as an inventory gap.",
  },
  {
    id: "ai-search-platform",
    name: "AI Search platform (namespace binding path)",
    source: "src/agents/aiSearchAgent.ts + src/agents/aiSearchPaths.ts",
    status: "degraded",
    commands: [],
    notes:
      "Cloudflare AI Search through the ai_search_namespaces binding: the binding is not declared in wrangler.jsonc (dashboard-issued namespace value), so the primary path is config-gated off and AiSearchAgent degrades to its MCP and REST paths. Owner enablement is recorded in src/types.ts: add the ai_search_namespaces entry (binding \"AI_SEARCH\", dashboard-issued namespace, remote true) to wrangler.jsonc and set AI_SEARCH_INSTANCE. Owner-gated in this programme; the registry slices record it and do not make it (S14, #2417).",
  },
  {
    id: "agent-skills",
    name: "Agent Skills (SDK SKILL.md packs)",
    source:
      "no defining module on main — the adapter is Think.getSkills() in @cloudflare/think, inherited through PortThink (src/actors/thinkAdapter.ts)",
    status: "absent",
    commands: [],
    toolNames: ["activate_skill", "read_skill_resource", "run_skill_script"],
    notes:
      "Named by the owner's Agents SDK Skills addition to #2225 (comment 6517280689); recorded by S14 (#2417). NOT ADOPTED: no agent class overrides getSkills() (zero occurrences in src/), so no skill catalog exists and the skills tools never appear in any turn. The adapter is present in the pinned SDK (@cloudflare/think 0.23.0): Think.getSkills() returns SkillSource[] — workspace, R2, or code-manifest sources, re-listed before every turn — and Think adds activate_skill / read_skill_resource when sources exist, plus run_skill_script behind an experimental script runner. The fleet runs Think behind the actor port: PortThink neither overrides nor blocks the hook, so adoption is a per-class override plus a source — but whether the port's adapter-driven turn surfaces Think's skills tools end-to-end is an open conformance question, recorded as the G7 matrix's skills aspect (GAP for every PortThink agent, programme backlog). A skill is instructions the model follows, so a source is a trust decision — source write-access is the control point — and any source binding (e.g. an R2 bucket for skills.r2()) is an owner-gated config change. The toolNames listed are the SDK's tool names: none is registered in the MCP catalog or any turn today (pinned).",
  },
];

// ---------------------------------------------------------------------------
// Doors — the five invocation surfaces (doors-and-layers §2), each
// with its own enforcement point. Channel ingresses are separate
// (MESH_CHANNELS); schedules are triggers, not doors.
// ---------------------------------------------------------------------------

export const MESH_DOORS: MeshDoorEntry[] = [
  {
    id: "chat-turn",
    name: "Chat turn",
    entryPoint:
      "src/server.ts routeAgentRequest -> OrchestratorAgent turn; the turn's catalog tools are DISCOVERED at runtime from the platform's own openaimp MCP server through the Agents SDK MCP client (src/agents/orchestrator/meshMcpClient.ts) and auto-merged into the turn by Think under tool_openaimp_<name> keys, alongside the native turn tools (src/agents/mcpAdapter.ts createAgentMcpTools) — #2496",
    gate: "Session auth at connect; MCP permission scopes (#1744) enforced at the /mcp route the discovered tools execute through (queue-time gate) and again by the async-job executor.",
  },
  {
    id: "http-routes",
    name: "HTTP routes",
    entryPoint: "src/server.ts routeRequest + src/agents/routes/*",
    gate: "Per-route session/API authentication.",
  },
  {
    id: "mcp",
    name: "MCP (external protocol surface)",
    entryPoint: "src/mcps/openaimp/index.ts MCP server over the McpToolFactory catalog (src/mcps/openaimp/commands.ts)",
    gate: "MCP permission scopes (#1744) at the /mcp route (queue-time) and the async-job executor. Since #2496 the route also threads the edge-verified acting login (x-user-login) into the execution context, and the handler stamps it server-side into queued mcp.tool payloads — the acting-login carrier this surface previously lacked (#2341) — so identified callers (session / API key, and the chat turn's own SDK loopback) are served the mesh-door commands as themselves; anonymous callers still fail closed at the gate.",
  },
  {
    id: "a2a",
    name: "A2A",
    entryPoint: "src/a2a/index.ts handleA2A (cards: src/a2a/agent-cards.ts; resolution: src/a2a/resolution.ts)",
    gate: "Per-agent bearer credential per surface (A2A_TOKEN_<SURFACE>) verified timing-safely at the edge, fail-closed (503 when no credential is configured for the surface, 401 on a wrong one, before agent resolution) — src/a2a/index.ts + src/a2a/meshCredentials.ts; the shared A2A_API_TOKEN is the TRANSITIONAL fallback for surfaces whose per-agent secret is unset (S16, #2426); per-agent dispatch modules under src/agents/.",
  },
  {
    id: "agent-as-a-tool",
    name: "Agent-as-a-tool",
    entryPoint:
      "Agents SDK runAgentTool (src/agents/orchestrator.ts; e.g. ResearchAgent via src/agents/orchestrator/researchPublish.ts)",
    gate: "Runs inside the parent turn's identity and instance boundary.",
  },
];

// ---------------------------------------------------------------------------
// Per-door cost budgets (S19, #2460, programme G13c) — for each
// door: the cost unit, the cap where one honestly exists, the
// accounting source where cost is measurable, the enforcement
// state, and the recorded gaps where it is not. The discipline
// is the SubrequestBudget one-ledger/hard-cap shape (#1204):
// a cap is recorded ONLY where a real enforcing surface charges
// a real ledger — today that is exactly the PaymentsAgent
// BudgetGuard (src/payments/budget-guard.ts), restored from
// mas_transactions on every check, whose DEFAULT_BUDGET caps
// the S19 suite pins this record against. Where a door's cost
// cannot be measured, the record says so in `gaps` and carries
// NO numbers: a fabricated cap would be a control that does not
// exist. The door-level guard substrate (ledger + coded refusal)
// lives in src/services/meshDoorBudgets.ts.
// ---------------------------------------------------------------------------

export interface MeshDoorCostBudgetEntry {
  door: MeshDoorEntry["id"];
  /** The cost unit this record prices. */
  unit: string;
  /** Caps in `unit`, only where a real enforcing surface applies them. */
  caps: { perCall?: number; perDay?: number } | null;
  /** The named surface that measures this door's cost, or null. */
  accountingSource: string | null;
  /** What the accounting covers — and what it does not. */
  accountingScope: string | null;
  enforcement: "enforced" | "accounting-only" | "not-measurable";
  /** The surface that refuses over-cap work. Enforced records only. */
  enforcingSurface: string | null;
  /** Cost facets that cannot be measured today, stated plainly. */
  gaps: string[];
}

export const MESH_DOOR_COST_BUDGETS: MeshDoorCostBudgetEntry[] = [
  {
    door: "chat-turn",
    unit: "usd-cents (paid-action spend)",
    caps: { perCall: 1000, perDay: 5000 },
    accountingSource:
      "mas_transactions (the ledger of record, src/payments/ledger.ts), read through PaymentsAgent.todaySpent / listPayments (src/agents/payments-agent.ts)",
    accountingScope:
      "Spend is bucketed by agentId — AGENTIC_SPEND_AGENT_ID for orchestrator-attributed spend — not by door: the same bucket is charged by chat-initiated and schedule-initiated paid actions, so a ledger row's door attribution is partial (the S16 caller attribution and the S17 trace id ride the payment audit record, not the bucket).",
    enforcement: "enforced",
    enforcingSurface:
      "BudgetGuard (src/payments/budget-guard.ts) restored from the ledger inside PaymentsAgent.budgetCheck / processPaidRequest, fail-closed; the chat paid path reaches it through the S5 budget door (check_payment_budget) and the S10 paid-screen flow (src/agents/orchestrator/nlqPorts.ts)",
    gaps: [
      "Model/token cost of a chat turn is not metered anywhere in the turn path (the doors-and-layers §7.1 named gap): no per-turn usage record exists to price, so no token cap can honestly be recorded for this door. AI Gateway (#1741) is not activated (no AI_GATEWAY_ID set), so gateway-side metering is unavailable either.",
    ],
  },
  {
    door: "http-routes",
    unit: "usd-cents (x402 settled charges)",
    caps: null,
    accountingSource:
      "Native ledger rows written from verified x402 facilitator settlements (S11, #2396; the three priced endpoints verified end-to-end by #2406) — src/payments/ledger.ts / mas_transactions",
    accountingScope:
      "Only the priced endpoints are metered: a settled charge is recorded per request with its amount. Unpriced routes record no cost at all.",
    enforcement: "accounting-only",
    enforcingSurface: null,
    gaps: [
      "No per-request cost metering exists for unpriced routes (no usage record is written on the general route path).",
      "No aggregate cap exists at the route layer: the per-request charge is the operator PriceCatalogue price itself, and spend caps live in PaymentsAgent's BudgetGuard behind the chat/A2A paid paths, not in route handlers — so this door is accounted, not capped.",
    ],
  },
  {
    door: "mcp",
    unit: "usd-cents (x402 scanner charges)",
    caps: null,
    accountingSource:
      "The paid scanner surface (/mcp/scanner, OptionsScannerMCP) settles through the same x402 / native-ledger path as the priced HTTP routes",
    accountingScope:
      "Only the scanner surface is metered. The McpToolFactory catalog's commands record no per-call cost.",
    enforcement: "accounting-only",
    enforcingSurface: null,
    gaps: [
      "Catalog commands carry no per-call cost metering: an external MCP call writes no usage row, so no cap can be charged on this door today.",
      "Mesh-door commands invoked through this door by identified callers (#2496 acting-login carrier) execute exactly like chat-turn calls, but — like every catalog command on this door — write no per-call usage row, so their cost is unmetered here and remains attributed to the chat-turn record's accounting.",
    ],
  },
  {
    door: "a2a",
    unit: "usd-cents (paid-request spend)",
    caps: { perCall: 1000, perDay: 5000 },
    accountingSource:
      "mas_transactions via PaymentsAgent.processPaidRequest, which records only after facilitator verification (the S16/S17 attribution rides the record)",
    accountingScope:
      "Per-agentId bucket, with S16's two-part attribution: the edge-authenticated caller is recorded beside the agentId on the payments audit record — A2A-origin spend is the one door whose rows carry caller attribution end to end.",
    enforcement: "enforced",
    enforcingSurface:
      "BudgetGuard inside PaymentsAgent.processPaidRequest, reached from src/agents/payments/a2aDispatch.ts — a denied check throws before any payment work runs",
    gaps: [
      "Non-payment A2A calls are unmetered. S17 records a trace hop per A2A call in agent_mesh_trace_hops, so invocation counts are observable — but hop recording is best-effort by design, and a lossy ledger cannot ground a hard cap, so no invocation cap is recorded for this door.",
    ],
  },
  {
    door: "agent-as-a-tool",
    unit: "model-tokens (sub-agent turns)",
    caps: null,
    accountingSource: null,
    accountingScope: null,
    enforcement: "not-measurable",
    enforcingSurface: null,
    gaps: [
      "A sub-agent dispatch runs inside the parent turn's identity and instance boundary and consumes the parent turn's model usage — which is itself unmetered (see the chat-turn record's gap). No per-dispatch usage record exists to price or cap.",
    ],
  },
];

/** The cost-budget record for one door. */
export function doorCostBudget(
  door: MeshDoorEntry["id"],
): MeshDoorCostBudgetEntry {
  const record = MESH_DOOR_COST_BUDGETS.find((r) => r.door === door);
  if (!record) {
    throw new Error(`no cost-budget record for door ${door}`);
  }
  return record;
}

// ---------------------------------------------------------------------------
// Workflows — the four ThinkWorkflow classes and their starters.
// ---------------------------------------------------------------------------

export const MESH_WORKFLOWS: MeshWorkflowEntry[] = [
  {
    className: "ScreenerScreenWorkflow",
    binding: "SCREENER_WORKFLOW",
    sourceFile: "src/workflows/screenerWorkflow.ts",
    starters: [
      "OrchestratorAgent submission paths (chat/HTTP) via src/services/goalScreenWorkflowSubmission.ts",
      "ScheduledAgent scheduled runs via src/services/scheduledTasks.ts",
    ],
    role: "Durable staged screen execution: feed -> gather -> analysis -> store -> deliver, with qualified partials.",
  },
  {
    className: "TradingTradeWorkflow",
    binding: "TRADE_WORKFLOW",
    sourceFile: "src/agents/trading-trade-workflow.ts",
    starters: ["TradingAgent (SDK runWorkflow, after the approval door)"],
    role: "Approved trade execution with durable approval waits.",
  },
  {
    className: "PaymentWorkflow",
    binding: "PAYMENT_WORKFLOW",
    sourceFile: "src/workflows/paymentWorkflow.ts",
    starters: [
      "src/services/paymentWorkflowSubmission.ts seam (paid screen submissions from routes; scheduled runs via src/services/scheduledTasks.ts)",
    ],
    role: "Per-run-request payment gate for paid screens: testnet, feature-flagged, default OFF; one charge per run-request, failure compensates with a replacement-run credit, never a cash refund.",
  },
  {
    className: "CrossDomainSagaWorkflow",
    binding: "SAGA_WORKFLOW",
    sourceFile: "src/workflows/sagaWorkflow.ts",
    starters: [
      "No starter in S1 (#2041): the entry route is S4 work; no route or submission seam starts this workflow by default — the binding exists, uncalled.",
    ],
    role: "Cross-domain paid-run journey: payment child → observed screen → journey gate (S2: all decision surfaces, first answer wins) → (S4 trading leg); S2 ends at the gate outcome (approved ends at the gate, trading leg stubbed).",
  },
];

// ---------------------------------------------------------------------------
// Capability × door census (S15, #2421, programme G12) — for every
// fleet class, its reach through each of the five doors: exposed
// (with the operations where they are enumerable, and the gate the
// door applies) or not-exposed (with the reason — the honest
// negative is a deliverable, not a gap).
//
// Derivation, per door: A2A from AGENT_CARDS + A2A_RESOLUTIONS +
// the per-agent dispatch constants + the classes' handleA2A
// wiring; chat-turn from the mesh-door command registry
// (src/mcps/openaimp/meshDoorCommands.ts) and the turn's own paths; MCP from
// the catalog's class-addressing commands; HTTP from the route
// records above; agent-as-a-tool from the runAgentTool call sites
// in src/. tests/mesh_every_door_s15_2421.test.ts pins the census
// against those sources. Consumers: S16 took the A2A column as its
// per-agent credential inventory (the identity records above);
// S18 (#2439) exercised the exposure with the golden-task harness
// and recorded G12 proven for the catalog's scope — see
// MESH_G12_PROOF below; S20 renders it.
// ---------------------------------------------------------------------------

export interface MeshCapabilityDoorEntry {
  className: string;
  door: MeshDoorEntry["id"];
  status: "exposed" | "not-exposed";
  /**
   * The enumerable operation/command names this door serves for
   * the class. Empty where the reach is not an enumerable op set
   * (route families, workflow steps, a broadcast protocol) — the
   * notes carry the shape instead.
   */
  operations: string[];
  /** The gate this door applies to the capability. Exposed only. */
  gate?: string;
  /** Why this door does not serve the class. Not-exposed only. */
  reason?: string;
  notes?: string;
}

const A2A_EDGE_GATE =
  "Per-agent credential (A2A_TOKEN_<SURFACE>) verified timing-safely at the A2A edge, fail-closed (503 when the surface has no credential configured, 401 on a missing/wrong one, before agent resolution) — src/a2a/index.ts + src/a2a/meshCredentials.ts. TRANSITIONAL: the shared A2A_API_TOKEN authenticates surfaces whose per-agent secret is unset, and the call's attribution says so (S16, #2426; removal when every surface carries its own secret).";
const NO_ACTING_LOGIN_CARRIER =
  "The mesh-door commands that reach this class are OrchestratorAgent-hosted (their class reach is recorded on the chat-turn column). Since #2496 the /mcp route carries the caller's edge-verified acting login, so an identified external MCP caller can invoke those door commands as themselves through their own orchestrator instance — before #2496 they failed closed on this surface for lack of a carrier (#2341). The mcp column's derivation (catalog class-addressing) is unchanged in this slice; its re-derivation under the carrier is recorded as a follow-up for the MCP-server programme (#2494).";

export const MESH_CAPABILITY_DOORS: MeshCapabilityDoorEntry[] = [
  // -- OrchestratorAgent -------------------------------------------------
  {
    className: "OrchestratorAgent",
    door: "chat-turn",
    status: "exposed",
    operations: [],
    gate: "Session auth at connect; MCP permission scopes (#1744) enforced at the /mcp route (queue-time) and the async-job executor — the discovered tools execute through that route (#2496).",
    notes:
      "The turn host class: since #2496 every catalog command reaches its turn by runtime DISCOVERY — the class registers the platform's own openaimp MCP server on the Agents SDK MCP client (src/agents/orchestrator/meshMcpClient.ts) and Think auto-merges the discovered set under tool_openaimp_<name> keys alongside the native turn tools; its outbound reach to the fleet is the G1 mesh doors (src/agents/orchestrator/meshDoors.ts). One catalog command is NOT in the turn's usable set by default (#2488): execute_nlq stays registered and wired (catalog, /mcp surface, facade, async nlq.execute capability, A2A, routes, channels) but is flagged off in the turn by the CHAT_NLQ_MODE switch (src/config/chatNlqModes.ts, built-in default off) — under discovery the flag restricts the merged set through TurnConfig.activeTools (chatNlqTurnGate in meshMcpClient.ts) — the turn's mesh runs without NLQ, and chat screens go through the mesh screen door (run_stock_screen).",
  },
  {
    className: "OrchestratorAgent",
    door: "http-routes",
    status: "exposed",
    operations: [],
    gate: "Per-route session/API authentication.",
    notes:
      "Worker routes terminate on this class: the DO route handlers under src/agents/routes/* plus the route families server.ts dispatches to the shared/per-login instances.",
  },
  {
    className: "OrchestratorAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "The MCP server executes the shared command catalog on the caller's own OrchestratorAgent instance (server.ts forwards to the per-login instance; since #2496 the class's own chat turn consumes the same surface through the SDK MCP client, and identified callers' commands execute with their acting login threaded by the route) — but no catalog command addresses an OrchestratorAgent instance as its target. The class's own invocation surfaces are the chat turn, its routes, and A2A.",
  },
  {
    className: "OrchestratorAgent",
    door: "a2a",
    status: "exposed",
    operations: [
      "search.query",
      "payments.draft",
      "payments.confirm",
      "tasks.create",
      "memory.remember",
      "memory.recall",
      "nlq.execute",
    ],
    gate: A2A_EDGE_GATE,
    notes:
      "Five surface names (orchestrator/search/tasks/memory/nlq) land on the shared instance; handleA2A delegates to src/agents/orchestrator/a2aDispatch.ts — wiring restored by #2421 after #2178 removed it (the dispatch had survived uncalled). payments.draft moves no funds (status awaiting_confirmation); payments.confirm is the human-approval second step — the capability's own gate travels with the exposure.",
  },
  {
    className: "OrchestratorAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "It is the parent that runs agent-as-a-tool delegations (runAgentTool); a class does not run itself as its own facet.",
  },
  // -- ResearchAgent ------------------------------------------------------
  {
    className: "ResearchAgent",
    door: "chat-turn",
    status: "exposed",
    operations: [],
    gate: "The orchestrator turn's session identity; the publish path fails closed without an explicit login (#2327).",
    notes:
      "Reached from the turn through the orchestrator's research publish path (runResearchAndPublish: stub reads + the facet run recorded on the agent-as-a-tool door), not through mesh-door commands.",
  },
  {
    className: "ResearchAgent",
    door: "http-routes",
    status: "exposed",
    operations: [],
    gate: "Session-authenticated research routes.",
    notes: "server.ts research routes and the orchestrator call the stub (RESEARCH_AGENT).",
  },
  {
    className: "ResearchAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "No MCP command addresses this class; market_data_research is a market-data service command, not a ResearchAgent invocation. Research runs start from the turn, the routes, or A2A.",
  },
  {
    className: "ResearchAgent",
    door: "a2a",
    status: "exposed",
    operations: [
      "research.run",
      "research.discovery",
      "research.latest",
      "research.history",
      "research.track_record",
      "research.evaluate",
      "research.config",
    ],
    gate: A2A_EDGE_GATE,
    notes:
      "Resolution lands on research:<service-login> and fails closed with no service identity configured — runs are attributed to the service identity, never a synthetic one.",
  },
  {
    className: "ResearchAgent",
    door: "agent-as-a-tool",
    status: "exposed",
    operations: ["runAgentTool"],
    gate: "Runs inside the parent turn's identity and instance boundary; the facet input carries the acting login explicitly (no ambient identity).",
    notes:
      "The fleet's one facet delegation: the orchestrator runs this class's deterministic pipeline tool via the SDK's runAgentTool (src/agents/orchestrator/researchPublish.ts), with the direct pipeline as its recorded fallback.",
  },
  // -- TradingAgent -------------------------------------------------------
  {
    className: "TradingAgent",
    door: "chat-turn",
    status: "exposed",
    operations: [
      "propose_stock_trade",
      "propose_options_trade",
      "get_trading_accounts",
      "get_trading_positions",
      "get_trading_quote",
      "start_trade_approval",
      "decide_trade_approval",
      "get_trade_approval_status",
    ],
    gate: "Acting-login carrier required (fail-closed without one). Proposals are preview-only; execution runs only through the approval door's TradingTradeWorkflow (#2375) — the synchronous settle (executeApprovedOrder) is never a door operation.",
    notes: "Addressed to the acting user's own instance via tradingAgentName (src/agents/orchestrator/meshDoors.ts).",
  },
  {
    className: "TradingAgent",
    door: "http-routes",
    status: "exposed",
    operations: [],
    gate: "Session-authenticated trading routes; order execution through the shared approval engine (#1262).",
    notes: "Trading routes and the DO route handlers reach the class's services (executeService) per login.",
  },
  {
    className: "TradingAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "The etrade_* commands drive the E*TRADE services, not this class. " +
      NO_ACTING_LOGIN_CARRIER,
  },
  {
    className: "TradingAgent",
    door: "a2a",
    status: "exposed",
    operations: [
      "trading.screen_stocks",
      "trading.screen_options",
      "trading.trade_stock",
      "trading.trade_options",
    ],
    gate: A2A_EDGE_GATE,
    notes:
      "Resolution lands on the service instance \"trading\". The trade_* operations run the class's approval-gated service path (#2223) — exposure through this door does not bypass the approval door.",
  },
  {
    className: "TradingAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "No facet tool surface is defined on this class, and a model-driven turn on it would sit beside the approval door instead of through it. The chat reach is the typed G1/G4 door.",
  },
  // -- PaymentsAgent ------------------------------------------------------
  {
    className: "PaymentsAgent",
    door: "chat-turn",
    status: "exposed",
    operations: ["check_payment_budget", "get_payments_overview"],
    gate: "Acting-login carrier required (fail-closed without one); checks are attributed to AGENTIC_SPEND_AGENT_ID with the acting login carried as requester (#2341).",
    notes:
      "processPaidRequest is deliberately NOT on this door: the chat paid-request flow is PaymentWorkflow with a budget check first (#2378), never the raw paid request.",
  },
  {
    className: "PaymentsAgent",
    door: "http-routes",
    status: "not-exposed",
    operations: [],
    reason:
      "Payment HTTP routes and webhooks terminate on OrchestratorAgent (the payments ledger's owner); this class is reached by stub callers (the orchestrator's budget paths, ScheduledAgent) and by A2A.",
  },
  {
    className: "PaymentsAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "draft_payment / confirm_payment_draft act on the orchestrator's MAS ledger, not this class. " +
      NO_ACTING_LOGIN_CARRIER,
  },
  {
    className: "PaymentsAgent",
    door: "a2a",
    status: "exposed",
    operations: [
      "payments.budget_check",
      "payments.today_spent",
      "payments.list",
      "payments.process",
    ],
    gate: A2A_EDGE_GATE,
    notes:
      "payments.process runs the agent's own gates — budget guard, facilitator verification, idempotency — unchanged; the door adds no path around them.",
  },
  {
    className: "PaymentsAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "No facet tool surface is defined on this class; a conversational payments turn would sit beside the budget-guard-first discipline. Chat reach is the typed door plus the PaymentWorkflow path (#2378).",
  },
  // -- ScreenerAgent ------------------------------------------------------
  {
    className: "ScreenerAgent",
    door: "chat-turn",
    status: "exposed",
    operations: ["run_stock_screen", "nlq.execute"],
    gate: "The acting login is carried by the tool context's actingLogin carrier (server-stamped at queue time) and fails closed before any workflow start — through the mesh screen door since #2488 (run_stock_screen), and through the NLQ stock-screen port for the NLQ surfaces (#2369).",
    notes:
      "Reached as ScreenerScreenWorkflow execute steps (runScreen / runGoalScreen) since S8. The chat turn's own screen path is the mesh screen door since #2488 (run_stock_screen → src/agents/orchestrator/meshScreenDoor.ts): an NLQ-free door-layer service with NO direct-ScreenerAgent fallback (an unavailable workflow port is a coded refusal). The NLQ stock-screen port still serves the surfaces that bind it — the async nlq.execute capability (deterministic submitters + A2A dispatch), handleA2A, and the chat error fallback — with its direct ScreenerAgent call as ITS recorded fallback; channel NLQ deps bind no stockScreenPort, so channel screens do NOT run this workflow (they take the NLQ listings branch).",
  },
  {
    className: "ScreenerAgent",
    door: "http-routes",
    status: "exposed",
    operations: [],
    gate: "Session-authenticated screening routes.",
    notes: "Stub callers: server routes, the orchestrator, and the screener workflow's shard runner.",
  },
  {
    className: "ScreenerAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "etrade_market_scan drives the pre-mesh listings engine (ETradeService.screenMarketsAsync — raw listings rows by filter): it never starts a workflow and never addresses this class. paid_options_screener drives the paid options screening service, not this class's instance surface. run_stock_screen addresses the class's workflow path and is OrchestratorAgent-hosted (recorded on the chat-turn column); on this door it previously refused for lack of an actingLogin carrier — since #2496 the /mcp route carries the caller's edge-verified acting login, so an identified external caller can start a screen as themselves through their own instance (#2488).",
  },
  {
    className: "ScreenerAgent",
    door: "a2a",
    status: "exposed",
    operations: [
      "screener.run_screen",
      "screener.run_goal_screen",
      "screener.latest",
      "screener.history",
      "screener.list_tasks",
    ],
    gate: A2A_EDGE_GATE,
    notes:
      "Resolution requires a configured service identity and lands on the \"default\" service instance; with none configured the door fails closed rather than starting a virgin instance.",
  },
  {
    className: "ScreenerAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "No facet tool surface is defined on this class; screens execute as workflow steps and stub RPC, not as a model facet run.",
  },
  // -- ScheduledAgent -----------------------------------------------------
  {
    className: "ScheduledAgent",
    door: "chat-turn",
    status: "exposed",
    operations: ["list_scheduled_goals", "trigger_scheduled_goal"],
    gate: "Acting-login carrier required (fail-closed without one). The door mirrors the shared operator catalogue's authority; add/remove/enable stay on the session-gated routes (#2341).",
    notes: "Addressed to the singleton \"default\" instance — the live catalogue cron fires.",
  },
  {
    className: "ScheduledAgent",
    door: "http-routes",
    status: "exposed",
    operations: [],
    gate: "Session-gated /api/schedule/* routes.",
    notes: "The catalogue's management surface (add/remove/enable) lives on this door.",
  },
  {
    className: "ScheduledAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      NO_ACTING_LOGIN_CARRIER,
  },
  {
    className: "ScheduledAgent",
    door: "a2a",
    status: "exposed",
    operations: [
      "scheduled.list_goals",
      "scheduled.tick_history",
      "scheduled.add_goal",
      "scheduled.remove_goal",
      "scheduled.set_goal_enabled",
      "scheduled.trigger_goal",
    ],
    gate: A2A_EDGE_GATE,
    notes:
      "Resolution pins the live \"default\" instance — any other instance would seed a virgin catalogue and serve plausible wrong state. Catalogue mutation authority on this door is the bearer credential, the door's enforcement point (#2223, unchanged by this slice). Cron firing itself (onCron) is deliberately not an A2A operation.",
  },
  {
    className: "ScheduledAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "No facet tool surface is defined on this class; the catalogue is data + methods reached via the chat door, the routes, and A2A.",
  },
  // -- ReportAssetAgent ---------------------------------------------------
  {
    className: "ReportAssetAgent",
    door: "chat-turn",
    status: "exposed",
    operations: ["list_report_assets", "get_report_asset"],
    gate: "Acting-login carrier required (fail-closed without one); addressed to the acting user's own instance (assets:<login>).",
    notes: "Generation stays with the report pipeline and the A2A door; the chat door is the read side (#2349).",
  },
  {
    className: "ReportAssetAgent",
    door: "http-routes",
    status: "not-exposed",
    operations: [],
    reason:
      "No HTTP route terminates on this class: report serving reads the canonical mas_reports/R2 store. The class is reached by stub callers (the report pipeline, ScreenerAgent, the G1 chat door) and by A2A.",
  },
  {
    className: "ReportAssetAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "agentdb.reports.list reads the D1 read projection, not this class. " +
      NO_ACTING_LOGIN_CARRIER,
  },
  {
    className: "ReportAssetAgent",
    door: "a2a",
    status: "exposed",
    operations: ["report_asset.generate", "report_asset.get", "report_asset.list"],
    gate: A2A_EDGE_GATE,
    notes:
      "Generation is scoped to the configured service identity and fails closed without one; get is key-addressed. list (added by #2421, parity with the chat door's list since #2349) enumerates the service instance's asset metadata — bytes never ride a listing.",
  },
  {
    className: "ReportAssetAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "Method-shaped storage surface with no facet definition; reached via the chat door and A2A.",
  },
  // -- BrowserAgent -------------------------------------------------------
  {
    className: "BrowserAgent",
    door: "chat-turn",
    status: "exposed",
    operations: [
      "browser_snap_transaction",
      "browser_capture_page",
      "browser_scrape_tables",
    ],
    gate: "Acting-login carrier required (fail-closed without one). No caller-supplied webhookUrl on any door — delivery targets are env configuration only (#2351, the #2223 precedent).",
    notes: "Addressed to the fixed instance \"browser\" (the class is stateless/env-driven); results propagate verbatim, degraded labels included.",
  },
  {
    className: "BrowserAgent",
    door: "http-routes",
    status: "exposed",
    operations: [],
    gate: "SDK agent routing to the class's onRequest surface.",
    notes:
      "onRequest mirrors the A2A operations; production callers are the A2A dispatcher and the G1 chat door.",
  },
  {
    className: "BrowserAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "browser_inspect_page / browser_screenshot drive ETradeBrowserService directly, not this class. " +
      NO_ACTING_LOGIN_CARRIER,
  },
  {
    className: "BrowserAgent",
    door: "a2a",
    status: "exposed",
    operations: [
      "browser.snap_transaction",
      "browser.capture_page",
      "browser.scrape_tables",
    ],
    gate: A2A_EDGE_GATE,
    notes:
      "The door never accepts or forwards a caller-supplied webhookUrl — delivery targets are env configuration only (the #2223 precedent, held on every door since #2351).",
  },
  {
    className: "BrowserAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "Stateless method surface with deliberately unset port hooks; no facet definition exists to delegate.",
  },
  // -- SlackAgent ---------------------------------------------------------
  {
    className: "SlackAgent",
    door: "chat-turn",
    status: "exposed",
    operations: ["slack_send_pre_trade_approval", "slack_dispatch_transaction_snap"],
    gate: "Acting-login carrier required (fail-closed without one). The approval-ticket operation posts the HITL gate — it approves and executes nothing. No caller-supplied webhookUrl.",
    notes: "Addressed to the fixed instance \"slack\"; only the class's two outbound helpers are on this door (#2351).",
  },
  {
    className: "SlackAgent",
    door: "http-routes",
    status: "exposed",
    operations: [],
    gate: "Slack signing secret via gateSlackRequest — mandatory (unconfigured → 503, bad signature → 401, 5-minute replay window).",
    notes:
      "Since S13 (#2412) the SDK-routed /agents/slack-agent/* ingress runs the one shared channel handler on this class; production ingress primarily terminates on per-team OrchestratorAgent instances running the same handler (see MESH_CHANNELS).",
  },
  {
    className: "SlackAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "Slack ingress is a channel (MESH_CHANNELS), not an MCP surface. " +
      NO_ACTING_LOGIN_CARRIER,
  },
  {
    className: "SlackAgent",
    door: "a2a",
    status: "exposed",
    operations: ["slack.send_pre_trade_approval", "slack.dispatch_transaction_snap"],
    gate: A2A_EDGE_GATE,
    notes:
      "Outbound helpers only — Slack event/command ingress is NOT served on this door; it stays behind the signature-gated channel routes. The no-caller-supplied-webhookUrl rule holds here as on every door (#2351).",
  },
  {
    className: "SlackAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "The outbound helpers are method-shaped and ingress is channel-hosted; no facet definition exists to delegate.",
  },
  // -- AiSearchAgent ------------------------------------------------------
  {
    className: "AiSearchAgent",
    door: "chat-turn",
    status: "exposed",
    operations: ["ai_search_agent_search"],
    gate: "Threads the turn's session login as callerLogin; report-type results are served only to their owner (#2250).",
    notes:
      "A catalog command, not a mesh-door command — the turn already had this typed reach before G1, so no second door was built (#2351).",
  },
  {
    className: "AiSearchAgent",
    door: "http-routes",
    status: "not-exposed",
    operations: [],
    reason:
      "Search HTTP routes drive the MAS/service paths (POST /search/mas, ETradeAISearchService); the class is reached via the catalog command (chat + MCP) and A2A.",
  },
  {
    className: "AiSearchAgent",
    door: "mcp",
    status: "exposed",
    operations: ["ai_search_agent_search"],
    gate: "MCP permission scopes (#1744) at the /mcp route + executor; the command owner-checks report-type results against the caller login its context carries.",
    notes: "The same catalog command serves the chat turn (discovered via the SDK MCP client, #2496) and the external MCP surface — one registry, and since #2496 one enforcement surface: both arrive at the instance's /mcp route (registry MESH_DOORS).",
  },
  {
    className: "AiSearchAgent",
    door: "a2a",
    status: "exposed",
    operations: ["aisearch.search"],
    gate: A2A_EDGE_GATE,
    notes: "Three-path search (namespace binding / instance MCP / REST) with honest degradation labels (src/agents/aiSearchPaths.ts).",
  },
  {
    className: "AiSearchAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "Turn-capable class, but no facet delegation from the orchestrator exists, and adding one is a behavior change, not an exposure fix. Its doors are the catalog command (chat + MCP) and A2A.",
  },
  // -- TickerAgent --------------------------------------------------------
  {
    className: "TickerAgent",
    door: "chat-turn",
    status: "not-exposed",
    operations: [],
    reason:
      "The tape is a client-facing broadcast; a chat turn holds no subscription to it. In-turn quote reads come from the market-data commands over the quote services.",
  },
  {
    className: "TickerAgent",
    door: "http-routes",
    status: "exposed",
    operations: [],
    gate: "None by design — the tape is public (no auth and no audit, survey M10); that posture is the capability's own, recorded here rather than silently inherited.",
    notes:
      "The WebSocket route /api/market/quotes/ws (+ /api/market-data/ and /api/foss/ aliases) terminates on the single shared \"ticker\" instance: subscribe → snapshot, 5s ticks, per-connection state.",
  },
  {
    className: "TickerAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "No catalog command addresses this class; quote reads exist as market-data commands over the services.",
  },
  {
    className: "TickerAgent",
    door: "a2a",
    status: "not-exposed",
    operations: [],
    reason:
      "The capability is a streaming, per-connection WebSocket broadcast — A2A's authenticated request/response dispatch cannot carry it, and putting the bearer gate in front of a deliberately public tape would change the capability's gate rather than carry it. Quote reads are already served on the MCP and HTTP doors.",
  },
  {
    className: "TickerAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "No turn ever runs on this class (its turn facet is inert by design, #2230); there is no facet to delegate.",
  },
  // -- SandboxAgent -------------------------------------------------------
  {
    className: "SandboxAgent",
    door: "chat-turn",
    status: "not-exposed",
    operations: [],
    reason:
      "run_sandbox_command reaches the sandbox capability by constructing ETradeSandboxService directly — this class is not wired to that command (the recorded #2253 follow-up). The capability's result is identical either way today, because the agent delegates to the same service construction; the gap is class wiring, not capability.",
  },
  {
    className: "SandboxAgent",
    door: "http-routes",
    status: "exposed",
    operations: [],
    gate: "SDK agent routing to the class's onRequest surface.",
    notes:
      "onRequest serves /health (the status surface) and POST /run, mirroring BrowserAgent; production capability traffic still arrives via the MCP facade's direct service construction (see the chat-turn entry).",
  },
  {
    className: "SandboxAgent",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "Same class-wiring gap as the chat turn: run_sandbox_command is in the catalog (cloudflare-agent-mcp-commands family) but constructs ETradeSandboxService directly; wiring it through this class is the recorded #2253 follow-up.",
  },
  {
    className: "SandboxAgent",
    door: "a2a",
    status: "exposed",
    operations: ["sandbox.status", "sandbox.run_command"],
    gate: A2A_EDGE_GATE,
    notes:
      "Added by #2421 — the #2253/S1 recorded follow-up (dispatch: src/agents/sandboxA2aDispatch.ts). Credential posture since S16 (#2426): this surface has its own mesh credential (A2A_TOKEN_SANDBOX), with the shared token as its transitional fallback, like every A2A surface. Results carry the service's degraded posture verbatim: with no container backend bound, run_command returns executed:false — never emulated, never fabricated. Input parity with the other doors: { command, timeoutMs } only; envVars/workingDir are accepted on no door and are not accepted here.",
  },
  {
    className: "SandboxAgent",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "The class defines no chat behavior and no facet (deliberately unset port hooks, #2253); its doors are its methods, onRequest, and A2A.",
  },
  // -- SessionStore -------------------------------------------------------
  {
    className: "SessionStore",
    door: "chat-turn",
    status: "not-exposed",
    operations: [],
    reason:
      "Credential/session store: no invocation surface on any door, by design — exposing session or broker-token storage to a turn would break the fleet's credential boundary.",
  },
  {
    className: "SessionStore",
    door: "http-routes",
    status: "not-exposed",
    operations: [],
    reason:
      "Reached by internal stub fetch from server/agent code only; no route terminates on it and none may.",
  },
  {
    className: "SessionStore",
    door: "mcp",
    status: "not-exposed",
    operations: [],
    reason:
      "The credential boundary again: no command surface over session/broker-token storage exists or may be added.",
  },
  {
    className: "SessionStore",
    door: "a2a",
    status: "not-exposed",
    operations: [],
    reason:
      "The credential boundary again: it publishes no card and no resolution, deliberately — A2A callers authenticate with credentials this store's contents must never become reachable through.",
  },
  {
    className: "SessionStore",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason:
      "Not an agent and not a capability: it is the identity substrate the other classes stand on.",
  },
  // -- OptionsScannerMCP --------------------------------------------------
  {
    className: "OptionsScannerMCP",
    door: "chat-turn",
    status: "not-exposed",
    operations: [],
    reason:
      "OUT of mesh scope per #2225 (no changes to this class in the programme); it is not part of the turn's tool registry.",
  },
  {
    className: "OptionsScannerMCP",
    door: "http-routes",
    status: "not-exposed",
    operations: [],
    reason:
      "No plain HTTP route surface distinct from its MCP transport. OUT of mesh scope per #2225.",
  },
  {
    className: "OptionsScannerMCP",
    door: "mcp",
    status: "exposed",
    operations: [],
    gate: "x402 payment gate — the class's own paid surface.",
    notes:
      "The class IS an MCP server (the paid options scanner); its tool surface is its own and is recorded here for census completeness — OUT of mesh scope per #2225, unaltered by this slice.",
  },
  {
    className: "OptionsScannerMCP",
    door: "a2a",
    status: "not-exposed",
    operations: [],
    reason: "It is an MCP server, not an A2A agent. OUT of mesh scope per #2225.",
  },
  {
    className: "OptionsScannerMCP",
    door: "agent-as-a-tool",
    status: "not-exposed",
    operations: [],
    reason: "OUT of mesh scope per #2225; no facet relationship exists.",
  },
];

// ---------------------------------------------------------------------------
// Trace spine (S17, #2428, programme G13a) — the unified trace:
// one W3C trace id (#1743) carried across doors, workflows, and
// agents. Each entry names one hop: carried (with its carrier
// and where the hop is recorded) or break (a hop that cannot
// carry the id today, with the consequence — a recorded trace
// break, never a fabricated link). Hop records live in AgentDB
// `agent_mesh_trace_hops` (migration 0023) behind the
// src/data/meshTracePorts.ts port, are emitted to the ADR 0011
// observability stream per hop, and are assembled by the
// `agentdb.trace.get` read command. tests/mesh_traces_s17_2428
// .test.ts pins this record against the carriers in code.
// ---------------------------------------------------------------------------

export interface MeshTraceSpineEntry {
  /** The hop kind (src/data/meshTracePorts.ts MESH_TRACE_HOP_KINDS), or the name of an unjoined leg for a break. */
  hop: string;
  status: "carried" | "break";
  /** How the trace id travels at this hop (carried only). */
  carrier?: string;
  /** Where the hop is recorded (carried only). */
  evidence?: string;
  /** Why the leg cannot join today, and the consequence (break only). */
  consequence?: string;
}

export const MESH_TRACE_SPINE: MeshTraceSpineEntry[] = [
  {
    hop: "ingress",
    status: "carried",
    carrier:
      "W3C traceparent header, continued or minted at the boundary (#1743 traceContextFromHeaders / withRequestObservability); the A2A edge continues or mints per call (src/a2a/index.ts).",
    evidence: "Observability stream (http.request + mesh.trace.hop events); A2A ingress hop recorded as kind \"a2a\".",
  },
  {
    hop: "turn",
    status: "carried",
    carrier:
      "Minted lazily on the OrchestratorAgent turn stash (turnTraceparent()) and shared by every consumer of the turn; carried to native turn tools via ChatTurnHelpersContext.turnTraceparent → McpToolContext.traceparent, and to the discovered MCP tools as the traceparent header the SDK loopback carrier stamps per call (src/agents/orchestrator/meshMcpClient.ts).",
    evidence: "Hop recorded at mint (kind \"turn\", caller = the turn's userLogin) in agent_mesh_trace_hops.",
  },
  {
    hop: "door",
    status: "carried",
    carrier:
      "McpToolContext.traceparent resolver, read by every mesh door command before dispatch (src/mcps/openaimp/meshDoorCommands.ts recordDoorHop), under the S5 server-side-only carrier discipline — never a tool argument.",
    evidence: "Hop per door call (kind \"door\", caller = acting login, agent = door target class).",
  },
  {
    hop: "job-queue",
    status: "carried",
    carrier:
      "Stamped into the mcp.tool async-job payload at queue time, server-side: since #2496 by the openaimp handler (src/mcps/openaimp/handler.ts) from the route-threaded traceparent carrier — the SDK loopback carrier sets that header from the turn stash, and external callers may supply their own W3C traceparent; before #2496 the turn adapter (McpAgentToolAdapter) stamped it from the turn context (mirrors the S5 actingLogin stamp).",
    evidence: "Hop at queue time (kind \"job-queue\", jobId = the queued job's id).",
  },
  {
    hop: "job-execute",
    status: "carried",
    carrier:
      "Re-supplied by the async-job executor from the payload stamp into executeMCPTool's traceparent carrier (src/agents/orchestrator/asyncJobs.ts), mirroring actingLogin.",
    evidence: "Hop at execution (kind \"job-execute\", jobId = the job's id).",
  },
  {
    hop: "workflow-start",
    status: "carried",
    carrier:
      "WorkflowJobCommand.traceparent (#1743's field, producer-stamped by buildChatScreenCommand from the turn resolver) through WorkflowPort.start; the paid path's PaymentWorkflow submission carries the identical command.",
    evidence: "Hop at start (kind \"workflow-start\", jobId = the run's jobId, operations screener.start / payment.start).",
  },
  {
    hop: "workflow-step",
    status: "carried",
    carrier:
      "The command's traceparent, inherited by shard commands via shardCommandFor's parent spread; step hops derive deterministic spans from (jobId, step name) so durable replay converges.",
    evidence: "Hops per completed step (kind \"workflow-step\") recorded by the screener flow's traceHop dep, wired in screenerWorkflow.ts buildDeps.",
  },
  {
    hop: "projection",
    status: "carried",
    carrier:
      "The trace's mapped jobId joins the D1 projection directly: assembly folds agent_shard_jobs rows for the jobId in as projection hops, and the flow records project-shard / project-final hops under the same trace.",
    evidence: "Projection rows (read via readJobHistory) + recorded hops (kind \"projection\").",
  },
  {
    hop: "a2a",
    status: "carried",
    carrier:
      "Traceparent header at the A2A edge (continued or minted), handed into handleA2A as the fourth argument beside the S16 attribution (src/a2a/index.ts).",
    evidence: "Hop at the edge (kind \"a2a\", caller = a2a-credential:<surface> or shared-transitional, agent = the surface).",
  },
  {
    hop: "ledger",
    status: "carried",
    carrier:
      "PaymentsAgent A2A path only: edge traceparent → dispatch deps → PaymentsProcessRequest.traceId → the ledger forward body → the ledger owner's payments_agent.recorded audit payload (shape-checked at the route).",
    evidence: "Audit payload carries traceId beside the S16 caller; hop recorded at the ledger route (kind \"ledger\", deterministic span on the idempotency key).",
  },
  {
    hop: "trading-workflow-steps",
    status: "break",
    consequence:
      "TradingTradeWorkflow's params carry no traceparent field (the S9 approval door starts it from TradingAgent, not from a traced command), so a chat trade's trace ends at the door/start hops: the trade run's internal steps cannot join the turn's trace until the workflow's params grow the field (a TradingAgent-slice change, not an instrumentation shim here). Assembly reports the trade trace as far as the door.",
  },
  {
    hop: "payment-workflow-steps",
    status: "break",
    consequence:
      "PaymentWorkflow's internal steps (gate, ledger record inside the workflow, screener start) record no step hops: the S10 path's trace covers the port's payment.start hop and the screener run it starts (whose command carries the traceparent), but the payment run's own step spans are not yet recorded, so assembly shows the payment leg as its start hop plus the screener leg.",
  },
  {
    hop: "http-route-workflow-starts",
    status: "break",
    consequence:
      "Route-originated workflow starts (goalScreenWorkflowSubmission and the scheduled starters) build their commands outside a turn and stamp no traceparent: withRequestObservability mints an ingress trace for the request's observability event but no handler receives it, so route-started runs are untraced end to end. Consequence: their runs appear in no trace assembly until a starter threads the ingress trace into its command.",
  },
  {
    hop: "channel-ingress-turns",
    status: "break",
    consequence:
      "Channel ingresses that drive services directly (email/voice trading paths, the NLQ webhook) never enter an OrchestratorAgent turn stash, so no turn trace is minted for them: their work is auditable through mas_events and the channel records, but it does not join the mesh trace spine until those paths route through a traced turn or mint at their own ingress.",
  },
];

export const MESH_NON_RENAMES: MeshNonRenameEntry[] = [
  {
    names: ["SearchAgent", "SearchHub", "SearchAgentTab"],
    decision:
      "Recorded non-rename: SearchHub and SearchAgentTab (src/client/search/) are UI names for the /search/agent REST surface — a different thing from the orchestrator Durable Object class (OrchestratorAgent since the #2523 rename; SearchAgent before it). Neither side is renamed for the other.",
    source: "mesh survey §5",
  },
];

// ---------------------------------------------------------------------------
// Typed accessors — the queryable shape later slices consume.
// ---------------------------------------------------------------------------

export const MESH_REGISTRY = {
  agents: MESH_AGENTS,
  surfaces: MESH_SURFACES,
  identities: MESH_IDENTITIES,
  channels: MESH_CHANNELS,
  toolFamilies: MESH_TOOL_FAMILIES,
  doors: MESH_DOORS,
  workflows: MESH_WORKFLOWS,
  capabilityDoors: MESH_CAPABILITY_DOORS,
  traceSpine: MESH_TRACE_SPINE,
  nonRenames: MESH_NON_RENAMES,
} as const;

export function getAgentByClass(className: string): MeshAgentEntry | undefined {
  return MESH_AGENTS.find((a) => a.className === className);
}

export function getAgentByBinding(binding: string): MeshAgentEntry | undefined {
  return MESH_AGENTS.find((a) => a.bindings.includes(binding));
}

export function getSurface(name: string): MeshSurfaceEntry | undefined {
  return MESH_SURFACES.find((s) => s.name === name);
}

export function getIdentityRecord(className: string): MeshIdentityRecord | undefined {
  return MESH_IDENTITIES.find((r) => r.className === className);
}

export function surfacesForClass(className: string): MeshSurfaceEntry[] {
  return MESH_SURFACES.filter((s) => s.ownerClass === className);
}

export function getChannel(id: MeshChannelEntry["id"]): MeshChannelEntry | undefined {
  return MESH_CHANNELS.find((c) => c.id === id);
}

export function getToolFamily(id: string): MeshToolFamilyEntry | undefined {
  return MESH_TOOL_FAMILIES.find((f) => f.id === id);
}

/** Map of every McpToolFactory command name to the family that owns it. */
export function mcpCommandOwners(): Map<string, string> {
  const owners = new Map<string, string>();
  for (const family of MESH_TOOL_FAMILIES) {
    for (const command of family.commands) owners.set(command, family.id);
  }
  return owners;
}

export function getDoor(id: MeshDoorEntry["id"]): MeshDoorEntry | undefined {
  return MESH_DOORS.find((d) => d.id === id);
}

export function getWorkflowByBinding(binding: string): MeshWorkflowEntry | undefined {
  return MESH_WORKFLOWS.find((w) => w.binding === binding);
}

/** One census cell: a class's reach through one door (S15, #2421). */
export function capabilityDoor(
  className: string,
  door: MeshDoorEntry["id"],
): MeshCapabilityDoorEntry | undefined {
  return MESH_CAPABILITY_DOORS.find(
    (e) => e.className === className && e.door === door,
  );
}

/** Every census cell for one class, in door order. */
export function capabilityDoorsForClass(className: string): MeshCapabilityDoorEntry[] {
  return MESH_CAPABILITY_DOORS.filter((e) => e.className === className);
}

/** The classes exposed on one door (S16's per-door inventory). */
export function classesExposedOn(door: MeshDoorEntry["id"]): string[] {
  return MESH_CAPABILITY_DOORS.filter(
    (e) => e.door === door && e.status === "exposed",
  ).map((e) => e.className);
}

// ---------------------------------------------------------------------------
// G12 proof record (S18, #2439) — S15 built the census above and
// recorded the programme constraint that G12 is claimed proven
// only when S18 lands. S18 landed the golden-task eval harness
// (src/services/meshGoldenTasks.ts): every task in its catalog
// names an EXPOSED cell of this census and drives that cell's
// real door path (fakes only at binding seams), including the
// census-recorded gate behavior — refusals are golden outcomes.
// Scored results are recorded in the eval result store
// (agent_mesh_eval_results), where S19's RSI loop reads them.
//
// The claim's scope is exactly the catalog: all five doors are
// exercised, across the cells the catalog enumerates. A census
// cell the catalog does not name is NOT proven by this record —
// exposure for those cells still rests on the S15 parity pins,
// as it did before S18.
// ---------------------------------------------------------------------------

export const MESH_G12_PROOF = {
  status: "proven",
  issue: 2439,
  catalog: "src/services/meshGoldenTasks.ts (MESH_GOLDEN_TASKS)",
  suites: [
    "tests/mesh_golden_tasks_s18_2439.test.ts",
    "tests/mesh_golden_http_s18_2439.test.ts",
  ],
  store: "agent_mesh_eval_results",
  doors: ["chat-turn", "http-routes", "mcp", "a2a", "agent-as-a-tool"],
  scope:
    "Proven for the census cells the golden catalog enumerates, at binding-seam fidelity; unenumerated cells rest on the S15 parity pins.",
} as const;

// ---------------------------------------------------------------------------
// Skills-packaging assessment (S19, #2460) — the owner addition
// on #2225 (comment 6517280689) asked whether Agents SDK Skills
// are the RSI loop's knowledge-packaging format. This record is
// the decision-grade answer. It is an ASSESSMENT ONLY: S14
// recorded the agent-skills tool family ABSENT and the G7 matrix
// records the skills aspect GAP for every PortThink agent, and
// both records stand unchanged — adoption is a separate
// owner-sequenced decision after this programme, and this slice
// builds no adoption machinery (no getSkills override, no skill
// source, no binding).
// ---------------------------------------------------------------------------

export const MESH_SKILLS_ASSESSMENT = {
  issue: 2460,
  question:
    "Agents SDK Skills (SKILL.md packs, loaded on demand via Think.getSkills()) as the RSI improvement loop's knowledge-packaging format — the format in which the loop's accumulated know-how (calibration notes, door playbooks, evaluation findings) would be carried to future turns.",
  recommendation: "adopt-as-packaging",
  adoptionState:
    "deferred — adoption itself is an owner-gated decision for the post-programme harness discussion; this record recommends the format for when that decision is taken, and adopts nothing now",
  fits: [
    "A SKILL.md pack is a plain file in the repository: versioned, diffable, and reviewable through the same gitops gate (issue → PR → CI → merge) that the loop already writes back through — packaging knowledge as packs keeps the loop's only write path the gated repository (doors-and-layers §7.4).",
    "The RSI loop's knowledge products are procedural know-how in prose — how a door behaves, what a falsified thesis taught, how a golden task is diagnosed — which is exactly the shape a skill pack carries (instructions plus bundled resources), unlike the registry (facts) or the eval store (outcomes).",
    "The adapter is already present in the pinned SDK (@cloudflare/think 0.23.0's Think.getSkills(), inherited through PortThink), so packaging in this format does not pre-commit to a vendor-specific store: sources may be code-manifest (in-repo) packs, which is the source shape that keeps packs under repository review.",
  ],
  doesNotFit: [
    "A skill is instructions the model follows — it is not evidence and not enforcement. Gates, budgets, falsification criteria, and the evidence bar stay in deterministic code and the registry; anything safety-relevant must never live only in a pack, because a pack cannot refuse anything.",
    "A pack is consumed at turn time by a model, so its content is guidance, not a record: the loop's evidence (traces, eval outcomes, ledger rows) remains the system of record, and a pack that disagrees with the record is simply wrong prose until a gated change fixes it.",
    "Fleet adoption is not a flip: the skills aspect is GAP for all 12 PortThink agents (matrix), adoption is a per-class getSkills() override plus a chosen source, and whether the port's adapter-driven turn surfaces Think's skills tools end-to-end is still unverified (the S14 conformance caveat).",
  ],
  controlPoint:
    "Source write-access is the control point: a skill is instructions the model follows, so a pack is only as trustworthy as the review that merged it. In-repo (code-manifest) packs inherit the repository's review; an out-of-repo source (an R2 bucket, a workspace directory) would move the control point to that store's write ACL and would need its own owner decision and gate story before use.",
  consistency:
    "Consistent with S14 (#2417): the agent-skills tool family in this registry remains ABSENT and the matrix's skills GAP cells are unchanged by this assessment. The recommendation names a format for a future adoption decision; it is not adoption.",
} as const;
