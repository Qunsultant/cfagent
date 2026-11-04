/**
 * #945 Wiring Phase 2b-part1 — small gating predicates for live call sites.
 *
 * This module is deliberately a LEAF: it imports only
 * iaaaSessionActivity (which imports sessionPolicy) and types, so
 * it can be imported from githubOAuth.ts without creating the
 * cycle that importing providers.ts (or iaaaLogin.ts) there would
 * cause — providers.ts imports githubOAuth.ts, and iaaaLogin.ts
 * imports githubOAuth.ts too.
 *
 * Both predicates encode the same rule: wiring OFF means the
 * legacy behaviour, unconditionally. Every gate is fail-closed
 * when its inputs are missing, and no default tenant is ever
 * invented.
 */

import {
  sessionRequiresStepUpForAction,
  type StepUpAction,
} from "./stepUpActions";
import type { SessionData } from "../types";

/**
 * Logout-audit gate. Returns the tenant to attribute to, or null
 * when nothing must be recorded. Null whenever wiring is off or
 * the tenant id is unset/blank. A caller that gets null records
 * nothing — it must NOT fall back to a default tenant, because
 * that would fabricate attribution.
 *
 * #1760 — the session's internalUserId is deliberately NOT a gate
 * input anymore: the caller distinguishes a wired logout event
 * (internalUserId present) from a logout_audit_skipped event
 * (legacy session, actor "unknown"). Gating the tenant on the
 * internal id was what made the skip silent: with no tenant, the
 * hook could record nothing at all. The tenant here comes from
 * the server-resolved tenant, never from the session, so
 * resolving it for a legacy session fabricates no identity.
 */
export function logoutAuditTenant(input: {
  wiringEnabled: boolean;
  tenantId?: string;
}): string | null {
  if (!input.wiringEnabled) return null;
  const tenant = input.tenantId?.trim();
  return tenant ? tenant : null;
}

/**
 * Wiring-aware step-up gate for one Q4 action (#3102, #945 Q4).
 * Wiring OFF never requires step-up (legacy behavior, same as the
 * pilot predicate below); wiring ON delegates to the action's
 * window in stepUpActions.ts. A session without a fresh authTimeMs
 * (including every legacy session) is stale for every action.
 */
export function requiresStepUpForAction(
  session: SessionData,
  action: StepUpAction,
  wiringEnabled: boolean,
  nowMs: number,
): boolean {
  if (!wiringEnabled) return false;
  return sessionRequiresStepUpForAction(session, action, nowMs);
}

/**
 * Step-up gate for the API-key mint pilot (POST /api/api-keys).
 * Wiring OFF never requires step-up; wiring ON fails closed: a
 * session without a fresh authTimeMs (including every legacy
 * session) must re-authenticate before minting a credential.
 * #3102 (#945 Q4) retimed this predicate from the 15-minute
 * default to the 5-minute integration-credential-management
 * window; the 15-minute default survives only as the fallback
 * for unlisted actions. Listing and revoking keys are NOT gated
 * by this predicate.
 */
export function requiresStepUpForMint(
  session: SessionData,
  wiringEnabled: boolean,
  nowMs: number,
): boolean {
  if (!wiringEnabled) return false;
  return sessionRequiresStepUpForAction(
    session,
    "integration-credential-management",
    nowMs,
  );
}
