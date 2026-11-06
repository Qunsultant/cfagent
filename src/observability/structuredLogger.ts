/**
 * Issue #3515 S2 — structured logging foundation (standards.md
 * §2.2). The central structured logger: the ONE seam through
 * which execution code emits structured logs.
 *
 * The slice 0 audit found no central structured logger in the
 * tree (grep for structuredLog / createLogger: zero hits) and
 * 671 console.* call sites emitting plain text. This module is
 * the logger the S3 console.* migration adopts — scope defaults
 * (tenant, actor, agent, component, trace) are carried once at
 * construction, never re-derived per call site.
 *
 * Every emitted event carries the 7 mandatory attributes
 * (trace_id, tenant_id, actor_id, agent_id, timestamp_iso8601,
 * severity, component) on the ObservabilityEvent schema: the
 * logger builds the full event and writes it through the
 * observability sink, so the Analytics Engine adapter, the
 * in-memory adapter, and the unbound JSON console fallback all
 * receive the same shaped record. Absent scope reads null —
 * never fabricated. The trace id is a correlator, not scope:
 * a fresh one is minted when no context reaches the logger
 * (the same ingress rule as traceContextFromHeaders).
 *
 * The logger never fails the caller: a throwing sink (sync or
 * async) is swallowed — logging is observability, never
 * behavior. Redaction stays the adapters' job (the port
 * discipline): fields pass through untouched here.
 */
import {
  newTraceContext,
  timestampIsoFor,
  type ObservabilityEvent,
  type ObservabilityLevel,
  type ObservabilitySink,
} from "./observabilityPorts";

/** Scope defaults carried once at construction. All optional; absent reads null. */
export interface StructuredLogContext {
  tenantId?: string | null;
  actorId?: string | null;
  agentId?: string | null;
  component?: string | null;
  traceId?: string;
  runId?: string | null;
  sessionRef?: string | null;
  spanId?: string;
  nowMs?: () => number;
}

/** Per-call overrides: anything the context carries, plus the call's own time and code. */
export interface StructuredLogOverrides {
  tenantId?: string | null;
  actorId?: string | null;
  agentId?: string | null;
  component?: string | null;
  traceId?: string;
  runId?: string | null;
  sessionRef?: string | null;
  spanId?: string;
  timestampMs?: number;
  errorCode?: string;
}

export interface StructuredLogger {
  info(
    operation: string,
    fields?: Record<string, unknown>,
    overrides?: StructuredLogOverrides,
  ): void;
  warn(
    operation: string,
    fields?: Record<string, unknown>,
    overrides?: StructuredLogOverrides,
  ): void;
  error(
    operation: string,
    fields?: Record<string, unknown>,
    overrides?: StructuredLogOverrides,
  ): void;
}

/** Build a logger over a sink with scope defaults. The sink is never null (see createObservabilitySink). */
export function createStructuredLogger(
  sink: ObservabilitySink,
  context: StructuredLogContext = {},
): StructuredLogger {
  const nowMs = context.nowMs ?? Date.now;

  function emit(
    level: ObservabilityLevel,
    operation: string,
    fields: Record<string, unknown>,
    overrides: StructuredLogOverrides,
  ): void {
    const timestampMs = overrides.timestampMs ?? nowMs();
    const event: ObservabilityEvent = {
      type: operation,
      level,
      operation,
      tenantId: overrides.tenantId ?? context.tenantId ?? null,
      actorId: overrides.actorId ?? context.actorId ?? null,
      agentId: overrides.agentId ?? context.agentId ?? null,
      component: overrides.component ?? context.component ?? null,
      runId: overrides.runId ?? context.runId ?? null,
      sessionRef: overrides.sessionRef ?? context.sessionRef ?? null,
      traceId:
        overrides.traceId ?? context.traceId ?? newTraceContext().traceId,
      ...(overrides.spanId ?? context.spanId
        ? { spanId: overrides.spanId ?? context.spanId }
        : {}),
      timestampMs,
      timestampIso: timestampIsoFor(timestampMs),
      ...(overrides.errorCode ? { errorCode: overrides.errorCode } : {}),
      fields,
    };
    try {
      const result = sink.write(event);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {
          // A failing async sink degrades silently — logging
          // never fails the caller.
        });
      }
    } catch {
      // A throwing sync sink degrades silently.
    }
  }

  return {
    info: (operation, fields = {}, overrides = {}) =>
      emit("info", operation, fields, overrides),
    warn: (operation, fields = {}, overrides = {}) =>
      emit("warn", operation, fields, overrides),
    error: (operation, fields = {}, overrides = {}) =>
      emit("error", operation, fields, overrides),
  };
}
