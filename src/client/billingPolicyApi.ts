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

/**
 * Issue #3246 — GET billing-policy for the offer-rules block
 * (operator-only). Callers MUST NOT render the POST answer as the
 * new state: re-read after every save and render only the fresh read.
 */
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
