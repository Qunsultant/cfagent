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
  type ObservabilityEvent,
  type ObservabilitySink,
  type TraceContext,
} from "./observabilityPorts";

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

export interface RequestObservabilityOptions {
  /** Resolve the sink from env; null means observability off for this request. */
  sinkFor?: (env: unknown) => ObservabilitySink | null;
  nowMs?: () => number;
}

/**
 * HTTP boundary wrapper: honor the incoming traceparent (or
 * start a fresh trace), time the request, emit one http.request
 * event (5xx → error level), return the response unchanged.
 * A throwing handler emits an error event and the throw
 * propagates (the error boundary outside converts it).
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
    try {
      const response = await handler(request, env);
      const end = nowMs();
      if (sink) {
        await safeWrite(sink, {
          type: "http.request",
          level: response.status >= 500 ? "error" : "info",
          operation: "http.request",
          tenantId: null,
          actorId: null,
          agentId: null,
          component: "http",
          runId: null,
          sessionRef: null,
          traceId: trace.traceId,
          spanId: trace.spanId,
          timestampMs: end,
          timestampIso: timestampIsoFor(end),
          durationMs: end - start,
          fields: { method: request.method, status: response.status },
        });
      }
      return response;
    } catch (err) {
      const end = nowMs();
      if (sink) {
        await safeWrite(sink, {
          type: "http.request",
          level: "error",
          operation: "http.request",
          tenantId: null,
          actorId: null,
          agentId: null,
          component: "http",
          runId: null,
          sessionRef: null,
          traceId: trace.traceId,
          spanId: trace.spanId,
          timestampMs: end,
          timestampIso: timestampIsoFor(end),
          durationMs: end - start,
          errorCode: errorCodeOf(err),
          fields: { method: request.method },
        });
      }
      throw err;
    }
  };
}
