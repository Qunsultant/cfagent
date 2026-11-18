/**
 * Issue #5061 (AG-7) — the monthly Autopilot evaluation's verdicts get a
 * consumer.
 *
 * `runAutopilotMonthlyEvaluation` records a verdict each month (id, passed,
 * binding rule, descriptor) and nothing read them back: a repeatedly failing
 * policy check produced one record a month and nothing else. The control
 * centre's GET /autopilot already reads the recent verdicts for display; this
 * module turns that read into an aggregate, so a binding rule that keeps
 * blocking is named to the operator instead of buried in a list.
 *
 * The rule is arithmetic and stated here:
 *  - the trend window is the newest `AUTOPILOT_VERDICT_TREND_WINDOW`
 *    verdicts (default 25, matching the route's read);
 *  - a binding rule seen at/above `AUTOPILOT_VERDICT_REPEAT_THRESHOLD`
 *    times in that window (default 2) is a repeat, and the aggregate is
 *    escalated;
 *  - `AUTOPILOT_VERDICT_TREND_ENABLED=false` is the kill switch.
 *
 * The aggregate is evidence for the operator, never an automatic policy
 * change: the envelope is edited by a human, and the notice says so.
 */
import type { Env } from "../types";

export interface AutopilotVerdictTrendPolicy {
  enabled: boolean;
  window: number;
  repeatThreshold: number;
}

export const AUTOPILOT_VERDICT_TREND_DEFAULTS: AutopilotVerdictTrendPolicy = {
  enabled: true,
  window: 25,
  repeatThreshold: 2,
};

export const AUTOPILOT_VERDICT_TREND_ENV = {
  enabled: "AUTOPILOT_VERDICT_TREND_ENABLED",
  window: "AUTOPILOT_VERDICT_TREND_WINDOW",
  repeatThreshold: "AUTOPILOT_VERDICT_REPEAT_THRESHOLD",
} as const;

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function resolveBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

export function resolveAutopilotVerdictTrendPolicy(
  env: Env | undefined | null,
): AutopilotVerdictTrendPolicy {
  return {
    enabled: resolveBool(
      env?.[AUTOPILOT_VERDICT_TREND_ENV.enabled],
      AUTOPILOT_VERDICT_TREND_DEFAULTS.enabled,
    ),
    window: resolvePositiveInt(
      env?.[AUTOPILOT_VERDICT_TREND_ENV.window],
      AUTOPILOT_VERDICT_TREND_DEFAULTS.window,
    ),
    repeatThreshold: resolvePositiveInt(
      env?.[AUTOPILOT_VERDICT_TREND_ENV.repeatThreshold],
      AUTOPILOT_VERDICT_TREND_DEFAULTS.repeatThreshold,
    ),
  };
}

/** The columns the aggregate reads (a subset of the verdict projection). */
export interface AutopilotVerdictLike {
  passed: number;
  binding_rule: string | null;
  created_at: string;
}

export interface AutopilotVerdictTrend {
  enabled: boolean;
  /** Verdicts considered in the window. */
  evaluations: number;
  blocked: number;
  passed: number;
  /** Binding rules at/above the repeat threshold, most frequent first. */
  repeatedBindingRules: Array<{ rule: string; count: number }>;
  /** True when at least one rule repeats. */
  escalated: boolean;
  /** One line for the operator; null when nothing needs saying. */
  notice: string | null;
}

/**
 * Aggregate the recent verdicts. Pure: the caller owns the read. Verdicts
 * arrive newest-first from the port; the window is the newest N.
 */
export function summarizeAutopilotVerdictTrend(
  verdicts: readonly AutopilotVerdictLike[],
  policy: AutopilotVerdictTrendPolicy,
): AutopilotVerdictTrend {
  if (!policy.enabled) {
    return {
      enabled: false,
      evaluations: 0,
      blocked: 0,
      passed: 0,
      repeatedBindingRules: [],
      escalated: false,
      notice: null,
    };
  }

  const window = verdicts.slice(0, policy.window);
  const counts = new Map<string, number>();
  let blocked = 0;
  let passed = 0;
  for (const verdict of window) {
    if (verdict.passed === 1) {
      passed += 1;
      continue;
    }
    blocked += 1;
    const rule = (verdict.binding_rule ?? "").trim();
    if (rule.length === 0) continue;
    counts.set(rule, (counts.get(rule) ?? 0) + 1);
  }

  const repeatedBindingRules = [...counts.entries()]
    .filter(([, count]) => count >= policy.repeatThreshold)
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));

  const escalated = repeatedBindingRules.length > 0;
  const notice = escalated
    ? `Autopilot policy checks blocked ${blocked} of the last ${window.length} time(s); ` +
      `repeated binding rule(s): ${repeatedBindingRules
        .map((r) => `${r.rule} ×${r.count}`)
        .join(", ")}. ` +
      "The envelope is changed by a human — this is evidence, not an automatic adjustment."
    : null;

  return {
    enabled: true,
    evaluations: window.length,
    blocked,
    passed,
    repeatedBindingRules,
    escalated,
    notice,
  };
}
