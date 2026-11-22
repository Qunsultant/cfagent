/**
 * Issue #5229 (monetization Phase 2.31, program #2405) — referral
 * credit rules client over the referral-rules route.
 *
 * GET /referral/rules (any verified login) reads the operator-owned
 * rule row; POST /referral/rules (operator-only server-side) replaces
 * it. The browser calls /api/... with the session cookie; the worker
 * injects x-user-login from the session. This module NEVER sends an
 * identity header and NEVER reads tier or tenant from a header or
 * localStorage claim — identity is the session, and the server is
 * the authority on the rules and on whether the viewer is a store
 * operator. The UI is never the access control, only the affordance.
 *
 * Error contract: every failure surfaces as ReferralRulesApiError
 * carrying the HTTP status. Callers map statuses to FIXED
 * caller-facing strings; server error bodies are never rendered.
 */
import { withCsrfInit } from "./apiFetch";

import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";
const BASE = COMMERCIAL_API_BASE;

export interface ReferralRulesView {
  earnAmountUSD: number;
  vestingDelayMs: number;
  redemptionScope: string;
  expiryPeriodMs: number;
  /** Issue #6141: trial days earned per referred first verified paid run. */
  extensionDays: number;
  /** Issue #6141: trial days granted to a referred user on signup via the link. */
  referredTrialDays: number;
  /** Issue #6141: max trial-extension grants per referrer per UTC day. */
  maxExtensionsPerDay: number;
  /** Issue #6141: max trial-extension grants per referrer per UTC calendar month. */
  maxExtensionsPerMonth: number;
  /** Issue #6141: plan whose trial the referred grant activates; null = disabled. */
  referralTrialPlanId: string | null;
  /** Issue #6141: share-message template; must contain {link}. */
  shareMessageTemplate: string;
}

export interface ReferralRulesResponse {
  code: string;
  rules: ReferralRulesView;
}

export class ReferralRulesApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`referral rules request failed: ${status}`);
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
    throw new ReferralRulesApiError(0);
  }
  if (!res.ok) throw new ReferralRulesApiError(res.status);
  return (await res.json().catch(() => ({}))) as unknown;
}

function assertRules(value: unknown): ReferralRulesView {
  if (!isRecord(value)) throw new ReferralRulesApiError(500);
  const rules = value.rules;
  if (!isRecord(rules)) throw new ReferralRulesApiError(500);
  if (
    typeof rules.earnAmountUSD !== "number" ||
    typeof rules.vestingDelayMs !== "number" ||
    typeof rules.redemptionScope !== "string" ||
    typeof rules.expiryPeriodMs !== "number" ||
    typeof rules.extensionDays !== "number" ||
    typeof rules.referredTrialDays !== "number" ||
    typeof rules.maxExtensionsPerDay !== "number" ||
    typeof rules.maxExtensionsPerMonth !== "number" ||
    !(rules.referralTrialPlanId === null || typeof rules.referralTrialPlanId === "string") ||
    typeof rules.shareMessageTemplate !== "string"
  ) {
    throw new ReferralRulesApiError(500);
  }
  return {
    earnAmountUSD: rules.earnAmountUSD,
    vestingDelayMs: rules.vestingDelayMs,
    redemptionScope: rules.redemptionScope,
    expiryPeriodMs: rules.expiryPeriodMs,
    extensionDays: rules.extensionDays,
    referredTrialDays: rules.referredTrialDays,
    maxExtensionsPerDay: rules.maxExtensionsPerDay,
    maxExtensionsPerMonth: rules.maxExtensionsPerMonth,
    referralTrialPlanId: rules.referralTrialPlanId,
    shareMessageTemplate: rules.shareMessageTemplate,
  };
}

export async function getReferralRules(): Promise<ReferralRulesView> {
  return assertRules(await callJson(`${BASE}/referral/rules`));
}

export async function setReferralRules(input: ReferralRulesView): Promise<ReferralRulesView> {
  return assertRules(
    await callJson(`${BASE}/referral/rules`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}
