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
import { codedMessage, resolveOutcome } from "../outcomes/outcomeAspects";

import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";
const BASE = COMMERCIAL_API_BASE;

export class CommercialApiError extends Error {
  readonly status: number;
  /**
   * Issue #3523: the outcome-catalog code the server returned for this failure, when the
   * error body carried one that resolves in the catalog. The message is then the coded
   * message (`[CODE] businessMessage`, the #2573 pattern); otherwise it is the fixed
   * per-status string and no server detail is ever rendered.
   */
  readonly code?: string;
  constructor(status: number, code?: string) {
    super(code && resolveOutcome(code).entry ? codedMessage(code) : errorMessageForStatus(status));
    this.status = status;
    this.code = code;
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
  if (!res.ok) {
    // Issue #3523: a coded error body carries its catalog code through (the #2573 pattern);
    // a legacy raw body falls back to the fixed per-status message — server detail is never
    // rendered, and an unknown code never invents a message.
    let code: string | undefined;
    try {
      const body = (await res.json()) as { code?: unknown };
      if (typeof body?.code === "string" && resolveOutcome(body.code).entry) code = body.code;
    } catch {
      code = undefined;
    }
    throw new CommercialApiError(res.status, code);
  }
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
  /** Issue #3262: operator-set top-up bounds from the billing policy (PROPOSED seeds $1–$500); null when the policy store is unavailable — the UI shows the limits as unavailable and mint still validates server-side. */
  topUpLimits: { minUSD: number; maxUSD: number } | null;
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
  /** Issue #3357: plan price approval — "proposed" until an operator approves it; only an APPROVED plan price may be charged. */
  approvalStatus?: "proposed" | "approved";
  /** Login of the approving operator; null while proposed (or on grandfathered rows). */
  approvedBy?: string | null;
  /** Epoch ms of the approval; null while proposed (or on grandfathered rows). */
  approvedAtMs?: number | null;
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
/**
 * Issue #3263: a completed workflow may also carry its output —
 * outcome (e.g. "quota_exhausted") plus the outcome-catalog code
 * (e.g. FAILURE_APPROVED_FREE_QUOTA_EXHAUSTED) — so the poller
 * can render the catalog message instead of a raw status.
 */
export interface SubmissionStatusView {
  workflowId: string;
  status: string;
  outcome?: string;
  outcomeCode?: string;
}

export const getSubmissionStatus = (workflowId: string): Promise<SubmissionStatusView> =>
  get<SubmissionStatusView>(`/submission-status?workflowId=${encodeURIComponent(workflowId)}`);

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
  /**
   * Issue #3246: audit-only offer context, present only when the
   * checkout was started from an upgrade offer. The server audits
   * `commercial.offer.accepted` when present and ignores it when
   * absent; it authorizes nothing and changes no price.
   */
  offerContext?: OfferContext;
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
  /**
   * Issue #3523: the outcome-catalog code + verbatim catalog businessMessage for this cancel
   * (SUCCESS_SUBSCRIPTION_CANCELED_PERIOD_END / _IMMEDIATE). `remaining` lists the still-active
   * rows this cancel did not cancel (out-of-scope tenant rows, rows failing the recheck).
   */
  code: string;
  message: string;
  canceled: SubscriptionView[];
  remaining: SubscriptionView[];
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

/**
 * Issue #3262 — self-service top-up: mint + confirm through the
 * native verified-payment pattern. The mint response carries the
 * provider join key per rail: card → checkoutUrl + checkoutSessionId
 * (Stripe session id); x402 → checkoutId + challenge (the 402
 * challenge the payer's wallet/agent completes — no URL exists for
 * crypto). The confirm response carries the credited account, so the
 * panel shows the new credit balance from the fresh server read.
 */
export interface TopUpChallenge {
  version: string;
  network: string;
  recipient: string;
  amountUSD: number;
  currency: "USDC";
  facilitator: string;
  resource: string;
  nonce: string;
  expiresAtMs: number;
}

export interface TopUpCheckoutView {
  /** Issue #3571: catalog-coded mint outcome (SUCCESS_TOP_UP_CHECKOUT_CREATED). */
  code: string;
  /** The catalog businessMessage for `code` — the one rendering, never hand-written. */
  message: string;
  topUpRequestId: string;
  rail: "card" | "x402";
  amountUSD: number;
  checkoutUrl?: string | null;
  checkoutSessionId?: string | null;
  checkoutId?: string | null;
  challenge?: TopUpChallenge | null;
}

export interface TopUpConfirmView {
  /** Issue #3571: catalog-coded confirm outcome (SUCCESS_TOP_UP_CREDITED). */
  code: string;
  /** The catalog businessMessage for `code` — the one rendering, never hand-written. */
  message: string;
  account: CommercialAccountView;
  topUpRequestId: string;
  creditedUSD: number;
  rail: "card" | "x402";
}

export const topUpCheckout = (body: {
  amountUSD: number;
  rail?: "card" | "x402";
  email: string;
  /**
   * Issue #3246: audit-only offer context, present only when the
   * top-up was started from an upgrade offer (same contract as
   * the subscription checkout's offerContext).
   */
  offerContext?: OfferContext;
}): Promise<TopUpCheckoutView> => post<TopUpCheckoutView>("/top-up/checkout", body);
export const topUpConfirm = (body: {
  topUpRequestId: string;
  checkoutSessionId?: string;
  paymentProof?: string;
  payer?: string;
}): Promise<TopUpConfirmView> => post<TopUpConfirmView>("/top-up/confirm", body);

/**
 * Issue #3246 slice 3 — runs packs: mint + confirm through the
 * native verified-payment pattern (the top-up shape). The mint
 * response carries the provider join key per rail: card →
 * checkoutUrl + checkoutSessionId (Stripe session id); x402 →
 * checkoutId + challenge (the 402 challenge the payer's
 * wallet/agent completes — no URL exists for crypto). The confirm
 * response carries the credited account and the pack balance, so
 * the panel shows the new balance from the fresh server read.
 */
export interface PackCheckoutView {
  packRequestId: string;
  rail: "card" | "x402";
  runs: number;
  priceUSD: number;
  checkoutUrl?: string | null;
  checkoutSessionId?: string | null;
  checkoutId?: string | null;
  challenge?: TopUpChallenge | null;
}

export interface PackConfirmView {
  account: CommercialAccountView;
  packRequestId: string;
  creditedRuns: number;
  rail: "card" | "x402";
  packRunsRemaining: number;
  code: string;
  message: string;
}

export const packCheckout = (body: {
  versionId: string;
  rail?: "card" | "x402";
  email: string;
  /**
   * Issue #3246: audit-only offer context, present only when the
   * pack was bought from an upgrade offer (same contract as the
   * subscription checkout's offerContext).
   */
  offerContext?: OfferContext;
}): Promise<PackCheckoutView> => post<PackCheckoutView>("/runs-packs/checkout", body);
export const packConfirm = (body: {
  packRequestId: string;
  checkoutSessionId?: string;
  paymentProof?: string;
  payer?: string;
}): Promise<PackConfirmView> => post<PackConfirmView>("/runs-packs/confirm", body);

/**
 * Issue #3246 — upgrade-offer payload views (slice 1 server shape,
 * design §2.4). The client renders the payload verbatim: every
 * number shown comes from here, never from client state, query
 * params, or storage. These are client-declared views of the
 * server's OfferPayload (src/services/upgradeOffers.ts), following
 * the PlanView precedent — the client never imports server code.
 */
export type OfferTrigger =
  | "manual_402"
  | "skip_notice"
  | "trial_end"
  | "quota_exhausted"
  | "ambient";

export const OFFER_TRIGGERS: readonly OfferTrigger[] = [
  "manual_402",
  "skip_notice",
  "trial_end",
  "quota_exhausted",
  "ambient",
];

export function isOfferTrigger(value: unknown): value is OfferTrigger {
  return typeof value === "string" && (OFFER_TRIGGERS as readonly string[]).includes(value);
}

/** Audit-only context a mint route accepts with an offer-started purchase (§4.3). */
export interface OfferContext {
  trigger: OfferTrigger;
  shownAtMs?: number;
}

export interface OfferTargetView {
  productId: string;
  name: string;
  versionId: string;
  priceUSD: number;
  approvalStatus: "approved" | "proposed";
  buyable: boolean;
  unavailableReason?: "proposed" | "billing_managed";
  billingPeriod: "monthly" | "annual";
  includedRuns: number;
  periodDays: number;
  trialDays: number | null;
  features: string[];
  effectiveFromMs: number;
  annualOption?: {
    versionId: string;
    priceUSD: number;
    savingsVsMonthlyUSD: number;
  };
  recommended: boolean;
}

/** Slice 3: one runs-pack offer row. Always empty until slice 3 lands. */
export interface RunsPackOfferView {
  productId: string;
  name: string;
  versionId: string;
  runs: number;
  priceUSD: number;
  effectiveFromMs: number;
}

export interface ReferralMentionView {
  redeemableUSD: number;
  totalEarnedUSD: number;
  earnAmountUSD: number;
  vestingDelayMs: number;
  attributedReferrer: string | null;
}

export interface FreeAccessMentionView {
  kind: "lifetime" | "limited";
  expiresAtMs: number | null;
}

export interface OfferPayloadView {
  trigger: OfferTrigger;
  eligible: boolean;
  reasonCode?: string;
  family?: ScreenerFamily;
  current: {
    effectiveTier: string;
    heldPlan: {
      planId: string;
      productId: string;
      name: string;
      heldPriceUSD: number;
      /** Slice 3 (§3.4): the held product's current effective price; null when none resolves. */
      currentPriceUSD: number | null;
      billingPeriod: "monthly" | "annual";
      includedRuns: number;
      periodEndMs: number;
      billingManaged: boolean;
    } | null;
    includedRunsRemaining: number;
    packRunsRemaining: number;
    creditsUSD: number;
    freeRunsRemaining?: number | null;
    segment: string;
  };
  targets: OfferTargetView[];
  downgradeTargets: OfferTargetView[];
  unavailableTargets: OfferTargetView[];
  runsPacks: RunsPackOfferView[];
  mentions: {
    referral: ReferralMentionView | null;
    freeAccess: FreeAccessMentionView | null;
  };
  perRun: {
    family: ScreenerFamily;
    priceUSD: number;
    productId: string;
    versionId: string;
  } | null;
  topUp: { minUSD: number; maxUSD: number } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOfferTargetView(value: unknown): value is OfferTargetView {
  if (!isRecord(value)) return false;
  return (
    typeof value.productId === "string" &&
    typeof value.name === "string" &&
    typeof value.versionId === "string" &&
    typeof value.priceUSD === "number" &&
    (value.approvalStatus === "approved" || value.approvalStatus === "proposed") &&
    typeof value.buyable === "boolean" &&
    (value.billingPeriod === "monthly" || value.billingPeriod === "annual") &&
    typeof value.includedRuns === "number" &&
    typeof value.periodDays === "number" &&
    (value.trialDays === null || typeof value.trialDays === "number") &&
    Array.isArray(value.features) &&
    typeof value.effectiveFromMs === "number" &&
    typeof value.recommended === "boolean"
  );
}

function isRunsPackOfferView(value: unknown): value is RunsPackOfferView {
  if (!isRecord(value)) return false;
  return (
    typeof value.productId === "string" &&
    typeof value.name === "string" &&
    typeof value.versionId === "string" &&
    typeof value.runs === "number" &&
    typeof value.priceUSD === "number" &&
    typeof value.effectiveFromMs === "number"
  );
}

/**
 * Structural guard for an offer payload: the offer surfaces render
 * the fixed fallback copy on ANY malformed payload (never a blank
 * section, never a crash on a half-shaped body). The check is
 * structural only — it never invents or repairs a value.
 */
export function isOfferPayloadView(value: unknown): value is OfferPayloadView {
  if (!isRecord(value)) return false;
  if (!isOfferTrigger(value.trigger) || typeof value.eligible !== "boolean") return false;
  if (!isRecord(value.current)) return false;
  const current = value.current;
  if (
    typeof current.effectiveTier !== "string" ||
    typeof current.includedRunsRemaining !== "number" ||
    typeof current.packRunsRemaining !== "number" ||
    typeof current.creditsUSD !== "number" ||
    typeof current.segment !== "string"
  ) {
    return false;
  }
  if (current.heldPlan !== null) {
    if (!isRecord(current.heldPlan)) return false;
    const held = current.heldPlan;
    if (
      typeof held.planId !== "string" ||
      typeof held.productId !== "string" ||
      typeof held.name !== "string" ||
      typeof held.heldPriceUSD !== "number" ||
      (held.currentPriceUSD !== null && typeof held.currentPriceUSD !== "number") ||
      (held.billingPeriod !== "monthly" && held.billingPeriod !== "annual") ||
      typeof held.includedRuns !== "number" ||
      typeof held.periodEndMs !== "number" ||
      typeof held.billingManaged !== "boolean"
    ) {
      return false;
    }
  }
  if (
    !Array.isArray(value.targets) ||
    !value.targets.every(isOfferTargetView) ||
    !Array.isArray(value.downgradeTargets) ||
    !value.downgradeTargets.every(isOfferTargetView) ||
    !Array.isArray(value.unavailableTargets) ||
    !value.unavailableTargets.every(isOfferTargetView) ||
    !Array.isArray(value.runsPacks) ||
    !value.runsPacks.every(isRunsPackOfferView)
  ) {
    return false;
  }
  if (!isRecord(value.mentions)) return false;
  if (value.perRun !== null && !isRecord(value.perRun)) return false;
  if (value.topUp !== null && !isRecord(value.topUp)) return false;
  return true;
}

/** POST /offer — a triggered offer. Family is required (the route 400s without it). */
export const postOffer = (body: {
  trigger: Exclude<OfferTrigger, "ambient">;
  family: ScreenerFamily;
  runRequestId?: string;
}): Promise<OfferPayloadView> => post<OfferPayloadView>("/offer", body);

/** GET /offer/compare — the ambient compare surface. Family is optional. */
export const getOfferCompare = (family?: ScreenerFamily): Promise<OfferPayloadView> =>
  get<OfferPayloadView>(family ? `/offer/compare?family=${encodeURIComponent(family)}` : "/offer/compare");

/** POST /offer/dismiss — record a dismissal (never for `ambient`; the route 400s it). */
export const postOfferDismiss = (body: {
  trigger: Exclude<OfferTrigger, "ambient">;
  family?: ScreenerFamily;
}): Promise<{ suppressedUntilMs: number }> => post<{ suppressedUntilMs: number }>("/offer/dismiss", body);

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
