/**
 * Issue #5081 (S1, observability program #5080) — the OTLP
 * ingestion route: OTLP/JSON in, R2 archive out.
 *
 * TDD Red first: the modules (src/observability/otelIngestion.ts,
 * src/server/routes/otel.ts) do not exist yet, so this file fails
 * at import.
 *
 * Flow: OTel SDK -> OTLP/HTTP (JSON) -> POST /api/otel/v1/logs
 * (this route, a real HTTP endpoint for external OTLP senders)
 * -> one JSONL object in R2 (REPORTS_BUCKET, otel-archive/
 * prefix). The Worker-side SDK uses the same handler in-process
 * (the transport calls the handler directly — a real HTTP POST
 * to the Worker's own domain returns Cloudflare 522).
 *
 * Safety: the HTTP route is DISABLED (404) unless the
 * OTEL_INGEST_TOKEN secret is set, and requires
 * `Authorization: Bearer <token>` when it is. An unauthenticated
 * ingestion endpoint could be used to fill R2. The in-process
 * transport bypasses HTTP auth (it calls the handler directly).
 * R2 unbound -> the records fall back to console (Workers Logs)
 * and the response says so; nothing is dropped silently.
 */
import { describe, it, expect } from "vitest";
import {
  createOtelIngestionLog,
  handleOtelLogsIngestion,
  type OtelIngestionResult,
} from "../src/observability/otelIngestion";
import { handleOtelRoutes } from "../src/server/routes/otel";
import type { BlobStore, BlobObject, BlobListPage } from "../src/services/blobStorePorts";
import { OBS_INGEST_FAILED, OBS_INGEST_REJECTED } from "../src/observability/otelMessages";
import { createStructuredLogger } from "../src/observability/structuredLogger";

/** An in-memory BlobStore double behind the same port. */
class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, { bytes: Uint8Array; contentType?: string }>();
  async put(key: string, value: Uint8Array | string, options?: { contentType?: string }): Promise<void> {
    const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
    this.objects.set(key, { bytes, contentType: options?.contentType });
  }
  async get(key: string): Promise<BlobObject | null> {
    const obj = this.objects.get(key);
    if (!obj) return null;
    return { bytes: obj.bytes, contentType: obj.contentType };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(options?: { prefix?: string }): Promise<BlobListPage> {
    const keys = [...this.objects.keys()].filter((k) =>
      options?.prefix ? k.startsWith(options.prefix) : true,
    );
    return { keys, truncated: false };
  }
}

/** A minimal OTLP/JSON ExportLogsServiceRequest body. */
function otlpLogsBody(records: Array<Record<string, unknown>> = []): string {
  return JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "cfagent" } }] },
        scopeLogs: [
          {
            scope: { name: "job-pipeline" },
            logRecords: records.length
              ? records
              : [
                  {
                    timeUnixNano: "1791158400000000000",
                    severityNumber: 9,
                    severityText: "INFO",
                    body: { stringValue: "job.run.settled" },
                    attributes: [
                      { key: "jobId", value: { stringValue: "yahoo-nasdaq100" } },
                      { key: "runId", value: { stringValue: "run-1" } },
                    ],
                  },
                ],
          },
        ],
      },
    ],
  });
}

describe("handleOtelLogsIngestion — OTLP/JSON to R2", () => {
  it("writes one JSONL object per batch under otel-archive/ and returns 202", async () => {
    const store = new MemoryBlobStore();
    const result: OtelIngestionResult = await handleOtelLogsIngestion({
      body: otlpLogsBody(),
      blobStore: store,
      now: () => new Date("2026-11-17T12:00:00.000Z"),
      newId: () => "batch-1",
    });
    expect(result.status).toBe(202);
    expect(result.received).toBe(1);
    expect(result.stored).toBe(true);
    expect(result.key).toBe("otel-archive/2026-11-17/batch-1.jsonl");
    const obj = await store.get("otel-archive/2026-11-17/batch-1.jsonl");
    expect(obj).not.toBeNull();
    expect(obj?.contentType).toBe("application/json");
    const lines = new TextDecoder().decode(obj!.bytes).trim().split("\n");
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]);
    expect(record.body.stringValue).toBe("job.run.settled");
  });

  it("counts log records across scopes and resources", async () => {
    const store = new MemoryBlobStore();
    const body = JSON.stringify({
      resourceLogs: [
        { scopeLogs: [{ logRecords: [{ body: { stringValue: "a" } }, { body: { stringValue: "b" } }] }] },
        { scopeLogs: [{ logRecords: [{ body: { stringValue: "c" } }] }] },
      ],
    });
    const result = await handleOtelLogsIngestion({ body, blobStore: store });
    expect(result.status).toBe(202);
    expect(result.received).toBe(3);
    const keys = [...store.objects.keys()];
    expect(keys).toHaveLength(1);
    const lines = new TextDecoder().decode(store.objects.get(keys[0])!.bytes).trim().split("\n");
    expect(lines).toHaveLength(3);
  });

  it("falls back to the structured log (Workers Logs) when R2 is unbound, and says so", async () => {
    const logged: string[] = [];
    const result = await handleOtelLogsIngestion({
      body: otlpLogsBody(),
      blobStore: null,
      log: { info: (message) => logged.push(message), error: () => undefined },
    });
    expect(result.status).toBe(202);
    expect(result.received).toBe(1);
    expect(result.stored).toBe(false);
    expect(result.fallback).toBe("console");
    expect(logged.length).toBe(1);
    expect(logged[0]).toContain("job.run.settled");
  });

  it("rejects malformed JSON with 400 and the coded OBS-1004 message", async () => {
    const store = new MemoryBlobStore();
    const result = await handleOtelLogsIngestion({ body: "{not json", blobStore: store });
    expect(result.status).toBe(400);
    expect(result.received).toBe(0);
    expect(result.code).toBe(OBS_INGEST_REJECTED);
    expect(store.objects.size).toBe(0);
  });

  it("rejects a payload with no resourceLogs with 400 and OBS-1004", async () => {
    const store = new MemoryBlobStore();
    const result = await handleOtelLogsIngestion({
      body: JSON.stringify({ foo: "bar" }),
      blobStore: store,
    });
    expect(result.status).toBe(400);
    expect(result.code).toBe(OBS_INGEST_REJECTED);
  });

  it("returns 500 with the coded OBS-1003 message when the R2 write fails", async () => {
    const failing: BlobStore = {
      ...new MemoryBlobStore(),
      put: async () => {
        throw new Error("r2 down");
      },
    };
    const result = await handleOtelLogsIngestion({ body: otlpLogsBody(), blobStore: failing });
    expect(result.status).toBe(500);
    expect(result.code).toBe(OBS_INGEST_FAILED);
    expect(result.stored).toBe(false);
  });

  it("createOtelIngestionLog routes info/error through the structured logger (no raw console)", () => {
    // The structured logger writes to a recording sink so the
    // operation names are pinned without touching console.
    const events: Array<{ type: string; level: string }> = [];
    const sink = {
      write: (event: { type: string; level: string }) => {
        events.push({ type: event.type, level: event.level });
      },
    };
    const logger = createStructuredLogger(sink as never, { component: "otel-ingestion" });
    const log = createOtelIngestionLog(logger);
    log.info("a fallback record");
    log.error("an ingestion failure");
    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({ type: "otel.ingest.fallback", level: "info" });
    expect(events[1]).toEqual({ type: "otel.ingest.failed", level: "error" });
  });

  it("defaults to a no-op log when none is injected (never throws, never calls console)", async () => {
    const result = await handleOtelLogsIngestion({ body: otlpLogsBody(), blobStore: null });
    expect(result.status).toBe(202);
    expect(result.fallback).toBe("console");
  });
});

describe("handleOtelRoutes — POST /api/otel/v1/logs", () => {
  const url = new URL("https://agent.openaimp.com/api/otel/v1/logs");

  it("returns null (falls through) for any other path", async () => {
    const res = await handleOtelRoutes(
      new Request("https://agent.openaimp.com/api/telemetry/summary"),
      {} as never,
      new URL("https://agent.openaimp.com/api/telemetry/summary"),
      "/api/telemetry/summary",
    );
    expect(res).toBeNull();
  });

  it("returns 404 (disabled) when OTEL_INGEST_TOKEN is not set", async () => {
    const res = await handleOtelRoutes(
      new Request(url, { method: "POST", body: otlpLogsBody() }),
      { REPORTS_BUCKET: undefined } as never,
      url,
      "/api/otel/v1/logs",
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(404);
  });

  it("returns 401 when the Bearer token is missing or wrong", async () => {
    const env = { OTEL_INGEST_TOKEN: "secret-token", REPORTS_BUCKET: undefined } as never;
    const noAuth = await handleOtelRoutes(
      new Request(url, { method: "POST", body: otlpLogsBody() }),
      env,
      url,
      "/api/otel/v1/logs",
    );
    expect(noAuth!.status).toBe(401);
    const wrong = await handleOtelRoutes(
      new Request(url, {
        method: "POST",
        headers: { Authorization: "Bearer wrong" },
        body: otlpLogsBody(),
      }),
      env,
      url,
      "/api/otel/v1/logs",
    );
    expect(wrong!.status).toBe(401);
  });

  it("accepts a valid Bearer token and ingests (202), falling back to console without R2", async () => {
    const env = { OTEL_INGEST_TOKEN: "secret-token", REPORTS_BUCKET: undefined } as never;
    const res = await handleOtelRoutes(
      new Request(url, {
        method: "POST",
        headers: { Authorization: "Bearer secret-token", "Content-Type": "application/json" },
        body: otlpLogsBody(),
      }),
      env,
      url,
      "/api/otel/v1/logs",
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(202);
    const payload = (await res!.json()) as { received: number; stored: boolean; fallback?: string };
    expect(payload.received).toBe(1);
    expect(payload.stored).toBe(false);
    expect(payload.fallback).toBe("console");
  });

  it("returns 405 for a non-POST to the ingestion route", async () => {
    const env = { OTEL_INGEST_TOKEN: "secret-token" } as never;
    const res = await handleOtelRoutes(new Request(url, { method: "GET" }), env, url, "/api/otel/v1/logs");
    expect(res).not.toBeNull();
    expect(res!.status).toBe(405);
  });
});
