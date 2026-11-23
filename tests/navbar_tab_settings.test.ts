import { describe, it, expect } from "vitest";
import {
  NAVIGATION_ITEMS,
  DEFAULT_VISIBLE_NAV_TABS,
  isNavIdVisible,
  routeOnlyNavParent,
} from "../src/client/components/NavigationMenu";
import {
  NAV_TAB_PRESETS,
  NAV_PRESET_KEYS,
  buildPresetMap,
  completeVisibleTabs,
  derivePresetKey,
  leftNavConfigIds,
} from "../src/client/navPresets";
import { TAB_TO_FEATURE_MAP } from "../src/client/featureFlags";

/** Every feature flag on: pins the map/parent behaviour, not the flags. */
const ALL_FLAGS_ON: Record<string, boolean> = Object.fromEntries(
  Object.values(TAB_TO_FEATURE_MAP).map((flag) => [flag, true]),
);

describe("Navbar Visible Tabs Settings", () => {
  it("defines an entry in DEFAULT_VISIBLE_NAV_TABS for every item in NAVIGATION_ITEMS", () => {
    for (const item of NAVIGATION_ITEMS) {
      expect(DEFAULT_VISIBLE_NAV_TABS[item.id]).toBe(true);
    }
  });

  it("provides the eight decided presets and no retired keys", () => {
    expect(NAV_PRESET_KEYS).toEqual([
      "alltabs",
      "research",
      "trading",
      "payment",
      "marketing",
      "platform",
      "minimal",
      "none",
    ]);
    expect(Object.keys(NAV_TAB_PRESETS).sort()).toEqual(
      [...NAV_PRESET_KEYS].sort(),
    );
    expect(
      (NAV_TAB_PRESETS as Record<string, unknown>).all,
    ).toBeUndefined();
    expect(
      (NAV_TAB_PRESETS as Record<string, unknown>).traderFocus,
    ).toBeUndefined();

    // Measured on main at build time: 26 left-nav config ids.
    const countOn = (map: Record<string, boolean>) =>
      Object.values(map).filter(Boolean).length;
    expect(countOn(NAV_TAB_PRESETS.alltabs)).toBe(26);
    expect(countOn(NAV_TAB_PRESETS.research)).toBe(7);
    expect(countOn(NAV_TAB_PRESETS.trading)).toBe(6);
    expect(countOn(NAV_TAB_PRESETS.payment)).toBe(4);
    expect(countOn(NAV_TAB_PRESETS.marketing)).toBe(2);
    expect(countOn(NAV_TAB_PRESETS.platform)).toBe(8);
    expect(countOn(NAV_TAB_PRESETS.minimal)).toBe(5);
    expect(countOn(NAV_TAB_PRESETS.none)).toBe(0);

    // Every preset map is keyed by the config ids, nothing else.
    const configIds = leftNavConfigIds();
    for (const key of NAV_PRESET_KEYS) {
      expect(Object.keys(NAV_TAB_PRESETS[key]).sort()).toEqual(
        [...configIds].sort(),
      );
    }
  });

  it("derives the category presets from the left-nav sections", () => {
    // Research is the Intelligence section (ooda joined it in #5116,
    // so the decided six-id list is seven on current main).
    for (const id of [
      "stock-hub",
      "options-screener",
      "goal-screen",
      "ooda",
      "chat",
      "search",
      "assets-hub",
    ]) {
      expect(NAV_TAB_PRESETS.research[id]).toBe(true);
    }
    expect(NAV_TAB_PRESETS.research.autopilot).toBe(false);

    // Trading is the Execution section plus orders.
    for (const id of [
      "autopilot",
      "order",
      "portfolio",
      "voice",
      "omnichannel",
      "orders",
    ]) {
      expect(NAV_TAB_PRESETS.trading[id]).toBe(true);
    }
    expect(NAV_TAB_PRESETS.trading["stock-hub"]).toBe(false);

    // Payment is the Billing section plus sandbox.
    for (const id of ["orders", "billing", "payments", "sandbox"]) {
      expect(NAV_TAB_PRESETS.payment[id]).toBe(true);
    }
    expect(NAV_TAB_PRESETS.payment["marketing-hub"]).toBe(false);

    // Marketing is the Marketing section; platform the Platform one.
    expect(NAV_TAB_PRESETS.marketing["marketing-hub"]).toBe(true);
    expect(NAV_TAB_PRESETS.marketing["product-hub"]).toBe(true);
    expect(NAV_TAB_PRESETS.marketing["platform-admin"]).toBe(false);
    expect(NAV_TAB_PRESETS.platform["platform-admin"]).toBe(true);
    expect(NAV_TAB_PRESETS.platform.schedules).toBe(true);
    expect(NAV_TAB_PRESETS.platform["workflow-runs"]).toBe(true);
    expect(NAV_TAB_PRESETS.platform.agents).toBe(true);
    expect(NAV_TAB_PRESETS.platform["audit-vault"]).toBe(true);
    expect(NAV_TAB_PRESETS.platform["data-hub"]).toBe(true);
    expect(NAV_TAB_PRESETS.platform["security-hub"]).toBe(true);
    expect(NAV_TAB_PRESETS.platform.observability).toBe(true);

    // Minimal is the five decided desk essentials.
    for (const id of [
      "autopilot",
      "order",
      "portfolio",
      "stock-hub",
      "chat",
    ]) {
      expect(NAV_TAB_PRESETS.minimal[id]).toBe(true);
    }
    expect(NAV_TAB_PRESETS.minimal["options-screener"]).toBe(false);
  });

  it("routes route-only nav ids through their left-nav parent", () => {
    expect(routeOnlyNavParent("checkout")).toBe("orders");
    expect(routeOnlyNavParent("ledger")).toBe("orders");
    expect(routeOnlyNavParent("revenue")).toBe("billing");
    expect(routeOnlyNavParent("payment-assurance")).toBe("payments");
    expect(routeOnlyNavParent("docs")).toBe("workflow-runs");
    expect(routeOnlyNavParent("workflows")).toBe("workflow-runs");
    expect(routeOnlyNavParent("endpoints")).toBe("agents");
    expect(routeOnlyNavParent("autopilot")).toBeUndefined();

    const trading = buildPresetMap("trading");
    // Parent following, with the flags on: checkout/ledger follow
    // orders (in trading), revenue follows billing (not in trading).
    expect(isNavIdVisible("checkout", trading, ALL_FLAGS_ON)).toBe(true);
    expect(isNavIdVisible("ledger", trading, ALL_FLAGS_ON)).toBe(true);
    expect(isNavIdVisible("revenue", trading, ALL_FLAGS_ON)).toBe(false);
    const payment = buildPresetMap("payment");
    expect(isNavIdVisible("revenue", payment, ALL_FLAGS_ON)).toBe(true);
    expect(isNavIdVisible("checkout", payment, ALL_FLAGS_ON)).toBe(true);
    expect(isNavIdVisible("docs", payment, ALL_FLAGS_ON)).toBe(false);
    // Under the test-env flag defaults, checkout/ledger are flag-gated
    // off (their parent orders maps to trading_orders, absent here) —
    // the flag gates first, the parent second.
    expect(isNavIdVisible("checkout", trading)).toBe(false);
    // Flag-enabled parents follow in this env too.
    expect(isNavIdVisible("docs", buildPresetMap("platform"))).toBe(true);
    expect(isNavIdVisible("workflows", buildPresetMap("platform"))).toBe(
      true,
    );
    expect(isNavIdVisible("endpoints", buildPresetMap("platform"))).toBe(
      true,
    );
  });

  it("fails closed: absent from the map means hidden, in both modes", () => {
    // A partial map (legacy, navEntry-keyed) hides the config-only
    // ids it never listed — goal-screen, ooda, orders, schedules,
    // sandbox. (The five config-only ids have no navEntry, so the
    // legacy map never listed them.)
    const legacy: Record<string, boolean> = {
      ...DEFAULT_VISIBLE_NAV_TABS,
    };
    expect(isNavIdVisible("goal-screen", legacy)).toBe(false);
    expect(isNavIdVisible("ooda", legacy)).toBe(false);
    expect(isNavIdVisible("orders", legacy)).toBe(false);
    expect(isNavIdVisible("schedules", legacy)).toBe(false);
    expect(isNavIdVisible("sandbox", legacy)).toBe(false);
    expect(isNavIdVisible("stock-hub", legacy)).toBe(true);
    expect(isNavIdVisible("docs", legacy)).toBe(true);
    // No map at all (tests, unmounted shell) still shows everything.
    expect(isNavIdVisible("goal-screen")).toBe(true);
    expect(isNavIdVisible("checkout")).toBe(true);
  });

  it("filters navigation items dynamically based on visibleTabs map", () => {
    const customVisibility: Record<string, boolean> = {
      ...buildPresetMap("alltabs"),
      // Issue 4682: the retired ads + referrals entries are one
      // Marketing Hub entry now, so hiding the hub hides both.
      "marketing-hub": false,
      // Revenue is route-only: it has no map entry of its own and
      // follows its parent, billing — hiding billing hides revenue.
      billing: false,
      payments: false,
    };

    const filtered = NAVIGATION_ITEMS.filter((item) =>
      isNavIdVisible(item.id, customVisibility),
    );
    const visibleIds = filtered.map((i) => i.id);

    expect(visibleIds).toContain("portfolio");
    expect(visibleIds).toContain("omnichannel");
    // Issue #2974 removed the Research & Dual Feed nav entry, so the
    // research route no longer renders as a nav item; chat stands in
    // as the always-visible Intelligence item here.
    expect(visibleIds).toContain("chat");
    expect(visibleIds).not.toContain("marketing-hub");
    expect(visibleIds).not.toContain("billing");
    expect(visibleIds).not.toContain("revenue");
    expect(visibleIds).not.toContain("payments");
    // Ten hidden in this env: four map-hidden (marketing-hub,
    // billing, revenue via its parent, payments), four flag-gated
    // off under the test-env defaults (autopilot, order, voice,
    // options-flows — payments is in both sets), and two more
    // flag-gated through their parent (checkout and ledger follow
    // orders, whose trading_orders flag is absent here). The lookup
    // gates on flags first, then the map, then the parent.
    expect(visibleIds).not.toContain("autopilot");
    expect(visibleIds).not.toContain("order");
    expect(visibleIds).not.toContain("voice");
    expect(visibleIds).not.toContain("options-flows");
    expect(visibleIds).not.toContain("checkout");
    expect(visibleIds).not.toContain("ledger");
    expect(filtered.length).toBe(NAVIGATION_ITEMS.length - 10);
  });

  it("toggles single tab visibility state correctly", () => {
    const state: Record<string, boolean> = { ...buildPresetMap("alltabs") };
    expect(state.endpoints).toBeUndefined();
    expect(isNavIdVisible("endpoints", state)).toBe(true);

    // Toggle its parent off: the route-only id follows the parent.
    state.agents = false;
    expect(isNavIdVisible("endpoints", state)).toBe(false);

    // Toggle back on
    state.agents = true;
    expect(isNavIdVisible("endpoints", state)).toBe(true);
  });

  it("derives the preset key from a complete map, or null for custom", () => {
    expect(derivePresetKey(buildPresetMap("alltabs"))).toBe("alltabs");
    expect(derivePresetKey(buildPresetMap("trading"))).toBe("trading");
    expect(derivePresetKey(buildPresetMap("none"))).toBe("none");
    const custom = {
      ...buildPresetMap("minimal"),
      "stock-hub": false,
    };
    expect(derivePresetKey(custom)).toBeNull();
  });

  it("completes a persisted map without resurrecting a deselect-all", () => {
    // Never saved: alltabs.
    expect(completeVisibleTabs(null)).toEqual(buildPresetMap("alltabs"));
    expect(completeVisibleTabs(undefined)).toEqual(
      buildPresetMap("alltabs"),
    );
    // Legacy partial map: missing ids fill from the saved preset.
    const legacy: Record<string, boolean> = {
      ...DEFAULT_VISIBLE_NAV_TABS,
      autopilot: false,
    };
    const completed = completeVisibleTabs(legacy, "minimal");
    expect(completed.autopilot).toBe(false);
    expect(completed["goal-screen"]).toBe(false);
    expect(completed["stock-hub"]).toBe(true);
    // Legacy deselect-all (no preset key ever written): stays empty.
    const deselectAll: Record<string, boolean> = {};
    for (const item of NAVIGATION_ITEMS) deselectAll[item.id] = false;
    expect(completeVisibleTabs(deselectAll, null)).toEqual(
      buildPresetMap("none"),
    );
  });
});
