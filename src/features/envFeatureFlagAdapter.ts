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
  DEFAULT_MONETIZATION_FLAG_VALUE,
  DEFAULT_SCHEDULE_CHAT_FLAG_VALUE,
  DEFAULT_SCHEDULE_NLQ_FLAG_VALUE,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  getFeatureFlagParent,
  isKnownFeatureFlag,
} from "./featureFlagPorts";
import { fileBackedEnvValue } from "../config/environment";
import type { Env } from "../types";

const PRODUCTION_ENV_NAMES = new Set(["production", "prod"]);
const NON_PRODUCTION_ENV_NAMES = new Set(["local", "test", "development", "dev"]);

/**
 * Issue #4613: Returns true when the runtime is production so the Env adapter
 * cannot serve flags outside local/test environments.
 */
export function isProductionFlagRuntime(env?: unknown): boolean {
  if (env && typeof env === "object") {
    const rec = env as Record<string, unknown>;
    const explicitCandidates = [rec.ENVIRONMENT, rec.CF_ENV, rec.NODE_ENV];
    for (const candidate of explicitCandidates) {
      if (typeof candidate !== "string") continue;
      const normalized = candidate.trim().toLowerCase();
      if (PRODUCTION_ENV_NAMES.has(normalized)) return true;
      if (NON_PRODUCTION_ENV_NAMES.has(normalized)) return false;
    }
  }
  const procEnv =
    typeof globalThis !== "undefined" &&
    (globalThis as { process?: { env?: Record<string, unknown> } }).process?.env;
  if (procEnv) {
    const procNodeEnv = typeof procEnv.NODE_ENV === "string" ? procEnv.NODE_ENV.trim().toLowerCase() : "";
    const procAppEnv = typeof procEnv.ENVIRONMENT === "string" ? procEnv.ENVIRONMENT.trim().toLowerCase() : "";
    if (PRODUCTION_ENV_NAMES.has(procNodeEnv) || PRODUCTION_ENV_NAMES.has(procAppEnv)) {
      return true;
    }
  }
  return false;
}

/**
 * Phase 3 (#6550): parses one on/off flag value. An unrecognized
 * string falls through (undefined) — the old adapter never treated
 * one as an explicit setting either.
 */
function parseOnOffFlagValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const trimmed = value.trim().toLowerCase();
    if (trimmed === "1" || trimmed === "true" || trimmed === "on") return true;
    if (trimmed === "0" || trimmed === "false" || trimmed === "off") return false;
  }
  return undefined;
}

export class EnvFeatureFlagAdapter implements FeatureFlagPort {
  constructor(private readonly env?: Record<string, unknown> | null) {}

  /**
   * Phase 3 (#6550): the first EXPLICIT (bulk JSON / direct env var)
   * value on any ancestor of `flag`, nearest ancestor first — or
   * undefined when no ancestor is set explicitly. Used so an
   * ancestor's explicit OFF/ON beats the flag's own FILE value
   * (explicit beats default); a parent with only a file value is
   * not explicit and does not stop the flag's own file value.
   */
  private explicitAncestorValue(flag: string): boolean | undefined {
    let parent = getFeatureFlagParent(flag);
    while (parent) {
      const bulkVar = this.env?.FEATURE_FLAGS;
      if (bulkVar) {
        try {
          const parsed = typeof bulkVar === "string" ? JSON.parse(bulkVar) : bulkVar;
          if (parsed && typeof parsed === "object" && typeof (parsed as Record<string, unknown>)[parent] === "boolean") {
            return (parsed as Record<string, boolean>)[parent];
          }
        } catch {
          // Malformed JSON continues to the direct var.
        }
      }
      const parsedDirect = parseOnOffFlagValue(this.env?.[`FEATURE_${parent.toUpperCase()}`]);
      if (parsedDirect !== undefined) return parsedDirect;
      parent = getFeatureFlagParent(parent);
    }
    return undefined;
  }

  async isEnabled(flag: string, _context?: FeatureEvaluationContext): Promise<boolean> {
    if (isProductionFlagRuntime(this.env)) {
      return false;
    }
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

    // 2. Named direct variable (`FEATURE_SCREENER="1"`,
    // `FEATURE_VOICE_TRADING="0"`) — RAW env only here. Phase 3
    // (#6550): the seven moved FEATURE_* vars now live in
    // environment.config.json (defaults.features); the file value is
    // the default and is consulted below (step 2b), AFTER the legacy
    // env vars (step 3) — an explicitly-set legacy env var beats the
    // file default, exactly as it beat the old code default. Reading
    // the file here would let it shadow the legacy env var.
    const envKey = `FEATURE_${flag.toUpperCase()}`;
    const rawDirectVar = this.env[envKey];
    const parsedDirect = parseOnOffFlagValue(rawDirectVar);
    if (parsedDirect !== undefined) return parsedDirect;

    // 3. Documented legacy fallback — raw env first.
    if (flag === "social_publishing") {
      // Phase 3 (#6550): SOCIAL_POSTING_ENABLED lives in
      // environment.config.json (defaults.social.postingEnabled);
      // a still-set env var wins over the file value below.
      const parsedLegacySocial = parseOnOffFlagValue(this.env.SOCIAL_POSTING_ENABLED);
      if (parsedLegacySocial !== undefined) return parsedLegacySocial;
    }

    // Issue #2043: legacy monetization env var, for environments
    // that set it before the Flagship flag existed. Flagship (when
    // the FLAGS binding is present) is the source of truth and never
    // reads this var; this fallback only applies to the env adapter.
    // Phase 3 (#6550): the raw env var is consulted BEFORE the file
    // value of FEATURE_MONETIZATION — an explicit
    // MONETIZATION_ENABLED="false" still turns monetization off.
    if (flag === "monetization") {
      const parsedLegacyMonetization = parseOnOffFlagValue(this.env.MONETIZATION_ENABLED);
      if (parsedLegacyMonetization !== undefined) return parsedLegacyMonetization;
    }

    // Phase 3 (#6550): an EXPLICIT value on any ancestor beats a
    // FILE value on the flag itself (explicit beats default, at any
    // level). Without this, the file's optionsScreener=true would
    // short-circuit a parent's explicit bulk OFF (options_research:
    // false) and resolve an absent sub-product ON — breaking the
    // #2596 contract "explicit OFF always wins". The walk below
    // checks bulk + direct vars only (no file, no defaults); a
    // parent with only a file value does not stop the flag's own
    // file value below.
    const ancestorExplicit = this.explicitAncestorValue(flag);
    if (ancestorExplicit !== undefined) return ancestorExplicit;

    // 2b. File value for the direct var (the moved FEATURE_* vars).
    // fileBackedEnvValue is env-wins; env was already consulted
    // above, so a defined value here is the file value.
    const parsedFileDirect = parseOnOffFlagValue(
      fileBackedEnvValue(
        this.env as unknown as Partial<Env> | undefined,
        envKey,
      ),
    );
    if (parsedFileDirect !== undefined) return parsedFileDirect;

    // 3b. File value for the legacy vars (SOCIAL_POSTING_ENABLED
    // moved to defaults.social.postingEnabled; MONETIZATION_ENABLED
    // has no file home — it is env-only by design).
    if (flag === "social_publishing") {
      const parsedFileLegacySocial = parseOnOffFlagValue(
        fileBackedEnvValue(
          this.env as unknown as Partial<Env> | undefined,
          "SOCIAL_POSTING_ENABLED",
        ),
      );
      if (parsedFileLegacySocial !== undefined) return parsedFileLegacySocial;
    }

    // Issue #2596: options product flags inherit their parent when
    // neither the bulk map nor a direct variable set them explicitly
    // (both explicit paths returned above). An explicit OFF/ON above
    // therefore always wins; reaching here means "absent", so the
    // parent evaluation — itself subject to its own parent chain —
    // is the value. This runs before the generic configured/bare
    // default below, so a configured environment with the parent ON
    // does not silently disable an absent per-product flag.
    const productParent = getFeatureFlagParent(flag);
    if (productParent) {
      return this.isEnabled(productParent, _context);
    }

    // Issue #4613: single monetization default shared with CfFlagshipAdapter.
    // Explicit overrides (FEATURE_FLAGS, FEATURE_MONETIZATION, MONETIZATION_ENABLED)
    // still win above.
    if (flag === "monetization") {
      return DEFAULT_MONETIZATION_FLAG_VALUE;
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

    // Issue #4249: the scheduling-channel defaults are explicit, so
    // they hold in a configured env too (where other unconfigured
    // flags default OFF) and in a bare env (where they would
    // otherwise default ON): chat ON (the default channel), NLQ OFF
    // (secondary). Bulk JSON / direct vars above still win when set.
    if (flag === "schedule_chat") {
      return DEFAULT_SCHEDULE_CHAT_FLAG_VALUE;
    }
    if (flag === "schedule_nlq") {
      return DEFAULT_SCHEDULE_NLQ_FLAG_VALUE;
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
    // Phase 3 (#6550): this check is deliberately ENV-ONLY — do NOT
    // make it file-aware. environment.config.json is versioned code
    // present in EVERY environment, including bare test fixtures, so
    // a file-aware check would be always-true and kill the bare-env
    // default-open branch (every unconfigured flag would read OFF in
    // a bare env). Production does not depend on this branch: live
    // runtimes use the Flagship adapter (FLAGS binding), and the env
    // adapter returns false for every flag in a production runtime
    // (isProductionFlagRuntime above). The seven moved flags resolve
    // from the file in step 2b regardless of this check.
    const hasFeatureConfig = Boolean(
      bulkVar ||
      rawDirectVar !== undefined ||
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
