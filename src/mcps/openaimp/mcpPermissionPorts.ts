/**
 * Issue #1744 — MCP tool permission port: per-tool scopes +
 * cryptographic execution isolation, port-first / adapter-first.
 *
 * WHAT THIS IS
 * Every MCP tool declares exactly one permission scope
 * (MCP_TOOL_SCOPES, completeness-pinned by test against the live
 * factory registry). Every tool execution passes through the gate
 * (executeWithPermissionGate): scope check BEFORE execution,
 * per-execution cryptographic isolation (see executionStore.ts),
 * denial as a business error + audit + stream event, never a
 * technical leak. Scopes resolve from the principal via an
 * adapter — never from tool-call arguments (a forged `scope`
 * argument is ignored, pinned by test).
 *
 * SCOPE ASSIGNMENT (explicit, #1717 SCOPED DEFAULTS)
 * The default assignment is current behavior: every interactive
 * principal kind (session, api-key, agent-turn) and every
 * platform-internal caller (system) holds every scope, so no
 * legitimate call changes behavior at launch. That default is
 * recorded here so the owner can overturn it, and it is the ONLY
 * thing a future IAAA role→scope adapter changes: the gate,
 * the declarations, and the isolation mechanics stay untouched.
 * The one non-default assignment at launch: scanner-payment
 * principals hold only mcp:payments (the paid-tool entitlement),
 * and unknown principals hold nothing and are always denied.
 * Scope assignment tied to IAAA identity beyond kind+login —
 * i.e. resolving a login to role bindings at the SearchAgent DO
 * tool-call site — does NOT exist in #945's consumed surface
 * today, so it is a follow-up for the CISO lane, not built here.
 *
 * WHAT THIS IS NOT
 * - Not session authentication: the Worker /mcp route (401
 *   without a session or cfk_ key) and IAAA requireAuth stand
 *   unchanged; this gate sits behind them.
 * - Not invocation-auth verification or scanner attribution:
 *   that is #1717/#1763 (CISO lane) territory, linked not
 *   duplicated.
 * - Not the chain.run execution binding: chain.run's scope is
 *   declared (mcp:execute) but its semantics are untouched.
 * - Not a replacement for HITL approval, x402 payment gates, or
 *   route auth: the scope gate composes with them.
 *
 * CHOKE POINTS (all use this gate; no tool execution bypasses it)
 * - McpToolFactory.executeTool (JSON-RPC sync path, REST bridge,
 *   job executor) — principal from context, defaulting to system
 *   for in-process platform callers whose route layer already
 *   authenticated; unknown tools keep the pre-existing
 *   not-registered error (lookup precedes the gate).
 * - handleMCPRequest tools/call queued path — authorize BEFORE
 *   submitJob, so a refused call never receives a job receipt.
 *   Since #2496 this is also the chat turn's enforcement point:
 *   the turn's discovered tools execute through the instance's
 *   own /mcp handler, with the principal resolved from the
 *   loopback carrier's stamped identity headers.
 * - McpAgentToolAdapter (direct in-process command adaptation —
 *   the mesh-door suites drive commands through it) — principal
 *   kind agent-turn: the turn runs inside the owner's own agent
 *   instance, so the instance boundary IS the identity boundary;
 *   threading the turn's userLogin into the principal is a
 *   follow-up, not a launch requirement.
 */

import { BusinessError } from "../../outcomes/outcomeAspects";
import {
  newTraceContext,
  sessionRefFor,
  timestampIsoFor,
  type ObservabilityEvent,
  type ObservabilitySink,
} from "../../observability/observabilityPorts";
import {
  authorizeAgentInvocation,
  type AgentAccessDeps,
  type AgentAccessMode,
  type AgentInvocationRequest,
} from "../../security/agentAccess";
import type { ObligationAuditWriter } from "../../security/obligations";
import { createExecutionStore, type ExecutionRecord, type ExecutionSeal } from "./executionStore";

/** Stable business-error code for a refused tool call (see outcomeCatalog.json). */
export const MCP_PERMISSION_DENIED_CODE = "FAILURE_MCP_PERMISSION_DENIED";

/** Audit event type for a refused tool call (durable trail, via context.audit). */
export const MCP_PERMISSION_DENIED_AUDIT = "mcp.permission_denied";

/** #2171 — audit event types for agent-grant decisions at this gate. */
export const AGENT_ACTION_AUDIT = "agent.action";
export const AGENT_ACCESS_DENIED_AUDIT = "agent.access_denied";
export const AGENT_ACCESS_SHADOW_DENIED_AUDIT = "agent.access_shadow_denied";

/** Stream event type for a refused tool call (counts/outcomes only, via #1743's port). */
export const MCP_PERMISSION_DENIED_STREAM = "mcp.permission_denied";

export const MCP_SCOPES = [
  "mcp:read",
  "mcp:write",
  "mcp:execute",
  "mcp:trade",
  "mcp:payments",
  "mcp:admin",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

/**
 * Caller classes at a tool-call site. `system` = in-process
 * platform code (REST bridge, job executor) whose route layer
 * already authenticated; `agent-turn` = model-driven calls inside
 * the owner's own agent instance; `unknown` = no identity could
 * be resolved — always denied, never defaulted to system.
 */
export type McpPrincipalKind =
  | "session"
  | "api-key"
  | "agent-turn"
  | "system"
  | "scanner-payment"
  | "unknown";

export interface McpPrincipal {
  login: string | null;
  kind: McpPrincipalKind;
}

export interface PermissionDecision {
  allowed: boolean;
  /** Null for unknown tools (no scope declared, no execution). */
  scope: McpScope | null;
  reason?: string;
}

export interface ToolPermissionPort {
  requiredScope(toolName: string): McpScope | null;
  scopesFor(principal: McpPrincipal): Promise<readonly McpScope[]>;
  authorize(principal: McpPrincipal, toolName: string): Promise<PermissionDecision>;
  beginExecution(principal: McpPrincipal, toolName: string): ExecutionSeal;
  openExecution(executionId: string, executionKey: string): ExecutionRecord | null;
  endExecution(executionId: string, executionKey: string): boolean;
}

/**
 * Per-tool scope declarations. One scope per tool, chosen by
 * what the tool DOES, not what it reads:
 * - read: pure reads (quotes, positions, status, history, lists, search).
 * - write: state-changing, non-financial (manage_*, memory, goal compile/schedule).
 * - execute: general execution (NLQ, chain.run, sandbox, backtest, webhook, think validation, screenshot).
 * - trade: order flow (preview counts as trade: it validates/reserves the order path, it is not a market-data read).
 * - payments: money movement + payment-domain data + paid-tool entitlement.
 * - admin: platform-wide reads (audit events, table listing/query, revenue summary).
 * The completeness test pins this table against the live factory
 * registry in both directions, so a future tool without a scope
 * fails loudly instead of executing unscoped.
 */
export const MCP_TOOL_SCOPES: Record<string, McpScope> = {
  // read (42)
  knowledge_search: "mcp:read",
  // #2760 (tracker #2708 A3): the standalone web fetch — a pure
  // read of a public page through the webFetch service (no state
  // changes, no delivery); the web-fetch family's first tool.
  web_fetch: "mcp:read",
  query_platform_knowledge: "mcp:read",
  // #2731: web_search — read-only; provider-gated at the seam
  // (src/services/webSearch.ts), not by scope.
  web_search: "mcp:read",
  get_async_job: "mcp:read",
  list_async_jobs: "mcp:read",
  etrade_get_quote: "mcp:read",
  etrade_get_positions: "mcp:read",
  etrade_auth_status: "mcp:read",
  etrade_account_discovery: "mcp:read",
  etrade_market_scan: "mcp:read",
  market_data_get_quote: "mcp:read",
  market_data_company_fundamentals: "mcp:read",
  market_data_historical_bars: "mcp:read",
  market_data_research: "mcp:read",
  alpaca_snapshot: "mcp:read",
  alpaca_account: "mcp:read",
  alpaca_positions: "mcp:read",
  alpaca_orders: "mcp:read",
  // #1906: deprecated aliases for the renamed market-data tools above;
  // same scopes as their canonical tools. Use canonical names instead.
  // Removal is a follow-up slice.
  foss_get_quote: "mcp:read",
  foss_company_fundamentals: "mcp:read",
  foss_historical_bars: "mcp:read",
  foss_market_research: "mcp:read",
  foss_alpaca_snapshot: "mcp:read",
  foss_alpaca_account: "mcp:read",
  foss_alpaca_positions: "mcp:read",
  foss_alpaca_orders: "mcp:read",
  browser_inspect_page: "mcp:read",
  ai_search_financial_docs: "mcp:read",
  ai_search_agent_search: "mcp:read",
  "agentdb.chain.status": "mcp:read",
  "agentdb.jobs.history": "mcp:read",
  "agentdb.audit.history": "mcp:read",
  "agentdb.reports.list": "mcp:read",
  "agentdb.trace.get": "mcp:read",
  // #2341 (mesh S5): the ScheduledAgent door's read — a pure list/inspect.
  list_scheduled_goals: "mcp:read",
  // #2349 (mesh S6): the TradingAgent door's reads (accounts,
  // positions, quote) and the ReportAssetAgent door's list/get —
  // pure reads of the acting user's own data through their agents.
  get_trading_accounts: "mcp:read",
  get_trading_positions: "mcp:read",
  get_trading_quote: "mcp:read",
  list_report_assets: "mcp:read",
  get_report_asset: "mcp:read",
  // #2375 (mesh S9): the trade approval run's status read — a pure
  // read of the workflow binding's own status surface.
  get_trade_approval_status: "mcp:read",
  // #2351 (mesh S7): the BrowserAgent door's scrape — a pure read of
  // a rendered page through the agent (its snap/capture siblings
  // deliver to Slack, so they sit in write).
  browser_scrape_tables: "mcp:read",
  // write (10)
  manage_categories: "mcp:write",
  manage_referrals: "mcp:write",
  manage_external_ads: "mcp:write",
  manage_session_memory: "mcp:write",
  "goal.compile": "mcp:write",
  "goal.schedule": "mcp:write",
  // #2341 (mesh S5): firing a goal changes state (and is budget-gated
  // inside ScheduledAgent/PaymentsAgent); the trigger itself moves no money.
  trigger_scheduled_goal: "mcp:write",
  // #2351 (mesh S7): the BrowserAgent/SlackAgent doors' deliveries —
  // each posts a snap to the configured Slack destination (an
  // outbound side effect; no caller-supplied webhook is accepted).
  browser_snap_transaction: "mcp:write",
  browser_capture_page: "mcp:write",
  slack_dispatch_transaction_snap: "mcp:write",
  // #2488: the mesh screen door — starting a screen workflow
  // changes state (and is budget-gated inside the door when
  // monetization is on); the command itself moves no money.
  run_stock_screen: "mcp:write",
  // #2581: the mesh options-strategy door — runs the options
  // evaluation engine over a universe batch (a read-shaped
  // scan that persists nothing itself and moves no money; the
  // write scope matches its sibling screen door).
  run_options_strategy_screen: "mcp:write",
  // execute (7)
  execute_nlq: "mcp:execute",
  "chain.run": "mcp:execute",
  run_sandbox_command: "mcp:execute",
  run_quant_backtest: "mcp:execute",
  dispatch_trading_webhook: "mcp:execute",
  think_trade_validation: "mcp:execute",
  browser_screenshot: "mcp:execute",
  // payments (9)
  draft_payment: "mcp:payments",
  confirm_payment_draft: "mcp:payments",
  get_transactions: "mcp:payments",
  get_payment_gateways: "mcp:payments",
  paid_options_screener: "mcp:payments",
  paid_market_research: "mcp:payments",
  agentic_wallet_status: "mcp:payments",
  // #2341 (mesh S5): the PaymentsAgent door — payment-domain verdicts
  // and payment-domain data (a check records nothing; the overview is
  // ledger data, so both sit in the payments scope, not read).
  check_payment_budget: "mcp:payments",
  get_payments_overview: "mcp:payments",
  // trade (10)
  etrade_preview_order: "mcp:trade",
  etrade_execute_order: "mcp:trade",
  alpaca_place_order: "mcp:trade",
  foss_alpaca_place_order: "mcp:trade", // #1906 deprecated alias, same scope as canonical
  execute_durable_twap: "mcp:trade",
  // #2349 (mesh S6): the TradingAgent door's proposal commands —
  // preview-only (a proposal is a pending-approval preview, never a
  // placed order), in the trade scope alongside etrade_preview_order.
  propose_stock_trade: "mcp:trade",
  propose_options_trade: "mcp:trade",
  // #2351 (mesh S7): the SlackAgent door's approval-ticket command —
  // it posts the strict HITL gate card for a trade draft (part of
  // the trade flow, alongside the proposal commands); the ticket
  // approves and executes nothing by itself.
  slack_send_pre_trade_approval: "mcp:trade",
  // #2375 (mesh S9): the TradingAgent approval door's workflow
  // commands — submitting a proposal to the approval door and
  // delivering the human's decision are order-flow acts (the start
  // places nothing; the decision is what authorizes settlement).
  start_trade_approval: "mcp:trade",
  decide_trade_approval: "mcp:trade",
  // admin (4)
  get_audit_events: "mcp:admin",
  list_database_tables: "mcp:admin",
  query_table_data: "mcp:admin",
  get_revenue_summary: "mcp:admin",
};

/**
 * Runtime scope declarations for dynamically registered tools
 * (the factory's OCP promise: tools can be registered after
 * boot). Static declarations above are IMMUTABLE: declaring a
 * scope for a statically declared tool throws, so runtime code
 * can never weaken a sensitive tool's scope by re-declaring it
 * (re-registering a static tool's implementation keeps its
 * static scope, since the gate resolves scope by NAME).
 */
const DYNAMIC_TOOL_SCOPES = new Map<string, McpScope>();

export function declareToolScope(toolName: string, scope: McpScope): void {
  if (!MCP_SCOPES.includes(scope)) {
    throw new Error(`declareToolScope: unknown scope ${scope} for tool ${toolName}`);
  }
  if (toolName in MCP_TOOL_SCOPES) {
    throw new Error(`declareToolScope: tool ${toolName} already has a static scope declaration`);
  }
  DYNAMIC_TOOL_SCOPES.set(toolName, scope);
}

export function resolveToolScope(toolName: string): McpScope | null {
  return DYNAMIC_TOOL_SCOPES.get(toolName) ?? MCP_TOOL_SCOPES[toolName] ?? null;
}

/** Default scope assignment (see the header: current behavior, explicitly recorded). */
export function defaultScopesForKind(kind: McpPrincipalKind): readonly McpScope[] {
  switch (kind) {
    case "system":
    case "session":
    case "api-key":
    case "agent-turn":
      return MCP_SCOPES;
    case "scanner-payment":
      return ["mcp:payments"];
    case "unknown":
      return [];
  }
}

function basePort(
  resolveScopes: (principal: McpPrincipal) => readonly McpScope[]
): ToolPermissionPort {
  const store = createExecutionStore();
  return {
    requiredScope(toolName) {
      return resolveToolScope(toolName);
    },
    async scopesFor(principal) {
      return resolveScopes(principal);
    },
    async authorize(principal, toolName) {
      const scope = resolveToolScope(toolName);
      if (scope === null) {
        return { allowed: false, scope: null, reason: `unknown tool: ${toolName}` };
      }
      const scopes = resolveScopes(principal);
      if (scopes.includes(scope)) return { allowed: true, scope };
      return {
        allowed: false,
        scope,
        reason: `principal kind ${principal.kind} lacks scope ${scope}`,
      };
    },
    beginExecution(principal, toolName) {
      return store.begin(principal, toolName);
    },
    openExecution(executionId, executionKey) {
      return store.open(executionId, executionKey);
    },
    endExecution(executionId, executionKey) {
      return store.end(executionId, executionKey);
    },
  };
}

/** Production adapter: static default policy (no durable assignment store exists yet). */
export function createProductionMcpPermissionPort(): ToolPermissionPort {
  return basePort((principal) => defaultScopesForKind(principal.kind));
}

export interface InMemoryPermissionPortOptions {
  /**
   * Explicit per-principal assignments, keyed `${kind}:${login ?? ""}`.
   * A principal with an override uses exactly that set; every other
   * principal falls back to the production default policy. This is
   * the seam a future IAAA role→scope adapter plugs into, and the
   * mechanism tests use to build restricted principals.
   */
  overrides?: Map<string, readonly McpScope[]> | Record<string, readonly McpScope[]>;
}

/** In-memory adapter: explicit overrides over the production default policy. */
export function createInMemoryMcpPermissionPort(
  options: InMemoryPermissionPortOptions = {}
): ToolPermissionPort {
  const overrides =
    options.overrides instanceof Map
      ? options.overrides
      : new Map(Object.entries(options.overrides ?? {}));
  return basePort((principal) => {
    const key = `${principal.kind}:${principal.login ?? ""}`;
    return overrides.get(key) ?? defaultScopesForKind(principal.kind);
  });
}

/**
 * Resolve the calling principal from the DO-forwarded identity
 * headers (set by the Worker /mcp route: x-user-login always,
 * x-principal-kind session|api-key). A missing login resolves to
 * `unknown` — fail closed, never defaulted to system: only
 * in-process callers (which never pass through this resolver)
 * may use the system default.
 */
export function resolveMcpPrincipalFromHeaders(headers: {
  get(name: string): string | null;
}): McpPrincipal {
  const login = headers.get("x-user-login");
  if (!login) return { login: null, kind: "unknown" };
  const kindRaw = headers.get("x-principal-kind");
  // Issue #2681: a service-token caller is never a session principal
  // at the MCP gate. Token roles are enforced by the PDP seam, not by
  // this kind mapping, so until #945 route wiring adopts it, a token
  // caller maps to "unknown" (deny-all scopes) instead of inheriting
  // session scope through the legacy default below.
  if (kindRaw === "service-token") return { login, kind: "unknown" };
  const kind: McpPrincipalKind = kindRaw === "api-key" ? "api-key" : "session";
  return { login, kind };
}

/**
 * #2171 — agent-grant enforcement at this gate, opt-in per call
 * site. The mode comes from the platform-only
 * IAAA_AGENT_ACCESS_MODE switch, resolved by the CALLER from its
 * platform env (never from run/session/user carriers) and passed
 * here already resolved. Absent → the pre-#2171 gate exactly
 * (scope check only). mode=off → evaluated never, nothing
 * audited. mode=audit → evaluated and audited as a shadow
 * denial, but never denies (the scope decision stands).
 * mode=enforce → a grant denial audits as agent.access_denied
 * and throws the same BusinessError as a scope denial, before
 * execution begins; a grant allow audits as agent.action (the
 * uniform allowed-call row G-AUD-1 asked for). The scope check
 * always runs first: a scope denial keeps its own audit and
 * never reaches the agent check.
 */
export interface McpAgentAccessOptions {
  mode: AgentAccessMode;
  deps: Omit<AgentAccessDeps, "auditSink">;
  agentId: string;
  tenantId: string;
  purpose?: string;
  resourceId?: string;
  nowMs: number;
  enforceObligations?: boolean;
  authTimeMs?: number;
  obligationAudit?: ObligationAuditWriter;
}

export interface PermissionGateOptions {
  port: ToolPermissionPort;
  principal: McpPrincipal;
  toolName: string;
  sessionId?: string;
  audit: (type: string, agent: unknown, payload: Record<string, unknown>) => void;
  /** Optional #1743 stream sink; denials only. Never fails the call. */
  decisionSink?: ObservabilitySink;
  /** Optional #2171 agent-grant enforcement (see McpAgentAccessOptions). */
  agentAccess?: McpAgentAccessOptions;
}

function denialStreamEvent(
  toolName: string,
  scope: McpScope | null,
  principal: McpPrincipal,
  sessionId: string | undefined
): ObservabilityEvent {
  const now = Date.now();
  return {
    type: MCP_PERMISSION_DENIED_STREAM,
    level: "warn",
    operation: toolName,
    tenantId: null,
    // The principal identity stays in the audit trail, not the
    // stream: actor/agent are null on the denial event.
    actorId: null,
    agentId: null,
    component: "mcp-permissions",
    runId: null,
    sessionRef: sessionId ? sessionRefFor(sessionId) : null,
    traceId: newTraceContext().traceId,
    timestampMs: now,
    timestampIso: timestampIsoFor(now),
    count: 1,
    errorCode: MCP_PERMISSION_DENIED_CODE,
    // Counts/outcomes only: tool, scope, kind. Never arguments,
    // never login material beyond the session correlator.
    fields: { tool: toolName, requiredScope: scope, principalKind: principal.kind },
  };
}

/**
 * Authorize one tool call. On allow, returns the decision. On
 * deny, audits (durable trail, with the authenticated login for
 * review), streams a denial event (counts/outcomes only), and
 * throws BusinessError FAILURE_MCP_PERMISSION_DENIED — a business error, never a
 * technical leak. The sink write is best-effort: a sink failure
 * never changes the decision.
 */
export async function authorizeMcpToolCall(
  port: ToolPermissionPort,
  principal: McpPrincipal,
  toolName: string,
  opts: Omit<PermissionGateOptions, "port" | "principal" | "toolName">
): Promise<PermissionDecision> {
  const decision = await port.authorize(principal, toolName);
  if (decision.allowed) {
    // #2171: agent-grant enforcement runs AFTER the scope allow,
    // so a scope denial is never relabeled and never reaches the
    // agent check. In audit (shadow) mode a grant denial is
    // audited but the scope decision stands; in enforce mode it
    // throws the same business error before execution begins.
    // The gate's audit fn is the sink of record: an allow whose
    // audit write throws is denied inside authorizeAgentInvocation
    // (AUDIT_FAILED) and never executes — fail-closed, mirroring
    // the scope path, where audit failure likewise precedes run.
    const agentAccess = opts.agentAccess;
    if (agentAccess && agentAccess.mode !== "off") {
      const request: AgentInvocationRequest = {
        agentId: agentAccess.agentId,
        tenantId: agentAccess.tenantId,
        targetKind: "tool",
        target: toolName,
        purpose: agentAccess.purpose,
        resourceId: agentAccess.resourceId,
        nowMs: agentAccess.nowMs,
        enforceObligations: agentAccess.enforceObligations,
        authTimeMs: agentAccess.authTimeMs,
        obligationAudit: agentAccess.obligationAudit,
      };
      const agentDecision = await authorizeAgentInvocation(
        {
          ...agentAccess.deps,
          auditSink: (event) => {
            const type =
              event.decision === "allow"
                ? AGENT_ACTION_AUDIT
                : agentAccess.mode === "audit"
                  ? AGENT_ACCESS_SHADOW_DENIED_AUDIT
                  : AGENT_ACCESS_DENIED_AUDIT;
            opts.audit(type, "mcp", {
              tool: toolName,
              agentId: event.agentId,
              agentKind: event.agentKind,
              grantId: event.grantId,
              delegatingPrincipal: event.delegatingPrincipal,
              tenantId: event.tenantId,
              decision: event.decision,
              reason: event.reason,
            });
          },
        },
        request,
      );
      if (agentDecision.decision === "deny" && agentAccess.mode === "enforce") {
        throw new BusinessError(MCP_PERMISSION_DENIED_CODE, {
          tool: toolName,
          scope: decision.scope ?? "none",
        });
      }
      // mode=audit: any agent outcome stands aside — the scope
      // decision is returned and execution proceeds.
    }
    return decision;
  }
  opts.audit(MCP_PERMISSION_DENIED_AUDIT, "mcp", {
    tool: toolName,
    requiredScope: decision.scope,
    principalKind: principal.kind,
    login: principal.login,
  });
  if (opts.decisionSink) {
    try {
      await opts.decisionSink.write(
        denialStreamEvent(toolName, decision.scope, principal, opts.sessionId)
      );
    } catch {
      // Sink failure never fails the producer (#1743 discipline).
    }
  }
  throw new BusinessError(MCP_PERMISSION_DENIED_CODE, {
    tool: toolName,
    scope: decision.scope ?? "none",
  });
}

/**
 * Run one tool execution behind the gate: authorize first (deny
 * throws before `run` is invoked), then begin a sealed execution
 * and destroy its seal in a finally block however `run` settles.
 * `run` receives the execution id for correlation; the execution
 * KEY never leaves the gate.
 */
export async function executeWithPermissionGate<T>(
  opts: PermissionGateOptions & { run: (executionId: string) => Promise<T> }
): Promise<T> {
  await authorizeMcpToolCall(opts.port, opts.principal, opts.toolName, opts);
  const seal = opts.port.beginExecution(opts.principal, opts.toolName);
  try {
    return await opts.run(seal.executionId);
  } finally {
    opts.port.endExecution(seal.executionId, seal.executionKey);
  }
}
