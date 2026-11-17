/**
 * Issue #5082 (S2, observability program #5080) — the OTLP
 * metrics ingestion handler: OTLP/JSON metrics in, R2 archive
 * out (POST /api/otel/v1/metrics), the same pattern S1 built
 * for logs (POST /api/otel/v1/logs).
 *
 * TDD Red first: the handler (handleOtelMetricsIngestion in
 * src/observability/otelIngestion.ts) does not exist yet, so
 * this file fails at import.
 *
 * Design (recorded in the PR body):
 * - Flow: OTel SDK -> OTLP/HTTP (JSON) -> POST
 *   /api/otel/v1/metrics (the route in src/server/routes/otel.ts,
 *   a real HTTP endpoint for external OTLP senders, token-gated
 *   by the same OTEL_INGEST_TOKEN as the logs route) -> one
 *   JSONL object in R2 (REPORTS_BUCKET, otel-archive/ prefix).
 *   The Worker-side SDK uses this same handler in-process (the
 *   transport calls the handler directly — the 522 self-fetch
 *   rule). One JSONL object per ingestion batch (not one per
 *   metric point): a batch is one exporter flush, so one R2
 *   write amortizes the whole batch. The object key is
 *   `otel-archive/<YYYY-MM-DD>/<id>.jsonl`; each line is one
 *   OTLP metric (the raw metric JSON).
 * - R2 unbound -> the metrics fall back to the structured
 *   logger (Workers Logs in production, via the base sink) and
 *   the response says so; nothing is dropped silently. A
 *   malformed payload is rejected (400, OBS-1004); an R2 write
 *   failure is a 500 (OBS-1003). The handler is pure (the
 *   BlobStore is a dependency), so it is testable with an
 *   in-memory double behind the same port.
 * - The metrics archive lives under the same otel-archive/
 *   prefix as the logs archive; the two signals are
 *   distinguished by the payload shape (resourceMetrics vs
 *   resourceLogs), not by a second prefix.
 */
import { describe, it, expect } from "vitest";
import {
  handleOtelMetricsIngestion,
  OTEL_ARCHIVE_PREFIX,
} from "../src/observability/otelIngestion";
import { OBS_INGEST_FAILED, OBS_INGEST_REJECTED } from "../src/observability/otelMessages";
import type { BlobStore } from "../src/services/blobStorePorts";

/** An in-memory BlobStore double that records every put. */
function memoryBlobStore() {
  const puts: Array<{ key: string; body: Uint8Array; contentType?: string }> = [];
  const store: BlobStore = {
    put: async (key: string, body: Uint8Array, opts?: { contentType?: string }) => {
      puts.push({ key, body, contentType: opts?.contentType });
    },
    get: async () => null,
    delete: async () => undefined,
    list: async () => [],
  } as unknown as BlobStore;
  return { store, puts };
}

/** A minimal OTLP ExportMetricsServiceRequest carrying one counter metric. */
function metricsPayload() {
  return JSON.stringify({
    resourceMetrics: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "cfagent" } }] },
        scopeMetrics: [
          {
            scope: { name: "cfagent" },
            metrics: [
              {
                name: "job.runs",
                description: "Terminally settled runs",
                unit: "1",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: [
                        { key: "job_id", value: { stringValue: "feed" } },
                        { key: "state", value: { stringValue: "completed" } },
                      ],
                      startTimeUnixNano: "1700000000000000000",
                      timeUnixNano: "1700000001000000000",
                      asInt: "3",
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });
}

describe("handleOtelMetricsIngestion — OTLP metrics in, R2 archive out", () => {
  it("stores one JSONL object per batch under otel-archive/<date>/", async () => {
    const { store, puts } = memoryBlobStore();
    const result = await handleOtelMetricsIngestion({
      body: metricsPayload(),
      blobStore: store,
      now: () => new Date("2026-11-17T12:00:00Z"),
      newId: () => "test-id-1",
    });
    expect(result.status).toBe(202);
    expect(result.received).toBe(1);
    expect(result.stored).toBe(true);
    expect(result.key).toBe(`${OTEL_ARCHIVE_PREFIX}2026-11-17/test-id-1.jsonl`);
    expect(puts).toHaveLength(1);
    const text = new TextDecoder().decode(puts[0].body);
    expect(text).toContain("job.runs");
    expect(puts[0].contentType).toBe("application/json");
  });

  it("falls back to the structured log when R2 is unbound (nothing dropped silently)", async () => {
    const lines: string[] = [];
    const result = await handleOtelMetricsIngestion({
      body: metricsPayload(),
      blobStore: null,
      log: {
        info: (message: string) => {
          lines.push(message);
        },
        error: () => undefined,
      },
    });
    expect(result.status).toBe(202);
    expect(result.received).toBe(1);
    expect(result.stored).toBe(false);
    expect(result.fallback).toBe("console");
    expect(lines.length).toBeGreaterThanOrEqual(1);
    expect(lines[0]).toContain("job.runs");
  });

  it("rejects malformed JSON with 400 + OBS-1004", async () => {
    const { store } = memoryBlobStore();
    const result = await handleOtelMetricsIngestion({ body: "{not json", blobStore: store });
    expect(result.status).toBe(400);
    expect(result.code).toBe(OBS_INGEST_REJECTED);
    expect(result.error).toContain(OBS_INGEST_REJECTED);
  });

  it("rejects a payload with no resourceMetrics array with 400 + OBS-1004", async () => {
    const { store } = memoryBlobStore();
    const result = await handleOtelMetricsIngestion({
      body: JSON.stringify({ resourceLogs: [] }),
      blobStore: store,
    });
    expect(result.status).toBe(400);
    expect(result.code).toBe(OBS_INGEST_REJECTED);
  });

  it("returns 500 + OBS-1003 when the R2 write fails", async () => {
    const failingStore = {
      put: async () => {
        throw new Error("R2 down");
      },
      get: async () => null,
      delete: async () => undefined,
      list: async () => [],
    } as unknown as BlobStore;
    const errors: string[] = [];
    const result = await handleOtelMetricsIngestion({
      body: metricsPayload(),
      blobStore: failingStore,
      log: {
        info: () => undefined,
        error: (message: string) => {
          errors.push(message);
        },
      },
    });
    expect(result.status).toBe(500);
    expect(result.code).toBe(OBS_INGEST_FAILED);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it("accepts an empty resourceMetrics array (0 received, still 202)", async () => {
    const { store, puts } = memoryBlobStore();
    const result = await handleOtelMetricsIngestion({
      body: JSON.stringify({ resourceMetrics: [] }),
      blobStore: store,
    });
    expect(result.status).toBe(202);
    expect(result.received).toBe(0);
    expect(puts).toHaveLength(1);
  });
});
