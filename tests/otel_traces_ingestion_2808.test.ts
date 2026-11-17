/**
 * Issue #2808 (S3, observability program #5080) — the OTLP
 * traces ingestion handler: OTLP/JSON traces in, R2 archive
 * out. The same contract as the logs (S1) and metrics (S2)
 * handlers (one JSONL object per batch under
 * otel-archive/<YYYY-MM-DD>/, R2 fallback to the structured
 * log, 400 on a malformed payload, 500 on an R2 write
 * failure), over the traces payload shape (resourceSpans,
 * not resourceLogs / resourceMetrics). The traces archive
 * lives under the same otel-archive/ prefix as the logs and
 * metrics archives; the signals are distinguished by the
 * payload shape, not by a second prefix.
 *
 * TDD Red first: handleOtelTracesIngestion in
 * src/observability/otelIngestion.ts does not exist yet, so
 * this file fails at import.
 */
import { describe, it, expect, vi } from "vitest";
import { handleOtelTracesIngestion } from "../src/observability/otelIngestion";
import type { BlobStore } from "../src/services/blobStorePorts";

/** An in-memory BlobStore double that records every put. */
function memoryBlobStore() {
  const objects = new Map<string, { body: Uint8Array; contentType?: string }>();
  const store: BlobStore = {
    put: async (key, body, opts) => {
      objects.set(key, { body, contentType: opts?.contentType });
    },
    get: async (key) => objects.get(key)?.body ?? null,
    list: async () => [...objects.keys()],
    delete: async (key) => {
      objects.delete(key);
    },
  };
  return { store, objects };
}

/** A minimal valid ExportTraceServiceRequest with one span. */
function tracesPayload() {
  return JSON.stringify({
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "cfagent" } }] },
        scopeSpans: [
          {
            scope: { name: "cfagent" },
            spans: [
              {
                traceId: "d0cdb8dfb8975b76faa869258aa19991",
                spanId: "6c423a69d362c7af",
                name: "job.stage.step",
                kind: 1,
                startTimeUnixNano: "1794956615912000000",
                endTimeUnixNano: "1794956615912423605",
                attributes: [
                  { key: "step", value: { stringValue: "feed" } },
                  { key: "component", value: { stringValue: "job-pipeline" } },
                ],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  });
}

describe("handleOtelTracesIngestion", () => {
  it("archives one JSONL object per batch under otel-archive/<date>/", async () => {
    const { store, objects } = memoryBlobStore();
    const log = { info: vi.fn(), error: vi.fn() };
    const result = await handleOtelTracesIngestion({
      body: new TextEncoder().encode(tracesPayload()),
      blobStore: store,
      now: () => new Date("2026-11-17T12:00:00Z"),
      newId: () => "trace-batch-1",
      log,
    });
    expect(result.status).toBe(202);
    expect(result.received).toBe(1);
    expect(result.stored).toBe(true);
    expect(result.key).toBe("otel-archive/2026-11-17/trace-batch-1.jsonl");
    const stored = objects.get("otel-archive/2026-11-17/trace-batch-1.jsonl");
    expect(stored).toBeDefined();
    const lines = new TextDecoder().decode(stored!.body).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.name).toBe("job.stage.step");
    expect(record.traceId).toBe("d0cdb8dfb8975b76faa869258aa19991");
  });

  it("accepts a string body", async () => {
    const { store, objects } = memoryBlobStore();
    const result = await handleOtelTracesIngestion({
      body: tracesPayload(),
      blobStore: store,
      now: () => new Date("2026-11-17T12:00:00Z"),
      newId: () => "trace-batch-2",
    });
    expect(result.status).toBe(202);
    expect(result.stored).toBe(true);
    expect(objects.has("otel-archive/2026-11-17/trace-batch-2.jsonl")).toBe(true);
  });

  it("rejects malformed JSON with 400 and OBS-1004", async () => {
    const { store } = memoryBlobStore();
    const log = { info: vi.fn(), error: vi.fn() };
    const result = await handleOtelTracesIngestion({
      body: new TextEncoder().encode("{not json"),
      blobStore: store,
      log,
    });
    expect(result.status).toBe(400);
    expect(result.received).toBe(0);
    expect(result.stored).toBe(false);
    expect(result.code).toBe("OBS-1004");
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("rejects a payload with no resourceSpans array with 400 and OBS-1004", async () => {
    const { store } = memoryBlobStore();
    const log = { info: vi.fn(), error: vi.fn() };
    const result = await handleOtelTracesIngestion({
      body: new TextEncoder().encode(JSON.stringify({ resourceLogs: [] })),
      blobStore: store,
      log,
    });
    expect(result.status).toBe(400);
    expect(result.code).toBe("OBS-1004");
  });

  it("falls back to the structured log when R2 is unbound (202, stored false)", async () => {
    const log = { info: vi.fn(), error: vi.fn() };
    const result = await handleOtelTracesIngestion({
      body: new TextEncoder().encode(tracesPayload()),
      blobStore: null,
      log,
    });
    expect(result.status).toBe(202);
    expect(result.received).toBe(1);
    expect(result.stored).toBe(false);
    expect(result.fallback).toBe("console");
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it("returns 500 with OBS-1003 when the R2 write fails", async () => {
    const failing: BlobStore = {
      put: async () => {
        throw new Error("R2 down");
      },
      get: async () => null,
      list: async () => [],
      delete: async () => undefined,
    };
    const log = { info: vi.fn(), error: vi.fn() };
    const result = await handleOtelTracesIngestion({
      body: new TextEncoder().encode(tracesPayload()),
      blobStore: failing,
      log,
    });
    expect(result.status).toBe(500);
    expect(result.stored).toBe(false);
    expect(result.code).toBe("OBS-1003");
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("archives multiple spans from multiple scopes as one JSONL object", async () => {
    const { store, objects } = memoryBlobStore();
    const payload = JSON.stringify({
      resourceSpans: [
        {
          scopeSpans: [
            { spans: [{ name: "job.stage.step", traceId: "a".repeat(32), spanId: "b".repeat(16) }] },
            { spans: [{ name: "job.run.settled", traceId: "c".repeat(32), spanId: "d".repeat(16) }] },
          ],
        },
      ],
    });
    const result = await handleOtelTracesIngestion({
      body: new TextEncoder().encode(payload),
      blobStore: store,
      now: () => new Date("2026-11-17T12:00:00Z"),
      newId: () => "trace-batch-3",
    });
    expect(result.status).toBe(202);
    expect(result.received).toBe(2);
    const stored = objects.get("otel-archive/2026-11-17/trace-batch-3.jsonl");
    const lines = new TextDecoder().decode(stored!.body).trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).name).toBe("job.stage.step");
    expect(JSON.parse(lines[1]).name).toBe("job.run.settled");
  });
});
