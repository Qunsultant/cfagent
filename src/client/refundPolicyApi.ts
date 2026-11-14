/**
 * Issue #2985 (monetization Phase 2.19, program #2405) — refund-policy
 * client calls over the EXISTING 2.7 routes only.
 *
 * The browser calls /api/... with the session cookie; the worker
 * injects x-user-login from the session before forwarding to the
 * orchestrator. This module NEVER sends an identity header and NEVER
 * reads tier or tenant from a header or localStorage claim — identity
 * is the session, and the server is the authority on policy and on
 * whether the viewer is a store operator.
 *
 * Error contract: every failure surfaces as RefundPolicyApiError
 * carrying the HTTP status. Callers map statuses to FIXED
 * caller-facing strings; server error bodies are never rendered.
 * GET refund-policy is any-verified-login; POST approve and GET
 * operators are operator-only server-side (the UI is never the
 * access control, only the affordance).
 */
import { withCsrfInit } from "./apiFetch";

import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";
const BASE = COMMERCIAL_API_BASE;

export type RefundKind = "subscription" | "pay_per_run";

export interface RefundPolicyView {
  windowDays: number;
  approver: string;
  allowPartial: boolean;
  subscriptionFullEffect: string;
  subscriptionPartialEffect: string;
  payPerRunEffect: string;
  creditEffect: string;
  approvedKinds: RefundKind[];
  approvedBy: string | null;
  approvedAtMs: number | null;
}

export interface RefundPolicyResponse {
  policy: RefundPolicyView;
  disclosure: string;
}

export interface OperatorRow {
  login: string;
  source: "env" | "store";
  addedBy: string | null;
  addedAtMs: number | null;
}

export class RefundPolicyApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`refund policy request failed: ${status}`);
    this.status = status;
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
    throw new RefundPolicyApiError(0);
  }
  if (!res.ok) throw new RefundPolicyApiError(res.status);
  return (await res.json().catch(() => ({}))) as unknown;
}

function isRefundKind(value: unknown): value is RefundKind {
  return value === "subscription" || value === "pay_per_run";
}

function assertPolicy(value: unknown): RefundPolicyView {
  if (!isRecord(value)) throw new RefundPolicyApiError(500);
  const approvedKinds = Array.isArray(value.approvedKinds)
    ? value.approvedKinds.filter(isRefundKind)
    : [];
  if (
    typeof value.windowDays !== "number" ||
    typeof value.approver !== "string" ||
    typeof value.allowPartial !== "boolean" ||
    typeof value.subscriptionFullEffect !== "string" ||
    typeof value.subscriptionPartialEffect !== "string" ||
    typeof value.payPerRunEffect !== "string" ||
    typeof value.creditEffect !== "string"
  ) {
    throw new RefundPolicyApiError(500);
  }
  return {
    windowDays: value.windowDays,
    approver: value.approver,
    allowPartial: value.allowPartial,
    subscriptionFullEffect: value.subscriptionFullEffect,
    subscriptionPartialEffect: value.subscriptionPartialEffect,
    payPerRunEffect: value.payPerRunEffect,
    creditEffect: value.creditEffect,
    approvedKinds,
    approvedBy: typeof value.approvedBy === "string" ? value.approvedBy : null,
    approvedAtMs: typeof value.approvedAtMs === "number" ? value.approvedAtMs : null,
  };
}

/** GET refund-policy — any verified login; returns { policy, disclosure }. */
export async function getRefundPolicy(): Promise<RefundPolicyResponse> {
  const data = await callJson(`${BASE}/refund-policy`);
  if (!isRecord(data)) throw new RefundPolicyApiError(500);
  return {
    policy: assertPolicy(data.policy),
    disclosure: typeof data.disclosure === "string" ? data.disclosure : "",
  };
}

/**
 * POST refund-policy/approve — operator-only, audited, not flag-gated.
 * Returns the POST answer, which callers MUST NOT render as the new
 * state: the section re-reads the policy after every action and
 * renders only the fresh read.
 */
export async function setRefundKindApproval(
  kind: RefundKind,
  approved: boolean,
): Promise<RefundPolicyView> {
  const data = await callJson(`${BASE}/refund-policy/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind, approved }),
  });
  if (!isRecord(data)) throw new RefundPolicyApiError(500);
  return assertPolicy(data.policy);
}

/**
 * GET operators — operator-only server-side, so a success proves the
 * viewer is a store operator and a 403 proves they are not. The list
 * itself is not rendered by the refund section; only its outcome is.
 */
export async function listOperators(): Promise<OperatorRow[]> {
  const data = await callJson(`${BASE}/operators`);
  if (!isRecord(data) || !Array.isArray(data.operators)) throw new RefundPolicyApiError(500);
  return data.operators.filter(isRecord).map((row) => ({
    login: typeof row.login === "string" ? row.login : "",
    source: row.source === "store" ? "store" : "env",
    addedBy: typeof row.addedBy === "string" ? row.addedBy : null,
    addedAtMs: typeof row.addedAtMs === "number" ? row.addedAtMs : null,
  }));
}
