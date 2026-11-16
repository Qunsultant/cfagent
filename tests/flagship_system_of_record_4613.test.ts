import { describe, it, expect, vi } from "vitest";
import { createFeatureFlagPort } from "../src/features/createFeatureFlagPort";
import {
  EnvFeatureFlagAdapter,
  isProductionFlagRuntime,
} from "../src/features/envFeatureFlagAdapter";
import { CfFlagshipAdapter } from "../src/features/cfFlagshipAdapter";
import { DEFAULT_MONETIZATION_FLAG_VALUE } from "../src/features/featureFlagPorts";

describe("Flagship is the flag system of record (#4613)", () => {
  it("blocks EnvFeatureFlagAdapter from serving flags in production runtimes", async () => {
    for (const prodEnv of [
      { ENVIRONMENT: "production", FEATURE_SCREENER: "1", FEATURE_MONETIZATION: "1", FEATURE_GOAL_WORKFLOW: "1" },
      { ENVIRONMENT: "prod", FEATURE_SCREENER: "1", FEATURE_PAYMENT_ASSURANCE: "1" },
      { NODE_ENV: "production", FEATURE_FLAGS: JSON.stringify({ screener: true, monetization: true }) },
      { CF_ENV: "production", MONETIZATION_ENABLED: "true" },
    ]) {
      expect(isProductionFlagRuntime(prodEnv)).toBe(true);

      const directEnvAdapter = new EnvFeatureFlagAdapter(prodEnv);
      expect(await directEnvAdapter.isEnabled("screener")).toBe(false);
      expect(await directEnvAdapter.isEnabled("monetization")).toBe(false);
      expect(await directEnvAdapter.isEnabled("goal_workflow")).toBe(false);
      expect(await directEnvAdapter.isEnabled("payment_assurance")).toBe(false);

      const port = createFeatureFlagPort(prodEnv);
      expect(port).not.toBeInstanceOf(EnvFeatureFlagAdapter);
      expect(await port.isEnabled("screener")).toBe(false);
      expect(await port.isEnabled("monetization")).toBe(false);
    }
  });

  it("uses CfFlagshipAdapter in production when FLAGS binding is present", async () => {
    const getBooleanValue = vi.fn().mockImplementation(async (_flag: string, defaultValue: boolean) => defaultValue);
    const port = createFeatureFlagPort({
      ENVIRONMENT: "production",
      FLAGS: { getBooleanValue },
    });
    expect(port).toBeInstanceOf(CfFlagshipAdapter);
    expect(await port.isEnabled("monetization")).toBe(DEFAULT_MONETIZATION_FLAG_VALUE);
  });

  it("shares one single monetization default across CfFlagshipAdapter and local/test EnvFeatureFlagAdapter", async () => {
    const envPort = new EnvFeatureFlagAdapter({ ENVIRONMENT: "local" });
    const flagshipPort = new CfFlagshipAdapter({
      getBooleanValue: vi.fn().mockImplementation(async (_flag: string, defaultValue: boolean) => defaultValue),
    });

    expect(DEFAULT_MONETIZATION_FLAG_VALUE).toBe(false);
    expect(await envPort.isEnabled("monetization")).toBe(DEFAULT_MONETIZATION_FLAG_VALUE);
    expect(await flagshipPort.isEnabled("monetization")).toBe(DEFAULT_MONETIZATION_FLAG_VALUE);
  });
});
