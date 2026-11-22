/**
 * Issue #6141 — referral trial-extension client over the existing
 * referral-balance route. The profile panel reads the same GET
 * /referral/balance?userId= the Billing tab already uses — the
 * server extended it with the `extension` block, so there is no
 * second referral-status route. Same session-cookie contract as
 * referralRulesApi: this module NEVER sends an identity header
 * and NEVER reads tier or tenant from a header or localStorage
 * claim; the server resolves the session login and enforces
 * ownership (own balance or operator).
 *
 * Error contract: every failure surfaces as ReferralTrialApiError
 * carrying the HTTP status. Callers map statuses to FIXED
 * caller-facing strings; server error bodies are never rendered.
 */
import { withCsrfInit } from "./apiFetch";

import { COMMERCIAL_API_BASE } from "../data/commercialUrlCatalog";
const BASE = COMMERCIAL_API_BASE;

export interface ReferralTrialExtensionView {
  referredCount: number;
  totalExtensionDays: number;
  appliedDays: number;
  bankedDays: number;
  expiredDays: number;
  trialEndsAtMs: number | null;
}

export interface ReferralTrialView {
  extension: ReferralTrialExtensionView;
  /** The rule values the panel renders: referred trial length + share template. */
  referredTrialDays: number;
  shareMessageTemplate: string;
}

export class ReferralTrialApiError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`referral trial request failed: ${status}`);
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function getReferralTrial(userId: string): Promise<ReferralTrialView> {
  let res: Response;
  try {
    res = await globalThis.fetch(
      `${BASE}/referral/balance?userId=${encodeURIComponent(userId)}`,
      withCsrfInit(undefined),
    );
  } catch {
    throw new ReferralTrialApiError(0);
  }
  if (!res.ok) throw new ReferralTrialApiError(res.status);
  const value = (await res.json().catch(() => ({}))) as unknown;
  if (!isRecord(value)) throw new ReferralTrialApiError(500);
  const extension = value.extension;
  const rules = value.rules;
  if (!isRecord(extension) || !isRecord(rules)) throw new ReferralTrialApiError(500);
  if (
    typeof extension.referredCount !== "number" ||
    typeof extension.totalExtensionDays !== "number" ||
    typeof extension.appliedDays !== "number" ||
    typeof extension.bankedDays !== "number" ||
    typeof extension.expiredDays !== "number" ||
    !(extension.trialEndsAtMs === null || typeof extension.trialEndsAtMs === "number") ||
    typeof rules.referredTrialDays !== "number" ||
    typeof rules.shareMessageTemplate !== "string"
  ) {
    throw new ReferralTrialApiError(500);
  }
  return {
    extension: {
      referredCount: extension.referredCount,
      totalExtensionDays: extension.totalExtensionDays,
      appliedDays: extension.appliedDays,
      bankedDays: extension.bankedDays,
      expiredDays: extension.expiredDays,
      trialEndsAtMs: extension.trialEndsAtMs,
    },
    referredTrialDays: rules.referredTrialDays,
    shareMessageTemplate: rules.shareMessageTemplate,
  };
}
