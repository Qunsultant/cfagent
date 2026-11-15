/**
 * Client for the PDP read endpoint (issue #4651):
 * GET /api/security/pdp — the PDP's resolved policy source
 * (IAAA_PDP_POLICY_SOURCE code|snapshot + invalid flag), the frozen
 * OBLIGATION_POLICY entries, and their live evaluateWithObligations()
 * coverage. Platform-admin only server-side (403 otherwise, audited).
 *
 * Nothing here decides authorization: the panel renders whatever the
 * server reports. All calls go through apiFetch (the #71 rule).
 */

import { apiFetch } from "./apiFetch";

export interface PdpPolicySourceInfo {
  source: "code" | "snapshot";
  invalid: boolean;
}

export interface PdpObligationInfo {
  permission: string;
  obligations: string[];
  advice: { kind: string; message: string }[];
}

export interface PdpCoverageInfo {
  permission: string;
  status: "enforced" | "residual";
  enforcementPoints: string[];
}

export interface PdpState {
  policySource: PdpPolicySourceInfo;
  obligations: PdpObligationInfo[];
  coverage: PdpCoverageInfo[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

function parsePdpState(value: unknown): PdpState {
  if (!isRecord(value)) throw new Error("PDP response was not an object.");
  if (!isRecord(value.policySource)) throw new Error("PDP response was malformed.");
  const { source, invalid } = value.policySource;
  if (source !== "code" && source !== "snapshot") {
    throw new Error("PDP response was malformed.");
  }
  if (typeof invalid !== "boolean") throw new Error("PDP response was malformed.");
  if (!Array.isArray(value.obligations) || !Array.isArray(value.coverage)) {
    throw new Error("PDP response was malformed.");
  }
  const obligations: PdpObligationInfo[] = [];
  for (const entry of value.obligations) {
    if (!isRecord(entry) || typeof entry.permission !== "string") {
      throw new Error("PDP response was malformed.");
    }
    if (!isStringArray(entry.obligations) || !Array.isArray(entry.advice)) {
      throw new Error("PDP response was malformed.");
    }
    const advice: { kind: string; message: string }[] = [];
    for (const a of entry.advice) {
      if (!isRecord(a) || typeof a.kind !== "string" || typeof a.message !== "string") {
        throw new Error("PDP response was malformed.");
      }
      advice.push({ kind: a.kind, message: a.message });
    }
    obligations.push({
      permission: entry.permission,
      obligations: entry.obligations,
      advice,
    });
  }
  const coverage: PdpCoverageInfo[] = [];
  for (const entry of value.coverage) {
    if (!isRecord(entry) || typeof entry.permission !== "string") {
      throw new Error("PDP response was malformed.");
    }
    if (entry.status !== "enforced" && entry.status !== "residual") {
      throw new Error("PDP response was malformed.");
    }
    if (!isStringArray(entry.enforcementPoints)) {
      throw new Error("PDP response was malformed.");
    }
    coverage.push({
      permission: entry.permission,
      status: entry.status,
      enforcementPoints: entry.enforcementPoints,
    });
  }
  return {
    policySource: { source, invalid },
    obligations,
    coverage,
  };
}

export async function fetchPdpState(): Promise<PdpState> {
  const res = await apiFetch("/api/security/pdp");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message =
      typeof body?.error === "string" && body.error !== ""
        ? body.error
        : "Failed to load PDP state.";
    throw new Error(message);
  }
  const body = (await res.json().catch(() => null)) as unknown;
  return parsePdpState(body);
}
