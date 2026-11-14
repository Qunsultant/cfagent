/**
 * Issue #2667 (Monetization Phase 2.12, program #2405) — usage/billing
 * reader client calls over the new GET route only.
 *
 * The browser calls /api/... with the session cookie; the worker
 * injects x-user-login from the session before forwarding to the
 * orchestrator. This module NEVER sends an identity header — identity
 * is the session, and the server is the authority on whose usage and
 * billing are read.
 *
 * Error contract: every failure surfaces as UsageBillingApiError
 * carrying the HTTP status and, when the server sent one, the catalog
 * code; its message is the catalog message via codedMessage, never
 * server detail. A malformed view throws instead of rendering a
 * partial read.
 */
import { codedMessage, resolveOutcome } from "../outcomes/outcomeAspects";
import { commercialPath } from "../data/commercialUrlCatalog";
import { withCsrfInit } from "./apiFetch";
import type { UsageBillingView as ServerUsageBillingView } from "../data/usageBilling";

export type UsageBillingView = ServerUsageBillingView;

const BASE = commercialPath("usageBilling");

export class UsageBillingApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(status: number, code?: string) {
    super(
      code
        ? codedMessage(code)
        : "Your usage and billing could not be loaded. Try again later.",
    );
    this.status = status;
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isProvenance(value: unknown): value is "real" | "simulated" | "audit" {
  return value === "real" || value === "simulated" || value === "audit";
}

function assertReceipt(value: unknown): void {
  if (!isRecord(value)) throw new UsageBillingApiError(500);
  if (typeof value.id !== "string" || value.id === "") throw new UsageBillingApiError(500);
  if (value.kind !== "meter" && value.kind !== "tier" && value.kind !== "transaction") {
    throw new UsageBillingApiError(500);
  }
  if (!isProvenance(value.provenance)) throw new UsageBillingApiError(500);
  if (typeof value.createdAt !== "string") throw new UsageBillingApiError(500);
  if (!(value.amountUSD === null || isFiniteNumber(value.amountUSD))) {
    throw new UsageBillingApiError(500);
  }
}

function assertSubscription(value: unknown): void {
  if (!isRecord(value)) throw new UsageBillingApiError(500);
  if (typeof value.id !== "string" || value.id === "") throw new UsageBillingApiError(500);
  if (typeof value.planId !== "string" || value.planId === "") throw new UsageBillingApiError(500);
  if (typeof value.status !== "string") throw new UsageBillingApiError(500);
  if (!isFiniteNumber(value.periodStartMs) || !isFiniteNumber(value.periodEndMs)) {
    throw new UsageBillingApiError(500);
  }
  if (!isProvenance(value.provenance)) throw new UsageBillingApiError(500);
}

function assertRefund(value: unknown): void {
  if (!isRecord(value)) throw new UsageBillingApiError(500);
  if (typeof value.id !== "string" || value.id === "") throw new UsageBillingApiError(500);
  if (typeof value.kind !== "string" || typeof value.status !== "string") {
    throw new UsageBillingApiError(500);
  }
  if (!isFiniteNumber(value.amountUSD)) throw new UsageBillingApiError(500);
  if (!isProvenance(value.provenance)) throw new UsageBillingApiError(500);
}

function assertRenewal(value: unknown): void {
  if (!isRecord(value)) throw new UsageBillingApiError(500);
  if (typeof value.subscriptionId !== "string" || typeof value.planId !== "string") {
    throw new UsageBillingApiError(500);
  }
  if (!isFiniteNumber(value.renewsAtMs)) throw new UsageBillingApiError(500);
}

/**
 * Structural validation of the server view: a malformed view throws
 * instead of rendering a partial read. The server is the authority
 * on every value; this only checks shape, never content.
 */
function assertUsageBillingView(value: unknown): UsageBillingView {
  if (!isRecord(value)) throw new UsageBillingApiError(500);
  if (value.outcome !== "SUCCESS_USAGE_BILLING_READ") throw new UsageBillingApiError(500);
  if (typeof value.userLogin !== "string" || value.userLogin === "") {
    throw new UsageBillingApiError(500);
  }
  if (typeof value.tier !== "string") throw new UsageBillingApiError(500);
  if (!isFiniteNumber(value.limit)) throw new UsageBillingApiError(500);
  const identity = value.identity;
  if (!isRecord(identity)) throw new UsageBillingApiError(500);
  if (!isFiniteNumber(identity.creditsUSD) || !isFiniteNumber(identity.includedRunsRemaining)) {
    throw new UsageBillingApiError(500);
  }
  if (typeof identity.hasAccount !== "boolean") throw new UsageBillingApiError(500);
  const usage = value.usage;
  if (!isRecord(usage) || !Array.isArray(usage.receipts) || !isRecord(usage.counts)) {
    throw new UsageBillingApiError(500);
  }
  for (const key of ["meter", "tier", "transaction", "real", "simulated", "audit"]) {
    if (!isFiniteNumber(usage.counts[key])) throw new UsageBillingApiError(500);
  }
  usage.receipts.forEach(assertReceipt);
  const billing = value.billing;
  if (!isRecord(billing)) throw new UsageBillingApiError(500);
  if (typeof billing.effectiveTier !== "string") throw new UsageBillingApiError(500);
  if (!(billing.current === null || isRecord(billing.current))) {
    throw new UsageBillingApiError(500);
  }
  if (billing.current !== null) assertSubscription(billing.current);
  if (!Array.isArray(billing.subscriptions) || !Array.isArray(billing.renewals) || !Array.isArray(billing.refunds)) {
    throw new UsageBillingApiError(500);
  }
  billing.subscriptions.forEach(assertSubscription);
  billing.renewals.forEach(assertRenewal);
  billing.refunds.forEach(assertRefund);
  const referral = billing.referral;
  if (!isRecord(referral)) throw new UsageBillingApiError(500);
  if (!isFiniteNumber(referral.redeemableUSD) || !isFiniteNumber(referral.totalEarnedUSD)) {
    throw new UsageBillingApiError(500);
  }
  return value as unknown as UsageBillingView;
}

/** GET /payments/agentic/commercial/usage-billing — the caller's own view. */
export async function fetchUsageBilling(): Promise<UsageBillingView> {
  let res: Response;
  try {
    res = await globalThis.fetch(BASE, withCsrfInit({}));
  } catch {
    throw new UsageBillingApiError(0);
  }
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const code = isRecord(data) && typeof data.code === "string" ? data.code : undefined;
    // Unknown codes pass through the resolver verbatim ([CODE]);
    // a missing code gets the fixed fallback, never server detail.
    throw new UsageBillingApiError(res.status, code && resolveOutcome(code).resolved ? code : undefined);
  }
  return assertUsageBillingView(data);
}
