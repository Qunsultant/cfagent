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
  options: { datasets: readonly string[]; table: string },
): FeedDatasetStore {
  const wanted = new Set(options.datasets.map((d) => d.toLowerCase()));
  return new Proxy(store, {
    get(target, prop, receiver) {
      if (prop === "store") {
        return async (input: FeedDatasetStoreInput): Promise<FeedDatasetArtifact> => {
          const artifact = await target.store(input);
          if (!wanted.has(String(input.dataset).toLowerCase())) return artifact;
          try {
            const result = await lake.append([
              lakeEventForArtifact(input, artifact, options.table),
            ]);
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
