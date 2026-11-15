import { describe, expect, it } from "vitest";
import adDisplayConfig from "../src/client/ad-display.config.json";
import { DEFAULT_AD_BANNER_CONFIG } from "../src/client/adBannerConfig";

describe("per-tab ad display configuration", () => {
  it("disables ad banners on Trading, Research, API/MCP, Options Flows, and Workflows tabs", () => {
    expect(adDisplayConfig.trading).toBe(false);
    expect(adDisplayConfig.research).toBe(false);
    expect(adDisplayConfig.endpoints).toBe(false);
    expect(adDisplayConfig["options-flows"]).toBe(false);
    expect(adDisplayConfig.workflows).toBe(false);
  });

  it("disables ad banners across all tabs through externalized configuration", () => {
    Object.values(adDisplayConfig).forEach((enabled) => {
      expect(enabled).toBe(false);
    });
  });

  it("defines an explicit ad visibility flag for every top-level tab", () => {
    expect(Object.keys(adDisplayConfig).sort()).toEqual([
      "ads",
      "audit",
      "chat",
      "endpoints",
      // Issue 4682: the Marketing Hub tab itself carries no ad strip.
      "marketing-hub",
      "nlq",
      "options-flows",
      "payments",
      "referrals",
      "research",
      "revenue",
      "trading",
      "workflows",
    ]);
    expect(Object.values(adDisplayConfig).every((enabled) => typeof enabled === "boolean")).toBe(true);
  });

  it("externalizes ads/banners by defaulting master enabled flag and spotlights to false", () => {
    expect(DEFAULT_AD_BANNER_CONFIG.enabled).toBe(false);
    expect(DEFAULT_AD_BANNER_CONFIG.showSponsorSpotlight).toBe(false);
    expect(DEFAULT_AD_BANNER_CONFIG.showAdNetworkStrip).toBe(false);
    expect(DEFAULT_AD_BANNER_CONFIG.showGoogleAdUnits).toBe(false);
    expect(Object.values(DEFAULT_AD_BANNER_CONFIG.tabVisibility).every((v) => v === false)).toBe(true);
  });
});

