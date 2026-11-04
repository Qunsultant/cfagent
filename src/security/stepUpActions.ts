/**
 * Issue #3102 (#945 Q4) — step-up thresholds and freshness windows per
 * action, plus the legacy-session rule. Pure policy; no wiring.
 *
 * The epic §4 action list, each with its own freshness window in
 * milliseconds. Higher blast radius / irreversibility gets a tighter
 * window; the settled 15-minute default (#1757) survives only as the
 * fallback for an unlisted action — fail closed, never no-gate.
 *
 * Windows (Q4 answer, CISO):
 * - 5 minutes: privileged-role-assignment (grants persist and can
 *   create platform admins), integration-credential-management
 *   (minted credentials outlive the session), auth-method-change
 *   (account-takeover vector), provider-linking (binds a new login
 *   path to the account), payment-configuration-change
 *   (money-adjacent configuration).
 * - 10 minutes: sensitive-export (read-only exfiltration, bounded
 *   blast radius).
 * - 15 minutes: fallback for any action not listed above.
 *
 * Legacy-session rule (settled, per assurance review §1.2): a
 * session without authTimeMs (every legacy session) is STALE for
 * all six actions — fail closed, re-authenticate and retry. Legacy
 * sessions continue for low-sensitivity reads; no gate is placed
 * on reads. Rotation does not refresh authTimeMs (rotation is not
 * re-authentication, per rotateSession in sessionPolicy.ts).
 *
 * Freshness here is exact arithmetic on authTimeMs. The ±60s
 * tolerance belongs to idle enforcement (lastActivityMs, touched
 * at most once per 60s) and is stated alongside these windows,
 * never folded into them.
 *
 * No step-up-enforced action in code falls outside the six: the
 * api-keys mint pilot is integration-credential management and
 * role:assign is privileged role assignment, so this table adds
 * nothing beyond the epic list. The frozen #1751 OBLIGATION_POLICY
 * is NOT edited by this module: route gates using these windows
 * are tighter than (or equal to) the obligation default, so the
 * tighter window governs.
 */
import { sessionRequiresStepUp } from "./iaaaSessionActivity";
import { DEFAULT_STEP_UP_FRESHNESS_MS } from "./sessionPolicy";
import type { SessionData } from "../types";

/** The epic §4 step-up actions, exactly as named in the Q4 answer. */
export type StepUpAction =
  | "privileged-role-assignment"
  | "integration-credential-management"
  | "auth-method-change"
  | "provider-linking"
  | "payment-configuration-change"
  | "sensitive-export";

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TEN_MINUTES_MS = 10 * 60 * 1000;

/** Per-action freshness windows (ms). Frozen: the Q4 answer. */
export const STEP_UP_ACTION_WINDOWS: Readonly<Record<StepUpAction, number>> =
  Object.freeze({
    "privileged-role-assignment": FIVE_MINUTES_MS,
    "integration-credential-management": FIVE_MINUTES_MS,
    "auth-method-change": FIVE_MINUTES_MS,
    "provider-linking": FIVE_MINUTES_MS,
    "payment-configuration-change": FIVE_MINUTES_MS,
    "sensitive-export": TEN_MINUTES_MS,
  });

/**
 * The freshness window for an action. An unlisted action falls back
 * to the settled 15-minute default — never to no-gate, never to an
 * unbounded window.
 */
export function stepUpWindowForAction(action: StepUpAction): number {
  const window = STEP_UP_ACTION_WINDOWS[action];
  return typeof window === "number" && Number.isFinite(window) && window > 0
    ? window
    : DEFAULT_STEP_UP_FRESHNESS_MS;
}

/**
 * True when the action requires fresh authentication for this
 * session: delegates to the real sessionRequiresStepUp rule with
 * the action's window. A missing, invalid, or future authTimeMs
 * is stale (fail closed) — including every legacy session.
 */
export function sessionRequiresStepUpForAction(
  session: SessionData,
  action: StepUpAction,
  nowMs: number,
): boolean {
  return sessionRequiresStepUp(session, nowMs, stepUpWindowForAction(action));
}
