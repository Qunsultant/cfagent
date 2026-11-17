/**
 * Issue #5169 (observability program #5080) — the R2 archive
 * read surface: list + serve the archived OTLP JSONL.
 *
 * The interim file browser the owner asked for (2026-11-17):
 * S1 logs (#5081) and S2 metrics (#5082) land in Analytics
 * Engine and are archived to R2, but until the S8 dashboard
 * (#5087) and the OTel backend (#5164) land there is no place
 * to SEE them in the app. This module is the read side only —
 * it reads what S1/S2 already write and changes nothing about
 * the logging/metrics instrumentation, the ingestion routes, or
 * the archive format.
 *
 * Layout (from src/observability/otelIngestion.ts): one JSONL
 * object per ingestion batch, key
 * `otel-archive/<YYYY-MM-DD>/<id>.jsonl`; each line is one OTLP
 * record. Logs AND metrics share the prefix and are
 * distinguished by payload shape, NOT by a second key prefix —
 * and the stored lines are RECORDS (log records / metrics),
 * not the Export*ServiceRequest envelope, so signal detection
 * reads the first line's shape in both forms.
 *
 * Bounds: the list never returns an unbounded page. The
 * effective page size is clamped to the config pageSize and
 * the config maxObjects is the absolute ceiling (both resolved
 * in src/config/otelModes.ts from config/otel.json + env).
 * Signal detection reads each listed object's content (one
 * bounded `get` per row) — the key carries no signal, so the
 * shape can only come from the payload.
 *
 * This module is pure (the BlobStore is a dependency), so it is
 * testable with an in-memory double behind the same port. Auth
 * + the platform-admin gate + audit live in the HTTP route
 * (src/server/routes/otelArchive.ts), not here.
 */

import type { BlobStore } from "../services/blobStorePorts";
import { OTEL_ARCHIVE_PREFIX } from "./otelIngestion";
import {
  OBS_ARCHIVE_KEY_REJECTED,
  OBS_ARCHIVE_NOT_FOUND,
  OBS_ARCHIVE_UNAVAILABLE,
  formatOtelMessage,
} from "./otelMessages";

/** The OTel archive list route path. */
export const OTEL_ARCHIVE_LIST_ROUTE = "/api/otel/v1/archive" as const;

/** The OTel archive object route path (serve one object, `?key=`). */
export const OTEL_ARCHIVE_OBJECT_ROUTE = "/api/otel/v1/archive/object" as const;

/** The OTel signal of one archived object, by payload shape. */
export type OtelArchiveSignal = "logs" | "metrics" | "traces" | "unknown";

/**
 * Detects the signal of one archived object from its JSONL
 * content — the first non-empty line's shape. Envelope form
 * (resourceLogs / resourceMetrics / resourceSpans) and the
 * stored record form (log record / metric / span) are both
 * recognised; anything else reads "unknown", never invented.
 * A log record that carries traceId/spanId correlation is
 * still logs: only a span's kind + start/end times read traces.
 */
export function detectOtelArchiveSignal(text: string): OtelArchiveSignal {
  const first = text.split("\n").find((line) => line.trim() !== "");
  if (!first) return "unknown";
  let parsed: unknown;
  try {
    parsed = JSON.parse(first) as unknown;
  } catch {
    return "unknown";
  }
  if (!parsed || typeof parsed !== "object") return "unknown";
  const record = parsed as Record<string, unknown>;
  if (Array.isArray(record.resourceLogs)) return "logs";
  if (Array.isArray(record.resourceMetrics)) return "metrics";
  if (Array.isArray(record.resourceSpans)) return "traces";
  if (
    typeof record.name === "string" &&
    ("gauge" in record || "sum" in record || "histogram" in record || "summary" in record)
  ) {
    return "metrics";
  }
  if (
    typeof record.kind === "number" &&
    "startTimeUnixNano" in record &&
    "endTimeUnixNano" in record
  ) {
    return "traces";
  }
  if ("body" in record || "severityNumber" in record || "observedTimeUnixNano" in record) {
    return "logs";
  }
  return "unknown";
}

/**
 * Extracts the YYYY-MM-DD date segment from an archive key
 * (`otel-archive/<YYYY-MM-DD>/<id>.jsonl`); null when the key
 * carries no valid date segment.
 */
export function archiveDateFromKey(key: string): string | null {
  if (!key.startsWith(OTEL_ARCHIVE_PREFIX)) return null;
  const rest = key.slice(OTEL_ARCHIVE_PREFIX.length);
  const segment = rest.split("/")[0] ?? "";
  return /^\d{4}-\d{2}-\d{2}$/.test(segment) ? segment : null;
}

/**
 * True only when the key is under the `otel-archive/` prefix.
 * A key that merely starts with the prefix text (e.g.
 * `otel-archive-evil/…`) or escapes it (`otel-archive/../…`)
 * is rejected — the serve path reads no arbitrary key.
 */
export function isOtelArchiveKey(key: string): boolean {
  if (!key.startsWith(OTEL_ARCHIVE_PREFIX)) return false;
  const rest = key.slice(OTEL_ARCHIVE_PREFIX.length);
  if (rest === "" || rest.includes("..")) return false;
  return true;
}

/** One archived object, as the list route reports it. */
export interface OtelArchiveObjectInfo {
  key: string;
  /** The YYYY-MM-DD date segment of the key ("" when absent). */
  date: string;
  signal: OtelArchiveSignal;
  sizeBytes: number;
  /** Non-empty lines in the object (one OTLP record per line). */
  lines: number;
}

export interface OtelArchiveListInput {
  blobStore: BlobStore | null;
  /** False when the R2 destination switch is OFF. */
  archivingEnabled: boolean;
  /** Config page size (the default page, and the per-page ceiling). */
  pageSize: number;
  /** Config absolute ceiling: never list more than this per page. */
  maxObjects: number;
  /** Opaque R2 cursor for the next page. */
  cursor?: string;
  /** Caller-requested page size; clamped to [1, pageSize] then maxObjects. */
  limit?: number;
}

export interface OtelArchiveListResult {
  status: number;
  archivingEnabled: boolean;
  objects: OtelArchiveObjectInfo[];
  truncated: boolean;
  cursor?: string;
  pageSize: number;
  maxObjects: number;
  error?: string;
  code?: string;
}

export async function listOtelArchive(input: OtelArchiveListInput): Promise<OtelArchiveListResult> {
  const { blobStore, archivingEnabled, pageSize, maxObjects } = input;
  if (!archivingEnabled) {
    // Archiving is OFF: report the state, not a misleading
    // empty list — the view states it plainly instead.
    return {
      status: 200,
      archivingEnabled: false,
      objects: [],
      truncated: false,
      pageSize,
      maxObjects,
    };
  }
  if (!blobStore) {
    const error = formatOtelMessage(
      OBS_ARCHIVE_UNAVAILABLE,
      "OTel archive unavailable: REPORTS_BUCKET is not bound",
    );
    return {
      status: 503,
      archivingEnabled: true,
      objects: [],
      truncated: false,
      pageSize,
      maxObjects,
      error,
      code: OBS_ARCHIVE_UNAVAILABLE,
    };
  }
  const requested = input.limit ?? pageSize;
  const effectiveLimit = Math.min(
    Math.max(1, Math.floor(requested) || pageSize),
    pageSize,
    maxObjects,
  );
  const page = await blobStore.list({
    prefix: OTEL_ARCHIVE_PREFIX,
    cursor: input.cursor,
    limit: effectiveLimit,
  });
  const objects: OtelArchiveObjectInfo[] = [];
  for (const key of page.keys) {
    // The key carries no signal, so the shape comes from the
    // payload: one bounded get per row, for size + signal.
    const obj = await blobStore.get(key);
    if (!obj) continue;
    const text = new TextDecoder().decode(obj.bytes);
    const lines = text.split("\n").filter((line) => line.trim() !== "").length;
    objects.push({
      key,
      date: archiveDateFromKey(key) ?? "",
      signal: detectOtelArchiveSignal(text),
      sizeBytes: obj.bytes.length,
      lines,
    });
  }
  return {
    status: 200,
    archivingEnabled: true,
    objects,
    truncated: page.truncated,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    pageSize,
    maxObjects,
  };
}

export interface OtelArchiveServeInput {
  blobStore: BlobStore | null;
  key: string;
}

export interface OtelArchiveServeResult {
  status: number;
  content?: Uint8Array;
  contentType?: string;
  error?: string;
  code?: string;
}

export async function serveOtelArchiveObject(
  input: OtelArchiveServeInput,
): Promise<OtelArchiveServeResult> {
  const { blobStore, key } = input;
  if (!isOtelArchiveKey(key)) {
    const error = formatOtelMessage(
      OBS_ARCHIVE_KEY_REJECTED,
      "OTel archive key rejected: the key must be under otel-archive/",
    );
    return { status: 400, error, code: OBS_ARCHIVE_KEY_REJECTED };
  }
  if (!blobStore) {
    const error = formatOtelMessage(
      OBS_ARCHIVE_UNAVAILABLE,
      "OTel archive unavailable: REPORTS_BUCKET is not bound",
    );
    return { status: 503, error, code: OBS_ARCHIVE_UNAVAILABLE };
  }
  const obj = await blobStore.get(key);
  if (!obj) {
    const error = formatOtelMessage(
      OBS_ARCHIVE_NOT_FOUND,
      `OTel archive object not found: ${key}`,
    );
    return { status: 404, error, code: OBS_ARCHIVE_NOT_FOUND };
  }
  return { status: 200, content: obj.bytes, contentType: "application/x-ndjson" };
}
