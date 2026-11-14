/**
 * Issue #3045 (monetization Phase 2.20, program #2405) — refund flow
 * client calls over the EXISTING 2.7 routes only.
 *
 * The browser calls /api/... with the session cookie; the worker
 * injects x-user-login from the session before forwarding to the
 * orchestrator. This module NEVER sends an identity header — identity
 * is the session, and the server is the authority on who may request,
 * decide, execute, or read a refund.
 *
 * Error contract: every failure surfaces as RefundFlowApiError
 * carrying the HTTP status. Callers map statuses to FIXED
 * caller-facing strings; server error bodies are never rendered.
 * POST answers are never treated as state: callers re-read after
 * every action and render only the fresh read.
 */
import type { RefundKind } from "./refundPolicyApi";
import { withCsrfInit } from "./apiFetch";

import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";
const BASE = COMMERCIAL_API_BASE;

export type { RefundKind };

export type RefundStatus =
  | "requested"
  | "approved"
  | "denied"
  | "executed"
  | "execution_failed";

export interface RefundRecord {
  id: string;
  userId: string;
  kind: RefundKind;
  originalPaymentRef: string;
  subscriptionId: string | null;
  paymentIntentId: string | null;
  family: string | null;
  originalAmountUSD: number;
  amountUSD: number;
  originalPaidAtMs: number;
  reason: string;
  status: RefundStatus;
  approverLogin: string | null;
  decisionNote: string | null;
  gatewayRefundId: string | null;
  executedAtMs: number | null;
  entitlementConsequence: string | null;
  createdAtMs: number;
  updatedAtMs: number;
}

export class RefundFlowApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`refund flow request failed: ${status}`);
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
    throw new RefundFlowApiError(0);
  }
  if (!res.ok) throw new RefundFlowApiError(res.status);
  return (await res.json().catch(() => ({}))) as unknown;
}

function isRefundKind(value: unknown): value is RefundKind {
  return value === "subscription" || value === "pay_per_run";
}

function isRefundStatus(value: unknown): value is RefundStatus {
  return (
    value === "requested" ||
    value === "approved" ||
    value === "denied" ||
    value === "executed" ||
    value === "execution_failed"
  );
}

function asStringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function assertRefundRecord(value: unknown): RefundRecord {
  if (!isRecord(value)) throw new RefundFlowApiError(500);
  if (typeof value.id !== "string" || value.id === "") throw new RefundFlowApiError(500);
  if (!isRefundKind(value.kind)) throw new RefundFlowApiError(500);
  if (!isRefundStatus(value.status)) throw new RefundFlowApiError(500);
  if (typeof value.originalPaymentRef !== "string" || value.originalPaymentRef === "") {
    throw new RefundFlowApiError(500);
  }
  if (typeof value.amountUSD !== "number" || typeof value.originalAmountUSD !== "number") {
    throw new RefundFlowApiError(500);
  }
  return {
    id: value.id,
    userId: typeof value.userId === "string" ? value.userId : "",
    kind: value.kind,
    originalPaymentRef: value.originalPaymentRef,
    subscriptionId: asStringOrNull(value.subscriptionId),
    paymentIntentId: asStringOrNull(value.paymentIntentId),
    family: asStringOrNull(value.family),
    originalAmountUSD: value.originalAmountUSD,
    amountUSD: value.amountUSD,
    originalPaidAtMs: asNumber(value.originalPaidAtMs, 0),
    reason: typeof value.reason === "string" ? value.reason : "",
    status: value.status,
    approverLogin: asStringOrNull(value.approverLogin),
    decisionNote: asStringOrNull(value.decisionNote),
    gatewayRefundId: asStringOrNull(value.gatewayRefundId),
    executedAtMs: typeof value.executedAtMs === "number" ? value.executedAtMs : null,
    entitlementConsequence: asStringOrNull(value.entitlementConsequence),
    createdAtMs: asNumber(value.createdAtMs, 0),
    updatedAtMs: asNumber(value.updatedAtMs, 0),
  };
}

/**
 * POST /refunds — owner-or-operator, flag-gated. The answer is
 * returned for its id only; callers MUST re-read by id and render
 * the fresh read.
 */
export async function requestRefund(input: {
  kind: RefundKind;
  originalPaymentRef: string;
  amountUSD: number;
  reason: string;
}): Promise<RefundRecord> {
  const data = await callJson(`${BASE}/refunds`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!isRecord(data)) throw new RefundFlowApiError(500);
  return assertRefundRecord(data.refund);
}

/** POST /refunds/approve — operator-only, flag-gated. */
export async function decideRefund(
  refundId: string,
  decision: "approve" | "deny",
  note?: string,
): Promise<RefundRecord> {
  const body: Record<string, unknown> = { refundId, decision };
  if (note !== undefined) body.note = note;
  const data = await callJson(`${BASE}/refunds/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!isRecord(data)) throw new RefundFlowApiError(500);
  return assertRefundRecord(data.refund);
}

/** POST /refunds/execute — operator-only, flag-gated. */
export async function executeRefund(refundId: string): Promise<RefundRecord> {
  const data = await callJson(`${BASE}/refunds/execute`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refundId }),
  });
  if (!isRecord(data)) throw new RefundFlowApiError(500);
  return assertRefundRecord(data.refund);
}

/** GET /refunds?refundId= — owner-or-operator, NOT flag-gated. */
export async function getRefund(refundId: string): Promise<RefundRecord> {
  const data = await callJson(`${BASE}/refunds?refundId=${encodeURIComponent(refundId)}`);
  if (!isRecord(data)) throw new RefundFlowApiError(500);
  return assertRefundRecord(data.refund);
}

/** GET /refunds — the caller's own list, NOT flag-gated. */
export async function listRefunds(): Promise<RefundRecord[]> {
  const data = await callJson(`${BASE}/refunds`);
  if (!isRecord(data) || !Array.isArray(data.refunds)) throw new RefundFlowApiError(500);
  return data.refunds.map(assertRefundRecord);
}
