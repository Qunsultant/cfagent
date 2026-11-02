// @vitest-environment node
/**
 * Issue #1815: FeatureFlagPort Conformance Suite (ADR 0006).
 *
 * Verifies that all adapters (InMemoryFeatureFlagAdapter, EnvFeatureFlagAdapter,
 * and CfFlagshipAdapter) strictly satisfy the FeatureFlagPort contract:
 *  - Unknown flags fail closed (return false)
 *  - Boolean resolution behaves deterministically across all adapters
 *  - getAllFlags returns the complete dictionary of all registered features
 *  - Composition root createFeatureFlagPort wires the appropriate adapter
 *  - Port definition module (src/features/featureFlagPorts.ts) contains zero cloud-specific types.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  ALL_FEATURE_FLAGS,
  type FeatureFlag,
  type FeatureFlagPort,
  isKnownFeatureFlag,
} from "../src/features/featureFlagPorts";
import { InMemoryFeatureFlagAdapter } from "../src/features/inMemoryFeatureFlagAdapter";
import { EnvFeatureFlagAdapter } from "../src/features/envFeatureFlagAdapter";
import { CfFlagshipAdapter, type FlagshipBindingLike } from "../src/features/cfFlagshipAdapter";
import { createFeatureFlagPort } from "../src/features/createFeatureFlagPort";

describe("FeatureFlagPort Conformance Suite (Issue #1815)", () => {
  describe("Port Contract Purity", () => {
    it("src/features/featureFlagPorts.ts does not leak any cloud or provider types", () => {
      const src = readFileSync(
        resolve(__dirname, "../src/features/featureFlagPorts.ts"),
        "utf8"
      );
      expect(src).not.toContain("cloudflare");
      expect(src).not.toContain("Flagship");
      expect(src).not.toContain("process.env");
      expect(src).not.toContain("D1Database");
      expect(src).not.toContain("Env");
    });
  });

  describe("InMemoryFeatureFlagAdapter", () => {
    it("defaults to closed (false) for all registered flags except payment_assurance (issue #2054)", async () => {
      const port: FeatureFlagPort = new InMemoryFeatureFlagAdapter();
      for (const flag of ALL_FEATURE_FLAGS) {
        expect(await port.isEnabled(flag)).toBe(flag === "payment_assurance");
      }
      expect(await port.isEnabled("unknown_feature")).toBe(false);
    });

    it("respects initial configuration and dynamic setFlag updates", async () => {
      const port = new InMemoryFeatureFlagAdapter({ screener: true, autopilot: false });
      expect(await port.isEnabled("screener")).toBe(true);
      expect(await port.isEnabled("autopilot")).toBe(false);

      port.setFlag("autopilot", true);
      expect(await port.isEnabled("autopilot")).toBe(true);

      const all = await port.getAllFlags();
      expect(all.screener).toBe(true);
      expect(all.autopilot).toBe(true);
      expect(all.trading_orders).toBe(false);
    });

    it("fails closed on unknown flags", async () => {
      const port = new InMemoryFeatureFlagAdapter();
      expect(await port.isEnabled("non_existent_flag")).toBe(false);
      expect(await port.isEnabled("")).toBe(false);
    });
  });

  describe("EnvFeatureFlagAdapter", () => {
    it("evaluates direct FEATURE_<FLAG> environment variables", async () => {
      const port: FeatureFlagPort = new EnvFeatureFlagAdapter({
        FEATURE_SCREENER: "1",
        FEATURE_OPTIONS_RESEARCH: "true",
        FEATURE_AUTOPILOT: "0",
      });

      expect(await port.isEnabled("screener")).toBe(true);
      expect(await port.isEnabled("options_research")).toBe(true);
      expect(await port.isEnabled("autopilot")).toBe(false);
      expect(await port.isEnabled("trading_orders")).toBe(false);
    });

    it("evaluates FEATURE_FLAGS bulk JSON configuration", async () => {
      const port: FeatureFlagPort = new EnvFeatureFlagAdapter({
        FEATURE_FLAGS: JSON.stringify({
          screener: true,
          voice_trading: true,
          payments: false,
        }),
      });

      expect(await port.isEnabled("screener")).toBe(true);
      expect(await port.isEnabled("voice_trading")).toBe(true);
      expect(await port.isEnabled("payments")).toBe(false);
      expect(await port.isEnabled("autopilot")).toBe(false);
    });

    it("preserves documented legacy SOCIAL_POSTING_ENABLED fallback", async () => {
      const port: FeatureFlagPort = new EnvFeatureFlagAdapter({
        SOCIAL_POSTING_ENABLED: "1",
      });
      expect(await port.isEnabled("social_publishing")).toBe(true);
    });

    it("fails closed on unknown flags or null env", async () => {
      const port = new EnvFeatureFlagAdapter(null);
      expect(await port.isEnabled("screener")).toBe(false);
      expect(await port.isEnabled("random_flag")).toBe(false);
    });

    it("payment_assurance is ON by default, OFF only on explicit disable (issue #2054)", async () => {
      // Reverses the #2049 always-closed rule: no explicit setting
      // means the page is visible. Explicit disable still wins.
      const bare = new EnvFeatureFlagAdapter({});
      expect(await bare.isEnabled("payment_assurance")).toBe(true);
      const enabled = new EnvFeatureFlagAdapter({
        FEATURE_FLAGS: JSON.stringify({ payment_assurance: true }),
      });
      expect(await enabled.isEnabled("payment_assurance")).toBe(true);
      const direct = new EnvFeatureFlagAdapter({ FEATURE_PAYMENT_ASSURANCE: "1" });
      expect(await direct.isEnabled("payment_assurance")).toBe(true);
      const bulkDisabled = new EnvFeatureFlagAdapter({
        FEATURE_FLAGS: JSON.stringify({ payment_assurance: false }),
      });
      expect(await bulkDisabled.isEnabled("payment_assurance")).toBe(false);
      const directDisabled = new EnvFeatureFlagAdapter({ FEATURE_PAYMENT_ASSURANCE: "0" });
      expect(await directDisabled.isEnabled("payment_assurance")).toBe(false);
    });

    it("defaults goal_workflow OPEN in a bare env, explicit OFF wins (issue #2051)", async () => {
      // #2051 reverses #1997: goal_workflow gates a shipped path, so an
      // unconfigured flag resolves ON; explicit OFF still wins.
      const bare = new EnvFeatureFlagAdapter({});
      expect(await bare.isEnabled("goal_workflow")).toBe(true);
      const bulkOff = new EnvFeatureFlagAdapter({
        FEATURE_FLAGS: JSON.stringify({ goal_workflow: false }),
      });
      expect(await bulkOff.isEnabled("goal_workflow")).toBe(false);
      const directOff = new EnvFeatureFlagAdapter({ FEATURE_GOAL_WORKFLOW: "0" });
      expect(await directOff.isEnabled("goal_workflow")).toBe(false);
      const enabled = new EnvFeatureFlagAdapter({
        FEATURE_FLAGS: JSON.stringify({ goal_workflow: true }),
      });
      expect(await enabled.isEnabled("goal_workflow")).toBe(true);
    });

    it("keeps monetization strictly closed in a bare env, Flagship ON/OFF controls it (issue #2043)", async () => {
      // Same rule as goal_workflow, for charging: a bare env must
      // never silently enable payment. Explicit enablement only:
      // FEATURE_FLAGS bulk JSON, FEATURE_MONETIZATION, or the
      // legacy MONETIZATION_ENABLED var (env adapter only).
      const bare = new EnvFeatureFlagAdapter({});
      expect(await bare.isEnabled("monetization")).toBe(false);
      const bulk = new EnvFeatureFlagAdapter({
        FEATURE_FLAGS: JSON.stringify({ monetization: true }),
      });
      expect(await bulk.isEnabled("monetization")).toBe(true);
      const direct = new EnvFeatureFlagAdapter({ FEATURE_MONETIZATION: "1" });
      expect(await direct.isEnabled("monetization")).toBe(true);
      const legacy = new EnvFeatureFlagAdapter({ MONETIZATION_ENABLED: "true" });
      expect(await legacy.isEnabled("monetization")).toBe(true);
      const legacyOff = new EnvFeatureFlagAdapter({ MONETIZATION_ENABLED: "false" });
      expect(await legacyOff.isEnabled("monetization")).toBe(false);
      // Flagship is the source of truth when the FLAGS binding is
      // present: ON in Flagship = ON, OFF = OFF, error = OFF.
      const on = new CfFlagshipAdapter({
        getBooleanValue: vi.fn().mockResolvedValue(true),
      });
      expect(await on.isEnabled("monetization")).toBe(true);
      const off = new CfFlagshipAdapter({
        getBooleanValue: vi.fn().mockResolvedValue(false),
      });
      expect(await off.isEnabled("monetization")).toBe(false);
      const broken = new CfFlagshipAdapter({
        getBooleanValue: vi.fn().mockRejectedValue(new Error("Flagship down")),
      });
      expect(await broken.isEnabled("monetization")).toBe(false);
      // Composition root: FLAGS present = Flagship, absent = env.
      expect(createFeatureFlagPort({ FLAGS: { getBooleanValue: vi.fn().mockResolvedValue(true) } })).toBeInstanceOf(CfFlagshipAdapter);
      expect(createFeatureFlagPort({ FEATURE_MONETIZATION: "1" })).toBeInstanceOf(EnvFeatureFlagAdapter);
    });
  });

  describe("CfFlagshipAdapter", () => {
    it("evaluates through Flagship binding getBooleanValue with context", async () => {
      const getBooleanValue = vi.fn().mockImplementation((flag: string) => {
        if (flag === "screener") return Promise.resolve(true);
        if (flag === "autopilot") return Promise.resolve(false);
        return Promise.resolve(false);
      });

      const binding: FlagshipBindingLike = { getBooleanValue };
      const port: FeatureFlagPort = new CfFlagshipAdapter(binding);

      const ctx = { userLogin: "test-user-1815" };
      expect(await port.isEnabled("screener", ctx)).toBe(true);
      expect(await port.isEnabled("autopilot", ctx)).toBe(false);
      expect(getBooleanValue).toHaveBeenCalledWith("screener", false, ctx);
    });

    it("uses the provider default for payment_assurance (issue #2054)", async () => {
      // The binding returns whatever default it is given: the
      // adapter must pass true for payment_assurance and false for
      // other flags, so a missing dashboard flag evaluates ON for
      // the assurance page and OFF for everything else.
      const getBooleanValue = vi.fn().mockImplementation((flag: string, defaultVal: boolean) => Promise.resolve(defaultVal));
      const binding: FlagshipBindingLike = { getBooleanValue };
      const port: FeatureFlagPort = new CfFlagshipAdapter(binding);
      expect(await port.isEnabled("payment_assurance")).toBe(true);
      expect(await port.isEnabled("screener")).toBe(false);
      expect(getBooleanValue).toHaveBeenCalledWith("payment_assurance", true, undefined);
    });

    it("passes goal_workflow default true to Flagship, other flags false (issue #2051)", async () => {
      const getBooleanValue = vi.fn().mockImplementation((flag: string, defaultVal: boolean) => Promise.resolve(defaultVal));
      const binding: FlagshipBindingLike = { getBooleanValue };
      const port: FeatureFlagPort = new CfFlagshipAdapter(binding);
      expect(await port.isEnabled("goal_workflow")).toBe(true);
      expect(await port.isEnabled("screener")).toBe(false);
      expect(getBooleanValue).toHaveBeenCalledWith("goal_workflow", true, undefined);
    });

    it("passes monetization default true to Flagship, other flags false (#2742, owner direction)", async () => {
      const getBooleanValue = vi.fn().mockImplementation((flag: string, defaultVal: boolean) => Promise.resolve(defaultVal));
      const binding: FlagshipBindingLike = { getBooleanValue };
      const port: FeatureFlagPort = new CfFlagshipAdapter(binding);
      expect(await port.isEnabled("monetization")).toBe(true);
      expect(await port.isEnabled("screener")).toBe(false);
      expect(getBooleanValue).toHaveBeenCalledWith("monetization", true, undefined);
    });

    it("fails closed when Flagship throws an error", async () => {
      const binding: FlagshipBindingLike = {
        getBooleanValue: vi.fn().mockRejectedValue(new Error("Flagship service unavailable")),
      };
      const port: FeatureFlagPort = new CfFlagshipAdapter(binding);

      expect(await port.isEnabled("screener")).toBe(false);
      expect(await port.isEnabled("autopilot")).toBe(false);
    });

    it("fails closed on unknown flags without invoking Flagship binding", async () => {
      const getBooleanValue = vi.fn();
      const binding: FlagshipBindingLike = { getBooleanValue };
      const port: FeatureFlagPort = new CfFlagshipAdapter(binding);

      expect(await port.isEnabled("completely_unknown_flag")).toBe(false);
      expect(getBooleanValue).not.toHaveBeenCalled();
    });
  });

  describe("createFeatureFlagPort composition root", () => {
    it("returns InMemoryFeatureFlagAdapter when runtime is in-memory", () => {
      const port = createFeatureFlagPort("in-memory", {
        initialFlags: { screener: true },
      });
      expect(port).toBeInstanceOf(InMemoryFeatureFlagAdapter);
    });

    it("returns CfFlagshipAdapter when FLAGS binding is provided in env", () => {
      const fakeBinding: FlagshipBindingLike = {
        getBooleanValue: vi.fn().mockResolvedValue(true),
      };
      const port = createFeatureFlagPort({ FLAGS: fakeBinding });
      expect(port).toBeInstanceOf(CfFlagshipAdapter);
    });

    it("returns EnvFeatureFlagAdapter when FLAGS binding is absent in env", () => {
      const port = createFeatureFlagPort({ FEATURE_SCREENER: "1" });
      expect(port).toBeInstanceOf(EnvFeatureFlagAdapter);
    });

    it("returns an EnvFeatureFlagAdapter with empty config when env is undefined", () => {
      const port = createFeatureFlagPort();
      expect(port).toBeInstanceOf(EnvFeatureFlagAdapter);
    });
  });

  describe("Adapter Parity (getAllFlags)", () => {
    it("all adapters return the exact same schema structure for getAllFlags", async () => {
      const inMemoryPort = new InMemoryFeatureFlagAdapter({ screener: true });
      const envPort = new EnvFeatureFlagAdapter({ FEATURE_SCREENER: "1" });
      const cfPort = new CfFlagshipAdapter({
        getBooleanValue: (flag) => Promise.resolve(flag === "screener"),
      });

      const inMemoryFlags = await inMemoryPort.getAllFlags();
      const envFlags = await envPort.getAllFlags();
      const cfFlags = await cfPort.getAllFlags();

      expect(Object.keys(inMemoryFlags).sort()).toEqual([...ALL_FEATURE_FLAGS].sort());
      expect(Object.keys(envFlags).sort()).toEqual([...ALL_FEATURE_FLAGS].sort());
      expect(Object.keys(cfFlags).sort()).toEqual([...ALL_FEATURE_FLAGS].sort());

      expect(inMemoryFlags.screener).toBe(true);
      expect(envFlags.screener).toBe(true);
      expect(cfFlags.screener).toBe(true);

      expect(inMemoryFlags.autopilot).toBe(false);
      expect(envFlags.autopilot).toBe(false);
      expect(cfFlags.autopilot).toBe(false);
    });
  });
});
