/**
 * Analytics-lake archiving ASPECT (AOP at a port boundary).
 *
 * A cross-cutting concern — "record what this port persisted, for the
 * analytics tier" — woven around the existing `FeedDatasetStore` port instead
 * of being sprinkled through the feed jobs. Domain code is untouched: the
 * decorator is applied once, in the composition root.
 *
 * The advice is deliberately narrow:
 *  - it runs AFTER the inner store's write succeeded, so nothing is archived
 *    that was not persisted;
 *  - it only archives the datasets it is configured for (default: technicals);
 *  - it NEVER throws and NEVER blocks the caller's result — a lake outage is
 *    reported through the structured log and the run stands on its own
 *    records (the same best-effort rule the feed outcome sink follows).
 */
import type {
  FeedDatasetArtifact,
  FeedDatasetStore,
  FeedDatasetStoreInput,
} from "../data/feedDatasetPorts";
import type { AnalyticsLakePort, LakeEvent } from "../data/analyticsLakePorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "aspects/analyticsLakeAspect",
});

export const ANALYTICS_LAKE_ARCHIVE_FAILED = "analytics_lake_archive_failed" as const;

/** Issue #5816 — one bar row, compacted to an array to keep events small. */
export type LakeBarRow = [string, number, number, number, number, number];

function compactBars(bars: unknown): LakeBarRow[] {
  if (!Array.isArray(bars)) return [];
  const rows: LakeBarRow[] = [];
  for (const raw of bars) {
    const bar = raw as { date?: unknown; open?: unknown; high?: unknown; low?: unknown; close?: unknown; volume?: unknown };
    if (typeof bar?.date !== "string") continue;
    rows.push([
      bar.date,
      Number(bar.open ?? 0),
      Number(bar.high ?? 0),
      Number(bar.low ?? 0),
      Number(bar.close ?? 0),
      Number(bar.volume ?? 0),
    ]);
  }
  return rows;
}

/**
 * Issue #5816 — one event per (run, symbol) for a bars-carrying dataset.
 * Returns the events and how many were dropped by the ceiling; the caller
 * reports the drop, never silently truncates.
 */
export function lakeBarEventsForArtifact(
  input: FeedDatasetStoreInput,
  artifact: FeedDatasetArtifact,
  table: string,
  maxEvents: number,
): { events: LakeEvent[]; dropped: number } {
  const rows = (input as { bars?: unknown }).bars;
  if (!Array.isArray(rows)) return { events: [], dropped: 0 };
  const run = input.run;
  const events: LakeEvent[] = [];
  let dropped = 0;
  for (const raw of rows) {
    const row = raw as { symbol?: unknown; bars?: unknown };
    const symbol = typeof row?.symbol === "string" ? row.symbol.toUpperCase() : "";
    if (!symbol) continue;
    const bars = compactBars(row.bars);
    if (bars.length === 0) continue;
    if (events.length >= maxEvents) {
      dropped += 1;
      continue;
    }
    events.push({
      table,
      eventId: `bars:${artifact.id}:${symbol}`,
      asOf: artifact.asOf,
      payload: {
        artifactId: artifact.id,
        jobId: input.jobId,
        dataset: input.dataset,
        runId: run.runId,
        symbol,
        barCount: bars.length,
        bars,
      },
    });
  }
  return { events, dropped };
}

/** One artifact becomes one small event: counts + provenance, never the payload. */
export function lakeEventForArtifact(
  input: FeedDatasetStoreInput,
  artifact: FeedDatasetArtifact,
  table: string,
): LakeEvent {
  const run = input.run;
  return {
    table,
    eventId: `dataset:${artifact.id}`,
    asOf: artifact.asOf,
    payload: {
      artifactId: artifact.id,
      jobId: input.jobId,
      sourceId: input.sourceId,
      dataset: input.dataset,
      runId: run.runId,
      status: run.status,
      trigger: run.trigger,
      requested: run.requested,
      received: run.received,
      failed: run.failed,
      codedError: run.codedError ?? null,
      universeKind: input.universe?.kind ?? null,
      universeIndex: (input.universe as { index?: unknown } | undefined)?.index ?? null,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
  };
}

/**
 * Decorate a feed-dataset store so persisted artifacts of the configured
 * datasets are archived to the lake. Every other contract of the port passes
 * through unchanged.
 */
export function withLakeArchive(
  store: FeedDatasetStore,
  lake: AnalyticsLakePort,
  options: {
    datasets: readonly string[];
    table: string;
    /** Issue #5816 — "dataset" (default) or "bars". */
    granularity?: "dataset" | "bars";
    /** Issue #5816 — events per artifact ceiling. */
    maxEvents?: number;
  },
): FeedDatasetStore {
  const wanted = new Set(options.datasets.map((d) => d.toLowerCase()));
  const granularity = options.granularity ?? "dataset";
  const maxEvents = Math.max(1, options.maxEvents ?? 500);
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "store") {
        return async (input: FeedDatasetStoreInput): Promise<FeedDatasetArtifact> => {
          const artifact = await target.store(input);
          if (!wanted.has(String(input.dataset).toLowerCase())) return artifact;
          try {
            // Issue #5816 — bars granularity emits one event per symbol and
            // reports the ceiling instead of truncating silently.
            const batch =
              granularity === "bars"
                ? lakeBarEventsForArtifact(input, artifact, options.table, maxEvents)
                : {
                    events: [lakeEventForArtifact(input, artifact, options.table)],
                    dropped: 0,
                  };
            if (batch.dropped > 0) {
              structuredLog.warn(ANALYTICS_LAKE_ARCHIVE_FAILED, {
                message: `[analyticsLake] ceiling ${maxEvents} dropped ${batch.dropped} bar event(s)`,
                jobId: input.jobId,
                dataset: input.dataset,
                runId: input.run?.runId,
                reason: "analytics_lake_max_events",
              });
            }
            const result = await lake.append(batch.events);
            if (result.dropped > 0) {
              structuredLog.warn(ANALYTICS_LAKE_ARCHIVE_FAILED, {
                message: `[analyticsLake] archive dropped ${result.dropped} event(s)`,
                jobId: input.jobId,
                dataset: input.dataset,
                runId: input.run?.runId,
                reason: result.reason,
              });
            }
          } catch (err) {
            // Best-effort: the dataset is persisted; the lake is analytics.
            structuredLog.warn(ANALYTICS_LAKE_ARCHIVE_FAILED, {
              message: `[analyticsLake] archive failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
              jobId: input.jobId,
              dataset: input.dataset,
              runId: input.run?.runId,
            });
          }
          return artifact;
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
}
