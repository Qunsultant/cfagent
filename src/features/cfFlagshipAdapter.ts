/**
 * Issue #1815: Cloudflare Flagship Adapter for FeatureFlagPort.
 *
 * Implements FeatureFlagPort against the native Cloudflare Flagship binding (`env.FLAGS`),
 * conforming to OpenFeature evaluation semantics.
 *
 * If Flagship fails or throws, it logs a warning and fails closed (returns false)
 * to avoid stale override leaks.
 */

import {
  ALL_FEATURE_FLAGS,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  getOptionsProductParentFlag,
  isKnownFeatureFlag,
} from "./featureFlagPorts";

export interface FlagshipBindingLike {
  getBooleanValue(
    flag: string,
    defaultValue: boolean,
    context?: Record<string, unknown>
  ): Promise<boolean>;
}

export class CfFlagshipAdapter implements FeatureFlagPort {
  constructor(private readonly flags: FlagshipBindingLike) {}

  async isEnabled(flag: string, context?: FeatureEvaluationContext): Promise<boolean> {
    if (!isKnownFeatureFlag(flag)) {
      return false;
    }

    // Issue #2054: per-flag provider defaults. Only payment_assurance
    // defaults ON: the assurance page is visible unless a dashboard
    // flag explicitly turns it off. Every other flag keeps the
    // historic default (false). A provider error still fails closed
    // to false below, including for payment_assurance.
      // Issue #2051: goal_workflow defaults ON — the default covers
      // the missing-flag case (the dashboard flag is still the
      // authoritative control; an explicit Flagship value wins, and
      // an evaluation failure still fails closed below).
    // Issue #2742: monetization defaults ON (owner direction).
    const defaultValue =
      flag === "payment_assurance" ||
      flag === "goal_workflow" ||
      flag === "monetization";
    try {
      // Issue #2596: Flagship cannot distinguish an absent dashboard
      // flag from an explicit one, so parent inheritance is expressed
      // through the default value: the parent chain is evaluated
      // first (recursively, so options_screener itself inherits
      // options_research) and its result becomes this flag's
      // default. A dashboard value still wins (getBooleanValue
      // returns it, not the default), and an evaluation failure
      // still fails closed below.
      const productParent = getOptionsProductParentFlag(flag);
      const inheritedDefault = productParent
        ? await this.isEnabled(productParent, context)
        : defaultValue;
      const result = await this.flags.getBooleanValue(
        flag,
        inheritedDefault,
        context as Record<string, unknown> | undefined
      );
      if (typeof result === "boolean") {
        return result;
      }
    } catch (flagshipError) {
      console.warn(
        `[CfFlagshipAdapter] Evaluation failed for flag '${flag}', failing closed to false:`,
        flagshipError
      );
      return false;
    }

    return false;
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
