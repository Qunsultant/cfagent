/**
 * Client for the OTel config endpoints (issue #5086, S7):
 * GET /api/otel/v1/config (catalog + key allow-list +
 * overrides + effective values), POST /api/otel/v1/config
 * (apply one override), DELETE /api/otel/v1/config
 * (clear one override). Platform-admin only server-side
 * (401 unauthenticated, 403 otherwise, audited).
 *
 * Nothing here decides authorization: the panel renders
 * whatever the server reports. All calls go through apiFetch
 * (the #71 rule). Every write carries a reason — the server
 * rejects a reason-less change (400), because every change
 * is audited with its reason.
 */

import { apiFetch } from "./apiFetch";

export type OtelCatalogSeverity = "info" | "warning" | "error" | "critical";

export interface OtelCatalogEntry {
  code: string;
  name: string;
  template: string;
  severity: OtelCatalogSeverity;
}

export type OtelConfigKeyKind =
  | "boolean"
  | "exporter"
  | "level"
  | "sampling"
  | "positiveInt"
  | "nonNegativeInt"
  | "ratio"
  | "severity"
  | "string"
  | "protocol";

export interface OtelConfigKeyDef {
  key: string;
  kind: OtelConfigKeyKind;
  description: string;
  envName?: string;
}

export interface OtelConfigOverride {
  key: string;
  value: unknown;
  version: number;
  updatedBy: string;
  updatedAtMs: number;
  reason: string;
}

export interface OtelEffectiveEntry {
  value: unknown;
  source: string;
}

export interface OtelConfigResponse {
  catalog: OtelCatalogEntry[];
  keys: OtelConfigKeyDef[];
  overrides: OtelConfigOverride[];
  effective: Record<string, OtelEffectiveEntry>;
}

export interface OtelConfigApplyResponse {
  record: OtelConfigOverride;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const SEVERITIES: readonly string[] = ["info", "warning", "error", "critical"];
const KEY_KINDS: readonly string[] = [
  "boolean",
  "exporter",
  "level",
  "sampling",
  "positiveInt",
  "nonNegativeInt",
  "ratio",
  "severity",
  "string",
  "protocol",
];

export function parseOtelConfig(value: unknown): OtelConfigResponse {
  if (!isRecord(value)) throw new Error("OTel config response was not an object.");
  if (!Array.isArray(value.catalog) || !Array.isArray(value.keys) || !Array.isArray(value.overrides)) {
    throw new Error("OTel config response was malformed.");
  }
  const catalog: OtelCatalogEntry[] = [];
  for (const entry of value.catalog) {
    if (
      !isRecord(entry) ||
      typeof entry.code !== "string" ||
      typeof entry.name !== "string" ||
      typeof entry.template !== "string" ||
      typeof entry.severity !== "string" ||
      !SEVERITIES.includes(entry.severity)
    ) {
      throw new Error("OTel config response was malformed.");
    }
    catalog.push({
      code: entry.code,
      name: entry.name,
      template: entry.template,
      severity: entry.severity as OtelCatalogSeverity,
    });
  }
  const keys: OtelConfigKeyDef[] = [];
  for (const entry of value.keys) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      typeof entry.kind !== "string" ||
      !KEY_KINDS.includes(entry.kind) ||
      typeof entry.description !== "string" ||
      (entry.envName !== undefined && typeof entry.envName !== "string")
    ) {
      throw new Error("OTel config response was malformed.");
    }
    keys.push({
      key: entry.key,
      kind: entry.kind as OtelConfigKeyKind,
      description: entry.description,
      ...(typeof entry.envName === "string" ? { envName: entry.envName } : {}),
    });
  }
  const overrides: OtelConfigOverride[] = [];
  for (const entry of value.overrides) {
    if (
      !isRecord(entry) ||
      typeof entry.key !== "string" ||
      !("value" in entry) ||
      typeof entry.version !== "number" ||
      typeof entry.updatedBy !== "string" ||
      typeof entry.updatedAtMs !== "number" ||
      typeof entry.reason !== "string"
    ) {
      throw new Error("OTel config response was malformed.");
    }
    overrides.push({
      key: entry.key,
      value: entry.value,
      version: entry.version,
      updatedBy: entry.updatedBy,
      updatedAtMs: entry.updatedAtMs,
      reason: entry.reason,
    });
  }
  if (!isRecord(value.effective)) throw new Error("OTel config response was malformed.");
  const effective: Record<string, OtelEffectiveEntry> = {};
  for (const [key, entry] of Object.entries(value.effective)) {
    if (!isRecord(entry) || !("value" in entry) || typeof entry.source !== "string") {
      throw new Error("OTel config response was malformed.");
    }
    effective[key] = { value: entry.value, source: entry.source };
  }
  return { catalog, keys, overrides, effective };
}

async function readError(res: Response, fallback: string): Promise<Error> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const message =
    typeof body?.error === "string" && body.error !== "" ? body.error : fallback;
  return new Error(message);
}

export async function fetchOtelConfig(): Promise<OtelConfigResponse> {
  const res = await apiFetch("/api/otel/v1/config");
  if (!res.ok) throw await readError(res, "Failed to load the OTel config.");
  return parseOtelConfig(await res.json().catch(() => null));
}

export async function applyOtelConfigOverride(
  key: string,
  value: unknown,
  reason: string,
): Promise<OtelConfigApplyResponse> {
  const res = await apiFetch("/api/otel/v1/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key, value, reason }),
  });
  if (!res.ok) throw await readError(res, "Failed to apply the OTel config override.");
  const body = (await res.json().catch(() => null)) as { record?: unknown } | null;
  if (!isRecord(body?.record)) throw new Error("OTel config apply response was malformed.");
  const record = body.record;
  if (
    typeof record.key !== "string" ||
    !("value" in record) ||
    typeof record.version !== "number" ||
    typeof record.updatedBy !== "string" ||
    typeof record.updatedAtMs !== "number" ||
    typeof record.reason !== "string"
  ) {
    throw new Error("OTel config apply response was malformed.");
  }
  return {
    record: {
      key: record.key,
      value: record.value,
      version: record.version,
      updatedBy: record.updatedBy,
      updatedAtMs: record.updatedAtMs,
      reason: record.reason,
    },
  };
}

export async function clearOtelConfigOverride(key: string, reason: string): Promise<void> {
  const params = new URLSearchParams({ key, reason });
  const res = await apiFetch(`/api/otel/v1/config?${params.toString()}`, {
    method: "DELETE",
  });
  if (!res.ok) throw await readError(res, "Failed to clear the OTel config override.");
}
