/**
 * The analytics-lake port: append-only events for the analytics tier.
 *
 * Deliberately NOT a read API and NOT a transactional store. Its one job is
 * to carry a record of something that already happened (a persisted dataset
 * artifact) to a lake that answers historical/aggregate questions D1 cannot
 * once its rows are pruned. Implementations must be safe to call best-effort:
 * the archiving aspect swallows and reports their failures, because a lake
 * outage must never fail a feed run.
 */
export interface LakeEvent {
  /** Iceberg table the event belongs to (namespace.table). */
  table: string;
  /** Stable id for the event, so a replay can be de-duplicated. */
  eventId: string;
  /** When the recorded fact happened (ISO). */
  asOf: string;
  /** The event body; JSON-shaped, small by contract (counts + provenance). */
  payload: Record<string, unknown>;
}

export interface LakeAppendResult {
  accepted: number;
  dropped: number;
  /** Present when anything was dropped, naming why. */
  reason?: string;
}

export interface AnalyticsLakePort {
  append(events: readonly LakeEvent[]): Promise<LakeAppendResult>;
}
