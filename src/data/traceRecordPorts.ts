/**
 * Issue #2288 (#1976 step 0, ADR 0022 D-F.2) — trace-record port.
 *
 * The unified trace substrate: one record per cross-agent call /
 * workflow step, in a D1-native family every agent can append to
 * and the intelligence loop (Sentinel #2279 first) can read —
 * the gap the survey recorded in §5.2 (mas_events is per-DO,
 * session-scoped, and carries no correlation fields; Analytics
 * Engine is fire-and-forget with no read port).
 *
 * Port-first (ADR 0002 R1/R2): this module carries record types,
 * the port interface, and pure helpers ONLY. It imports no store
 * client, references no env binding, and writes no SQL. Query
 * code lives in d1TraceRecordAdapter.ts; the in-memory adapter
 * shares this module's types so the two cannot drift. A
 * structural test pins the import rule.
 *
 * Append discipline (#1133, ADR 0022 D-F2): substrate writes
 * never throw into the caller's path. The port's appendTrace is
 * the writer-path operation and DOES throw (a caller who must
 * know uses it directly); `recordTraceSafely` is the discipline
 * wrapper every publication call site should use — it converts
 * a failed append into a recorded result carrying the stable
 * catalog code DATA_TRACE_APPEND_FAILED, mirroring
 * captureStore's never-throws + failure-marker semantics. The
 * gap is visible in the result, never silently swallowed.
 *
 * Attribution is two-part (G14): every record names the acting
 * agent AND the principal it acted for. Retention is gate G-4:
 * no retention line is encoded in this slice beyond the schema.
 */
import {
  DataFoundationCode,
} from "../aspects/errorCodes";

import { createStructuredLogger } from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

/** One trace record: a single cross-agent call / workflow step. */
export interface TraceRecord {
  /** Caller-supplied id; replays of the same id are no-ops. */
  id: string;
  /** The end-to-end flow this step belongs to. */
  correlationId: string;
  /** The step that caused this one; null for a flow's first step. */
  causationId: string | null;
  /** The agent that performed the step (G14 acting identity). */
  actingAgent: string;
  /** The principal the agent acted for (G14). */
  principal: string;
  /** Operation name, e.g. "aisearch.search" or "workflow.step". */
  operation: string;
  /** Catalog outcome code (#1969), e.g. DATA_TX_COMMITTED. */
  outcomeCode: string;
  /** Step latency when measured; null when not applicable. */
  latencyMs: number | null;
  /** Normalized cost units when metered; null when not metered. */
  costUnits: number | null;
  /** JSON detail for cost attribution; null when not metered. */
  costDetailJson: string | null;
  /** Epoch milliseconds when the step occurred. */
  occurredAtMs: number;
}

/** The trace store surface: append + the loop's two reads. */
export interface TraceRecordStore {
  /**
   * Append one record. Writer-path semantics: THROWS on error.
   * Replaying an existing id is a no-op (at-least-once safe).
   */
  appendTrace(record: TraceRecord): Promise<void>;
  /** All steps of one flow, oldest first. Throws on error. */
  listByCorrelation(correlationId: string): Promise<TraceRecord[]>;
  /** One agent's recent steps, newest first. Throws on error. */
  listByAgent(actingAgent: string, limit?: number): Promise<TraceRecord[]>;
}

/** The #1133-discipline result of a safe append. */
export type RecordTraceResult =
  | { recorded: true }
  | { recorded: false; failureCode: DataFoundationCode; error: string };

/**
 * Append a trace record WITHOUT ever throwing into the caller
 * (#1133 capture discipline, ADR 0022 D-F2): a failed append is
 * logged with its catalog code and returned as data, so the
 * substrate's gap is on the record instead of becoming a second
 * failure inside the operation being traced.
 */
export async function recordTraceSafely(
  store: TraceRecordStore,
  record: TraceRecord,
  options?: { sink?: ObservabilitySink },
): Promise<RecordTraceResult> {
  // #3515 S3 batch 7 — logger over the injected sink (d1QueryLogger
  // precedent), else the structured console fallback (never a `{}` sink,
  // #5587). This port module has no env binding by design.
  const structuredLog = createStructuredLogger(
    options?.sink ?? new ConsoleObservabilitySink(),
    { component: "data/traceRecordPorts" },
  );
  try {
    await store.appendTrace(record);
    return { recorded: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    structuredLog.error("traceRecordPorts.trace_append_failed", {
      message: `[data-foundation] Trace append failed (${DataFoundationCode.TRACE_APPEND_FAILED}) for ${record.actingAgent}/${record.operation}:`,
      error: message,
      failureCode: DataFoundationCode.TRACE_APPEND_FAILED,
      actingAgent: record.actingAgent,
      operation: record.operation,
    });
    return {
      recorded: false,
      failureCode: DataFoundationCode.TRACE_APPEND_FAILED,
      error: message,
    };
  }
}
