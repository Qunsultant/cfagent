/**
 * Client for the OTel archive read endpoints (issue #5169):
 * GET /api/otel/v1/archive (list) and
 * GET /api/otel/v1/archive/object?key= (serve one object).
 * Platform-admin only server-side (401 unauthenticated, 403
 * otherwise, audited).
 *
 * Nothing here decides authorization: the panel renders whatever
 * the server reports. All calls go through apiFetch (the #71
 * rule). The serve endpoint is never fetched as JSON — the panel
 * links straight to it (view in a new tab, download via the
 * download attribute), so the browser handles the raw JSONL.
 */

import { apiFetch } from "./apiFetch";

export type OtelArchiveListSignal = "logs" | "metrics" | "traces" | "unknown";

export interface OtelArchiveListObject {
  key: string;
  date: string;
  signal: OtelArchiveListSignal;
  sizeBytes: number;
  lines: number;
}

export interface OtelArchiveListResponse {
  archivingEnabled: boolean;
  objects: OtelArchiveListObject[];
  truncated: boolean;
  cursor?: string;
  pageSize: number;
  maxObjects: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SIGNALS: readonly string[] = ["logs", "metrics", "traces", "unknown"];

function parseOtelArchiveList(value: unknown): OtelArchiveListResponse {
  if (!isRecord(value)) throw new Error("Archive response was not an object.");
  if (typeof value.archivingEnabled !== "boolean") {
    throw new Error("Archive response was malformed.");
  }
  if (!Array.isArray(value.objects)) throw new Error("Archive response was malformed.");
  const objects: OtelArchiveListObject[] = [];
  for (const entry of value.objects) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      typeof entry.date !== "string" ||
      typeof entry.signal !== "string" ||
      !SIGNALS.includes(entry.signal) ||
      typeof entry.sizeBytes !== "number" ||
      typeof entry.lines !== "number"
    ) {
      throw new Error("Archive response was malformed.");
    }
    objects.push({
      key: entry.key,
      date: entry.date,
      signal: entry.signal as OtelArchiveListSignal,
      sizeBytes: entry.sizeBytes,
      lines: entry.lines,
    });
  }
  if (typeof value.truncated !== "boolean") {
    throw new Error("Archive response was malformed.");
  }
  if (typeof value.pageSize !== "number" || typeof value.maxObjects !== "number") {
    throw new Error("Archive response was malformed.");
  }
  return {
    archivingEnabled: value.archivingEnabled,
    objects,
    truncated: value.truncated,
    ...(typeof value.cursor === "string" ? { cursor: value.cursor } : {}),
    pageSize: value.pageSize,
    maxObjects: value.maxObjects,
  };
}

export async function fetchOtelArchiveList(cursor?: string): Promise<OtelArchiveListResponse> {
  const params = new URLSearchParams();
  if (cursor) params.set("cursor", cursor);
  const query = params.toString();
  const res = await apiFetch(`/api/otel/v1/archive${query ? `?${query}` : ""}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message =
      typeof body?.error === "string" && body.error !== ""
        ? body.error
        : "Failed to load the OTel archive.";
    throw new Error(message);
  }
  return parseOtelArchiveList(await res.json().catch(() => null));
}

/** The serve URL for one archived object (view in a new tab, or download). */
export function otelArchiveObjectUrl(key: string): string {
  return `/api/otel/v1/archive/object?key=${encodeURIComponent(key)}`;
}
