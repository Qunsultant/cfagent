/**
 * Issue #1743 — Foundation-layer aspect interceptors for the
 * observability port (the AOP doc's target flow, Foundation
 * layer only: tracing → logging → metrics → correlation).
 *
 * withObservability wraps one function with all four in one
 * place: one completion event carrying duration, or one error
 * event carrying a code (never a message). The wrapped
 * function's result and error pass through untouched, and a
 * failing sink never fails the call — observability never
 * changes behavior (the issue's parity criterion).
 *
 * withRequestObservability is the HTTP boundary: it honors an
 * incoming traceparent (or starts a fresh trace), times the
 * request, and returns the handler's response unchanged. It
 * deliberately does NOT mutate the response (no injected
 * headers) — a purely observational wrapper cannot break
 * response-identity pins.
 *
 * These are the unified interceptors the AOP doc's Phase 1
 * calls for, built on the port (one schema, one sink, one
 * trace context). The two legacy aspect modules
 * (src/aspects/loggingAspect.ts, src/outcomes/outcomeAspects.ts)
 * keep serving their existing call sites unchanged in this
 * slice — consolidating them into re-export shims is a
 * follow-up, not a churn event (incremental refactoring only).
 */
import { createObservabilitySink } from "./createObservabilityPorts";
import {
  newTraceContext,
  sessionRefFor,
  timestampIsoFor,
  traceContextFromHeaders,
  type ApiRequestDimensions,
  type ObservabilityEvent,
  type ObservabilitySink,
  type TraceContext,
} from "./observabilityPorts";
// Type-only: the wrapper CONSUMES the boundary's outcome shape
// (never builds one). Erased at compile time — no runtime
// dependency from the observability layer into security.
import type { ApiRequestContextOutcome } from "../security/apiRequestContext";

export interface ObservabilityAspectContext {
  sink: ObservabilitySink;
  operation: string;
  tenantId?: string | null;
  runId?: string | null;
  /** Raw session id — hashed to sessionRef, never logged raw. */
  sessionId?: string | null;
  /** Emitting component (§2.2); null when the caller names none — never fabricated. */
  component?: string | null;
  trace?: TraceContext;
  nowMs?: () => number;
  /**
   * Issue #2065: extra structured facts merged into the event
   * (e.g. binding presence at a start attempt). Codes and facts
   * only — never a raw message.
   */
  fields?: Record<string, unknown>;
}

/** Catalog/business code when the error carries one, else "unknown". Never the message. */
function errorCodeOf(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) return code;
  }
  return "unknown";
}

/** A sink failure never fails the wrapped call (defense in depth under Safe). */
async function safeWrite(
  sink: ObservabilitySink,
  event: ObservabilityEvent,
): Promise<void> {
  try {
    await sink.write(event);
  } catch {
    // The Safe wrapper logs; a raw failing sink degrades silently.
  }
}

/**
 * Wrap a function with tracing + logging + metrics +
 * correlation: one event per call, duration measured, trace
 * carried, scope attached. Result and error pass through.
 */
export async function withObservability<T>(
  ctx: ObservabilityAspectContext,
  fn: () => Promise<T> | T,
): Promise<T> {
  const nowMs = ctx.nowMs ?? Date.now;
  const trace = ctx.trace ?? newTraceContext();
  const start = nowMs();
  const scope = {
    operation: ctx.operation,
    tenantId: ctx.tenantId ?? null,
    actorId: null,
    agentId: null,
    component: ctx.component ?? null,
    runId: ctx.runId ?? null,
    sessionRef: ctx.sessionId ? sessionRefFor(ctx.sessionId) : null,
    traceId: trace.traceId,
    spanId: trace.spanId,
  };
  try {
    const result = await fn();
    const end = nowMs();
    await safeWrite(ctx.sink, {
      ...scope,
      type: ctx.operation,
      level: "info",
      timestampMs: end,
      timestampIso: timestampIsoFor(end),
      durationMs: end - start,
      fields: ctx.fields ?? {},
    });
    return result;
  } catch (err) {
    const end = nowMs();
    await safeWrite(ctx.sink, {
      ...scope,
      type: ctx.operation,
      level: "error",
      timestampMs: end,
      timestampIso: timestampIsoFor(end),
      durationMs: end - start,
      errorCode: errorCodeOf(err),
      fields: ctx.fields ?? {},
    });
    throw err;
  }
}

/** One observed HTTP request: the status + duration the API SLOs read. */
export interface ApiRequestObservation {
  status: number;
  durationMs: number;
  /**
   * Issue #6172: the SLO cuts of the request's validated context
   * (tenant, dispatch mode, exec mode, environment). Present only
   * when the request carried a resolved context — an absent or
   * denied context leaves the observation undimensioned, exactly
   * as the pre-#6172 observations were.
   */
  dimensions?: ApiRequestDimensions;
}

export interface RequestObservabilityOptions {
  /** Resolve the sink from env; null means observability off for this request. */
  sinkFor?: (env: unknown) => ObservabilitySink | null;
  nowMs?: () => number;
  /**
   * Issue #5425 (#3515 S5): per-request hook for the API SLO
   * recording. Called (best-effort, never throwing into the
   * response path) with the status + duration after the log
   * event is written — success path with the real status, error
   * path with 500. A throwing hook is swallowed: observability
   * never changes behavior.
   */
  onRequestObserved?: (observation: ApiRequestObservation, env: unknown) => void;
  /**
   * Issue #6172: read the request's carried execution-context
   * outcome (set by the fetch boundary before the handler runs).
   * The wrapper calls this AFTER the handler settles — the
   * boundary runs inside the wrapped handler, so the carrier is
   * populated only then. A throwing reader is swallowed:
   * observability never changes behavior. Absent (no hook, or
   * an undefined return) means the request carried no context
   * and the event keeps today's nulls.
   */
  contextForRequest?: (
    request: Request,
  ) => ApiRequestContextOutcome | undefined;
}

/**
 * The SLO cuts of a resolved outcome (undefined otherwise).
 * The full id list rides the http.request event's scope +
 * fields; the observation carries only these cuts.
 */
function dimensionsForOutcome(
  outcome: ApiRequestContextOutcome | undefined,
): ApiRequestDimensions | undefined {
  if (!outcome || outcome.outcome !== "resolved") return undefined;
  const c = outcome.context;
  return {
    tenantId: c.tenantId,
    dispatchMode: c.dispatchMode,
    execMode: c.execMode,
    environment: c.environment,
  };
}

/**
 * HTTP boundary wrapper: honor the incoming traceparent (or
 * start a fresh trace), time the request, emit one http.request
 * event (5xx → error level), return the response unchanged.
 * A throwing handler emits an error event and the throw
 * propagates (the error boundary outside converts it).
 *
 * Issue #6172: when the fetch boundary carried a validated
 * execution context on the request, the event's scope names it
 * (tenant, actor = principal, agent = agent run, run, session
 * as a hash — never raw) and its fields carry the context's
 * dimensions + contextStatus; the trace id prefers the
 * context's (the boundary's trace is the request's canonical
 * trace). Without a carried context the event keeps today's
 * nulls and contextStatus "absent" — an unauthenticated
 * request has no tenant, recorded as null, not fabricated.
 */
export function withRequestObservability(
  handler: (request: Request, env: any) => Promise<Response>,
  opts: RequestObservabilityOptions = {},
): (request: Request, env: any) => Promise<Response> {
  const sinkFor =
    opts.sinkFor ??
    ((env: unknown) => createObservabilitySink(env as { OBSERVABILITY?: unknown }));
  const nowMs = opts.nowMs ?? Date.now;
  return async (request: Request, env: any): Promise<Response> => {
    const sink = sinkFor(env);
    const trace = traceContextFromHeaders(request.headers);
    const start = nowMs();
    const readOutcome = (): ApiRequestContextOutcome | undefined => {
      try {
        return opts.contextForRequest?.(request);
      } catch {
        return undefined;
      }
    };
    const observe = async (
      status: number,
      errorCode?: string,
    ): Promise<ApiRequestObservation> => {
      const outcome = readOutcome();
      const context =
        outcome?.outcome === "resolved" ? outcome.context : undefined;
      const end = nowMs();
      const observation: ApiRequestObservation = {
        status,
        durationMs: end - start,
        dimensions: dimensionsForOutcome(outcome),
      };
      if (sink) {
        const event: ObservabilityEvent = {
          type: "http.request",
          level:
            errorCode !== undefined || status >= 500 ? "error" : "info",
          operation: "http.request",
          tenantId: context?.tenantId ?? null,
          actorId: context?.principalId ?? null,
          agentId: context?.agentRunId ?? null,
          component: "http",
          runId: context?.runId ?? null,
          sessionRef: context?.sessionId
            ? sessionRefFor(context.sessionId)
            : null,
          traceId: context?.traceId ?? trace.traceId,
          spanId: trace.spanId,
          timestampMs: end,
          timestampIso: timestampIsoFor(end),
          durationMs: end - start,
          fields: {
            method: request.method,
            status,
            dispatchMode: context?.dispatchMode,
            execMode: context?.execMode,
            environment: context?.environment,
            platformId: context?.platformId,
            taskId: context?.taskId,
            serviceId: context?.serviceId,
            correlationId: context?.correlationId,
            contextStatus: outcome?.outcome ?? "absent",
          },
        };
        if (errorCode !== undefined) event.errorCode = errorCode;
        await safeWrite(sink, event);
      }
      if (opts.onRequestObserved) {
        try {
          opts.onRequestObserved(observation, env);
        } catch {
          // Best-effort: a failing hook never fails the request.
        }
      }
      return observation;
    };
    try {
      const response = await handler(request, env);
      await observe(response.status);
      return response;
    } catch (err) {
      await observe(500, errorCodeOf(err));
      throw err;
    }
  };
}
