/**
 * Resource-usage measurement port (issue #1819).
 *
 * Pure port, no bindings, no I/O — the same shape as #1742's TelemetryPort
 * (`src/telemetry/`), but for a different subject: rows read/written by
 * Durable Object SQLite (and D1) statements, attributed to a caller and a
 * trigger. The port exists because the 2026-10-26 SessionStore quota
 * exhaustion could not be attributed from code: point gets are cheap, but
 * volume × ops-per-request is invisible without measured counters.
 *
 * Event discipline (owner instrument-first direction, aligned shape):
 * - fields are rowsRead/rowsWritten/caller/trigger/statement fingerprint —
 *   NEVER bindings, tokens, user data, or raw session ids. `sessionRef`, when
 *   present, must already be a truncated hash (the #1743 convention), never
 *   the session id itself.
 * - `statement` is the parameterized SQL template only (placeholders, no
 *   bound values); `fingerprintSql` normalizes whitespace so the same
 *   template maps to one key however it was laid out in source.
 * - caller/trigger are populated ONLY where a call site passes attribution
 *   explicitly. They are never inferred: an unattributed op aggregates as
 *   "unknown" (see `bucketTotals`), it is not guessed.
 * - Conversion to #1743's landed schema (`toObservabilityEvent`) makes the
 *   resource event a new event TYPE inside the existing stream — same
 *   tenant/run/session scope, same key-based redaction, same single-index
 *   Analytics Engine constraint — not a second schema and not a second
 *   pipeline. Aggregation lives in exactly one place: `bucketTotals`, whose
 *   units (rows read/written per op, time-bucketed) are the units the
 *   Cloudflare dashboard reports, so instrumented totals line up against
 *   dashboard hourly curves.
 */
import {
  timestampIsoFor,
  type ObservabilityEvent,
} from "../observability/observabilityPorts";

/** Where the op was triggered from. Absent = unknown (never inferred). */
export type ResourceTrigger = "user" | "scheduled" | "tick" | "manual";

/** Explicit attribution, passed by the call site that knows it. */
export interface ResourceAttribution {
  caller: string;
  trigger: ResourceTrigger;
}

export interface ResourceUsageEvent {
  /** Logical bucket inside the store ("sessions", "etrade", ...). */
  ns: string;
  /** Store op ("get" | "put" | "delete" | "consume" | "list"). */
  op: string;
  /** Platform-measured rows read/written for this op (cursor totals). */
  rowsRead: number;
  rowsWritten: number;
  /** Call-site attribution; absent when the call site did not pass it. */
  caller?: string;
  trigger?: ResourceTrigger;
  /** Parameterized SQL template only — never bound values. */
  statement?: string;
  /** #1743 scope; sessionRef must already be a truncated hash, never an id. */
  tenantId?: string | null;
  runId?: string | null;
  sessionRef?: string | null;
  timestampMs: number;
  durationMs?: number;
}

/** The port: one measured event per store op. Recording never throws. */
export interface ResourceUsagePort {
  record(event: ResourceUsageEvent): void | Promise<void>;
}

/** Collapse whitespace so one template maps to one key. */
export function fingerprintSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim();
}

/**
 * Convert a resource event into #1743's landed ObservabilityEvent shape.
 * Field keys are chosen to survive the landed key-based redaction with
 * nothing to redact (no key/secret/token/password/session/credential key).
 * traceId is empty: resource events are emitted outside request tracing; a
 * future slice may stamp the W3C traceparent instead of inventing one.
 */
export function toObservabilityEvent(event: ResourceUsageEvent): ObservabilityEvent {
  const fields: Record<string, unknown> = {
    ns: event.ns,
    op: event.op,
    rowsRead: event.rowsRead,
    rowsWritten: event.rowsWritten,
  };
  if (event.caller !== undefined) fields.caller = event.caller;
  if (event.trigger !== undefined) fields.trigger = event.trigger;
  if (event.statement !== undefined) fields.statement = event.statement;
  return {
    type: "resource.sql_op",
    level: "info",
    operation: "resource.sql_op",
    tenantId: event.tenantId ?? null,
    actorId: null,
    agentId: null,
    component: "resource-usage",
    runId: event.runId ?? null,
    sessionRef: event.sessionRef ?? null,
    traceId: "",
    timestampMs: event.timestampMs,
    timestampIso: timestampIsoFor(event.timestampMs),
    ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
    fields,
  };
}

export interface ResourceBucketTotal {
  bucketStartMs: number;
  ns: string;
  op: string;
  caller: string;
  trigger: string;
  ops: number;
  rowsRead: number;
  rowsWritten: number;
}

/**
 * The single aggregation definition: time-bucketed totals by ns/op/caller/
 * trigger. Both the D1 adapter's SQL totals and the in-memory adapter use
 * this shape, so a total computed from instrumented events and a total read
 * off the dashboard's hourly curves are comparable numbers.
 */
export function bucketTotals(
  events: readonly ResourceUsageEvent[],
  bucketMs: number
): ResourceBucketTotal[] {
  const grouped = new Map<string, ResourceBucketTotal>();
  for (const event of events) {
    const bucketStartMs = Math.floor(event.timestampMs / bucketMs) * bucketMs;
    const caller = event.caller ?? "unknown";
    const trigger = event.trigger ?? "unknown";
    const key = [bucketStartMs, event.ns, event.op, caller, trigger].join("\0");
    const existing = grouped.get(key);
    if (existing) {
      existing.ops += 1;
      existing.rowsRead += event.rowsRead;
      existing.rowsWritten += event.rowsWritten;
    } else {
      grouped.set(key, {
        bucketStartMs,
        ns: event.ns,
        op: event.op,
        caller,
        trigger,
        ops: 1,
        rowsRead: event.rowsRead,
        rowsWritten: event.rowsWritten,
      });
    }
  }
  return [...grouped.values()].sort(
    (a, b) =>
      a.bucketStartMs - b.bucketStartMs ||
      a.ns.localeCompare(b.ns) ||
      a.op.localeCompare(b.op) ||
      a.caller.localeCompare(b.caller) ||
      a.trigger.localeCompare(b.trigger)
  );
}
