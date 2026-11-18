/**
 * Issue #5055 (AG-1) — the Stock Copilot agentic cycle's learning
 * read-back policy.
 *
 * The cycle distils a learning every run into `stock_copilot_learnings`
 * (DO SQLite, retention 50). This module turns those prior learnings
 * into a plan input, with the rules stated once, here:
 *
 *  - `risk` learnings at/above `riskBlockAt` in the window block NEW
 *    entries. Exits always execute: a risk lesson must never trap an
 *    open position behind a halted entry path.
 *  - `session` learnings at/above `sessionLimitAt` in the window force
 *    limit-only order shaping for new entries, including the regular
 *    session where the default shape is a market order.
 *  - `refusal` and `execution`/`pattern` learnings are counted and
 *    reported, but do not change a plan: a refusal learning records why
 *    a cycle declined (it names no strategy), so there is nothing
 *    actionable to apply from it yet.
 *
 * Every threshold is externalized (AOP, `AGENTS.md`): exported defaults
 * below, each overridable through the env names in
 * `COPILOT_LEARNING_POLICY_ENV`, plus a kill switch so an operator can
 * disable read-back without a deploy.
 *
 * An unreadable memory port is treated as "no policy" (fail open), not
 * as a risk signal: a storage blip must not halt trading. The caller
 * records the read failure as a cycle error.
 */
import {
  COPILOT_LEARNINGS_RETENTION,
  type CopilotLearningRecord,
} from "../data/stockCopilotStorePorts";

/** Issue #5055: an env-driven policy needs an env-shaped input. */
export interface CopilotLearningPolicyEnv {
  COPILOT_LEARNING_READBACK_ENABLED?: string;
  COPILOT_LEARNING_POLICY_WINDOW?: string;
  COPILOT_LEARNING_RISK_BLOCK_AT?: string;
  COPILOT_LEARNING_SESSION_LIMIT_AT?: string;
}

export interface CopilotLearningPolicyThresholds {
  /** Kill switch: false makes the cycle ignore prior learnings entirely. */
  enabled: boolean;
  /** How many of the newest learnings the policy considers. */
  window: number;
  /** Risk-category learnings in the window that block new entries. */
  riskBlockAt: number;
  /** Session-category learnings in the window that force limit-only. */
  sessionLimitAt: number;
}

/** The single place the policy's defaults are stated. */
export const COPILOT_LEARNING_POLICY_DEFAULTS: CopilotLearningPolicyThresholds = {
  enabled: true,
  window: COPILOT_LEARNINGS_RETENTION,
  riskBlockAt: 2,
  sessionLimitAt: 2,
};

/** Env names that override each default (documented in .dev.vars.example). */
export const COPILOT_LEARNING_POLICY_ENV = {
  enabled: "COPILOT_LEARNING_READBACK_ENABLED",
  window: "COPILOT_LEARNING_POLICY_WINDOW",
  riskBlockAt: "COPILOT_LEARNING_RISK_BLOCK_AT",
  sessionLimitAt: "COPILOT_LEARNING_SESSION_LIMIT_AT",
} as const;

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function resolveBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

/**
 * Resolve the thresholds from the deployment env (AOP): a valid value
 * wins, anything else (absent, non-numeric, zero, negative, not a
 * boolean) falls back to the exported default. Call sites never carry a
 * literal.
 */
export function resolveCopilotLearningPolicyThresholds(
  env: CopilotLearningPolicyEnv | undefined | null,
): CopilotLearningPolicyThresholds {
  return {
    enabled: resolveBoolean(
      env?.[COPILOT_LEARNING_POLICY_ENV.enabled],
      COPILOT_LEARNING_POLICY_DEFAULTS.enabled,
    ),
    window: resolvePositiveInt(
      env?.[COPILOT_LEARNING_POLICY_ENV.window],
      COPILOT_LEARNING_POLICY_DEFAULTS.window,
    ),
    riskBlockAt: resolvePositiveInt(
      env?.[COPILOT_LEARNING_POLICY_ENV.riskBlockAt],
      COPILOT_LEARNING_POLICY_DEFAULTS.riskBlockAt,
    ),
    sessionLimitAt: resolvePositiveInt(
      env?.[COPILOT_LEARNING_POLICY_ENV.sessionLimitAt],
      COPILOT_LEARNING_POLICY_DEFAULTS.sessionLimitAt,
    ),
  };
}

/** What prior learnings tell this cycle's plan to do. */
export interface CopilotLearningsPolicy {
  enabled: boolean;
  /** Learnings read into this decision. */
  considered: number;
  riskCount: number;
  sessionCount: number;
  refusalCount: number;
  /** True when new entries are held back this cycle. */
  blockEntries: boolean;
  /** True when new entries must be shaped LIMIT regardless of session. */
  requireLimitOrders: boolean;
  /** One line stating why the plan changed (or did not). */
  reason: string;
}

/** The policy a cycle uses when it has read nothing (fresh tenant, kill switch, read failure). */
export function neutralCopilotLearningPolicy(
  enabled: boolean,
): CopilotLearningsPolicy {
  return {
    enabled,
    considered: 0,
    riskCount: 0,
    sessionCount: 0,
    refusalCount: 0,
    blockEntries: false,
    requireLimitOrders: false,
    reason: enabled
      ? "No prior learnings available; plan unchanged."
      : "Learning read-back disabled by operator; plan unchanged.",
  };
}

/**
 * Derive the plan policy from the newest learnings. Pure: the caller
 * owns the read, this owns the rule.
 */
export function deriveCopilotLearningPolicy(
  learnings: readonly CopilotLearningRecord[],
  thresholds: CopilotLearningPolicyThresholds,
): CopilotLearningsPolicy {
  const considered = thresholds.window > 0 ? learnings.slice(0, thresholds.window) : [];
  let riskCount = 0;
  let sessionCount = 0;
  let refusalCount = 0;
  for (const learning of considered) {
    if (learning.category === "risk") riskCount += 1;
    else if (learning.category === "session") sessionCount += 1;
    else if (learning.category === "refusal") refusalCount += 1;
  }

  const blockEntries = riskCount >= thresholds.riskBlockAt;
  const requireLimitOrders = sessionCount >= thresholds.sessionLimitAt;

  let reason: string;
  if (blockEntries) {
    reason = `${riskCount} risk learning(s) in the last ${considered.length}: new entries blocked until the risk lesson ages out.`;
  } else if (requireLimitOrders) {
    reason = `${sessionCount} session learning(s) in the last ${considered.length}: new entries shaped limit-only.`;
  } else {
    reason = `${considered.length} prior learning(s) read; no threshold reached.`;
  }

  return {
    enabled: true,
    considered: considered.length,
    riskCount,
    sessionCount,
    refusalCount,
    blockEntries,
    requireLimitOrders,
    reason,
  };
}
