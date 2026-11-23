/**
 * Issue #6172 (slice 2 of the universal execution context) — the
 * API layer carries the one validated ExecutionContext.
 *
 * The resolution happens ONCE per request at the fetch boundary
 * (handleFetch, before the route dispatch chain) and is carried
 * unchanged through the request on the request object itself
 * (a WeakMap keyed by the Request — entries die with the
 * request, never shared across requests). Handlers read the
 * carried context; they never build or re-derive their own —
 * the one shared resolution from slice 1 (#6151,
 * resolvePlatformContext) is the only resolver any API surface
 * calls. No second resolver, no second field set, no
 * handler-local context construction.
 *
 * Boundary inputs are FIXED (never client-supplied — the #1069
 * rule): serviceId "api"; permission "task:read" (the broadest
 * tenant permission — held by member, auditor, tenant-admin,
 * and workspace-admin); taskId "http:<traceId>"; environment
 * "sandbox" (the boundary context never claims live — live
 * operations resolve their own operation contexts); dispatch
 * "manual", exec "sync" (an HTTP request is manually dispatched
 * and awaited); correlationId = traceId (the incoming
 * traceparent when present, else a fresh trace).
 *
 * Fail-closed, observe-first (the #1078 staging, #5477
 * precedent): a request whose context cannot be resolved is
 * DENIED with a named code and an audited, correlated event —
 * never a defaulted or shared identity. In observe mode (the
 * default) the denial is audited and the request proceeds
 * unattributed, exactly as today; in enforce mode
 * (EXECUTION_CONTEXT_MODE=enforce, an explicit flip) the
 * boundary refuses with 403 + the named code before any route
 * runs. A legacy session — no internalUserId — can never carry
 * a validated context: the contract forbids a login as a
 * principal id, so the resolver is never called for it
 * (NO_PRINCIPAL). Requests with no session cookie carry no
 * context (absent) and proceed as today; token-authenticated
 * MCP requests have no session cookie and are unaffected —
 * MCP carriage is slice 3 (#6173).
 *
 * platformId is left unset at this boundary: no platform id
 * registry exists in code (docs/agentic-org/platforms.md is a
 * federated org model with no code registry), and inventing an
 * id would be a second system. runId / agentRunId /
 * workspaceId / connectionId / externalAccountId are likewise
 * unset — no run or connection exists on a generic request.
 */
import { createCommercialAdapter } from "../data/createCommercialPorts";
import { createSubscriptionAdapter } from "../data/createSubscriptionPorts";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import { traceContextFromHeaders } from "../observability/observabilityPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { authenticateRequest } from "../server/auth";
import {
  executionContextMode,
  type ExecutionContext,
} from "./executionContext";
import {
  type PlatformContextDenyCode,
  type PlatformContextResult,
  type PlatformContextSources,
  type ResolvePlatformContextInput,
} from "./platformContext";
import type { Env, SessionData } from "../types";

/**
 * The codes a boundary denial can carry: the resolver's codes,
 * plus the boundary's own pre-resolution refusal — a session
 * with no internal user id has no principal to resolve for, so
 * the resolver is never invoked (NO_PRINCIPAL is a boundary
 * code, not a contract code; the contract is never asked).
 */
export type ApiRequestContextDenyCode =
  | PlatformContextDenyCode
  | "NO_PRINCIPAL";

export type ApiRequestContextOutcome =
  | { outcome: "resolved"; context: ExecutionContext }
  | {
      outcome: "denied";
      code: ApiRequestContextDenyCode;
      error: string;
    }
  | { outcome: "absent" };

/** The request carrier: keyed by the Request object, dead with it. */
const REQUEST_CONTEXTS = new WeakMap<Request, ApiRequestContextOutcome>();

export function setRequestExecutionContext(
  request: Request,
  outcome: ApiRequestContextOutcome,
): void {
  REQUEST_CONTEXTS.set(request, outcome);
}

export function requestExecutionContext(
  request: Request,
): ApiRequestContextOutcome | undefined {
  return REQUEST_CONTEXTS.get(request);
}

export interface ApiRequestContextDeps {
  authenticate?: (
    request: Request,
    env: Env,
  ) => Promise<{ session: SessionData; sessionId: string } | null>;
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
 * factories (verified live: `agentic_payments_identity_binding`
 * fails 3/19 with the static edge — the mocked
 * `readTenantBrokerSelection` stops applying — and passes 19/19
 * with the lazy edge). Loading server.ts must not drag the
 * trading graph through a new static edge; the resolution loads
 * it on the first authenticated request instead.
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

function defaultLogDenied(env: Env): NonNullable<ApiRequestContextDeps["logDenied"]> {
  const log = createStructuredLogger(createObservabilitySink(env), {
    component: "security/apiRequestContext",
  });
  return (fields) => {
    log.warn("api.context_denied", {
      message: `[ApiRequestContext] API request context denied (${fields.code})`,
      code: fields.code,
      correlationId: fields.correlationId,
      traceId: fields.traceId,
    });
  };
}

/**
 * Resolve the request's execution context once, at the boundary,
 * and carry it on the request. Returns the outcome plus a refusal
 * Response when the mode says to refuse (enforce + denied) — the
 * caller returns the refusal before routing. In observe mode (or
 * when the context resolves, or when there is no session) the
 * refusal is null and the request proceeds.
 */
export async function establishApiRequestContext(
  request: Request,
  env: Env,
  deps: ApiRequestContextDeps = {},
): Promise<{
  outcome: ApiRequestContextOutcome;
  refusal: Response | null;
}> {
  const trace = traceContextFromHeaders(request.headers);
  const authenticate = deps.authenticate ?? authenticateRequest;
  const authed = await authenticate(request, env);
  if (!authed) {
    const outcome: ApiRequestContextOutcome = { outcome: "absent" };
    setRequestExecutionContext(request, outcome);
    return { outcome, refusal: null };
  }
  const { session, sessionId } = authed;
  const logDenied = deps.logDenied ?? defaultLogDenied(env);

  const deny = (
    code: ApiRequestContextDenyCode,
    error: string,
  ): { outcome: ApiRequestContextOutcome; refusal: Response | null } => {
    const outcome: ApiRequestContextOutcome = {
      outcome: "denied",
      code,
      error,
    };
    setRequestExecutionContext(request, outcome);
    logDenied({
      code,
      correlationId: trace.traceId,
      traceId: trace.traceId,
    });
    const refusal =
      executionContextMode(env) === "enforce"
        ? Response.json({ error, code }, { status: 403 })
        : null;
    return { outcome, refusal };
  };

  // A legacy session carries no internal user id: the contract
  // forbids a login as a principal id, so no validated context
  // can ever be resolved for it — refuse before the resolver.
  if (!session.internalUserId) {
    return deny(
      "NO_PRINCIPAL",
      "the session carries no internal user id, so no validated execution context can be resolved for this request",
    );
  }

  const input: ResolvePlatformContextInput = {
    principalId: session.internalUserId,
    sessionId,
    taskId: `http:${trace.traceId}`,
    serviceId: "api",
    permission: "task:read",
    environment: "sandbox",
    nowMs: Date.now(),
    traceId: trace.traceId,
    correlationId: trace.traceId,
    dispatchMode: "manual",
    execMode: "sync",
  };
  const resolve =
    deps.resolve ??
    (await import("./platformContext")).resolvePlatformContext;
  const sources = await (deps.buildSources ?? defaultBuildSources)(env);
  const result = await resolve(sources, input);
  if (!result.ok) {
    return deny(result.code, result.error);
  }
  const outcome: ApiRequestContextOutcome = {
    outcome: "resolved",
    context: result.context,
  };
  setRequestExecutionContext(request, outcome);
  return { outcome, refusal: null };
}
