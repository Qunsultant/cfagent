/**
 * Issue #1743 — Cloudflare Analytics Engine adapter for the
 * observability port. This is the ONLY module that touches the
 * Analytics Engine binding: domain code imports the port types
 * and the composition root, never this adapter.
 *
 * Datapoint mapping (Analytics Engine allows up to 20 blobs
 * and doubles, but EXACTLY ONE index — the docs state a
 * datapoint with multiple indexes is not recorded, and the
 * SQL table exposes only index1):
 *  - indexes (the sampling key): [tenant ("none" when the
 *    boundary has no tenant scope)] — per-tenant sampling, so
 *    one tenant's flood samples only that tenant's events.
 *  - doubles (measurable): [durationMs (0 when absent),
 *    count (1 when absent)]
 *  - blobs (filterable dimensions): [type, level, operation,
 *    runId ("" when absent), sessionRef ("" when absent),
 *    traceId, errorCode ("" when absent), actorId ("" when
 *    absent), agentId ("" when absent), component ("" when
 *    absent), timestampIso, fields JSON (redacted)] — the §2.2
 *    mandatory attributes ride as blobs so the stream stays
 *    queryable on actor / agent / component / time.
 * writeDataPoint is synchronous and buffered by the runtime —
 * the sink never awaits a network round-trip, so a slow or
 * unavailable Analytics Engine cannot stall the request (and
 * the Safe wrapper degrades to local logging on throw).
 */
import {
  redactForStream,
  type ObservabilityEvent,
  type ObservabilitySink,
} from "./observabilityPorts";

/** Minimal structural surface of an Analytics Engine dataset. */
export interface AnalyticsEngineDatasetLike {
  writeDataPoint(point: {
    indexes?: ((ArrayBuffer | string) | null)[];
    doubles?: number[];
    blobs?: ((ArrayBuffer | string) | null)[];
  }): void;
}

/** Pure mapping, unit-testable without a binding. */
export function eventToDataPoint(event: ObservabilityEvent): {
  indexes: string[];
  doubles: number[];
  blobs: string[];
} {
  return {
    indexes: [event.tenantId ?? "none"],
    doubles: [event.durationMs ?? 0, event.count ?? 1],
    blobs: [
      event.type,
      event.level,
      event.operation,
      event.runId ?? "",
      event.sessionRef ?? "",
      event.traceId,
      event.errorCode ?? "",
      event.actorId ?? "",
      event.agentId ?? "",
      event.component ?? "",
      event.timestampIso,
      JSON.stringify(redactForStream(event.fields)),
    ],
  };
}

export class AnalyticsEngineObservabilityAdapter implements ObservabilitySink {
  constructor(private readonly dataset: AnalyticsEngineDatasetLike) {}

  write(event: ObservabilityEvent): void {
    this.dataset.writeDataPoint(eventToDataPoint(event));
  }

  writeBatch(events: readonly ObservabilityEvent[]): void {
    for (const event of events) this.write(event);
  }
}
