/**
 * Issue #5169 (observability program #5080) — the R2 archive
 * sub-tab: the OTel archive read surface (list + serve).
 *
 * TDD Red first: the module (src/observability/otelArchive.ts)
 * does not exist yet, so this file fails at import.
 *
 * The archive is the R2 prefix `otel-archive/` (REPORTS_BUCKET)
 * that S1 (#5081) and S2 (#5082) already write: one JSONL object
 * per ingestion batch, key `otel-archive/<YYYY-MM-DD>/<id>.jsonl`,
 * each line one OTLP record. Logs AND metrics share the prefix
 * and are distinguished by payload shape, NOT by a second key
 * prefix — and the stored lines are RECORDS (log records /
 * metrics), not the Export*ServiceRequest envelope, so signal
 * detection reads the first line's shape in both forms.
 *
 * Rules pinned here:
 * - signal detection by payload shape (envelope OR record form);
 *   anything else reads "unknown", never invented.
 * - the list never returns an unbounded page: the effective page
 *   size is clamped to the config pageSize, and the config
 *   maxObjects is the absolute ceiling.
 * - the serve path rejects any key outside `otel-archive/`
 *   (fail-closed, coded OBS-1009) and a missing object reads 404
 *   (OBS-1010); an unbound store reads 503 (OBS-1008).
 * - when R2 archiving is OFF the list reports archivingEnabled
 *   false with no objects instead of a misleading empty list.
 */
import { describe, it, expect } from "vitest";
import {
  OTEL_ARCHIVE_LIST_ROUTE,
  OTEL_ARCHIVE_OBJECT_ROUTE,
  archiveDateFromKey,
  detectOtelArchiveSignal,
  isOtelArchiveKey,
  listOtelArchive,
  serveOtelArchiveObject,
} from "../src/observability/otelArchive";
import type { BlobStore, BlobObject, BlobListPage } from "../src/services/blobStorePorts";
import {
  OBS_ARCHIVE_FORBIDDEN,
  OBS_ARCHIVE_KEY_REJECTED,
  OBS_ARCHIVE_NOT_FOUND,
  OBS_ARCHIVE_UNAVAILABLE,
} from "../src/observability/otelMessages";

/** An in-memory BlobStore double with cursor+limit list support. */
class MemoryBlobStore implements BlobStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, value: Uint8Array | string): Promise<void> {
    this.objects.set(
      key,
      typeof value === "string" ? new TextEncoder().encode(value) : value,
    );
  }
  async get(key: string): Promise<BlobObject | null> {
    const bytes = this.objects.get(key);
    if (!bytes) return null;
    return { bytes };
  }
  async delete(key: string): Promise<void> {
    this.objects.delete(key);
  }
  async list(options?: {
    prefix?: string;
    cursor?: string;
    limit?: number;
  }): Promise<BlobListPage> {
    const keys = [...this.objects.keys()]
      .filter((k) => (options?.prefix ? k.startsWith(options.prefix) : true))
      .sort();
    const start = options?.cursor ? Number(options.cursor) : 0;
    const limit = options?.limit ?? keys.length;
    const page = keys.slice(start, start + limit);
    const next = start + page.length;
    return {
      keys: page,
      truncated: next < keys.length,
      ...(next < keys.length ? { cursor: String(next) } : {}),
    };
  }
}

const LOG_RECORD = {
  timeUnixNano: "1791158400000000000",
  observedTimeUnixNano: "1791158400000000000",
  severityNumber: 9,
  severityText: "INFO",
  body: { stringValue: "job.run.settled" },
  attributes: [{ key: "jobId", value: { stringValue: "yahoo-nasdaq100" } }],
};
const METRIC_RECORD = {
  name: "otel.metrics.exported",
  description: "Exported metric batches",
  unit: "1",
  sum: {
    dataPoints: [{ asInt: "3", timeUnixNano: "1791158400000000000" }],
    aggregationTemporality: 2,
    isMonotonic: true,
  },
};
const SPAN_RECORD = {
  traceId: "5b8efff798038103d269b633813fc60c",
  spanId: "eee19b7ec3c1b174",
  name: "job.run",
  kind: 3,
  startTimeUnixNano: "1791158400000000000",
  endTimeUnixNano: "1791158401000000000",
  status: {},
};

function jsonl(...records: Array<Record<string, unknown>>): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

describe("detectOtelArchiveSignal — payload shape, not key prefix", () => {
  it("reads logs from the envelope form (resourceLogs)", () => {
    expect(
      detectOtelArchiveSignal(JSON.stringify({ resourceLogs: [{ scopeLogs: [] }] })),
    ).toBe("logs");
  });
  it("reads metrics from the envelope form (resourceMetrics)", () => {
    expect(
      detectOtelArchiveSignal(JSON.stringify({ resourceMetrics: [{ scopeMetrics: [] }] })),
    ).toBe("metrics");
  });
  it("reads traces from the envelope form (resourceSpans)", () => {
    expect(
      detectOtelArchiveSignal(JSON.stringify({ resourceSpans: [{ scopeSpans: [] }] })),
    ).toBe("traces");
  });
  it("reads logs from the stored record form (body + severityNumber)", () => {
    expect(detectOtelArchiveSignal(jsonl(LOG_RECORD))).toBe("logs");
  });
  it("reads metrics from the stored record form (name + sum)", () => {
    expect(detectOtelArchiveSignal(jsonl(METRIC_RECORD))).toBe("metrics");
  });
  it("reads metrics from the stored record form (name + gauge)", () => {
    expect(
      detectOtelArchiveSignal(jsonl({ name: "cpu", unit: "1", gauge: { dataPoints: [] } })),
    ).toBe("metrics");
  });
  it("reads traces from the stored record form (kind + start/end time)", () => {
    expect(detectOtelArchiveSignal(jsonl(SPAN_RECORD))).toBe("traces");
  });
  it("reads unknown for an empty object, unparseable text, and an empty file", () => {
    expect(detectOtelArchiveSignal("")).toBe("unknown");
    expect(detectOtelArchiveSignal("not json\n")).toBe("unknown");
    expect(detectOtelArchiveSignal(jsonl({}))).toBe("unknown");
  });
  it("does not mistake a correlated log record (traceId/spanId) for a span", () => {
    expect(
      detectOtelArchiveSignal(
        jsonl({
          ...LOG_RECORD,
          traceId: "5b8efff798038103d269b633813fc60c",
          spanId: "eee19b7ec3c1b174",
        }),
      ),
    ).toBe("logs");
  });
});

describe("archiveDateFromKey / isOtelArchiveKey — the key layout", () => {
  it("extracts the YYYY-MM-DD date segment", () => {
    expect(archiveDateFromKey("otel-archive/2026-11-17/abc-123.jsonl")).toBe("2026-11-17");
  });
  it("returns null when the key carries no date segment", () => {
    expect(archiveDateFromKey("otel-archive/abc-123.jsonl")).toBeNull();
    expect(archiveDateFromKey("reports/2026-11-17/abc.json")).toBeNull();
  });
  it("accepts only keys under otel-archive/", () => {
    expect(isOtelArchiveKey("otel-archive/2026-11-17/x.jsonl")).toBe(true);
    expect(isOtelArchiveKey("otel-archive/../reports/x.json")).toBe(false);
    expect(isOtelArchiveKey("reports/x.json")).toBe(false);
    expect(isOtelArchiveKey("otel-archive-evil/x.jsonl")).toBe(false);
    expect(isOtelArchiveKey("")).toBe(false);
  });
});

describe("otel archive routes — path constants", () => {
  it("list and serve live under /api/otel/v1/archive", () => {
    expect(OTEL_ARCHIVE_LIST_ROUTE).toBe("/api/otel/v1/archive");
    expect(OTEL_ARCHIVE_OBJECT_ROUTE).toBe("/api/otel/v1/archive/object");
  });
});

describe("listOtelArchive — bounded, grouped, shaped", () => {
  it("lists objects grouped by date with signal, size, and line count", async () => {
    const store = new MemoryBlobStore();
    const logJsonl = jsonl(LOG_RECORD, LOG_RECORD);
    const metricJsonl = jsonl(METRIC_RECORD);
    await store.put("otel-archive/2026-11-17/log-1.jsonl", logJsonl);
    await store.put("otel-archive/2026-11-16/metric-1.jsonl", metricJsonl);
    await store.put("reports/other.json", "{}");
    const result = await listOtelArchive({
      blobStore: store,
      archivingEnabled: true,
      pageSize: 50,
      maxObjects: 500,
    });
    expect(result.status).toBe(200);
    expect(result.archivingEnabled).toBe(true);
    expect(result.objects).toHaveLength(2);
    const byKey = new Map(result.objects.map((o) => [o.key, o]));
    const logRow = byKey.get("otel-archive/2026-11-17/log-1.jsonl")!;
    expect(logRow.date).toBe("2026-11-17");
    expect(logRow.signal).toBe("logs");
    expect(logRow.sizeBytes).toBe(new TextEncoder().encode(logJsonl).length);
    expect(logRow.lines).toBe(2);
    const metricRow = byKey.get("otel-archive/2026-11-16/metric-1.jsonl")!;
    expect(metricRow.date).toBe("2026-11-16");
    expect(metricRow.signal).toBe("metrics");
    expect(metricRow.lines).toBe(1);
    expect(result.truncated).toBe(false);
  });

  it("clamps a requested limit to the config pageSize", async () => {
    const store = new MemoryBlobStore();
    for (let i = 0; i < 5; i++) {
      await store.put(`otel-archive/2026-11-17/f-${i}.jsonl`, jsonl(LOG_RECORD));
    }
    const result = await listOtelArchive({
      blobStore: store,
      archivingEnabled: true,
      pageSize: 2,
      maxObjects: 500,
      limit: 50,
    });
    expect(result.objects).toHaveLength(2);
    expect(result.truncated).toBe(true);
    expect(result.cursor).toBeTruthy();
  });

  it("never lists more than the config maxObjects in one page", async () => {
    const store = new MemoryBlobStore();
    for (let i = 0; i < 5; i++) {
      await store.put(`otel-archive/2026-11-17/f-${i}.jsonl`, jsonl(LOG_RECORD));
    }
    const result = await listOtelArchive({
      blobStore: store,
      archivingEnabled: true,
      pageSize: 50,
      maxObjects: 3,
    });
    expect(result.objects).toHaveLength(3);
    expect(result.truncated).toBe(true);
  });

  it("follows a cursor to the next page", async () => {
    const store = new MemoryBlobStore();
    for (let i = 0; i < 4; i++) {
      await store.put(`otel-archive/2026-11-17/f-${i}.jsonl`, jsonl(LOG_RECORD));
    }
    const first = await listOtelArchive({
      blobStore: store,
      archivingEnabled: true,
      pageSize: 2,
      maxObjects: 500,
    });
    expect(first.objects).toHaveLength(2);
    const second = await listOtelArchive({
      blobStore: store,
      archivingEnabled: true,
      pageSize: 2,
      maxObjects: 500,
      cursor: first.cursor,
    });
    expect(second.objects).toHaveLength(2);
    expect(second.truncated).toBe(false);
    const allKeys = [...first.objects, ...second.objects].map((o) => o.key);
    expect(new Set(allKeys).size).toBe(4);
  });

  it("reports an empty archive honestly (enabled, zero objects)", async () => {
    const store = new MemoryBlobStore();
    const result = await listOtelArchive({
      blobStore: store,
      archivingEnabled: true,
      pageSize: 50,
      maxObjects: 500,
    });
    expect(result.status).toBe(200);
    expect(result.archivingEnabled).toBe(true);
    expect(result.objects).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("reports archivingEnabled false with no objects when the R2 switch is OFF", async () => {
    const store = new MemoryBlobStore();
    await store.put("otel-archive/2026-11-17/log-1.jsonl", jsonl(LOG_RECORD));
    const result = await listOtelArchive({
      blobStore: store,
      archivingEnabled: false,
      pageSize: 50,
      maxObjects: 500,
    });
    expect(result.status).toBe(200);
    expect(result.archivingEnabled).toBe(false);
    expect(result.objects).toEqual([]);
  });

  it("returns 503 OBS-1008 when R2 is unbound", async () => {
    const result = await listOtelArchive({
      blobStore: null,
      archivingEnabled: true,
      pageSize: 50,
      maxObjects: 500,
    });
    expect(result.status).toBe(503);
    expect(result.code).toBe(OBS_ARCHIVE_UNAVAILABLE);
    expect(result.error).toContain("OBS-1008");
  });
});

describe("serveOtelArchiveObject — prefix-validated read", () => {
  it("returns the JSONL content for a valid key", async () => {
    const store = new MemoryBlobStore();
    const content = jsonl(LOG_RECORD);
    await store.put("otel-archive/2026-11-17/log-1.jsonl", content);
    const result = await serveOtelArchiveObject({
      blobStore: store,
      key: "otel-archive/2026-11-17/log-1.jsonl",
    });
    expect(result.status).toBe(200);
    expect(new TextDecoder().decode(result.content)).toBe(content);
  });

  it("rejects a key outside otel-archive/ with 400 OBS-1009", async () => {
    const store = new MemoryBlobStore();
    await store.put("reports/secret.json", "{}");
    for (const key of ["reports/secret.json", "otel-archive/../reports/secret.json", ""]) {
      const result = await serveOtelArchiveObject({ blobStore: store, key });
      expect(result.status).toBe(400);
      expect(result.code).toBe(OBS_ARCHIVE_KEY_REJECTED);
      expect(result.error).toContain("OBS-1009");
    }
  });

  it("returns 404 OBS-1010 for a missing object under the prefix", async () => {
    const store = new MemoryBlobStore();
    const result = await serveOtelArchiveObject({
      blobStore: store,
      key: "otel-archive/2026-11-17/nope.jsonl",
    });
    expect(result.status).toBe(404);
    expect(result.code).toBe(OBS_ARCHIVE_NOT_FOUND);
    expect(result.error).toContain("OBS-1010");
  });

  it("returns 503 OBS-1008 when R2 is unbound", async () => {
    const result = await serveOtelArchiveObject({
      blobStore: null,
      key: "otel-archive/2026-11-17/log-1.jsonl",
    });
    expect(result.status).toBe(503);
    expect(result.code).toBe(OBS_ARCHIVE_UNAVAILABLE);
  });

  it("exposes the forbidden code for the route's admin gate", () => {
    expect(OBS_ARCHIVE_FORBIDDEN).toBe("OBS-1011");
  });
});
