/**
 * Client for the PEP read endpoint (issue #4653):
 * GET /api/security/pep — the PEP's live enforcement state for the
 * caller's session (IAAA_PDP_ENABLED flag + shouldEnforcePdp /
 * isLegacyPdpGraceExpired evaluation), the cited gate inventory
 * (every evaluateRoutePep / evaluateAgentSchedulePdp call site), and
 * the recent-decisions record (none exists yet — the endpoint reports
 * decisionsAvailable: false, never invented rows).
 * Platform-admin only server-side (403 otherwise, audited).
 *
 * Nothing here decides authorization: the panel renders whatever the
 * server reports. All calls go through apiFetch (the #71 rule).
 */

import { apiFetch } from "./apiFetch";

export interface PepEnforcementInfo {
  pdpEnabled: boolean;
  enforced: boolean;
  graceExpired: boolean;
  sessionKind: "wired" | "legacy";
  legacyGraceWindowSeconds: number;
}

export interface PepGateInfo {
  route: string;
  method: "GET" | "POST";
  permission: string;
  gateway: "evaluateRoutePep" | "evaluateAgentSchedulePdp";
  source: string;
  denied: string;
}

export interface PepState {
  enforcement: PepEnforcementInfo;
  gates: PepGateInfo[];
  decisions: null;
  decisionsAvailable: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parsePepState(value: unknown): PepState {
  if (!isRecord(value)) throw new Error("PEP response was not an object.");
  if (!isRecord(value.enforcement)) throw new Error("PEP response was malformed.");
  const enforcement = value.enforcement;
  if (typeof enforcement.pdpEnabled !== "boolean") {
    throw new Error("PEP response was malformed.");
  }
  if (typeof enforcement.enforced !== "boolean") {
    throw new Error("PEP response was malformed.");
  }
  if (typeof enforcement.graceExpired !== "boolean") {
    throw new Error("PEP response was malformed.");
  }
  if (enforcement.sessionKind !== "wired" && enforcement.sessionKind !== "legacy") {
    throw new Error("PEP response was malformed.");
  }
  if (typeof enforcement.legacyGraceWindowSeconds !== "number") {
    throw new Error("PEP response was malformed.");
  }
  if (!Array.isArray(value.gates)) throw new Error("PEP response was malformed.");
  const gates: PepGateInfo[] = [];
  for (const entry of value.gates) {
    if (!isRecord(entry)) throw new Error("PEP response was malformed.");
    if (typeof entry.route !== "string") throw new Error("PEP response was malformed.");
    if (entry.method !== "GET" && entry.method !== "POST") {
      throw new Error("PEP response was malformed.");
    }
    if (typeof entry.permission !== "string") throw new Error("PEP response was malformed.");
    if (entry.gateway !== "evaluateRoutePep" && entry.gateway !== "evaluateAgentSchedulePdp") {
      throw new Error("PEP response was malformed.");
    }
    if (typeof entry.source !== "string") throw new Error("PEP response was malformed.");
    if (typeof entry.denied !== "string") throw new Error("PEP response was malformed.");
    gates.push({
      route: entry.route,
      method: entry.method,
      permission: entry.permission,
      gateway: entry.gateway,
      source: entry.source,
      denied: entry.denied,
    });
  }
  if (typeof value.decisionsAvailable !== "boolean") {
    throw new Error("PEP response was malformed.");
  }
  if (value.decisions !== null) throw new Error("PEP response was malformed.");
  return {
    enforcement: {
      pdpEnabled: enforcement.pdpEnabled,
      enforced: enforcement.enforced,
      graceExpired: enforcement.graceExpired,
      sessionKind: enforcement.sessionKind,
      legacyGraceWindowSeconds: enforcement.legacyGraceWindowSeconds,
    },
    gates,
    decisions: null,
    decisionsAvailable: value.decisionsAvailable,
  };
}

export async function fetchPepState(): Promise<PepState> {
  const res = await apiFetch("/api/security/pep");
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const message =
      typeof body?.error === "string" && body.error !== ""
        ? body.error
        : "Failed to load PEP state.";
    throw new Error(message);
  }
  const body = (await res.json().catch(() => null)) as unknown;
  return parsePepState(body);
}
