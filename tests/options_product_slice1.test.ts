/**
 * Issue #2596 — Options Screener product programme, slice 1 (UX only).
 *
 * Pins:
 *  - the per-product flag catalogue (parent + 10 products) and its
 *    inheritance rule: explicit OFF always wins; an absent flag
 *    inherits its parent; an absent parent inherits options_research;
 *    unknown flags fail closed.
 *  - the server route mapping for each product (specific prefixes win
 *    over generic options/screener prefixes; a disabled product route
 *    is what the server gate turns into 404 FEATURE_DISABLED).
 *  - the top-level Options Screener nav entry, its sub-menu, and the
 *    aggregate page's product list (flags registered, host tabs real).
 *  - client tab/product gating helpers.
 *
 * Deliberately NOT pinned here: hub-internal deep-links (IV history
 * section, strategy panel section) — slice 1 links to the hosting
 * tab and says so on the card; deep-linking is a later slice.
 */
import { describe, expect, it, vi } from "vitest";
import {
  ALL_FEATURE_FLAGS,
  getOptionsProductParentFlag,
  isKnownFeatureFlag,
  OPTIONS_PRODUCT_FLAG_PARENTS,
} from "../src/features/featureFlagPorts";
import { EnvFeatureFlagAdapter } from "../src/features/envFeatureFlagAdapter";
import { InMemoryFeatureFlagAdapter } from "../src/features/inMemoryFeatureFlagAdapter";
import { CfFlagshipAdapter } from "../src/features/cfFlagshipAdapter";
import { matchFeatureForRoute } from "../src/config/featureFlags";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  findNavItemConfig,
  isNavItemOrSubItemActive,
} from "../src/client/navConfig";
import { getRoute } from "../src/client/routes";
import {
  getClientFeatureFlags,
  isOptionsProductEnabled,
  isTabFeatureEnabled,
  TAB_TO_FEATURE_MAP,
} from "../src/client/featureFlags";
import { OPTIONS_SCREENER_PRODUCTS } from "../src/client/OptionsScreenerPage";

const PRODUCT_FLAGS = [
  "options_contract_screen",
  "options_strategy_panel",
  "options_best_trade",
  "options_compare",
  "options_llm_ideas",
  "options_llm_evaluate",
  "options_discovery",
  "options_scheduled",
  "options_flows",
  "options_iv_history",
] as const;

describe("options product flags (issue #2596)", () => {
  it("registers the parent and one flag per sub-product", () => {
    expect(isKnownFeatureFlag("options_screener")).toBe(true);
    for (const flag of PRODUCT_FLAGS) {
      expect(isKnownFeatureFlag(flag)).toBe(true);
      expect(ALL_FEATURE_FLAGS).toContain(flag);
    }
    expect(getOptionsProductParentFlag("options_screener")).toBe("options_research");
    for (const flag of PRODUCT_FLAGS) {
      expect(getOptionsProductParentFlag(flag)).toBe("options_screener");
    }
    expect(getOptionsProductParentFlag("options_research")).toBeNull();
    expect(Object.keys(OPTIONS_PRODUCT_FLAG_PARENTS)).toHaveLength(11);
  });

  it("fails closed on unknown flags in every adapter", async () => {
    expect(await new EnvFeatureFlagAdapter({}).isEnabled("options_nope")).toBe(false);
    expect(await new InMemoryFeatureFlagAdapter().isEnabled("options_nope")).toBe(false);
    const cf = new CfFlagshipAdapter({ getBooleanValue: vi.fn().mockResolvedValue(true) });
    expect(await cf.isEnabled("options_nope")).toBe(false);
  });

  it("Env: absent product inherits parent, explicit OFF always wins", async () => {
    const parentOn = new EnvFeatureFlagAdapter({
      FEATURE_FLAGS: JSON.stringify({ options_research: true }),
    });
    expect(await parentOn.isEnabled("options_screener")).toBe(true);
    expect(await parentOn.isEnabled("options_best_trade")).toBe(true);

    const productOff = new EnvFeatureFlagAdapter({
      FEATURE_FLAGS: JSON.stringify({ options_research: true, options_best_trade: false }),
    });
    expect(await productOff.isEnabled("options_best_trade")).toBe(false);
    expect(await productOff.isEnabled("options_compare")).toBe(true);

    const parentOff = new EnvFeatureFlagAdapter({
      FEATURE_FLAGS: JSON.stringify({ options_research: false }),
    });
    expect(await parentOff.isEnabled("options_best_trade")).toBe(false);

    // Configured environment with only screener ON: options_research
    // resolves OFF, so absent products resolve OFF too — nothing is
    // silently enabled by inheritance from an unrelated flag.
    const screenerOnly = new EnvFeatureFlagAdapter({ FEATURE_SCREENER: "1" });
    expect(await screenerOnly.isEnabled("options_best_trade")).toBe(false);

    // Configured environment with FEATURE_OPTIONS_SCREENER ON:
    // options_screener and absent sub-products resolve ON.
    const optionsOn = new EnvFeatureFlagAdapter({
      FEATURE_SCREENER: "1",
      FEATURE_OPTIONS_SCREENER: "1",
    });
    expect(await optionsOn.isEnabled("options_screener")).toBe(true);
    expect(await optionsOn.isEnabled("options_best_trade")).toBe(true);
  });

  it("InMemory: absent product inherits an explicitly set parent", async () => {
    const bare = new InMemoryFeatureFlagAdapter();
    expect(await bare.isEnabled("options_best_trade")).toBe(false);
    const parentOn = new InMemoryFeatureFlagAdapter({ options_research: true });
    expect(await parentOn.isEnabled("options_screener")).toBe(true);
    expect(await parentOn.isEnabled("options_best_trade")).toBe(true);
    parentOn.setFlag("options_best_trade", false);
    expect(await parentOn.isEnabled("options_best_trade")).toBe(false);
    expect(await parentOn.isEnabled("options_compare")).toBe(true);
  });

  it("Flagship: absent product inherits its parent via the default value", async () => {
    // Dashboard holds options_research ON and nothing else: a product
    // call receives the inherited parent value as its default.
    const binding = {
      getBooleanValue: vi.fn().mockImplementation((flag: string, defaultVal: boolean) => {
        if (flag === "options_research") return Promise.resolve(true);
        return Promise.resolve(defaultVal);
      }),
    };
    const cf = new CfFlagshipAdapter(binding);
    expect(await cf.isEnabled("options_best_trade")).toBe(true);

    // An explicit dashboard OFF for the product wins over the parent.
    const explicitOff = {
      getBooleanValue: vi.fn().mockImplementation((flag: string, defaultVal: boolean) => {
        if (flag === "options_research") return Promise.resolve(true);
        if (flag === "options_best_trade") return Promise.resolve(false);
        return Promise.resolve(defaultVal);
      }),
    };
    expect(await new CfFlagshipAdapter(explicitOff).isEnabled("options_best_trade")).toBe(false);
  });

  it("maps each product route to its own flag, generic options routes to the parent flag", () => {
    expect(matchFeatureForRoute("/api/options/screen")).toBe("options_contract_screen");
    expect(matchFeatureForRoute("/api/trading/options/screen")).toBe("options_contract_screen");
    expect(matchFeatureForRoute("/api/trading/options/strategies")).toBe("options_strategy_panel");
    expect(matchFeatureForRoute("/api/etrade/options/strategy")).toBe("options_strategy_panel");
    expect(matchFeatureForRoute("/api/trading/options/best-trade")).toBe("options_best_trade");
    expect(matchFeatureForRoute("/api/trading/options/compare")).toBe("options_compare");
    expect(matchFeatureForRoute("/api/trading/options/comparison")).toBe("options_compare");
    expect(matchFeatureForRoute("/api/trading/options/llm-ideas")).toBe("options_llm_ideas");
    expect(matchFeatureForRoute("/api/etrade/options/discovery-runs")).toBe("options_discovery");
    expect(matchFeatureForRoute("/api/etrade/options/iv-history")).toBe("options_iv_history");
    expect(matchFeatureForRoute("/api/options/flows/latest")).toBe("options_flows");
    // Generic options routes stay on the pre-existing parent flag.
    expect(matchFeatureForRoute("/api/trading/options/chains")).toBe("options_research");
    // Stock screener routes are untouched.
    expect(matchFeatureForRoute("/api/screener/runs")).toBe("screener");
    expect(matchFeatureForRoute("/api/etrade/screen")).toBe("screener");
  });

  it("client fallback returns screener and options_screener enabled when unconfigured", () => {
    expect(getClientFeatureFlags().options_screener).toBe(true);
  });

  it("client tab map gates the new page by the parent and flows by its product flag", () => {
    expect(TAB_TO_FEATURE_MAP["options-screener"]).toBe("options_screener");
    expect(TAB_TO_FEATURE_MAP["options"]).toBe("options_screener");
    expect(TAB_TO_FEATURE_MAP["options-flows"]).toBe("options_flows");
    const flags = { options_screener: true, options_flows: false } as Record<string, boolean>;
    expect(isTabFeatureEnabled("options-screener", flags)).toBe(true);
    expect(isTabFeatureEnabled("options-flows", flags)).toBe(false);
    expect(isOptionsProductEnabled("options_best_trade", flags)).toBe(false);
    expect(isOptionsProductEnabled("options_best_trade", { options_best_trade: true })).toBe(true);
  });
});

describe("options screener navigation (issue #2596)", () => {
  it("promotes Options Screener to a top-level item with its own sub-menu", () => {
    const item = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "options-screener");
    expect(item).toBeDefined();
    expect(item!.label).toBe("Options Screener");
    expect(item!.subItems!.map((s) => s.id)).toEqual([
      "options",
      "scanner",
      "options-flows",
      "docs",
      "workflow-runs",
      "schedules",
    ]);
    expect(isNavItemOrSubItemActive(item!, "options-screener")).toBe(true);
    expect(isNavItemOrSubItemActive(item!, "options")).toBe(true);
    expect(isNavItemOrSubItemActive(item!, "portfolio")).toBe(false);
  });

  it("does not remove the historical Screeners sub-menu entry for options", () => {
    const screeners = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "screeners")!;
    expect(screeners.subItems!.map((s) => s.id)).toContain("options");
    expect(screeners.subItems!.map((s) => s.id)).toContain("screeners");
  });

  it("every sub-menu entry is a real route or a hub-internal id with no tab map entry", () => {
    const item = findNavItemConfig(DEFAULT_LEFT_NAV_CONFIG, "options-screener")!;
    for (const sub of item.subItems!) {
      // Real tabs resolve in the route table; hub-internal ids (none
      // in this sub-menu) would fall back to the tab-map core rule.
      expect(getRoute(sub.id)).toBeDefined();
    }
  });

  it("the aggregate page lists one card per product flag with a real host tab", () => {
    expect(OPTIONS_SCREENER_PRODUCTS).toHaveLength(10);
    const flags = OPTIONS_SCREENER_PRODUCTS.map((p) => p.flag);
    expect(new Set(flags).size).toBe(10);
    for (const product of OPTIONS_SCREENER_PRODUCTS) {
      expect(isKnownFeatureFlag(product.flag)).toBe(true);
      expect(getRoute(product.hostTab)).toBeDefined();
      expect(product.label.length).toBeGreaterThan(0);
      expect(product.description.length).toBeGreaterThan(0);
    }
    expect(flags).toEqual([...PRODUCT_FLAGS]);
  });
});
