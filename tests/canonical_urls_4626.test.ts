/**
 * Issue #4626 (S1 of #4625): one canonical URL per surface — the five
 * dual-homed surfaces retire their standalone address onto the home
 * where their workflow lives, via legacyDualHomeRedirect (router.ts),
 * applied fourth in Chat.tsx applyRoute before the tab is adopted.
 *
 * Retirements (decided 2026-11-15 09:28 EST — all five follow one rule,
 * a surface lives where its workflow lives):
 * - screeners -> assets-hub (view=forex|futures|commodities|bonds carried;
 *   view=reports/goal-screen/review/track-record map to their own homes;
 *   view=schedules stays owned by legacySchedulesRedirect, which runs first)
 * - research -> stock-hub&view=research (researchTab carried)
 * - options-flows -> options&view=options-flows (flowsTab carried)
 * - risk-analysis -> order&orderTab=risk (riskTab carried)
 * - approvals -> order&orderTab=approvals (reverses #4538; supersedes
 *   #4573's additive framing — the sub-tab is now the only home)
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { legacyDualHomeRedirect, legacyMarketingHubRedirect, TAB_PARAM_OWNERS } from "../src/client/router";
import { isTabFeatureEnabled } from "../src/client/featureFlags";
import { mapTabToTradingSubTab } from "../src/client/chat/types";
import { SURFACE_TAB_DEFS, surfaceTabHref } from "../src/client/deepLinks";

const ROOT = join(__dirname, "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");
const ALL_FLAGS = {
  screener: true,
  autopilot: true,
  trading_orders: true,
  options_research: true,
  options_flows: true,
};

describe("legacyDualHomeRedirect (#4626)", () => {
  it("retires ?tab=screeners onto the Assets Hub, carrying the asset view", () => {
    expect(legacyDualHomeRedirect("?tab=screeners")).toEqual({ tab: "assets-hub" });
    expect(legacyDualHomeRedirect("?tab=screeners&view=forex")).toEqual({
      tab: "assets-hub",
      view: "forex",
    });
    expect(legacyDualHomeRedirect("?tab=screeners&view=futures")).toEqual({
      tab: "assets-hub",
      view: "futures",
    });
    expect(legacyDualHomeRedirect("?tab=screeners&view=commodities")).toEqual({
      tab: "assets-hub",
      view: "commodities",
    });
    expect(legacyDualHomeRedirect("?tab=screeners&view=bonds")).toEqual({
      tab: "assets-hub",
      view: "bonds",
    });
    // The screenerTab alias carries the same views.
    expect(legacyDualHomeRedirect("?tab=screeners&screenerTab=bonds")).toEqual({
      tab: "assets-hub",
      view: "bonds",
    });
  });

  it("maps the retired screeners hub's other views to their own homes", () => {
    expect(legacyDualHomeRedirect("?tab=screeners&view=reports")).toEqual({
      tab: "reports",
    });
    expect(
      legacyDualHomeRedirect("?tab=screeners&view=reports&reportsTab=ideas"),
    ).toEqual({ tab: "reports", params: { reportsTab: "ideas" } });
    expect(legacyDualHomeRedirect("?tab=screeners&view=goal-screen")).toEqual({
      tab: "goal-screen",
    });
    expect(legacyDualHomeRedirect("?tab=screeners&view=review")).toEqual({
      tab: "review",
    });
    expect(legacyDualHomeRedirect("?tab=screeners&view=track-record")).toEqual({
      tab: "track-record",
    });
    // An unknown view falls back to the hub default, never a dead tab.
    expect(legacyDualHomeRedirect("?tab=screeners&view=bogus")).toEqual({
      tab: "assets-hub",
    });
  });

  it("leaves view=schedules to legacySchedulesRedirect, which runs first", () => {
    expect(legacyDualHomeRedirect("?tab=screeners&view=schedules")).toBeNull();
  });

  it("retires ?tab=research onto the Stock Hub research view, carrying researchTab", () => {
    expect(legacyDualHomeRedirect("?tab=research")).toEqual({
      tab: "stock-hub",
      view: "research",
    });
    expect(legacyDualHomeRedirect("?tab=research&researchTab=bars")).toEqual({
      tab: "stock-hub",
      view: "research",
      params: { researchTab: "bars" },
    });
  });

  it("retires ?tab=options-flows onto the nested Options hub view, carrying flowsTab", () => {
    expect(legacyDualHomeRedirect("?tab=options-flows")).toEqual({
      tab: "options",
      view: "options-flows",
    });
    expect(legacyDualHomeRedirect("?tab=options-flows&flowsTab=live")).toEqual({
      tab: "options",
      view: "options-flows",
      params: { flowsTab: "live" },
    });
  });

  it("retires ?tab=risk-analysis onto the order risk sub-tab, carrying riskTab", () => {
    expect(legacyDualHomeRedirect("?tab=risk-analysis")).toEqual({
      tab: "order",
      params: { orderTab: "risk" },
    });
    expect(legacyDualHomeRedirect("?tab=risk-analysis&riskTab=scenarios")).toEqual({
      tab: "order",
      params: { orderTab: "risk", riskTab: "scenarios" },
    });
  });

  it("retires ?tab=approvals onto the order approvals sub-tab", () => {
    expect(legacyDualHomeRedirect("?tab=approvals")).toEqual({
      tab: "order",
      params: { orderTab: "approvals" },
    });
  });

  it("leaves every canonical address alone", () => {
    for (const search of [
      "?tab=order",
      "?tab=order&orderTab=approvals",
      "?tab=order&orderTab=risk",
      "?tab=options&view=options-flows",
      "?tab=stock-hub&view=research",
      "?tab=assets-hub&view=forex",
      "?tab=autopilot",
      "?tab=reports",
    ]) {
      expect(legacyDualHomeRedirect(search)).toBeNull();
    }
  });
});

/**
 * Issue 4682: the three standalone marketing addresses retire onto
 * their Marketing Hub section — the same one-rule shape as #4626
 * (a surface lives where its workflow lives). The old standalone
 * form carried the inner tab in `view`; the new nested-param form
 * carries it in its own param; both map onto the nested param.
 */
describe("legacyMarketingHubRedirect (issue 4682)", () => {
  it("retires ?tab=ads onto the hub ads section, carrying the inner tab", () => {
    expect(legacyMarketingHubRedirect("?tab=ads")).toEqual({
      tab: "marketing-hub",
      view: "ads",
    });
    expect(legacyMarketingHubRedirect("?tab=ads&view=submit")).toEqual({
      tab: "marketing-hub",
      view: "ads",
      params: { adsTab: "submit" },
    });
    expect(legacyMarketingHubRedirect("?tab=ads&adsTab=submit")).toEqual({
      tab: "marketing-hub",
      view: "ads",
      params: { adsTab: "submit" },
    });
    expect(legacyMarketingHubRedirect("?tab=ads&view=bogus")).toEqual({
      tab: "marketing-hub",
      view: "ads",
    });
  });

  it("retires ?tab=referrals onto the hub referrals section, carrying the inner tab", () => {
    expect(legacyMarketingHubRedirect("?tab=referrals")).toEqual({
      tab: "marketing-hub",
      view: "referrals",
    });
    expect(legacyMarketingHubRedirect("?tab=referrals&view=activity")).toEqual({
      tab: "marketing-hub",
      view: "referrals",
      params: { referralsTab: "activity" },
    });
    expect(legacyMarketingHubRedirect("?tab=referrals&referralsTab=links")).toEqual({
      tab: "marketing-hub",
      view: "referrals",
      params: { referralsTab: "links" },
    });
    expect(legacyMarketingHubRedirect("?tab=referrals&view=bogus")).toEqual({
      tab: "marketing-hub",
      view: "referrals",
    });
  });

  it("retires ?tab=social onto the hub social section, carrying the inner tab", () => {
    expect(legacyMarketingHubRedirect("?tab=social")).toEqual({
      tab: "marketing-hub",
      view: "social",
    });
    expect(legacyMarketingHubRedirect("?tab=social&view=posts")).toEqual({
      tab: "marketing-hub",
      view: "social",
      params: { socialTab: "posts" },
    });
    expect(legacyMarketingHubRedirect("?tab=social&socialTab=tokens")).toEqual({
      tab: "marketing-hub",
      view: "social",
      params: { socialTab: "tokens" },
    });
    expect(legacyMarketingHubRedirect("?tab=social&view=bogus")).toEqual({
      tab: "marketing-hub",
      view: "social",
    });
  });

  it("leaves every canonical address alone", () => {
    for (const search of [
      "?tab=marketing-hub",
      "?tab=marketing-hub&view=ads&adsTab=submit",
      "?tab=marketing-hub&view=referrals&referralsTab=activity",
      "?tab=marketing-hub&view=social&socialTab=posts",
      "?tab=product-hub",
      "?tab=revenue",
    ]) {
      expect(legacyMarketingHubRedirect(search)).toBeNull();
    }
  });
});

describe("retired params narrow to their canonical owner (#4626)", () => {
  it("researchTab is owned by stock-hub only", () => {
    expect(TAB_PARAM_OWNERS.researchTab).toEqual(["stock-hub"]);
  });

  it("riskTab is owned by order only", () => {
    expect(TAB_PARAM_OWNERS.riskTab).toEqual(["order"]);
  });
});

describe("feature gate follows the canonical home (#4626)", () => {
  it("assets-hub is gated by the screener flag, like screeners was", () => {
    expect(isTabFeatureEnabled("assets-hub", ALL_FLAGS)).toBe(true);
    expect(isTabFeatureEnabled("assets-hub", { ...ALL_FLAGS, screener: false })).toBe(
      false,
    );
  });
});

describe("hub sub-tab mapping follows the canonical home (#4626)", () => {
  it("maps the retired screeners tab onto assets-hub", () => {
    expect(mapTabToTradingSubTab("screeners")).toBe("assets-hub");
    expect(mapTabToTradingSubTab("assets-hub")).toBe("assets-hub");
    expect(mapTabToTradingSubTab("stock-hub")).toBe("stock-hub");
  });
});

describe("deep-link surfaces follow the canonical home (#4626)", () => {
  it("screeners-hub lives on assets-hub", () => {
    const def = SURFACE_TAB_DEFS.find((d) => d.surface === "screeners-hub")!;
    expect(def.page).toBe("assets-hub");
    expect(surfaceTabHref(def, "forex")).toBe("?tab=assets-hub&view=forex");
  });

  it("research-panel lives on stock-hub under view=research", () => {
    const def = SURFACE_TAB_DEFS.find((d) => d.surface === "research-panel")!;
    expect(def.page).toBe("stock-hub");
    expect(def.pageView).toBe("research");
    expect(surfaceTabHref(def, "screener")).toBe(
      "?tab=stock-hub&view=research&researchTab=screener",
    );
  });

  it("options-flows lives on options under view=options-flows", () => {
    const def = SURFACE_TAB_DEFS.find((d) => d.surface === "options-flows")!;
    expect(def.page).toBe("options");
    expect(def.pageView).toBe("options-flows");
    expect(surfaceTabHref(def, "live")).toBe(
      "?tab=options&view=options-flows&flowsTab=live",
    );
  });

  it("the order surface still carries the approvals + risk sub-tabs", () => {
    const def = SURFACE_TAB_DEFS.find((d) => d.surface === "order")!;
    expect(def.values).toContain("approvals");
    expect(def.values).toContain("risk");
    expect(surfaceTabHref(def, "approvals")).toBe("?tab=order&orderTab=approvals");
    expect(surfaceTabHref(def, "risk")).toBe("?tab=order&orderTab=risk");
  });

  it("the risk-analysis surface stays host-dependent: it is the modal's tabs", () => {
    const def = SURFACE_TAB_DEFS.find((d) => d.surface === "risk-analysis")!;
    expect(def.page).toBeNull();
    expect(def.param).toBe("riskTab");
  });
});

describe("admin-products surface follows the nested pattern (#4689)", () => {
  it("lives on product-hub under view=admin-products with its own adminTab param", () => {
    const def = SURFACE_TAB_DEFS.find((d) => d.surface === "admin-products")!;
    expect(def.page).toBe("product-hub");
    expect(def.pageView).toBe("admin-products");
    expect(def.param).toBe("adminTab");
    expect(def.values).toEqual(["products", "create-product", "create-version"]);
    expect(surfaceTabHref(def, "create-product")).toBe(
      "?tab=product-hub&view=admin-products&adminTab=create-product",
    );
    expect(surfaceTabHref(def, "create-version")).toBe(
      "?tab=product-hub&view=admin-products&adminTab=create-version",
    );
    expect(surfaceTabHref(def, "products")).toBe(
      "?tab=product-hub&view=admin-products&adminTab=products",
    );
  });

  it("adminTab is owned by product-hub only", () => {
    expect(TAB_PARAM_OWNERS.adminTab).toEqual(["product-hub"]);
  });
});

describe("retired mounts and links are gone from the sources (#4626)", () => {
  it("Chat.tsx applies the dual-home redirect and mounts no retired page", () => {
    const chat = read("src/client/Chat.tsx");
    expect(chat).toContain("legacyDualHomeRedirect(window.location.search)");
    expect(chat).not.toContain("    approvals: (");
    expect(chat).not.toContain('    "options-flows": (');
    expect(chat).not.toContain('    "risk-analysis": (');
    expect(chat).not.toContain("    research: (");
    // The screener-first fallback lands on the Assets Hub now.
    expect(chat).not.toContain('return "screeners"');
    expect(chat).toContain('return "assets-hub"');
  });

  it("the trading hub renders no screeners sub-tab", () => {
    const hub = read("src/client/TradeHub.tsx");
    expect(hub).not.toContain('effectiveSubTab === "screeners"');
    expect(hub).not.toContain('screeners: "Multi-Asset Screeners"');
    expect(hub).not.toContain('| "screeners"');
  });

  it("every ?tab=approvals link re-points to the approvals sub-tab", () => {
    const ticket = read("src/client/OrderTicketPanel.tsx");
    expect(ticket).toContain('href="?tab=order&orderTab=approvals"');
    expect(ticket).not.toContain('href="?tab=approvals"');
    expect(ticket).not.toContain("Open the full Approvals page");
    const queues = read("src/client/QueuesPage.tsx");
    expect(queues).toContain('href="?tab=order&orderTab=approvals"');
    expect(queues).not.toContain('href="?tab=approvals"');
  });
});

describe("nav-config keeps the retired routes, drops their nav entries (#4626)", () => {
  it("all five retired ids stay as routes; approvals + options-flows lose their nav entries", () => {
    const data = JSON.parse(read("src/client/nav-config.json")) as {
      routes: { id: string; navEntry?: unknown }[];
    };
    // Issue 4682: the Marketing Hub route joins the table; 44 → 45.
    // Issue #5169: the Observability route joins the table; 45 → 46.
    // Issues 3696/3697: the Navigation Settings route joins the table; 46 → 47.
    expect(data.routes).toHaveLength(47);
    const byId = new Map(data.routes.map((r) => [r.id, r]));
    for (const id of ["screeners", "research", "options-flows", "risk-analysis", "approvals"]) {
      expect(byId.has(id)).toBe(true);
    }
    expect(byId.get("approvals")!.navEntry).toBeUndefined();
    expect(byId.get("options-flows")!.navEntry).toBeUndefined();
    // The retired nav entries keep their route metadata: the
    // options-flows icon stays "Flows" on the route row.
    expect(byId.get("options-flows")!.icon).toBe("Flows");
    expect(byId.get("approvals")!.icon).toBe("Approvals");
    // research, risk-analysis and screeners never had one.
    expect(byId.get("research")!.navEntry).toBeUndefined();
    expect(byId.get("risk-analysis")!.navEntry).toBeUndefined();
    expect(byId.get("screeners")!.navEntry).toBeUndefined();
    const orders = data.routes
      .filter((r) => r.navEntry)
      .map((r) => (r.navEntry as { navOrder: number }).navOrder);
    expect(orders).toHaveLength(28);
    expect([...orders].sort((a, b) => a - b)).toEqual(
      Array.from({ length: 28 }, (_, i) => i),
    );
  });
});

describe("nav-config keeps the retired marketing routes, drops their nav entries (issue 4682)", () => {
  it("ads, referrals, and social stay as routes, lose navEntry + shellRetain, keep their icons", () => {
    const data = JSON.parse(read("src/client/nav-config.json")) as {
      routes: { id: string; icon: string; navEntry?: unknown; shellRetain?: boolean }[];
    };
    const byId = new Map(data.routes.map((r) => [r.id, r]));
    for (const id of ["ads", "referrals", "social"]) {
      expect(byId.has(id)).toBe(true);
      expect(byId.get(id)!.navEntry).toBeUndefined();
      expect(byId.get(id)!.shellRetain).toBeUndefined();
    }
    expect(byId.get("ads")!.icon).toBe("Ads");
    expect(byId.get("referrals")!.icon).toBe("Referrals");
    expect(byId.get("social")!.icon).toBe("Social");
    // The hub carries the retain flag now; payments and revenue keep theirs.
    expect(byId.get("marketing-hub")!.shellRetain).toBe(true);
    expect(byId.get("payments")!.shellRetain).toBe(true);
    expect(byId.get("revenue")!.shellRetain).toBe(true);
  });
});
