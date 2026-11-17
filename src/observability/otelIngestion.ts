/**
 * Issue #5081 (S1, observability program #5080) — the OTLP
 * ingestion handler: OTLP/JSON in, R2 archive out.
 *
 * Flow: OTel SDK -> OTLP/HTTP (JSON) -> POST /api/otel/v1/logs
 * (the route in src/server/routes/otel.ts, a real HTTP endpoint
 * for external OTLP senders) -> one JSONL object in R2
 * (REPORTS_BUCKET, otel-archive/ prefix). The Worker-side SDK
 * uses this same handler in-process (the transport calls the
 * handler directly — a real HTTP POST to the Worker's own domain
 * returns Cloudflare 522 in production).
 *
 * One JSONL object per ingestion batch (not one per log record):
 * a batch is one exporter flush, so one R2 write amortizes the
 * whole batch. The object key is
 * `otel-archive/<YYYY-MM-DD>/<id>.jsonl`; each line is one OTLP
 * log record (the raw record JSON). R2 is the archive: cheap,
 * durable, no per-row quotas. It is retention, not
 * observability — there is no query engine, dashboard, or
 * alerting on it until the S8 dashboard (which reads the OTel
 * backend, not R2 directly).
 *
 * R2 unbound -> the records fall back to the structured logger
 * (Workers Logs in production, via the base sink) and the
 * response says so; nothing is dropped silently. The fallback
 * log is INJECTED (the caller passes a structured-log-backed
 * log) — this module never calls raw console.* (the #3515
 * ratchet pins new files at zero). A malformed payload is
 * rejected (400, OBS-1004); an R2 write failure is a 500
 * (OBS-1003). The handler is pure (the BlobStore is a
 * dependency), so it is testable with an in-memory double
 * behind the same port.
 */

import type { BlobStore } from "../services/blobStorePorts";
import type { StructuredLogger } from "./structuredLogger";
import { OBS_INGEST_FAILED, OBS_INGEST_REJECTED, formatOtelMessage } from "./otelMessages";

/** The R2 key prefix for the OTel archive. */
export const OTEL_ARCHIVE_PREFIX = "otel-archive/" as const;

/**
 * Where the ingestion fallback writes. The two methods keep
 * levels honest: the fallback records are info, the OBS-1003 /
 * OBS-1004 rejections are errors. The caller builds this over
 * the structured logger (the base sink only — never the OTel
 * sink, or a fallback record would re-enter the OTel pipeline).
 */
export interface OtelIngestionLog {
  info(message: string): void;
  error(message: string): void;
}

/** The no-op log (the default when the caller injects none). */
export const NOOP_OTEL_INGESTION_LOG: OtelIngestionLog = {
  info: () => undefined,
  error: () => undefined,
};

/**
 * Builds the ingestion log over a structured logger. The
 * logger must write to the BASE sink only (Analytics Engine /
 * console), never the OTel sink — see OtelIngestionLog.
 */
export function createOtelIngestionLog(logger: StructuredLogger): OtelIngestionLog {
  return {
    info: (message) => logger.info("otel.ingest.fallback", { message }),
    error: (message) => logger.error("otel.ingest.failed", { message }),
  };
}

export interface OtelIngestionInput {
  body: Uint8Array | string;
  blobStore: BlobStore | null;
  now?: () => Date;
  newId?: () => string;
  /** Where the fallback writes (a structured-log-backed log; a recorder in tests). Defaults to a no-op. */
  log?: OtelIngestionLog;
}

export interface OtelIngestionResult {
  status: number;
  received: number;
  stored: boolean;
  key?: string;
  fallback?: "console";
  error?: string;
  code?: string;
}

function defaultId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  }
}

function datePrefix(now: Date): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  const day = String(now.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Extracts every OTLP log record from a parsed ExportLogsServiceRequest. */
function collectLogRecords(payload: unknown): Array<Record<string, unknown>> | null {
  if (!payload || typeof payload !== "object") return null;
  const resourceLogs = (payload as { resourceLogs?: unknown }).resourceLogs;
  if (!Array.isArray(resourceLogs)) return null;
  const records: Array<Record<string, unknown>> = [];
  for (const resource of resourceLogs) {
    if (!resource || typeof resource !== "object") continue;
    const scopeLogs = (resource as { scopeLogs?: unknown }).scopeLogs;
    if (!Array.isArray(scopeLogs)) continue;
    for (const scope of scopeLogs) {
      if (!scope || typeof scope !== "object") continue;
      const logRecords = (scope as { logRecords?: unknown }).logRecords;
      if (!Array.isArray(logRecords)) continue;
      for (const record of logRecords) {
        if (record && typeof record === "object") {
          records.push(record as Record<string, unknown>);
        }
      }
    }
  }
  return records;
}

export async function handleOtelLogsIngestion(input: OtelIngestionInput): Promise<OtelIngestionResult> {
  const { blobStore } = input;
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? defaultId;
  const log = input.log ?? NOOP_OTEL_INGESTION_LOG;

  let text: string;
  if (typeof input.body === "string") {
    text = input.body;
  } else {
    text = new TextDecoder().decode(input.body);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    const error = formatOtelMessage(OBS_INGEST_REJECTED, "OTLP ingestion rejected: malformed JSON");
    log.error(error);
    return { status: 400, received: 0, stored: false, error, code: OBS_INGEST_REJECTED };
  }

  const records = collectLogRecords(payload);
  if (records === null) {
    const error = formatOtelMessage(
      OBS_INGEST_REJECTED,
      "OTLP ingestion rejected: payload has no resourceLogs array",
    );
    log.error(error);
    return { status: 400, received: 0, stored: false, error, code: OBS_INGEST_REJECTED };
  }

  if (!blobStore) {
    for (const record of records) {
      log.info(JSON.stringify(record));
    }
    return { status: 202, received: records.length, stored: false, fallback: "console" };
  }

  const key = `${OTEL_ARCHIVE_PREFIX}${datePrefix(now())}/${newId()}.jsonl`;
  const jsonl = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
  try {
    await blobStore.put(key, new TextEncoder().encode(jsonl), {
      contentType: "application/json",
    });
  } catch (error) {
    const message = formatOtelMessage(
      OBS_INGEST_FAILED,
      `OTLP ingestion failed writing ${key} to R2: ${error instanceof Error ? error.message : String(error)}`,
    );
    log.error(message);
    return {
      status: 500,
      received: records.length,
      stored: false,
      error: message,
      code: OBS_INGEST_FAILED,
    };
  }
  return { status: 202, received: records.length, stored: true, key };
}

/** Extracts every OTLP metric from a parsed ExportMetricsServiceRequest. */
function collectMetricRecords(payload: unknown): Array<Record<string, unknown>> | null {
  if (!payload || typeof payload !== "object") return null;
  const resourceMetrics = (payload as { resourceMetrics?: unknown }).resourceMetrics;
  if (!Array.isArray(resourceMetrics)) return null;
  const records: Array<Record<string, unknown>> = [];
  for (const resource of resourceMetrics) {
    if (!resource || typeof resource !== "object") continue;
    const scopeMetrics = (resource as { scopeMetrics?: unknown }).scopeMetrics;
    if (!Array.isArray(scopeMetrics)) continue;
    for (const scope of scopeMetrics) {
      if (!scope || typeof scope !== "object") continue;
      const metrics = (scope as { metrics?: unknown }).metrics;
      if (!Array.isArray(metrics)) continue;
      for (const metric of metrics) {
        if (metric && typeof metric === "object") {
          records.push(metric as Record<string, unknown>);
        }
      }
    }
  }
  return records;
}

/**
 * Issue #5082 (S2, observability program #5080) — the OTLP
 * metrics ingestion handler: OTLP/JSON metrics in, R2 archive
 * out. The same contract as handleOtelLogsIngestion (one JSONL
 * object per batch under otel-archive/<YYYY-MM-DD>/, R2
 * fallback to the structured log, 400 on a malformed payload,
 * 500 on an R2 write failure), over the metrics payload shape
 * (resourceMetrics, not resourceLogs). The metrics archive
 * lives under the same otel-archive/ prefix as the logs
 * archive; the two signals are distinguished by the payload
 * shape, not by a second prefix.
 */
export async function handleOtelMetricsIngestion(
  input: OtelIngestionInput,
): Promise<OtelIngestionResult> {
  const { blobStore } = input;
  const now = input.now ?? (() => new Date());
  const newId = input.newId ?? defaultId;
  const log = input.log ?? NOOP_OTEL_INGESTION_LOG;

  let text: string;
  if (typeof input.body === "string") {
    text = input.body;
  } else {
    text = new TextDecoder().decode(input.body);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    const error = formatOtelMessage(OBS_INGEST_REJECTED, "OTLP ingestion rejected: malformed JSON");
    log.error(error);
    return { status: 400, received: 0, stored: false, error, code: OBS_INGEST_REJECTED };
  }

  const records = collectMetricRecords(payload);
  if (records === null) {
    const error = formatOtelMessage(
      OBS_INGEST_REJECTED,
      "OTLP ingestion rejected: payload has no resourceMetrics array",
    );
    log.error(error);
    return { status: 400, received: 0, stored: false, error, code: OBS_INGEST_REJECTED };
  }

  if (!blobStore) {
    for (const record of records) {
      log.info(JSON.stringify(record));
    }
    return { status: 202, received: records.length, stored: false, fallback: "console" };
  }

  const key = `${OTEL_ARCHIVE_PREFIX}${datePrefix(now())}/${newId()}.jsonl`;
  const jsonl = records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
  try {
    await blobStore.put(key, new TextEncoder().encode(jsonl), {
      contentType: "application/json",
    });
  } catch (error) {
    const message = formatOtelMessage(
      OBS_INGEST_FAILED,
      `OTLP ingestion failed writing ${key} to R2: ${error instanceof Error ? error.message : String(error)}`,
    );
    log.error(message);
    return {
      status: 500,
      received: records.length,
      stored: false,
      error: message,
      code: OBS_INGEST_FAILED,
    };
  }
  return { status: 202, received: records.length, stored: true, key };
}
