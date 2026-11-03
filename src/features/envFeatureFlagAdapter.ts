/**
 * Issue #1815: Environment Variable Adapter for FeatureFlagPort.
 *
 * Implements FeatureFlagPort against environment variables:
 * 1. Bulk JSON map (`env.FEATURE_FLAGS`)
 * 2. Named direct variables (`env.FEATURE_<FLAG>`)
 * 3. Documented legacy variables (e.g. `SOCIAL_POSTING_ENABLED` for `social_publishing`)
 * 4. Screener-first rollout defaults:
 *    - `screener` is strictly default-closed (OFF)
 *    - In configured environments, unconfigured flags default to closed (OFF)
 *    - In bare unit test environments with zero feature variables, baseline routes
 *      do not fail closed prematurely.
 */

import {
  ALL_FEATURE_FLAGS,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  getOptionsProductParentFlag,
  isKnownFeatureFlag,
} from "./featureFlagPorts";

export class EnvFeatureFlagAdapter implements FeatureFlagPort {
  constructor(private readonly env?: Record<string, unknown> | null) {}

  async isEnabled(flag: string, _context?: FeatureEvaluationContext): Promise<boolean> {
    if (!isKnownFeatureFlag(flag)) {
      return false;
    }

    if (!this.env) {
      return false;
    }

    // 1. Bulk JSON env var fallback (`FEATURE_FLAGS='{"screener": true}'`)
    const bulkVar = this.env.FEATURE_FLAGS;
    if (bulkVar) {
      try {
        const parsed = typeof bulkVar === "string" ? JSON.parse(bulkVar) : bulkVar;
        if (
          parsed &&
          typeof parsed === "object" &&
          typeof (parsed as Record<string, unknown>)[flag] === "boolean"
        ) {
          return (parsed as Record<string, boolean>)[flag];
        }
      } catch {
        // Malformed JSON continues to next fallback
      }
    }

    // 2. Named environment variable fallback (`FEATURE_SCREENER="1"`, `FEATURE_VOICE_TRADING="0"`)
    const envKey = `FEATURE_${flag.toUpperCase()}`;
    const directVar = this.env[envKey];
    if (typeof directVar === "string") {
      const trimmed = directVar.trim().toLowerCase();
      if (trimmed === "1" || trimmed === "true" || trimmed === "on") return true;
      if (trimmed === "0" || trimmed === "false" || trimmed === "off") return false;
    } else if (typeof directVar === "boolean") {
      return directVar;
    }

    // 3. Documented legacy fallback
    if (flag === "social_publishing") {
      const legacySocial = this.env.SOCIAL_POSTING_ENABLED;
      if (typeof legacySocial === "string") {
        const trimmed = legacySocial.trim().toLowerCase();
        if (trimmed === "1" || trimmed === "true" || trimmed === "on") return true;
        if (trimmed === "0" || trimmed === "false" || trimmed === "off") return false;
      }
    }

    // Issue #2043: legacy monetization env var, for environments
    // that set it before the Flagship flag existed. Flagship (when
    // the FLAGS binding is present) is the source of truth and never
    // reads this var; this fallback only applies to the env adapter.
    if (flag === "monetization") {
      const legacyMonetization = this.env.MONETIZATION_ENABLED;
      if (typeof legacyMonetization === "string") {
        const trimmed = legacyMonetization.trim().toLowerCase();
        if (trimmed === "1" || trimmed === "true" || trimmed === "on") return true;
        if (trimmed === "0" || trimmed === "false" || trimmed === "off") return false;
      } else if (typeof legacyMonetization === "boolean") {
        return legacyMonetization;
      }
    }

    // Issue #2596: options product flags inherit their parent when
    // neither the bulk map nor a direct variable set them explicitly
    // (both explicit paths returned above). An explicit OFF/ON above
    // therefore always wins; reaching here means "absent", so the
    // parent evaluation — itself subject to its own parent chain —
    // is the value. This runs before the generic configured/bare
    // default below, so a configured environment with the parent ON
    // does not silently disable an absent per-product flag.
    const productParent = getOptionsProductParentFlag(flag);
    if (productParent) {
      return this.isEnabled(productParent, _context);
    }

    // Issue #2043: monetization is ALWAYS default-closed (OFF),
    // like screener. It gates charging: the
    // bare-env default-TRUE below would otherwise silently enable
    // payment in any environment with zero feature configuration.
    // Explicit enablement only: FEATURE_FLAGS bulk JSON,
    // FEATURE_MONETIZATION, or the legacy var above.
    if (flag === "monetization") {
      return false;
    }

    // 4. Screener is ALWAYS default-closed (OFF)
    if (flag === "screener") {
      return false;
    }

    // Issue #2051: goal_workflow defaults OPEN (opt-out). It gates
    // a shipped execution path (staged goal runs + the #1998 gather),
    // not a new rollout — an unconfigured flag resolves ON, and
    // explicit OFF (bulk false or direct "0"/"false"/"off" above)
    // still wins. This reverses #1997's strictly-closed default.
    if (flag === "goal_workflow") {
      return true;
    }

    // Issue #2054: payment_assurance is default-ON (owner direction).
    // (The #2049 always-closed block that sat here is removed: it
    // shadowed this return and made the #2054 default unreachable.)
    // Bulk JSON and the direct var above already returned for an
    // explicit enable or disable, so reaching here means no explicit
    // setting: the page is visible. Rollback is an explicit disable
    // (FEATURE_FLAGS bulk false, or FEATURE_PAYMENT_ASSURANCE=0) +
    // redeploy. This replaces the #2049 always-closed rule.
    if (flag === "payment_assurance") {
      return true;
    }

    // 5. For other registered features:
    // When feature configuration is present in the environment (bulk flags set,
    // or direct FEATURE_<FLAG> configured), non-enabled features default to OFF (closed).
    // In bare unit test environments with zero feature flags, baseline routes do not fail closed.
    const hasFeatureConfig = Boolean(
      bulkVar ||
      directVar !== undefined ||
      this.env.FEATURE_SCREENER !== undefined
    );

    return !hasFeatureConfig;
  }

  async getAllFlags(context?: FeatureEvaluationContext): Promise<Record<FeatureFlag, boolean>> {
    const entries = await Promise.all(
      ALL_FEATURE_FLAGS.map(async (flag) => {
        const enabled = await this.isEnabled(flag, context);
        return [flag, enabled] as const;
      })
    );

    return Object.fromEntries(entries) as Record<FeatureFlag, boolean>;
  }
}
