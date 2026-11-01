/**
 * Issue #1815: In-Memory Adapter for FeatureFlagPort.
 *
 * Implements FeatureFlagPort using an in-memory Map.
 * Used for deterministic unit testing, sandbox shadow runs, and local mocks
 * without requiring Cloudflare Workers bindings or environment variables.
 */

import {
  ALL_FEATURE_FLAGS,
  type FeatureEvaluationContext,
  type FeatureFlag,
  type FeatureFlagPort,
  getOptionsProductParentFlag,
  isKnownFeatureFlag,
} from "./featureFlagPorts";

export class InMemoryFeatureFlagAdapter implements FeatureFlagPort {
  private readonly flags = new Map<FeatureFlag, boolean>();
  private readonly explicit = new Set<FeatureFlag>();

  constructor(initialFlags?: Partial<Record<FeatureFlag, boolean>>) {
    // Default-closed for all known flags, except payment_assurance
    // (issue #2054: default ON, overridable via initialFlags).
    // Issue #2596: options product flags are NOT pre-filled here —
    // an absent product flag must inherit its parent (see isEnabled),
    // and pre-filling false would mask that inheritance. Non-product
    // flags keep the historical defaults.
    for (const flag of ALL_FEATURE_FLAGS) {
      if (!getOptionsProductParentFlag(flag)) {
        this.flags.set(flag, flag === "payment_assurance");
      }
    }

    if (initialFlags) {
      for (const [flag, enabled] of Object.entries(initialFlags)) {
        if (isKnownFeatureFlag(flag) && typeof enabled === "boolean") {
          this.flags.set(flag, enabled);
          this.explicit.add(flag);
        }
      }
    }
  }

  setFlag(flag: FeatureFlag, enabled: boolean): void {
    if (isKnownFeatureFlag(flag)) {
      this.flags.set(flag, enabled);
      this.explicit.add(flag);
    }
  }

  async isEnabled(flag: string, _context?: FeatureEvaluationContext): Promise<boolean> {
    if (!isKnownFeatureFlag(flag)) {
      return false;
    }
    // Issue #2596: an explicitly set flag always wins; an absent
    // options product flag inherits its parent chain (which ends at
    // options_research, default-closed here, so a bare adapter still
    // resolves every product flag false — the conformance pin).
    if (this.explicit.has(flag)) {
      return this.flags.get(flag) ?? false;
    }
    const parent = getOptionsProductParentFlag(flag);
    if (parent) {
      return this.isEnabled(parent, _context);
    }
    return this.flags.get(flag) ?? false;
  }

  async getAllFlags(context?: FeatureEvaluationContext): Promise<Record<FeatureFlag, boolean>> {
    const result: Partial<Record<FeatureFlag, boolean>> = {};
    for (const flag of ALL_FEATURE_FLAGS) {
      result[flag] = await this.isEnabled(flag, context);
    }
    return result as Record<FeatureFlag, boolean>;
  }
}
