/**
 * Issue #2860 (15-factor re-audit, Factor 14 Telemetry) — per-isolate
 * screen-run metrics aggregation.
 *
 * Consumes the funnel's screen.started / screen.completed /
 * screen.failed events (logScreenRunEvent, the one join point in
 * src/workflows/screenRunAspects.ts) and folds them into the counts
 * the telemetry summary reads: runs started/completed/failed, total
 * + average duration, and failures by classification — broken down
 * by (trigger, universe) so a spike is attributable to a trigger
 * and a universe, not just to "screens". This is the telemetry
 * slice's consumption of the funnel: it does NOT redefine the event
 * (it reuses ScreenRunLogEvent's shape) and does NOT persist
 * counts — they are ephemeral operational signals with the same
 * documented loss semantics as retrieval stats (src/telemetry/
 * retrievalStats.ts: an isolate recycle resets them; fail-open on
 * cold start). The durable home for run streams is #1743's
 * Analytics Engine pipeline (named follow-up, not built here).
 *
 * Validation: only well-formed funnel events fold (known event
 * name, string trigger/universe, numeric duration when present).
 * Malformed or foreign events return false and change nothing;
 * ingestion never throws.
 */

export type ScreenRunMetricEvent = "screen.started" | "screen.completed" | "screen.failed";

export interface ScreenRunMetricInput {
  event: ScreenRunMetricEvent;
  trigger: string;
  universe: string;
  /** Milliseconds the run took (completed/failed only). */
  durationMs?: number;
  /** Failure classification (failed only). */
  classification?: string;
}

export interface ScreenRunBucket {
  trigger: string;
  universe: string;
  started: number;
  completed: number;
  failed: number;
  /** Sum of durationMs over completed + failed runs in this bucket. */
  totalDurationMs: number;
  /** Runs that carried a duration (completed + failed). */
  durationSamples: number;
  /** Failures by classification (failed only). */
  failedByClassification: Record<string, number>;
}

export interface ScreenRunStatsSnapshot {
  totalStarted: number;
  totalCompleted: number;
  totalFailed: number;
  totalDurationMs: number;
  buckets: ScreenRunBucket[];
}

const buckets = new Map<string, ScreenRunBucket>();

function bucketFor(trigger: string, universe: string): ScreenRunBucket {
  const key = `${trigger}::${universe}`;
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = {
      trigger,
      universe,
      started: 0,
      completed: 0,
      failed: 0,
      totalDurationMs: 0,
      durationSamples: 0,
      failedByClassification: {},
    };
    buckets.set(key, bucket);
  }
  return bucket;
}

/** Fold one funnel event into the accumulator. */
export function ingestScreenRunEvent(input: ScreenRunMetricInput): boolean {
  if (!input || typeof input !== "object") return false;
  if (
    input.event !== "screen.started" &&
    input.event !== "screen.completed" &&
    input.event !== "screen.failed"
  ) {
    return false;
  }
  if (typeof input.trigger !== "string" || typeof input.universe !== "string") return false;
  if (input.durationMs !== undefined && typeof input.durationMs !== "number") return false;
  if (input.classification !== undefined && typeof input.classification !== "string") return false;
  const bucket = bucketFor(input.trigger, input.universe);
  if (input.event === "screen.started") bucket.started += 1;
  if (input.event === "screen.completed") bucket.completed += 1;
  if (input.event === "screen.failed") {
    bucket.failed += 1;
    if (input.classification) {
      bucket.failedByClassification[input.classification] =
        (bucket.failedByClassification[input.classification] ?? 0) + 1;
    }
  }
  if (input.durationMs !== undefined) {
    bucket.totalDurationMs += input.durationMs;
    bucket.durationSamples += 1;
  }
  return true;
}

/** Current accumulator snapshot (copies — callers cannot mutate state). */
export function screenRunStatsSnapshot(): ScreenRunStatsSnapshot {
  const list = [...buckets.values()].map((b) => ({
    ...b,
    failedByClassification: { ...b.failedByClassification },
  }));
  return {
    totalStarted: list.reduce((n, b) => n + b.started, 0),
    totalCompleted: list.reduce((n, b) => n + b.completed, 0),
    totalFailed: list.reduce((n, b) => n + b.failed, 0),
    totalDurationMs: list.reduce((n, b) => n + b.totalDurationMs, 0),
    buckets: list,
  };
}

/** Test seam: drop the accumulator (mirrors __resetRetrievalStats). */
export function __resetScreenRunStats(): void {
  buckets.clear();
}
