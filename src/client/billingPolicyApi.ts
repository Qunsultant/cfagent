/**
 * Issue #3262 — top-up limits client over the EXISTING billing-policy
 * route only (Phase 2.1, #2656). No new server route.
 *
 * The browser calls /api/... with the session cookie; the worker
 * injects x-user-login from the session before forwarding to the
 * orchestrator. This module NEVER sends an identity header and NEVER
 * reads tier or tenant from a header or localStorage claim — identity
 * is the session, and the server is the authority on policy and on
 * whether the viewer is a store operator.
 *
 * Error contract: every failure surfaces as BillingPolicyApiError
 * carrying the HTTP status. Callers map statuses to FIXED
 * caller-facing strings; server error bodies are never rendered.
 * GET/POST billing-policy are operator-only server-side (the UI is
 * never the access control, only the affordance). The top-up limits
 * themselves are also served to any verified login on the pricing
 * route (topUpLimits) — the limits section reads values there for
 * non-operators and uses this module for operator reads + edits.
 */
import { withCsrfInit } from "./apiFetch";

const BASE = "/api/payments/agentic/commercial";

export interface TopUpLimitsView {
  topUpMinUSD: number;
  topUpMaxUSD: number;
}

export interface BillingPolicyResponse {
  limits: TopUpLimitsView;
  seedNote: string;
}

export class BillingPolicyApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`billing policy request failed: ${status}`);
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
    throw new BillingPolicyApiError(0);
  }
  if (!res.ok) throw new BillingPolicyApiError(res.status);
  return (await res.json().catch(() => ({}))) as unknown;
}

function assertLimits(value: unknown): TopUpLimitsView {
  if (!isRecord(value)) throw new BillingPolicyApiError(500);
  if (typeof value.topUpMinUSD !== "number" || typeof value.topUpMaxUSD !== "number") {
    throw new BillingPolicyApiError(500);
  }
  return { topUpMinUSD: value.topUpMinUSD, topUpMaxUSD: value.topUpMaxUSD };
}

/**
 * GET billing-policy — operator-only. Returns the top-up limits plus
 * the seed note (values not yet edited are PROPOSED seeds pending
 * owner approval). Callers MUST NOT render the POST answer as the
 * new state: re-read after every save and render only the fresh read.
 */
export async function getBillingPolicy(): Promise<BillingPolicyResponse> {
  const data = await callJson(`${BASE}/billing-policy`);
  if (!isRecord(data)) throw new BillingPolicyApiError(500);
  return {
    limits: assertLimits(data.policy),
    seedNote: typeof data.seedNote === "string" ? data.seedNote : "",
  };
}

/**
 * POST billing-policy with only the top-up limits — operator-only,
 * audited server-side. Returns the fresh limits from the POST
 * answer, which callers MUST NOT render as the new state: the
 * section re-reads the policy after every save.
 */
export async function setTopUpLimits(
  topUpMinUSD: number,
  topUpMaxUSD: number,
): Promise<TopUpLimitsView> {
  const data = await callJson(`${BASE}/billing-policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ topUpMinUSD, topUpMaxUSD }),
  });
  if (!isRecord(data)) throw new BillingPolicyApiError(500);
  return assertLimits(data.policy);
}
