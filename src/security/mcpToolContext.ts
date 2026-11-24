/**
 * Issue #6173 (slice 3 of the universal execution context) — the
 * MCP layer carries the one validated ExecutionContext.
 *
 * The resolution happens ONCE per MCP exchange at the DO route
 * shell (src/agents/routes/mcpChatNlq.ts, POST /mcp), before
 * handleOpenaimpMcpHttpRequest, and is carried unchanged through
 * the tool call on the handler context (OpenaimpMcpHandlerContext
 * .executionContext). The permission gate reads it (role-derived
 * scopes via the #5350 seam B adapter + attributed denial
 * observations); handlers never build or re-derive their own —
 * the one shared resolution from slice 1 (#6151,
 * resolvePlatformContext) is the only resolver any MCP surface
 * calls. No second resolver, no second field set, no
 * entry-local context construction.
 *
 * Why the DO resolves its own context (not the Worker
 * boundary's): the Worker boundary (slice 2) resolves the HTTP
 * request's context — serviceId "api", the Worker's session id,
 * taskId "http:<trace>". The tool call needs its own — serviceId
 * "mcp", the DO route's session key, taskId "mcp:<trace>" — and
 * the gate's roles, which the Worker context does not carry.
 * Each entry builds its own context once; the two are linked by
 * the trace id (both derive from the incoming traceparent).
 * The in-app explorer's session-cookie calls resolve at both
 * layers; token-authenticated (cfk_) calls resolve only here —
 * the Worker boundary sees no session cookie for them (absent).
 *
 * Boundary inputs are FIXED (never client-supplied — the #1069
 * rule): serviceId "mcp"; permission "task:read" (the broadest
 * tenant permission — the context proves identity + tenant +
 * membership; the tool-level scope check stays at the gate,
 * via the adapter, because the tool name lives in the JSON-RPC
 * body the shell does not parse); taskId "mcp:<traceId>";
 * environment "sandbox" (the boundary context never claims
 * live — live operations resolve their own operation contexts);
 * dispatch "manual", exec "sync" (the MCP exchange is manually
 * dispatched and awaited; the queued job's own record carries
 * its trigger, "agent", as today); correlationId = traceId
 * (the incoming traceparent when present, else a fresh trace).
 * platformId is left unset at this boundary: no platform id
 * registry exists in code (docs/agentic-org/platforms.md is a
 * federated org model with no code registry), and inventing an
 * id would be a second system. runId / agentRunId /
 * workspaceId / connectionId / externalAccountId are likewise
 * unset — no run or connection exists on a generic call.
 *
 * Fail-closed, observe-first (the #1078 staging, #5477
 * precedent, slice 2's mode): a call whose context cannot be
 * resolved is DENIED with a named code and an audited,
 * correlated event — never a defaulted or shared identity. In
 * observe mode (the default) the denial is audited and the
 * call proceeds unattributed, exactly as today; in enforce
 * mode (EXECUTION_CONTEXT_MODE=enforce, an explicit flip) the
 * shell refuses with 403 + the named code before any tool
 * runs. A login with no wired internal user id can never
 * carry a validated context: the contract forbids a login as
 * a principal id, so the resolver is never called for it
 * (NO_PRINCIPAL). A call with no login at all carries no
 * context (absent) and proceeds as today — in-process platform
 * callers (the handleMCPRequest facade) have no login and the
 * gate defaults them to system, exactly as before.
 *
 * Roles (the #5350 seam B adapter): the establishment also
 * returns a McpRoleResolver bound to the resolved context's
 * identity (principalId + tenantId + login). The resolver
 * reads roles FRESH from the membership store on every gate
 * call — never cached, so revocation denies at the point of
 * use, the same rule as the PDP. Only live memberships in the
 * context's tenant contribute (unrevoked, unexpired bindings —
 * the authorize() liveness rule, mirrored here); a store
 * error is unresolvable (null — the adapter falls back to the
 * recorded defaults, the GAP-4 behavior); a login mismatch
 * resolves to nothing (fail closed — never another identity's
 * roles). The adapter's kind pins (scanner-payment, unknown,
 * system) govern before the resolver is ever called.
 */
import { createCommercialAdapter } from "../data/createCommercialPorts";
import { createSubscriptionAdapter } from "../data/createSubscriptionPorts";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { newTraceContext } from "../observability/observabilityPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import {
  executionContextMode,
  type ExecutionContext,
} from "./executionContext";
import { lookupInternalUserIdByLogin } from "./iaaaMigration";
import { sessionStore } from "./session";
import {
  type PlatformContextDenyCode,
  type PlatformContextResult,
  type PlatformContextSources,
  type ResolvePlatformContextInput,
} from "./platformContext";
import type {
  McpPrincipal,
  McpRoleResolver,
} from "../mcps/openaimp/mcpPermissionPorts";
import type { MembershipStore, Role } from "./authorization";
import type { Env } from "../types";

/**
 * The codes a boundary denial can carry: the resolver's codes,
 * plus the boundary's own pre-resolution refusal — a login
 * with no wired internal user id has no principal to resolve
 * for, so the resolver is never invoked (NO_PRINCIPAL is a
 * boundary code, not a contract code; the contract is never
 * asked).
 */
export type McpToolContextDenyCode =
  | PlatformContextDenyCode
  | "NO_PRINCIPAL";

export type McpToolContextOutcome =
  | { outcome: "resolved"; context: ExecutionContext }
  | {
      outcome: "denied";
      code: McpToolContextDenyCode;
      error: string;
    }
  | { outcome: "absent" };

export interface McpToolContextInput {
  /** Calling principal, resolved from the Worker-forwarded identity headers. */
  principal: McpPrincipal;
  /** The DO route's session key — the session this call belongs to. Required. */
  sessionId: string;
  /** Trace id from the incoming traceparent; a fresh trace when absent. */
  traceId?: string;
  /** Correlation id; defaults to the trace id. */
  correlationId?: string;
  /** Test seam — production callers omit it (Date.now()). */
  nowMs?: number;
}

export interface McpToolContextDeps {
  lookupUserId?: (login: string) => Promise<string | null>;
  /**
   * The one shared resolution (#6151). Same (sources, input)
   * order as resolvePlatformContext itself, so the default plugs
   * in directly with no adapter.
   */
  resolve?: (
    sources: PlatformContextSources,
    input: ResolvePlatformContextInput,
  ) => Promise<PlatformContextResult>;
  buildSources?: (env: Env) => Promise<PlatformContextSources>;
  logDenied?: (fields: {
    code: string;
    correlationId: string;
    traceId: string;
  }) => void;
}

/**
 * The production sources, built LAZILY (dynamic imports, not
 * static ones): the authority factory and the resolver both sit
 * on the provider/trading graph (`providerConnections` and
 * `tenantProviders` import the trading barrel), and a static
 * edge from this boundary module into that graph breaks test
 * suites that mock those modules with `importOriginal`
 * factories (verified live in slice 2: `agentic_payments_identity_binding`
 * fails 3/19 with the static edge and passes 19/19 with the
 * lazy edge). Loading the DO route shell must not drag the
 * trading graph through a new static edge; the resolution loads
 * it on the first authenticated MCP call instead.
 */
async function defaultBuildSources(env: Env): Promise<PlatformContextSources> {
  const { createScreenConnectionAuthority } = await import(
    "../services/providerConnections"
  );
  return {
    authority: createScreenConnectionAuthority({ env }),
    ports: {
      commercial: createCommercialAdapter(env),
      subscriptions: createSubscriptionAdapter(env),
    },
    env,
  };
}

function defaultLookupUserId(env: Env): NonNullable<McpToolContextDeps["lookupUserId"]> {
  const kv = sessionStore(env);
  return (login: string) => lookupInternalUserIdByLogin(kv, login);
}

function defaultLogDenied(env: Env): NonNullable<McpToolContextDeps["logDenied"]> {
  const log = createStructuredLogger(createObservabilitySink(env), {
    component: "security/mcpToolContext",
  });
  return (fields) => {
    log.warn("mcp.context_denied", {
      message: `[McpToolContext] MCP tool call context denied (${fields.code})`,
      code: fields.code,
      correlationId: fields.correlationId,
      traceId: fields.traceId,
    });
  };
}

/**
 * Roles for the resolved context's identity, read fresh from
 * the membership store on every call — never cached. Only
 * live memberships in the context's tenant contribute
 * (unrevoked, unexpired bindings — the authorize() liveness
 * rule). A store error is unresolvable (null — the adapter
 * falls back to the recorded defaults); a login mismatch
 * resolves to nothing (fail closed).
 */
export function rolesForMcpContext(
  memberships: MembershipStore | undefined,
  principalId: string,
  tenantId: string,
  boundLogin: string,
): McpRoleResolver {
  return async (principal) => {
    if (principal.login !== boundLogin) return [];
    if (
      principal.kind !== "session" &&
      principal.kind !== "api-key" &&
      principal.kind !== "agent-turn"
    ) {
      return null;
    }
    if (!memberships) return null;
    let rows;
    try {
      rows = await memberships.getMembershipsByUser(principalId);
    } catch {
      return null;
    }
    const nowMs = Date.now();
    const roles = new Set<Role>();
    for (const m of rows) {
      if (m.tenantId !== tenantId) continue;
      if (m.revokedAtMs !== undefined) continue;
      for (const b of m.roleBindings) {
        if (b.expiresAtMs !== undefined && b.expiresAtMs <= nowMs) continue;
        roles.add(b.role);
      }
    }
    return [...roles];
  };
}

/**
 * Resolve the MCP call's execution context once, at the DO
 * route shell, and return it with the role resolver bound to
 * it. Returns a refusal Response when the mode says to refuse
 * (enforce + denied) — the caller returns the refusal before
 * the handler runs. In observe mode (or when the context
 * resolves, or when there is no login) the refusal is null
 * and the call proceeds.
 */
export async function establishMcpToolContext(
  input: McpToolContextInput,
  env: Env,
  deps: McpToolContextDeps = {},
): Promise<{
  outcome: McpToolContextOutcome;
  refusal: Response | null;
  resolveRoles?: McpRoleResolver;
}> {
  const { principal, sessionId } = input;
  const traceId = input.traceId ?? newTraceContext().traceId;
  const correlationId = input.correlationId ?? traceId;
  const nowMs = input.nowMs ?? Date.now();
  const logDenied = deps.logDenied ?? defaultLogDenied(env);

  // No login at all: no identity to resolve for — the call
  // proceeds as today (in-process platform callers, gated as
  // system by the permission gate's own default).
  if (!principal.login) {
    return {
      outcome: { outcome: "absent" },
      refusal: null,
    };
  }

  const deny = (
    code: McpToolContextDenyCode,
    error: string,
  ): { outcome: McpToolContextOutcome; refusal: Response | null } => {
    const outcome: McpToolContextOutcome = {
      outcome: "denied",
      code,
      error,
    };
    logDenied({ code, correlationId, traceId });
    const refusal =
      executionContextMode(env) === "enforce"
        ? Response.json({ error, code }, { status: 403 })
        : null;
    return { outcome, refusal };
  };

  // A login with no wired internal user id: the contract
  // forbids a login as a principal id, so no validated context
  // can ever be resolved for it — refuse before the resolver.
  const lookupUserId = deps.lookupUserId ?? defaultLookupUserId(env);
  const principalId = await lookupUserId(principal.login);
  if (!principalId) {
    return deny(
      "NO_PRINCIPAL",
      "the login carries no wired internal user id, so no validated execution context can be resolved for this MCP call",
    );
  }

  const resolveInput: ResolvePlatformContextInput = {
    principalId,
    sessionId,
    taskId: `mcp:${traceId}`,
    serviceId: "mcp",
    permission: "task:read",
    environment: "sandbox",
    nowMs,
    traceId,
    correlationId,
    dispatchMode: "manual",
    execMode: "sync",
  };
  const resolve =
    deps.resolve ??
    (await import("./platformContext")).resolvePlatformContext;
  const sources = await (deps.buildSources ?? defaultBuildSources)(env);
  const result = await resolve(sources, resolveInput);
  if (!result.ok) {
    return deny(result.code, result.error);
  }
  const resolveRoles = rolesForMcpContext(
    sources.authority.memberships,
    principalId,
    result.context.tenantId,
    principal.login,
  );
  return {
    outcome: { outcome: "resolved", context: result.context },
    refusal: null,
    resolveRoles,
  };
}
