/**
 * Client for the SLO read endpoint (issue #5425, #3515 S5):
 * GET /api/otel/v1/slo (`?tenantId=`, default "primary").
 * Platform-admin only server-side (401 unauthenticated, 403
 * otherwise, audited).
 *
 * Nothing here decides authorization or thresholds: the panel
 * renders whatever the server reports. All calls go through
 * apiFetch (the #71 rule). The response parser is strict — a
 * malformed body throws instead of rendering invented numbers.
 */

import { apiFetch } from "./apiFetch";

/** The per-SLO compliance state the read reports. */
export type SloStatus = "within" | "breached" | "unconfigured" | "no-data";

export interface OtelSloResponse {
  tenantId: string;
  evaluatedAtMs: number;
  sample: {
    totalRequests: number;
    failedRequests: number;
    latencySamples: number;
  };
  uptime: {
    status: SloStatus;
    value: number | null;
    target: number | null;
  };
  p95Latency: {
    status: SloStatus;
    valueMs: number | null;
    targetMs: number | null;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SLO_STATUSES: readonly string[] = ["within", "breached", "unconfigured", "no-data"];

function parseSloStatus(value: unknown): SloStatus {
  if (typeof value !== "string" || !SLO_STATUSES.includes(value)) {
    throw new Error("SLO response was malformed.");
  }
  return value as SloStatus;
}

function parseNullableNumber(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number") throw new Error("SLO response was malformed.");
  return value;
}

export function parseOtelSloResponse(value: unknown): OtelSloResponse {
  if (!isRecord(value)) throw new Error("SLO response was malformed.");
  if (typeof value.tenantId !== "string") throw new Error("SLO response was malformed.");
  if (typeof value.evaluatedAtMs !== "number") throw new Error("SLO response was malformed.");
  if (!isRecord(value.sample)) throw new Error("SLO response was malformed.");
  const sample = value.sample;
  if (
    typeof sample.totalRequests !== "number" ||
    typeof sample.failedRequests !== "number" ||
    typeof sample.latencySamples !== "number"
  ) {
    throw new Error("SLO response was malformed.");
  }
  if (!isRecord(value.uptime)) throw new Error("SLO response was malformed.");
  if (!isRecord(value.p95Latency)) throw new Error("SLO response was malformed.");
  return {
    tenantId: value.tenantId,
    evaluatedAtMs: value.evaluatedAtMs,
    sample: {
      totalRequests: sample.totalRequests,
      failedRequests: sample.failedRequests,
      latencySamples: sample.latencySamples,
    },
    uptime: {
      status: parseSloStatus(value.uptime.status),
      value: parseNullableNumber(value.uptime.value),
      target: parseNullableNumber(value.uptime.target),
    },
    p95Latency: {
      status: parseSloStatus(value.p95Latency.status),
      valueMs: parseNullableNumber(value.p95Latency.valueMs),
      targetMs: parseNullableNumber(value.p95Latency.targetMs),
    },
  };
}

export async function fetchOtelSlo(tenantId?: string): Promise<OtelSloResponse> {
  const params = new URLSearchParams();
  if (tenantId) params.set("tenantId", tenantId);
  const query = params.toString();
  const res = await apiFetch(`/api/otel/v1/slo${query ? `?${query}` : ""}`);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message =
      typeof body?.error === "string" && body.error !== ""
        ? body.error
        : "Failed to load SLO compliance.";
    throw new Error(message);
  }
  return parseOtelSloResponse(await res.json().catch(() => null));
}
