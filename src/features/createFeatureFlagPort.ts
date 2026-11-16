/**
 * Issue #1815: Composition root for FeatureFlagPort (ADR 0006).
 *
 * This is the composition root that maps Worker bindings or runtime options
 * to a concrete FeatureFlagPort implementation. Domain code imports this
 * factory and the FeatureFlagPort interface, never the concrete adapters.
 *
 * Pattern:
 * 1. Live Cloudflare runtime with Flagship (`env.FLAGS`): returns CfFlagshipAdapter.
 * 2. Standard Cloudflare runtime without Flagship: returns EnvFeatureFlagAdapter.
 * 3. In-memory / unit testing: returns InMemoryFeatureFlagAdapter.
 */

import { CfFlagshipAdapter, type FlagshipBindingLike } from "./cfFlagshipAdapter";
import { EnvFeatureFlagAdapter, isProductionFlagRuntime } from "./envFeatureFlagAdapter";
import {
  ALL_FEATURE_FLAGS,
  type FeatureFlag,
  type FeatureFlagPort,
} from "./featureFlagPorts";
import { InMemoryFeatureFlagAdapter } from "./inMemoryFeatureFlagAdapter";

class FailClosedProductionFlagPort implements FeatureFlagPort {
  async isEnabled(): Promise<boolean> {
    return false;
  }

  async getAllFlags(): Promise<Record<FeatureFlag, boolean>> {
    return Object.fromEntries(
      ALL_FEATURE_FLAGS.map((flag) => [flag, false]),
    ) as Record<FeatureFlag, boolean>;
  }
}

export type FeatureFlagRuntime = "cf" | "env" | "in-memory";

export interface CreateFeatureFlagPortOptions {
  runtime?: FeatureFlagRuntime;
  initialFlags?: Partial<Record<FeatureFlag, boolean>>;
}

/**
 * Creates a FeatureFlagPort instance based on runtime options and environment.
 */
export function createFeatureFlagPort(
  envOrRuntime?: unknown,
  options?: CreateFeatureFlagPortOptions
): FeatureFlagPort {
  // 1. Explicit in-memory runtime
  if (options?.runtime === "in-memory" || envOrRuntime === "in-memory") {
    return new InMemoryFeatureFlagAdapter(options?.initialFlags);
  }

  // 2. If an env object is provided
  if (envOrRuntime && typeof envOrRuntime === "object") {
    const envObj = envOrRuntime as Record<string, unknown>;
    const flagsBinding = envObj.FLAGS as FlagshipBindingLike | undefined;

    if (flagsBinding && typeof flagsBinding.getBooleanValue === "function") {
      return new CfFlagshipAdapter(flagsBinding);
    }

    if (isProductionFlagRuntime(envObj)) {
      return new FailClosedProductionFlagPort();
    }

    return new EnvFeatureFlagAdapter(envObj);
  }

  if (isProductionFlagRuntime()) {
    return new FailClosedProductionFlagPort();
  }

  // 3. Fallback to empty env adapter in local/test only
  return new EnvFeatureFlagAdapter({});
}

export type { FeatureFlagPort };
