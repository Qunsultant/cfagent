/**
 * Issue #2137: checkout UI API client (commercial routes).
 *
 * The browser calls /api/... with the session cookie; the worker
 * injects x-user-login from the session before forwarding to the
 * orchestrator. This module NEVER sends an identity header and NEVER
 * reads tier or tenant from a header or localStorage claim — identity
 * is the session, and the server is the authority on tier, tenant,
 * prices, and whether charging is on.
 *
 * Error contract: every failure surfaces as CommercialApiError with
 * the HTTP status. errorMessageForStatus maps statuses to FIXED
 * caller-facing strings (the #2060 CodeQL precedent: generic text to
 * the caller, detail server-side only). Server error bodies are never
 * rendered — they can carry internal detail.
 */
import { withCsrfInit } from "./apiFetch";

const BASE = "/api/payments/agentic/commercial";

export class CommercialApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(errorMessageForStatus(status));
    this.status = status;
  }
}

/** Fixed caller-facing message per HTTP status. No server detail leaks. */
export function errorMessageForStatus(status: number): string {
  switch (status) {
    case 0:
      return "The service could not be reached. Check your connection and try again.";
    case 400:
      return "Some values are missing or invalid. Check the form and try again.";
    case 401:
      return "Sign in again to continue.";
    case 402:
      return "The checkout is not paid yet. Complete the payment, then try again.";
    case 403:
      return "Payments are currently off, or you do not have access to this. No charge was made.";
    case 404:
      return "This service is not deployed yet. Try again after the next release.";
    case 409:
      return "This payment was already used, or the plan is no longer active.";
    case 503:
      return "The payment service is temporarily unavailable. Try again later.";
    default:
      return "Something went wrong. Try again later.";
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, withCsrfInit({
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
    }));
  } catch {
    throw new CommercialApiError(0);
  }
  if (!res.ok) throw new CommercialApiError(res.status);
  return (await res.json()) as T;
}

const get = <T>(path: string): Promise<T> => call<T>(path);
const post = <T>(path: string, body: unknown): Promise<T> =>
  call<T>(path, { method: "POST", body: JSON.stringify(body) });

export type ScreenerFamily = "stock" | "goal" | "options" | "strategy";

/**
 * Issue #2196 (slice 3, #2146): the pricing route's server-derived
 * network marker. The panel renders this marker — it never hardcodes
 * a network. testnetOnly is gone: acceptMainnet's negation is the
 * testnet presentation, derived server-side from the Stripe mode +
 * x402 network. browserPaymentScope is operator-served (default
 * card-only) so widening it needs no client deploy.
 */
export interface NetworkMarker {
  stripeMode: "sandbox" | "live" | "unconfigured";
  x402Network: string | null;
  acceptsMainnet: boolean;
}

export type BrowserPaymentScope = "card-only" | "card-and-x402";

export interface Pricing {
  monetizationEnabled: boolean;
  prices: Record<ScreenerFamily, number>;
  network: NetworkMarker;
  browserPaymentScope: BrowserPaymentScope;
  failurePolicy: string;
}

export interface CommercialAccountView {
  id?: string;
  tenantId?: string;
  tier?: string;
  creditsUSD?: number;
  includedRunsRemaining?: number;
}

export interface PlanView {
  id: string;
  name: string;
  priceUSD: number;
  periodDays: number;
  includedRuns: number;
  active?: boolean;
  /** Issue #3243: trial length in days, operator data; null = no trial offered. */
  trialDays?: number | null;
}

export interface SubscriptionView {
  id: string;
  planId: string;
  status: string;
  periodStartMs: number;
  periodEndMs: number;
  canceledAtMs?: number | null;
  /**
   * Issue #2669 (2.14): present when the row is Billing-managed
   * (provider-canceled by Stripe); absent/null for native repurchase
   * rows. The GET /subscription route already returns it; the client
   * type just declares it so the UI can distinguish the two kinds.
   */
  providerSubscriptionId?: string | null;
}

export interface SubscriptionStatusView {
  userId: string;
  effectiveTier: string;
  current: SubscriptionView | null;
  subscriptions: SubscriptionView[];
}

export interface SubmitResult {
  runRequestId: string;
  workflowId?: string;
  status: string;
  creditRunId?: string;
}

/**
 * Issue #2196 (slice 3, #2146): the native check-payment response.
 * paymentUrl is the native Stripe checkoutUrl for card (null when
 * Stripe serves none, e.g. a completed session). x402 never has a
 * URL: challengeFlow carries the 402 presentation instead (network,
 * amount, recipient, no link).
 */
export interface ChallengeFlow {
  network: string | null;
  amountUSD?: number;
  currency: "USDC";
  recipient?: string;
  note: string;
}

export interface CheckPaymentResult {
  runRequestId: string;
  paid: boolean;
  delivered?: boolean;
  state?: string;
  paymentUrl?: string | null;
  rail?: "stripe" | "x402";
  challengeFlow?: ChallengeFlow;
}

export interface FeaturesResponse {
  features?: Record<string, boolean>;
}

export const getPricing = (): Promise<Pricing> => get<Pricing>("/pricing");
export const getFeatures = async (): Promise<FeaturesResponse> => {
  let res: Response;
  try {
    res = await fetch("/api/features");
  } catch {
    throw new CommercialApiError(0);
  }
  if (!res.ok) throw new CommercialApiError(res.status);
  return (await res.json()) as FeaturesResponse;
};
export const getAccount = (userId: string): Promise<CommercialAccountView> =>
  get<CommercialAccountView>(`/account?userId=${encodeURIComponent(userId)}`);

/**
 * Issue #2219: the platform identity for the verified session
 * login — the payment screen's read-only display. There is no
 * userId parameter: the server resolves the session login, so
 * this can never return another user's data. tenantId is null
 * when no commercial account row exists (hasAccount false);
 * tier is the effective tier at read time.
 */
export interface PlatformIdentityView {
  userLogin: string;
  tenantId: string | null;
  hasAccount: boolean;
  tier: string;
  creditsUSD: number;
  includedRunsRemaining: number;
}

export const getIdentity = (): Promise<PlatformIdentityView> => get<PlatformIdentityView>("/identity");
export const listPlans = (): Promise<{ plans: PlanView[] }> => get<{ plans: PlanView[] }>("/plans");
export const getSubscriptionStatus = (userId: string): Promise<SubscriptionStatusView> =>
  get<SubscriptionStatusView>(`/subscription?userId=${encodeURIComponent(userId)}`);
export const getSubmissionStatus = (workflowId: string): Promise<{ workflowId: string; status: string }> =>
  get<{ workflowId: string; status: string }>(`/submission-status?workflowId=${encodeURIComponent(workflowId)}`);

export interface SubmitBody {
  family: ScreenerFamily;
  /**
   * Issue #2219: legacy/optional only. The server derives the
   * run tenant from the resolved platform identity and ignores
   * any client-supplied tenantId, even on mismatch. The panel
   * never sends one; the free path (flag OFF) with no resolved
   * account falls back server-side to the verified-login scope.
   */
  tenantId?: string;
  email: string;
  trigger?: "manual" | "scheduled";
  scheduleKind?: "one_off";
  authorizedAtSubmission?: boolean;
  screenerCommand: Record<string, unknown>;
}

export const submitRun = (body: SubmitBody): Promise<SubmitResult> => post<SubmitResult>("/submit", body);
export const checkPayment = (
  runRequestId: string,
  opts?: { sessionId?: string; family?: ScreenerFamily; paymentProof?: string; payer?: string },
): Promise<CheckPaymentResult> =>
  post<CheckPaymentResult>("/submission/check-payment", { runRequestId, ...(opts ?? {}) });
export const buildGoalCommand = (body: {
  jobId: string;
  goalKind: string;
  direction: string;
  symbols?: string[];
  tenantId?: string;
}): Promise<{ screenerCommand: Record<string, unknown> }> => post("/goal-command", body);
export const subscriptionCheckout = (body: {
  planId: string;
  /** Issue #2219: legacy/optional only — the server derives the tenant from the resolved identity. */
  tenantId?: string;
  email: string;
}): Promise<{ checkoutRequestId: string; checkoutUrl: string; checkoutSessionId: string; plan: PlanView }> =>
  post("/subscription/checkout", body);
export const subscriptionPurchase = (body: {
  planId: string;
  /** Issue #2219: legacy/optional only — the server derives the tenant from the resolved identity. */
  tenantId?: string;
  checkoutRequestId: string;
  checkoutSessionId: string;
}): Promise<{ subscription: SubscriptionView; account: CommercialAccountView; effectiveTier: string }> =>
  post("/subscription/purchase", body);
export const subscriptionCancel = (): Promise<{
  userId: string;
  canceled: SubscriptionView[];
  accessThroughMs: number | null;
  /**
   * Issue #2669 (2.14): the timing the server applied, from the 2.7
   * operator billing policy — period_end keeps access to period end,
   * immediate truncates it now. The UI reports the outcome per this
   * value instead of asserting one timing unconditionally.
   */
  downgradeTiming: "period_end" | "immediate";
}> => post("/subscription/cancel", {});
/**
 * Issue #3243 — start a $0 trial subscription (no payment taken).
 * The server creates a trialing row and grants the plan's
 * included runs; the response carries the trial end and the
 * outcome-encoded trial message.
 */
export const subscriptionTrial = (body: {
  planId: string;
}): Promise<{
  subscription: SubscriptionView;
  account: CommercialAccountView;
  effectiveTier: string;
  trialEndsAtMs: number;
  message: string;
}> => post("/subscription/trial", body);

/** Split a comma-separated symbols field into a clean list. */
export function parseSymbols(input: string): string[] {
  return input
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Build a non-goal screener command. The server stamps userLogin from
 * the verified session on submit, so the client command carries no
 * identity claim — the session header is the authority, not this
 * object. Goal commands MUST come from the server goal-command route
 * (a goal screen requires a server-built scenario).
 */
export function buildNonGoalCommand(
  jobId: string,
  family: Exclude<ScreenerFamily, "goal">,
  symbols: string[]
): Record<string, unknown> {
  return {
    jobId,
    type: "run-screen",
    source: "manual",
    trigger: "manual",
    role: "parent",
    shards: [{ shardId: family, symbols }],
  };
}

/** Format a USD amount with exactly two decimals. */
export function formatUSD(value: number): string {
  return `$${value.toFixed(2)}`;
}

/** Format a period-end timestamp for display. */
export function formatPeriodEnd(ms: number | null | undefined): string {
  if (!ms) return "—";
  return new Date(ms).toLocaleString();
}
