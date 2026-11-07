/**
 * Issue #3489 (Uniform Copilot Standard S1, epic #3488) — the
 * PortThink capability spine: a typed, config-resolved capability
 * manifest for every agent class on the port.
 *
 * The standard (owner doctrine, 2026-11-06): a user must be able to
 * invoke any copilot through any channel; each copilot acts as an
 * MCP client, is schedulable, maintains its own state, logs and
 * surfaces its lifecycle, supports websockets, and carries the
 * per-agent tools (workspace, sandbox, browser, web fetch, web
 * search, AI Search, payments, observability) — all enabled through
 * externalized configuration (the AOP mandate). This module is the
 * spine that makes that a checkable property of the fleet: three
 * families, eighteen capabilities, one state vocabulary, resolved
 * from externalized config in the #2419 idiom (optional env vars
 * documented on the Env type; absence = doctrine defaults).
 *
 * TRUTHFUL STATES — the standing rule of this module. A state is a
 * claim about the CURRENT code on the PINNED SDK (agents 0.32.0 /
 * @cloudflare/think 0.23.0), verified against the pinned packages'
 * type surface and repo evidence, never against the docs alone:
 *
 *  - enabled: the capability is live for this class today.
 *  - disabled-by-config: live, but an externalized override
 *    (AGENT_CAPABILITIES_DISABLED) turns it off for this class.
 *    Config can only ever disable — it can never fabricate a
 *    capability the code does not implement.
 *  - unavailable: implemented, but the deployment lacks a named
 *    prerequisite (a secret, a binding, a backend) — the capability
 *    fails loud at use with the named reason, in the #3474 posture
 *    (THINK_WEBHOOK_SECRET unset => the webhook channel answers
 *    503 rather than pretending to listen).
 *  - not-implemented: no wiring exists yet; the entry names the
 *    slice of epic #3488 that lands it. Honest absence, never a
 *    silent gap: every family member is present in every manifest.
 *
 * Pinned-SDK verification (2026-11-06, against the installed
 * packages — the docs describe this same generation, and the pins
 * below record where the pinned surface and the repo diverge):
 *  - agents 0.32.0 Agent carries the documented substrate:
 *    `lifecycle` (agents/lifecycle: Lifecycle.install/use),
 *    `mcp` (MCPClientManager: addMcpServer/getAITools), `state` /
 *    `setState` / `validateStateChange` / `onStateChanged`,
 *    `schedule` / `scheduleEvery`, `getConnections`, and the email
 *    ingress (`routeAgentEmail` + the `_onEmail` override point).
 *    `agents/voice` exports the `withVoice` mixin; `agents/email`
 *    exports the resolvers. None of the channel mixins/hooks are
 *    adopted by any fleet class yet — adoption is S2/S3/S5's work,
 *    and the manifest says so per class.
 *  - @cloudflare/think 0.23.0 gives every Think agent a workspace
 *    (`workspace: ThinkWorkspace`, defaulting to a
 *    @cloudflare/computer Workspace over the DO's storage) and
 *    merges the workspace tools into every turn — so `workspace`
 *    is enabled by construction fleet-wide, and S7 (#3491) is
 *    about surfacing/configuring it through the port, not creating
 *    it.
 *
 * This module is a pure seam in the thinkPortMapping/pollingConfig
 * style: no runtime imports beyond the webhook-secret resolver, no
 * env access at import time, resolution never throws (malformed
 * config is collected into `configIssues` and surfaced, in the
 * repo's fail-visible posture). The fleet registry
 * (src/agents/registry.ts) re-exports the resolver as
 * capabilitiesForClass, and the S20 Agents view joins the resolved
 * manifest onto each registry entry.
 */
import {
  THINK_WEBHOOK_SECRET_ENV,
  resolveThinkWebhookSecret,
} from "./thinkPortMapping";

// ---------------------------------------------------------------------------
// The three families and the state vocabulary
// ---------------------------------------------------------------------------

/** Channels: the Agents-docs communication channels (wave 1). */
export const CAPABILITY_CHANNELS = [
  "chat",
  "webhooks",
  "email",
  "slack",
  "voice",
] as const;
export type CapabilityChannelId = (typeof CAPABILITY_CHANNELS)[number];

/** Runtime capabilities: what every copilot must be able to do (wave 1). */
export const CAPABILITY_RUNTIME = [
  "mcpClient",
  "scheduler",
  "state",
  "lifecycle",
  "webSockets",
] as const;
export type CapabilityRuntimeId = (typeof CAPABILITY_RUNTIME)[number];

/** Tools: the per-agent tool family (wave 2). */
export const CAPABILITY_TOOLS = [
  "workspace",
  "sandbox",
  "browser",
  "webFetch",
  "webSearch",
  "aiSearch",
  "payments",
  "observability",
] as const;
export type CapabilityToolId = (typeof CAPABILITY_TOOLS)[number];

export type CapabilityId =
  | CapabilityChannelId
  | CapabilityRuntimeId
  | CapabilityToolId;

export const ALL_CAPABILITY_IDS: readonly CapabilityId[] = [
  ...CAPABILITY_CHANNELS,
  ...CAPABILITY_RUNTIME,
  ...CAPABILITY_TOOLS,
];

const CAPABILITY_ID_SET: ReadonlySet<string> = new Set(ALL_CAPABILITY_IDS);

export type CapabilityState =
  | "enabled"
  | "disabled-by-config"
  | "unavailable"
  | "not-implemented";

export interface CapabilityEntry {
  state: CapabilityState;
  /** The evidence for the state — what provides it, or what is missing. */
  note: string;
  /**
   * Deployment prerequisite (env var or binding name) the capability
   * needs, when one exists. Recorded always; EVALUATED only when a
   * resolution is given an env to evaluate against.
   */
  prerequisite?: string;
  /** Named fail-loud reason; present exactly when state is "unavailable". */
  unavailableReason?: string;
  /** The raw override entry that disabled this capability, when disabled. */
  disabledBy?: string;
}

export interface AgentCapabilityManifest {
  className: string;
  /** wrangler DO binding names for the class (override scopes match these). */
  bindings: string[];
  channels: Record<CapabilityChannelId, CapabilityEntry>;
  capabilities: Record<CapabilityRuntimeId, CapabilityEntry>;
  tools: Record<CapabilityToolId, CapabilityEntry>;
  /** Malformed override entries from config — surfaced, never dropped. */
  configIssues: string[];
}

// ---------------------------------------------------------------------------
// Externalized configuration (AOP, #2419 idiom)
// ---------------------------------------------------------------------------

/**
 * The one externalized override var: comma-separated
 * `<scope>:<capability>` entries naming capabilities DISABLED by
 * deployment config. Scope is an agent class name, one of its
 * wrangler binding names, or `*` (every class). Absence = doctrine
 * defaults (enabled unless explicitly disabled). An entry can only
 * move an `enabled` capability to `disabled-by-config` — it never
 * enables, never re-enables, and never masks a deployment fact (an
 * `unavailable` capability stays unavailable). Declared on the Env
 * type in src/types.ts; set explicitly EMPTY in wrangler.jsonc
 * since #3727 — externalized, with nothing disabled (the fleet
 * ships fully enabled; a deployment opts a capability out only by
 * naming it here).
 */
export const AGENT_CAPABILITIES_DISABLED_ENV = "AGENT_CAPABILITIES_DISABLED";

export interface CapabilityDisabledEntry {
  scope: string;
  capability: CapabilityId;
}

export function parseCapabilityDisabledList(raw: string | null | undefined): {
  entries: CapabilityDisabledEntry[];
  issues: string[];
} {
  const entries: CapabilityDisabledEntry[] = [];
  const issues: string[] = [];
  if (raw === null || raw === undefined) return { entries, issues };
  for (const part of String(raw).split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep <= 0 || sep === trimmed.length - 1) {
      issues.push(
        `${AGENT_CAPABILITIES_DISABLED_ENV}: malformed entry "${trimmed}" (expected "<scope>:<capability>")`,
      );
      continue;
    }
    const scope = trimmed.slice(0, sep).trim();
    const capability = trimmed.slice(sep + 1).trim();
    if (!scope || !CAPABILITY_ID_SET.has(capability)) {
      issues.push(
        `${AGENT_CAPABILITIES_DISABLED_ENV}: unknown capability in entry "${trimmed}"`,
      );
      continue;
    }
    entries.push({ scope, capability: capability as CapabilityId });
  }
  return { entries, issues };
}

// ---------------------------------------------------------------------------
// Base postures — the checked projection of the fleet as it stands.
//
// FLEET_DEFAULT_POSTURE is what an unremarkable PortThink class
// truthfully reports. PORT_THINK_CAPABILITY_BASE carries one
// EXPLICIT record per fleet class (an empty record = "the defaults,
// deliberately reviewed for this class"); the conformance suite
// (tests/capability_spine_s1_3489.test.ts) fails any inventoried
// PortThink class without one, so a future class cannot ship
// without its capability posture being a deliberate act.
// ---------------------------------------------------------------------------

const entry = (
  state: CapabilityState,
  note: string,
  extra?: Partial<CapabilityEntry>,
): CapabilityEntry => ({ state, note, ...extra });

const FLEET_DEFAULT_POSTURE: Record<CapabilityId, CapabilityEntry> = {
  chat: entry(
    "not-implemented",
    "No chat terminus is wired for this class: the fleet's chat surface terminates at OrchestratorAgent. The Think turn pipeline exists by construction (@cloudflare/think 0.23.0), but nothing routes user chat to this class.",
  ),
  webhooks: entry(
    "enabled",
    "Exposed by PortThink by default (#3474): fetch intercepts the reserved /webhooks/<source> tail, verifies HMAC-SHA256 over the raw body, and dispatches to the port hooks' onWebhook. No fleet class defines onWebhook yet, so deliveries are refused (405) until a class opts in.",
    { prerequisite: THINK_WEBHOOK_SECRET_ENV },
  ),
  email: entry(
    "not-implemented",
    "No email hook exists on the port. The pinned SDK surface exists (agents 0.32.0: routeAgentEmail + the Agent._onEmail override point) but no class wires it; the platform's email traffic runs through the #1262 Worker forwarder pipeline, which is not this capability. Lands as S2 (#3490).",
  ),
  slack: entry(
    "not-implemented",
    "This class is not a Slack host. Slack ingress runs the shared channel handler (src/agents/routes/tradingIntegrations.ts) on OrchestratorAgent (production) and SlackAgent (SDK-routed) only; the uniform invocation surface is S5.",
  ),
  voice: entry(
    "not-implemented",
    "No voice capability on the port. The pinned SDK offers the withVoice mixin (agents 0.32.0, agents/voice) but no class adopts it; the platform's voice surface is the #1262 NLQ voice pipeline, not a per-agent voice channel. Lands as S3.",
  ),
  mcpClient: entry(
    "not-implemented",
    "Not wired for this class. The SDK client manager exists on the base Agent (agents 0.32.0: this.mcp, addMcpServer, getAITools) but no server is registered through it here; MCP-client as a port capability lands as S4.",
  ),
  scheduler: entry(
    "enabled",
    "Schedulable by construction: the Agents SDK scheduler is on the base (agents 0.32.0: schedule/scheduleEvery, dispatched by method name through the lifecycle job queue) and the port exposes it as ActorSchedulePort; Think classes may also declare tasks via getScheduledTasks.",
  ),
  state: entry(
    "enabled",
    "Every agent maintains its own state: Durable Object storage behind the port's ActorStatePort, plus the base Agent's state/setState with its websocket broadcast (agents 0.32.0).",
  ),
  lifecycle: entry(
    "enabled",
    "The SDK lifecycle is installed on the base Agent (agents 0.32.0: this.lifecycle, onStart once per in-memory lifetime). Uniform lifecycle logging and registry surfacing land as S6.",
  ),
  webSockets: entry(
    "enabled",
    "Native to the Agent base (agents 0.32.0): websocket upgrades, hibernation, connection tags, and the setState broadcast to connected clients.",
  ),
  workspace: entry(
    "enabled",
    "Provided by the base class: @cloudflare/think 0.23.0 gives every Think agent a workspace (this.workspace — a @cloudflare/computer Workspace over the Durable Object's storage) and merges the workspace tools into every turn. Not yet surfaced or configured through the port — S7 (#3491).",
  ),
  sandbox: entry(
    "not-implemented",
    "No per-agent sandbox for this class: code execution lives in the dedicated SandboxAgent. A per-agent sandbox tool lands as S8 (#3492).",
  ),
  browser: entry(
    "not-implemented",
    "No per-agent browser for this class: browsing lives in the dedicated BrowserAgent. A per-agent browser tool lands as S9 (#3493).",
  ),
  webFetch: entry(
    "not-implemented",
    "The web_fetch tool exists on the platform surface (src/services/webFetch.ts, #2760) but is not wired as a per-agent capability for this class. Port-level availability lands as S10 (#3494).",
  ),
  webSearch: entry(
    "not-implemented",
    "The web_search tool exists on the platform surface (src/services/webSearch.ts, #2731) but is not wired as a per-agent capability for this class. Port-level availability lands as S11 (#3495).",
  ),
  aiSearch: entry(
    "not-implemented",
    "This class does not query AI Search. The fleet's AiSearchAgent fronts the instance; per-agent retrieval lands as S13 (#3497).",
  ),
  payments: entry(
    "not-implemented",
    "This class exposes no priced capability. Payments run through the CBO price-catalogue gate on the classes that expose them; payments as a uniform port capability lands as S14 (#3498).",
  ),
  observability: entry(
    "not-implemented",
    "No uniform per-agent behavior emission yet: aspect interceptors (#1743) and the audit history exist at platform call sites, not as a per-agent contract. Lands as S15 (#3499).",
  ),
};

export const PORT_THINK_CAPABILITY_BASE: Record<
  string,
  Partial<Record<CapabilityId, CapabilityEntry>>
> = {
  OrchestratorAgent: {
    chat: entry(
      "enabled",
      "The fleet's chat terminus: the chat tab and websocket turns run on per-login instances of this class (ORCHESTRATOR_AGENT binding).",
    ),
    slack: entry(
      "enabled",
      "Production Slack ingress terminates on per-team instances of this class (slack_<teamId>), running the shared channel handler (src/agents/routes/tradingIntegrations.ts) — the #1262 trading/NLQ pipeline. The uniform any-copilot invocation surface is S5.",
    ),
    mcpClient: entry(
      "enabled",
      "Wired: servers are registered on the SDK client manager (this.mcp) through src/agents/orchestrator/meshMcpClient.ts (#2496), and this.mcp.getAITools() merges into every turn's tool set. Activated for the Stock Copilot as S4 (#3721): the stock registration declares mcpClient (src/client/chat/copilotRegistry.ts), and while this entry resolves enabled a stock turn is steered to the copilot's own discovered commands (tool_openaimp_stock_copilot_*); the externalized override withdraws that activation.",
    ),
    webFetch: entry(
      "enabled",
      "The web_fetch command (src/mcps/openaimp/webFetchCommands.ts over src/services/webFetch.ts, #2760) is served on this class's tool surface.",
    ),
    webSearch: entry(
      "enabled",
      "The web_search command (src/mcps/openaimp/webSearchCommands.ts over src/services/webSearch.ts, #2731) runs over a named-provider seam (first provider: Brave). It fails loud with web_search_provider_not_configured until the provider key is set; the provider decision is #3501.",
      { prerequisite: "BRAVE_SEARCH_API_KEY" },
    ),
    payments: entry(
      "enabled",
      "Priced capabilities on this class's surface (draft_payment / confirm_payment_draft, the agentic-payment commands) run through the CBO price-catalogue gate (src/data/priceCataloguePorts.ts, #2547-#2551): an unapproved price refuses fail-closed. Approving a price is the owner/CPO step — no agent approves prices.",
    ),
  },
  ResearchAgent: {},
  TradingAgent: {},
  PaymentsAgent: {
    payments: entry(
      "enabled",
      "DID-attested drafts and x402/MPP premium legs over the payments ledger, behind the BudgetGuard and the CBO price-catalogue gate (src/data/priceCataloguePorts.ts).",
    ),
  },
  ScreenerAgent: {},
  ScheduledAgent: {},
  ReportAssetAgent: {},
  BrowserAgent: {
    browser: entry(
      "enabled",
      "This class is the fleet's browser surface: fetch, inspect, and screenshot over the BROWSER rendering binding declared in wrangler.jsonc. A per-agent browser tool for every class lands as S9 (#3493).",
    ),
  },
  SlackAgent: {
    slack: entry(
      "enabled",
      "Hosts the shared Slack channel handler on SDK-routed ingress (onRequest delegates to src/agents/routes/tradingIntegrations.ts); production ingress is the Worker forwarder onto OrchestratorAgent instances. The uniform any-copilot invocation surface is S5.",
    ),
  },
  AiSearchAgent: {
    aiSearch: entry(
      "enabled",
      "Fronts the AI Search instance (namespace \"default\", instance \"screener-search\"): the namespace-binding path is the live primary and REST is the fallback. Recorded degraded in the registry — the namespace path's end-to-end seed+probe verification under #1169 is still outstanding.",
    ),
  },
  TickerAgent: {},
  SandboxAgent: {
    sandbox: entry(
      "unavailable",
      "The class and its A2A/MCP surfaces are live, but no container backend is configured (no containers declared in wrangler.jsonc), so run_command honestly returns executed:false. The enablement is the owner's containers configuration step; a per-agent sandbox tool lands as S8 (#3492).",
      { unavailableReason: "sandbox_container_backend_not_configured" },
    ),
  },
};

/** True when the class carries an explicit (reviewed) base record. */
export function hasExplicitCapabilityRecord(className: string): boolean {
  return Object.prototype.hasOwnProperty.call(PORT_THINK_CAPABILITY_BASE, className);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Prerequisites the resolver can evaluate against an env, keyed by
 * env var name: the check and the fail-loud reason recorded when it
 * fails. Only ever downgrades an `enabled` entry to `unavailable`.
 */
const PREREQUISITE_CHECKS: Record<
  string,
  { isMet: (env: Record<string, unknown>) => boolean; unavailableReason: string }
> = {
  [THINK_WEBHOOK_SECRET_ENV]: {
    isMet: (env) => resolveThinkWebhookSecret(env) !== undefined,
    unavailableReason: "webhook_secret_not_configured",
  },
  BRAVE_SEARCH_API_KEY: {
    isMet: (env) =>
      typeof env.BRAVE_SEARCH_API_KEY === "string" &&
      env.BRAVE_SEARCH_API_KEY.trim().length > 0,
    unavailableReason: "web_search_provider_not_configured",
  },
};

export interface CapabilityResolutionOptions {
  /** The class's wrangler binding names (override scopes match these). */
  bindings?: string[];
  /**
   * The deployment env (or any record of env values). When provided,
   * prerequisites are evaluated against it and the override list is
   * read from it unless `disabledRaw` is given. When omitted,
   * prerequisites are recorded but not evaluated — the code posture.
   */
  env?: Record<string, unknown> | null;
  /** Explicit AGENT_CAPABILITIES_DISABLED value; wins over the env's. */
  disabledRaw?: string | null;
}

function clonePosture(): Record<CapabilityId, CapabilityEntry> {
  const out = {} as Record<CapabilityId, CapabilityEntry>;
  for (const id of ALL_CAPABILITY_IDS) out[id] = { ...FLEET_DEFAULT_POSTURE[id] };
  return out;
}

function splitPosture(
  flat: Record<CapabilityId, CapabilityEntry>,
): Pick<AgentCapabilityManifest, "channels" | "capabilities" | "tools"> {
  const channels = {} as Record<CapabilityChannelId, CapabilityEntry>;
  for (const id of CAPABILITY_CHANNELS) channels[id] = flat[id];
  const capabilities = {} as Record<CapabilityRuntimeId, CapabilityEntry>;
  for (const id of CAPABILITY_RUNTIME) capabilities[id] = flat[id];
  const tools = {} as Record<CapabilityToolId, CapabilityEntry>;
  for (const id of CAPABILITY_TOOLS) tools[id] = flat[id];
  return { channels, capabilities, tools };
}

/**
 * Resolve one class's capability manifest: base posture (explicit
 * record over fleet defaults) → prerequisite evaluation (only when
 * an env is supplied) → config overrides (disable-only). Never
 * throws; malformed config lands in `configIssues`.
 */
export function resolveAgentCapabilityManifest(
  className: string,
  options: CapabilityResolutionOptions = {},
): AgentCapabilityManifest {
  const bindings = [...(options.bindings ?? [])];
  const flat = clonePosture();
  const overrides = PORT_THINK_CAPABILITY_BASE[className];
  if (overrides) {
    for (const id of ALL_CAPABILITY_IDS) {
      const o = overrides[id];
      if (o) flat[id] = { ...o };
    }
  }

  const env = options.env ?? null;
  if (env) {
    for (const id of ALL_CAPABILITY_IDS) {
      const e = flat[id];
      if (e.state !== "enabled" || !e.prerequisite) continue;
      const check = PREREQUISITE_CHECKS[e.prerequisite];
      if (check && !check.isMet(env)) {
        e.state = "unavailable";
        e.unavailableReason = check.unavailableReason;
      }
    }
  }

  const raw =
    options.disabledRaw !== undefined
      ? options.disabledRaw
      : env
        ? (env[AGENT_CAPABILITIES_DISABLED_ENV] as string | undefined)
        : undefined;
  const { entries, issues } = parseCapabilityDisabledList(raw);
  for (const { scope, capability } of entries) {
    if (scope !== "*" && scope !== className && !bindings.includes(scope)) continue;
    const e = flat[capability];
    if (e.state === "enabled") {
      e.state = "disabled-by-config";
      e.disabledBy = `${scope}:${capability}`;
    }
  }

  return {
    className,
    bindings,
    ...splitPosture(flat),
    configIssues: issues,
  };
}
