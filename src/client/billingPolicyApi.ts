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
 * carrying the HTTP status and the server's outcome code when the
 * failure body carries one. Callers render the catalog message for
 * a resolving code and fall back to FIXED caller-facing strings
 * keyed by status otherwise; server error bodies are never rendered.
 * GET/POST billing-policy are operator-only server-side (the UI is
 * never the access control, only the affordance). The top-up limits
 * themselves are also served to any verified login on the pricing
 * route (topUpLimits) — the limits section reads values there for
 * non-operators and uses this module for operator reads + edits.
 */
import { withCsrfInit } from "./apiFetch";

import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";
const BASE = COMMERCIAL_API_BASE;

export interface TopUpLimitsView {
  topUpMinUSD: number;
  topUpMaxUSD: number;
}

/**
 * Issue #3246 — the offer-rules block view (design §4.2), one
 * JSON-valued billing-policy key (`offer_rules`). The whole block
 * is replaced on update, the same wholesale discipline as
 * `stripePriceByPlan`. Rank is NOT a rule — it lives on the
 * product row and is edited in the Products section.
 */
export interface OfferRulesView {
  enabled: boolean;
  triggersEnabled: {
    manual402: boolean;
    skipNotice: boolean;
    trialEnd: boolean;
    quotaExhausted: boolean;
    ambient: boolean;
  };
  dismissCooldownDays: number;
  showProposed: boolean;
  downgradesEnabled: boolean;
  runsPacksEnabled: boolean;
  mentionsEnabled: {
    referral: boolean;
    freeAccess: boolean;
  };
}

export interface BillingPolicyResponse {
  limits: TopUpLimitsView;
  seedNote: string;
}

export interface OfferRulesResponse {
  offerRules: OfferRulesView;
  seedNote: string;
}

export class BillingPolicyApiError extends Error {
  readonly status: number;
  /** Issue #3571 (residual): the server's outcome code when the failure body carries one. */
  readonly code?: string;
  constructor(status: number, code?: string) {
    super(`billing policy request failed: ${status}`);
    this.status = status;
    this.code = code;
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
  if (!res.ok) {
    // Issue #3571 (residual): propagate the server's outcome code so
    // callers render the catalog message; a body without a code keeps
    // the caller's fixed per-status fallback.
    const body = (await res.json().catch(() => ({}))) as unknown;
    const code = isRecord(body) && typeof body.code === "string" ? body.code : undefined;
    throw new BillingPolicyApiError(res.status, code);
  }
  return (await res.json().catch(() => ({}))) as unknown;
}

function assertLimits(value: unknown): TopUpLimitsView {
  if (!isRecord(value)) throw new BillingPolicyApiError(500);
  if (typeof value.topUpMinUSD !== "number" || typeof value.topUpMaxUSD !== "number") {
    throw new BillingPolicyApiError(500);
  }
  return { topUpMinUSD: value.topUpMinUSD, topUpMaxUSD: value.topUpMaxUSD };
}

function isBooleanRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, boolean> {
  if (!isRecord(value)) return false;
  return keys.every((key) => typeof value[key] === "boolean");
}

/** Validate the offer-rules block shape from a policy read (the server assert is authoritative; this only guards the render against a half-shaped body). */
export function assertOfferRulesView(value: unknown): OfferRulesView {
  if (!isRecord(value)) throw new BillingPolicyApiError(500);
  if (
    typeof value.enabled !== "boolean" ||
    !isBooleanRecord(value.triggersEnabled, [
      "manual402",
      "skipNotice",
      "trialEnd",
      "quotaExhausted",
      "ambient",
    ]) ||
    typeof value.dismissCooldownDays !== "number" ||
    typeof value.showProposed !== "boolean" ||
    typeof value.downgradesEnabled !== "boolean" ||
    typeof value.runsPacksEnabled !== "boolean" ||
    !isBooleanRecord(value.mentionsEnabled, ["referral", "freeAccess"])
  ) {
    throw new BillingPolicyApiError(500);
  }
  return {
    enabled: value.enabled,
    triggersEnabled: {
      manual402: value.triggersEnabled.manual402,
      skipNotice: value.triggersEnabled.skipNotice,
      trialEnd: value.triggersEnabled.trialEnd,
      quotaExhausted: value.triggersEnabled.quotaExhausted,
      ambient: value.triggersEnabled.ambient,
    },
    dismissCooldownDays: value.dismissCooldownDays,
    showProposed: value.showProposed,
    downgradesEnabled: value.downgradesEnabled,
    runsPacksEnabled: value.runsPacksEnabled,
    mentionsEnabled: {
      referral: value.mentionsEnabled.referral,
      freeAccess: value.mentionsEnabled.freeAccess,
    },
  };
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

export interface StripePriceByPlanResponse {
  stripePriceByPlan: Record<string, string>;
  seedNote: string;
}

/** Validate the stripePriceByPlan block shape from a policy read (the
 *  server assert is authoritative; this only guards the render against
 *  a half-shaped body). Mirrors the server's assertStripePriceByPlan:
 *  an object mapping plan id to a non-empty Stripe Price id. */
export function assertStripePriceByPlanView(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BillingPolicyApiError(500);
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v !== "string" || !v.trim()) throw new BillingPolicyApiError(500);
    out[k] = v;
  }
  return out;
}

/**
 * Issue #4511 — GET billing-policy for the stripePriceByPlan block
 * (operator-only). Callers MUST NOT render the POST answer as the
 * new state: re-read after every save and render only the fresh read.
 */
export async function getStripePriceByPlan(): Promise<StripePriceByPlanResponse> {
  const data = await callJson(`${BASE}/billing-policy`);
  if (!isRecord(data) || !isRecord(data.policy)) throw new BillingPolicyApiError(500);
  return {
    stripePriceByPlan: assertStripePriceByPlanView(data.policy.stripePriceByPlan),
    seedNote: typeof data.seedNote === "string" ? data.seedNote : "",
  };
}

/**
 * Issue #4511 — POST billing-policy with the whole stripePriceByPlan
 * block (operator-only, audited server-side). The whole block is
 * replaced on update, the same wholesale discipline as offerRules.
 * Returns the mapping from the POST answer, which callers MUST NOT
 * render as the new state: the section re-reads the policy after
 * every save.
 */
export async function setStripePriceByPlan(
  mapping: Record<string, string>,
): Promise<Record<string, string>> {
  const data = await callJson(`${BASE}/billing-policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stripePriceByPlan: mapping }),
  });
  if (!isRecord(data) || !isRecord(data.policy)) throw new BillingPolicyApiError(500);
  return assertStripePriceByPlanView(data.policy.stripePriceByPlan);
}
export async function getOfferRules(): Promise<OfferRulesResponse> {
  const data = await callJson(`${BASE}/billing-policy`);
  if (!isRecord(data) || !isRecord(data.policy)) throw new BillingPolicyApiError(500);
  return {
    offerRules: assertOfferRulesView(data.policy.offerRules),
    seedNote: typeof data.seedNote === "string" ? data.seedNote : "",
  };
}

/**
 * Issue #3246 — POST billing-policy with the whole offer-rules
 * block (operator-only, audited server-side). Returns the rules
 * from the POST answer, which callers MUST NOT render as the new
 * state: the section re-reads the policy after every save.
 */
export async function setOfferRules(rules: OfferRulesView): Promise<OfferRulesView> {
  const data = await callJson(`${BASE}/billing-policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offerRules: rules }),
  });
  if (!isRecord(data) || !isRecord(data.policy)) throw new BillingPolicyApiError(500);
  return assertOfferRulesView(data.policy.offerRules);
}

/**
 * Issue #5230 — the remaining billing-policy fields view: the nine
 * operator-data fields with no management surface before this slice
 * (grace period, dunning schedule, proration, downgrade timing,
 * billing period default/allowed, annual discount, repurchase
 * migration, cfpay channel fixed price) plus the bundle Stripe Price
 * mapping (same class: operator data, no surface). Top-up limits,
 * offer rules, and the plan Stripe Price mapping already have their
 * own sections and are NOT repeated here.
 */
export type BillingPeriod = "monthly" | "annual";
export type DowngradeTiming = "period_end" | "immediate";
export type ProrationBehavior = "none" | "create_prorations" | "always_invoice";
export type RepurchaseMigration = "grandfather" | "expire" | "migrate";

export interface BillingPolicyFieldsView {
  billingPeriodDefault: BillingPeriod;
  billingPeriodsAllowed: BillingPeriod[];
  dunningRetryDelayDays: number[];
  gracePeriodDays: number;
  downgradeTiming: DowngradeTiming;
  prorationBehavior: ProrationBehavior;
  repurchaseMigration: RepurchaseMigration;
  stripePriceByBundle: Record<string, string>;
  cfpayChannelFixedPriceUSD: number | null;
  annualDiscountPct: number;
}

export interface BillingPolicyFieldsResponse {
  fields: BillingPolicyFieldsView;
  seedNote: string;
}

function isBillingPeriod(value: unknown): value is BillingPeriod {
  return value === "monthly" || value === "annual";
}

/** Validate the billing-policy fields shape from a policy read (the server assert is authoritative; this only guards the render against a half-shaped body). */
export function assertBillingPolicyFieldsView(value: unknown): BillingPolicyFieldsView {
  if (!isRecord(value)) throw new BillingPolicyApiError(500);
  if (
    !isBillingPeriod(value.billingPeriodDefault) ||
    !Array.isArray(value.billingPeriodsAllowed) ||
    !value.billingPeriodsAllowed.every(isBillingPeriod) ||
    !Array.isArray(value.dunningRetryDelayDays) ||
    !value.dunningRetryDelayDays.every((d) => typeof d === "number") ||
    typeof value.gracePeriodDays !== "number" ||
    (value.downgradeTiming !== "period_end" && value.downgradeTiming !== "immediate") ||
    (value.prorationBehavior !== "none" &&
      value.prorationBehavior !== "create_prorations" &&
      value.prorationBehavior !== "always_invoice") ||
    (value.repurchaseMigration !== "grandfather" &&
      value.repurchaseMigration !== "expire" &&
      value.repurchaseMigration !== "migrate") ||
    (value.cfpayChannelFixedPriceUSD !== null &&
      typeof value.cfpayChannelFixedPriceUSD !== "number") ||
    typeof value.annualDiscountPct !== "number"
  ) {
    throw new BillingPolicyApiError(500);
  }
  return {
    billingPeriodDefault: value.billingPeriodDefault,
    billingPeriodsAllowed: [...value.billingPeriodsAllowed],
    dunningRetryDelayDays: [...value.dunningRetryDelayDays],
    gracePeriodDays: value.gracePeriodDays,
    downgradeTiming: value.downgradeTiming,
    prorationBehavior: value.prorationBehavior,
    repurchaseMigration: value.repurchaseMigration,
    stripePriceByBundle: assertStripePriceByPlanView(value.stripePriceByBundle),
    cfpayChannelFixedPriceUSD: value.cfpayChannelFixedPriceUSD,
    annualDiscountPct: value.annualDiscountPct,
  };
}

/**
 * Issue #5230 — GET billing-policy for the remaining fields block
 * (operator-only). Callers MUST NOT render the POST answer as the
 * new state: re-read after every save and render only the fresh read.
 */
export async function getBillingPolicyFields(): Promise<BillingPolicyFieldsResponse> {
  const data = await callJson(`${BASE}/billing-policy`);
  if (!isRecord(data) || !isRecord(data.policy)) throw new BillingPolicyApiError(500);
  return {
    fields: assertBillingPolicyFieldsView(data.policy),
    seedNote: typeof data.seedNote === "string" ? data.seedNote : "",
  };
}

/**
 * Issue #5230 — POST billing-policy with a partial update of the
 * remaining fields (operator-only, audited server-side). Returns the
 * fields from the POST answer, which callers MUST NOT render as the
 * new state: the section re-reads the policy after every save.
 */
export async function setBillingPolicyFields(
  partial: Partial<BillingPolicyFieldsView>,
): Promise<BillingPolicyFieldsView> {
  const data = await callJson(`${BASE}/billing-policy`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(partial),
  });
  if (!isRecord(data) || !isRecord(data.policy)) throw new BillingPolicyApiError(500);
  return assertBillingPolicyFieldsView(data.policy);
}
