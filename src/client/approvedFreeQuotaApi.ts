/**
 * Issue #3263 (sub-issue of #3256; ownership COO-spr9) — approved-free
 * quota client calls over the quota routes only.
 *
 * The browser calls /api/... with the session cookie; the worker
 * injects x-user-login from the session before forwarding to the
 * orchestrator. This module NEVER sends an identity header and NEVER
 * reads tier or tenant from a header or localStorage claim — identity
 * is the session, and the server is the authority on quota state and
 * on whether the viewer is a store operator.
 *
 * Error contract: every failure surfaces as
 * ApprovedFreeQuotaApiError carrying the HTTP status AND, when the
 * server sent a catalog-coded body, the outcome code + business
 * message (AOP #2381). Callers render the server message when a
 * code is present and fall back to FIXED caller-facing strings
 * otherwise; raw server text is never rendered. GET
 * approved-free-quota is own-or-operator; POST is operator-only
 * server-side (the UI is never the access control, only the
 * affordance). Operator detection reuses listOperators from the
 * refund-policy module (#2985): a success proves the viewer is a
 * store operator, a 403 proves they are not.
 */
import { withCsrfInit } from "./apiFetch";
import { listOperators } from "./refundPolicyApi";
import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";

const BASE = COMMERCIAL_API_BASE;

export type ApprovedFreeQuotaFamily = "stock" | "goal" | "options" | "strategy";
export type ApprovedFreeQuotaWindowKind = "month" | "week";
export type ApprovedFreeQuotaAtLimitAction = "upgrade_or_buy_credits" | "stop";

export interface ApprovedFreeQuotaFamilyRow {
  family: ApprovedFreeQuotaFamily;
  cap: number | null;
  used: number;
  remaining: number | null;
  period: string | null;
}

export interface ApprovedFreeQuotaSettings {
  windowKind: ApprovedFreeQuotaWindowKind;
  atLimitAction: ApprovedFreeQuotaAtLimitAction;
  updatedAtMs: number;
  updatedBy: string | null;
}

export interface ApprovedFreeQuotaState {
  userId: string;
  tenantId: string | null;
  settings: ApprovedFreeQuotaSettings | null;
  period: string | null;
  families: ApprovedFreeQuotaFamilyRow[];
  grant: { active: boolean; expiresAtMs: number | null };
}

export class ApprovedFreeQuotaApiError extends Error {
  readonly status: number;
  /** Outcome-catalog code from the server body, when the server sent one. */
  readonly code: string | null;
  /** Server's catalog business message, when the server sent one. */
  readonly serverMessage: string | null;
  constructor(status: number, code?: string | null, serverMessage?: string | null) {
    super(`approved-free quota request failed: ${status}`);
    this.status = status;
    this.code = typeof code === "string" && code !== "" ? code : null;
    this.serverMessage = typeof serverMessage === "string" && serverMessage !== "" ? serverMessage : null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function callJson(path: string, init?: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await globalThis.fetch(path, withCsrfInit(init));
  } catch {
    throw new ApprovedFreeQuotaApiError(0);
  }
  if (!res.ok) {
    // AOP: the server answers quota failures with a catalog-coded
    // body {error: businessMessage, code, retryable} — carry the
    // code + message so the panel renders the catalog message.
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const code = typeof body.code === "string" ? body.code : null;
    const message = typeof body.error === "string" ? body.error : null;
    throw new ApprovedFreeQuotaApiError(res.status, code, message);
  }
  return (await res.json().catch(() => ({}))) as unknown;
}

function isFamily(value: unknown): value is ApprovedFreeQuotaFamily {
  return value === "stock" || value === "goal" || value === "options" || value === "strategy";
}

function assertSettings(value: unknown): ApprovedFreeQuotaSettings | null {
  if (value === null) return null;
  if (!isRecord(value)) throw new ApprovedFreeQuotaApiError(500);
  if (
    (value.windowKind !== "month" && value.windowKind !== "week") ||
    (value.atLimitAction !== "upgrade_or_buy_credits" && value.atLimitAction !== "stop") ||
    typeof value.updatedAtMs !== "number"
  ) {
    throw new ApprovedFreeQuotaApiError(500);
  }
  return {
    windowKind: value.windowKind,
    atLimitAction: value.atLimitAction,
    updatedAtMs: value.updatedAtMs,
    updatedBy: typeof value.updatedBy === "string" ? value.updatedBy : null,
  };
}

function assertState(value: unknown): ApprovedFreeQuotaState {
  if (!isRecord(value)) throw new ApprovedFreeQuotaApiError(500);
  if (typeof value.userId !== "string") throw new ApprovedFreeQuotaApiError(500);
  if (!Array.isArray(value.families)) throw new ApprovedFreeQuotaApiError(500);
  const families: ApprovedFreeQuotaFamilyRow[] = value.families.map((entry) => {
    if (!isRecord(entry) || !isFamily(entry.family)) throw new ApprovedFreeQuotaApiError(500);
    if (
      (entry.cap !== null && typeof entry.cap !== "number") ||
      typeof entry.used !== "number" ||
      (entry.remaining !== null && typeof entry.remaining !== "number") ||
      (entry.period !== null && typeof entry.period !== "string")
    ) {
      throw new ApprovedFreeQuotaApiError(500);
    }
    return {
      family: entry.family,
      cap: entry.cap,
      used: entry.used,
      remaining: entry.remaining,
      period: entry.period,
    };
  });
  const grant = isRecord(value.grant)
    ? {
        active: value.grant.active === true,
        expiresAtMs: typeof value.grant.expiresAtMs === "number" ? value.grant.expiresAtMs : null,
      }
    : { active: false, expiresAtMs: null };
  return {
    userId: value.userId,
    tenantId: typeof value.tenantId === "string" ? value.tenantId : null,
    settings: assertSettings(value.settings ?? null),
    period: typeof value.period === "string" ? value.period : null,
    families,
    grant,
  };
}

/**
 * GET approved-free-quota — own or operator. No userId reads the
 * caller's own quota; a userId reads that account (operator only
 * server-side).
 */
export async function getApprovedFreeQuota(userId?: string): Promise<ApprovedFreeQuotaState> {
  const suffix = userId ? `?userId=${encodeURIComponent(userId)}` : "";
  return assertState(await callJson(`${BASE}/approved-free-quota${suffix}`));
}

/** POST approved-free-quota { family, capRuns } — operator-only. Returns the catalog-coded success. */
export async function setApprovedFreeQuotaCap(
  family: ApprovedFreeQuotaFamily,
  capRuns: number,
): Promise<{ family: ApprovedFreeQuotaFamily; capRuns: number; code: string; message: string }> {
  const data = await callJson(`${BASE}/approved-free-quota`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ family, capRuns }),
  });
  if (
    !isRecord(data) ||
    !isFamily(data.family) ||
    typeof data.capRuns !== "number" ||
    typeof data.code !== "string" ||
    typeof data.message !== "string"
  ) {
    throw new ApprovedFreeQuotaApiError(500);
  }
  return { family: data.family, capRuns: data.capRuns, code: data.code, message: data.message };
}

/**
 * POST approved-free-quota { windowKind } or { atLimitAction } —
 * operator-only. One setting per call; returns the fresh settings
 * row plus the catalog-coded success — which callers MUST NOT render
 * as the new state: the section re-reads the quota after every
 * action and renders only the fresh read. The returned message is
 * the success NOTE, not state.
 */
export async function setApprovedFreeQuotaSettings(patch: {
  windowKind?: ApprovedFreeQuotaWindowKind;
  atLimitAction?: ApprovedFreeQuotaAtLimitAction;
}): Promise<{ settings: ApprovedFreeQuotaSettings; code: string; message: string }> {
  const data = await callJson(`${BASE}/approved-free-quota`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!isRecord(data)) throw new ApprovedFreeQuotaApiError(500);
  const settings = assertSettings(data.settings);
  if (!settings || typeof data.code !== "string" || typeof data.message !== "string") {
    throw new ApprovedFreeQuotaApiError(500);
  }
  return { settings, code: data.code, message: data.message };
}

/**
 * True when the account HAD a grant that has since expired:
 * inactive with an expiry set. A never-granted account reads
 * inactive with expiresAtMs null and is NOT expired — it never
 * had a grant. The expired rendering shows the catalog-coded
 * expired message; the never-granted rendering stays "No
 * approved-free grant for this account."
 */
export function isGrantExpired(grant: ApprovedFreeQuotaState["grant"]): boolean {
  return grant.active === false && grant.expiresAtMs !== null;
}

/** True when GET /operators succeeds — i.e. the viewer is a store operator. */
export async function isStoreOperator(): Promise<boolean> {
  try {
    await listOperators();
    return true;
  } catch {
    return false;
  }
}
