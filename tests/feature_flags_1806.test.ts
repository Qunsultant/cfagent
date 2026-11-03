/**
 * Issue #1806: Cloudflare Feature Flags Tests.
 *
 * Verifies:
 * 1. Default-closed & fail-closed behavior for unknown flags and missing configs.
 * 2. Cloudflare Flagship native binding evaluation and error handling (fail-closed).
 * 3. Environment variable fallbacks (named and bulk JSON).
 * 4. Legacy flag migrations (e.g. SOCIAL_POSTING_ENABLED).
 * 5. Server-side enforcement (disabled routes return HTTP 404 FEATURE_DISABLED).
 * 6. Screener-first activation behavior.
 */

import { describe, expect, it, vi } from "vitest";

// src/server.ts re-exports agent classes, whose module graph pulls in
// cloudflare: protocol imports that Node ESM loader cannot resolve.
// Mock agent SDK entry points with stand-ins.
vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import {
  ALL_FEATURE_FLAGS,
  createFeatureDisabledResponse,
  getAllFeatureFlags,
  isFeatureEnabled,
  isKnownFeatureFlag,
  matchFeatureForRoute,
  type FeatureFlag,
} from "../src/config/featureFlags";
import {
  isTabFeatureEnabled,
  TAB_TO_FEATURE_MAP,
} from "../src/client/featureFlags";
import worker from "../src/server";

describe("Cloudflare Feature Flags (Issue #1806)", () => {
  describe("Feature Registry & Fallback Evaluation", () => {
    it("recognizes all defined feature flags and rejects unknown names", () => {
      expect(isKnownFeatureFlag("screener")).toBe(true);
      expect(isKnownFeatureFlag("options_research")).toBe(true);
      expect(isKnownFeatureFlag("autopilot")).toBe(true);
      expect(isKnownFeatureFlag("trading_orders")).toBe(true);
      expect(isKnownFeatureFlag("voice_trading")).toBe(true);
      expect(isKnownFeatureFlag("social_publishing")).toBe(true);
      expect(isKnownFeatureFlag("nlq")).toBe(true);
      expect(isKnownFeatureFlag("payments")).toBe(true);
      expect(isKnownFeatureFlag("schedules")).toBe(true);

      expect(isKnownFeatureFlag("unknown_feature")).toBe(false);
      expect(isKnownFeatureFlag("")).toBe(false);
      expect(isKnownFeatureFlag("__proto__")).toBe(false);
    });

    it("fails closed (returns false) for unknown flags even if env var exists", async () => {
      const env = {
        FEATURE_UNKNOWN_FEATURE: "1",
        FEATURE_FLAGS: JSON.stringify({ unknown_feature: true }),
      };
      const result = await isFeatureEnabled(env, "unknown_feature");
      expect(result).toBe(false);
    });

    it("defaults to closed (false) for screener when configuration is empty", async () => {
      const env = {};
      const enabled = await isFeatureEnabled(env, "screener");
      expect(enabled).toBe(false);
    });

    it("defaults to closed (false) for all flags when feature configuration is set, except payment_assurance (issue #2054) and goal_workflow (issue #2051)", async () => {
      const env = { FEATURE_SCREENER: "0" };
      for (const flag of ALL_FEATURE_FLAGS) {
        const enabled = await isFeatureEnabled(env, flag);
        // #2051 + #2054: these two flags are default-ON (opt-out);
        // every other flag defaults closed. This pin names the
        // exceptions deliberately — a new default-ON flag must update it.
        expect(enabled).toBe(flag === "payment_assurance" || flag === "goal_workflow");
      }
    });

    it("evaluates Cloudflare Flagship native binding via env.FLAGS.getBooleanValue", async () => {
      const getBooleanValue = vi.fn().mockImplementation(async (flag: string, defaultVal: boolean) => {
        if (flag === "screener") return true;
        return defaultVal;
      });

      const env = {
        FLAGS: { getBooleanValue },
      };

      const screenerEnabled = await isFeatureEnabled(env as any, "screener", { userLogin: "analyst1" });
      expect(screenerEnabled).toBe(true);
      expect(getBooleanValue).toHaveBeenCalledWith("screener", false, { userLogin: "analyst1" });

      const autopilotEnabled = await isFeatureEnabled(env as any, "autopilot");
      expect(autopilotEnabled).toBe(false);
    });

    it("fails closed when Flagship evaluation throws an error (service unavailable)", async () => {
      const consoleWarnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const getBooleanValue = vi.fn().mockRejectedValue(new Error("Cloudflare Edge KV timeout"));

      const env = {
        FLAGS: { getBooleanValue },
        // Even if an env var is set, an active binding error fails closed to avoid stale override leaks
        FEATURE_SCREENER: "1",
      };

      const result = await isFeatureEnabled(env as any, "screener");
      expect(result).toBe(false);
      expect(consoleWarnSpy).toHaveBeenCalled();
      consoleWarnSpy.mockRestore();
    });

    it("falls back to named environment variables when Flagship binding is absent", async () => {
      const env = {
        FEATURE_SCREENER: "1",
        FEATURE_AUTOPILOT: "true",
        FEATURE_VOICE_TRADING: "0",
        FEATURE_PAYMENTS: "false",
      };

      expect(await isFeatureEnabled(env, "screener")).toBe(true);
      expect(await isFeatureEnabled(env, "autopilot")).toBe(true);
      expect(await isFeatureEnabled(env, "voice_trading")).toBe(false);
      expect(await isFeatureEnabled(env, "payments")).toBe(false);
      expect(await isFeatureEnabled(env, "nlq")).toBe(false); // unset
    });

    it("falls back to bulk JSON configuration in env.FEATURE_FLAGS", async () => {
      const env = {
        FEATURE_FLAGS: JSON.stringify({
          screener: true,
          autopilot: false,
          trading_orders: true,
        }),
      };

      expect(await isFeatureEnabled(env, "screener")).toBe(true);
      expect(await isFeatureEnabled(env, "autopilot")).toBe(false);
      expect(await isFeatureEnabled(env, "trading_orders")).toBe(true);
      expect(await isFeatureEnabled(env, "voice_trading")).toBe(false);
    });

    it("supports documented legacy fallback for social_publishing (SOCIAL_POSTING_ENABLED)", async () => {
      const envOn = { SOCIAL_POSTING_ENABLED: "1" };
      expect(await isFeatureEnabled(envOn, "social_publishing")).toBe(true);

      const envOff = { SOCIAL_POSTING_ENABLED: "0" };
      expect(await isFeatureEnabled(envOff, "social_publishing")).toBe(false);
    });

    it("getAllFeatureFlags returns dictionary of all flags", async () => {
      const env = {
        FEATURE_SCREENER: "1",
      };

      const all = await getAllFeatureFlags(env);
      expect(all.screener).toBe(true);
      expect(all.autopilot).toBe(false);
      expect(all.voice_trading).toBe(false);
      expect(all.options_research).toBe(false);
      expect(Object.keys(all).length).toBe(ALL_FEATURE_FLAGS.length);
    });
  });

  describe("Route Feature Matching", () => {
    it("maps screener routes to 'screener'", () => {
      expect(matchFeatureForRoute("/api/screener/runs")).toBe("screener");
      expect(matchFeatureForRoute("/api/screener/export/pdf")).toBe("screener");
      expect(matchFeatureForRoute("/api/etrade/screen")).toBe("screener");
      // Issue #2596: the options contract screen is its own product flag now.
      expect(matchFeatureForRoute("/api/options/screen")).toBe("options_contract_screen");
      expect(matchFeatureForRoute("/api/market-data/screen")).toBe("screener");
      expect(matchFeatureForRoute("/screener/presets")).toBe("screener");
    });

    it("maps other feature routes to their respective flags", () => {
      // Issue #2596: options flows is its own product flag now.
      expect(matchFeatureForRoute("/api/options/flows/latest")).toBe("options_flows");
      expect(matchFeatureForRoute("/api/trading/options/chains")).toBe("options_research");
      expect(matchFeatureForRoute("/api/trading/orders/preview")).toBe("trading_orders");
      expect(matchFeatureForRoute("/api/trading/voice/synthesize")).toBe("voice_trading");
      expect(matchFeatureForRoute("/api/autopilot/status")).toBe("autopilot");
      expect(matchFeatureForRoute("/api/social/publish")).toBe("social_publishing");
      expect(matchFeatureForRoute("/api/trading/nlq/webhook")).toBe("nlq");
      expect(matchFeatureForRoute("/api/premium/verify")).toBe("payments");
      expect(matchFeatureForRoute("/api/schedules/list")).toBe("schedules");
    });

    it("returns null for ungated routes", () => {
      expect(matchFeatureForRoute("/")).toBeNull();
      expect(matchFeatureForRoute("/login")).toBeNull();
      expect(matchFeatureForRoute("/auth/login/github")).toBeNull();
      expect(matchFeatureForRoute("/.well-known/oauth-client-id-metadata-document")).toBeNull();
    });
  });

  describe("Server-Side Enforcement (HTTP 404 FEATURE_DISABLED)", () => {
    it("returns 404 FEATURE_DISABLED when a feature is disabled", async () => {
      const request = new Request("https://agent.openaimp.com/api/screener/runs", {
        method: "GET",
      });

      // Env with screener OFF
      const env = {
        FEATURE_SCREENER: "0",
      };

      const response = await worker.fetch(request, env as any);
      expect(response.status).toBe(404);

      const json = await response.json() as any;
      expect(json.code).toBe("FEATURE_DISABLED");
      expect(json.feature).toBe("screener");
    });

    it("serves GET /api/features dynamically with all evaluated flags", async () => {
      const request = new Request("https://agent.openaimp.com/api/features", {
        method: "GET",
      });

      const env = {
        FEATURE_SCREENER: "1",
        FEATURE_AUTOPILOT: "0",
      };

      const response = await worker.fetch(request, env as any);
      expect(response.status).toBe(200);

      const json = await response.json() as any;
      expect(json.features).toBeDefined();
      expect(json.features.screener).toBe(true);
      expect(json.features.autopilot).toBe(false);
    });

    it("blocks non-enabled features while screener is enabled (screener first rollout)", async () => {
      const env = {
        FEATURE_SCREENER: "1", // Screener ON
        // other features default to OFF
      };

      // Voice trading route is blocked
      const voiceReq = new Request("https://agent.openaimp.com/api/trading/voice/stream", {
        method: "POST",
      });
      const voiceRes = await worker.fetch(voiceReq, env as any);
      expect(voiceRes.status).toBe(404);
      const voiceJson = await voiceRes.json() as any;
      expect(voiceJson.code).toBe("FEATURE_DISABLED");
      expect(voiceJson.feature).toBe("voice_trading");

      // Options flows route is blocked
      const flowsReq = new Request("https://agent.openaimp.com/api/options/flows/unusual", {
        method: "GET",
      });
      const flowsRes = await worker.fetch(flowsReq, env as any);
      expect(flowsRes.status).toBe(404);
      const flowsJson = await flowsRes.json() as any;
      expect(flowsJson.code).toBe("FEATURE_DISABLED");
      // Issue #2596: flows is its own product flag now; it is still
      // blocked here because only screener is enabled.
      expect(flowsJson.feature).toBe("options_flows");
    });
  });

  describe("Client-Side Feature Visibility", () => {
    it("reports tab enablement based on feature flags", () => {
      const flags = {
        screener: true,
        autopilot: false,
        trading_orders: false,
        options_research: false,
      };

      expect(isTabFeatureEnabled("screeners", flags)).toBe(true);
      expect(isTabFeatureEnabled("scanner", flags)).toBe(true);
      expect(isTabFeatureEnabled("reports", flags)).toBe(true);
      expect(isTabFeatureEnabled("autopilot", flags)).toBe(false);
      expect(isTabFeatureEnabled("order", flags)).toBe(false);
      expect(isTabFeatureEnabled("options-flows", flags)).toBe(false);

      // Core ungated tabs remain accessible
      expect(isTabFeatureEnabled("chat", flags)).toBe(true);
      expect(isTabFeatureEnabled("workflows", flags)).toBe(true);
    });
  });
});
