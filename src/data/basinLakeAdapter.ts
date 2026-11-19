/**
 * Basin pipeline adapter — the lake's HTTP ingest edge.
 *
 * Basin Pipelines accept a schema'd event batch over HTTP; the pipeline's SQL
 * then rolls it into an Iceberg table through the catalog. This adapter is
 * ONLY the transport: batching, auth, and a named failure. It deliberately
 * does not retry — the archiving aspect decides what a failure means, and a
 * feed run must never wait on the lake.
 */
import type { AnalyticsLakePort, LakeAppendResult, LakeEvent } from "./analyticsLakePorts";

export const ANALYTICS_LAKE_APPEND_FAILED = "analytics_lake_append_failed" as const;

export interface BasinLakeAdapterOptions {
  endpoint: string;
  token: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Batch ceiling; larger appends are chunked. */
  batchSize?: number;
}

export class BasinLakeAdapter implements AnalyticsLakePort {
  private readonly batchSize: number;
  private readonly doFetch: typeof fetch;

  constructor(private readonly opts: BasinLakeAdapterOptions) {
    this.batchSize = Math.max(1, opts.batchSize ?? 100);
    this.doFetch = opts.fetchImpl ?? fetch;
  }

  async append(events: readonly LakeEvent[]): Promise<LakeAppendResult> {
    if (events.length === 0) return { accepted: 0, dropped: 0 };
    let accepted = 0;
    for (let i = 0; i < events.length; i += this.batchSize) {
      const batch = events.slice(i, i + this.batchSize);
      let response: Response;
      try {
        response = await this.doFetch(this.opts.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.opts.token}`,
          },
          // Issue #5830/#5816 — the stream schema is scalar-typed
          // (string/int64/float64/bool), so the body rides as a JSON string:
          // portable across Basin's schema and still queryable in Basin SQL.
          body: JSON.stringify(
            batch.map((event) => ({
              ...event,
              payload: JSON.stringify(event.payload),
            })),
          ),
        });
      } catch (err) {
        throw new Error(
          `${ANALYTICS_LAKE_APPEND_FAILED}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      if (!response.ok) {
        throw new Error(
          `${ANALYTICS_LAKE_APPEND_FAILED}: ingest returned ${response.status}`,
        );
      }
      accepted += batch.length;
    }
    return { accepted, dropped: events.length - accepted };
  }
}
