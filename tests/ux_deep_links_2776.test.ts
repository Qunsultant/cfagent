import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildDeepLinkCatalog,
  buildSurfaceTabCatalog,
  deepLinkForNavNode,
  deepLinkHref,
  DEEP_LINK_OVERRIDES,
  navNodeKey,
  surfaceTabHref,
  SURFACE_TAB_DEFS,
} from "../src/client/deepLinks";
import { DEFAULT_LEFT_NAV_CONFIG } from "../src/client/navConfig";
import { parseTabFromSearch } from "../src/client/router";
import { isValidScreenerTab } from "../src/client/ScreenersHub";
import { isValidWorkflowsSubTab } from "../src/client/WorkflowsHub";

const ROOT = join(__dirname, "..");
const leftNavSource = readFileSync(
  join(ROOT, "src/client/components/LeftNavBar.tsx"),
  "utf8",
);

function collectNodeKeys(): string[] {
  const keys: string[] = [];
  const walk = (parentId: string | null, nodes: Array<{ id: string; subItems?: Array<{ id: string }> }>) => {
    for (const node of nodes) {
      keys.push(navNodeKey(parentId, node.id));
      if (node.subItems) walk(node.id, node.subItems);
    }
  };
  for (const section of DEFAULT_LEFT_NAV_CONFIG.sections) {
    walk(null, section.items);
  }
  return keys;
}

describe("Deep-link catalog (issue #2776)", () => {
  it("covers every left-nav node exactly once", () => {
    const catalog = buildDeepLinkCatalog();
    const keys = collectNodeKeys();
    expect(catalog.length).toBe(keys.length);
    expect(new Set(catalog.map((e) => e.key)).size).toBe(keys.length);
    for (const key of keys) {
      expect(catalog.some((e) => e.key === key)).toBe(true);
    }
  });

  it("every override key names a real nav node or a real node id (no stale entries)", () => {
    const keys = new Set(collectNodeKeys());
    const ids = new Set<string>();
    for (const key of keys) ids.add(key.split(":").pop()!);
    // Issue #3121 S2: platform-admin sub-item ids are pre-prefixed
    // (`platform-admin:scheduled-goals`), so their full id is a real
    // node id even though the catalog key double-prefixes it — the
    // bare-id fallback in deepLinkForNavNode resolves them. Collect
    // the full ids too, not just their last segments.
    for (const section of DEFAULT_LEFT_NAV_CONFIG.sections) {
      const walkIds = (nodes: Array<{ id: string; subItems?: Array<{ id: string }> }>) => {
        for (const node of nodes) {
          ids.add(node.id);
          if (node.subItems) walkIds(node.subItems);
        }
      };
      walkIds(section.items);
    }
    // Issue #2972: the planned:* keys are intentionally kept after the
    // Planned menu retired, so old node references still generate the
    // Assets Hub view links. They are legacy, not stale-by-neglect.
    // Issue #2994: the options-screener:best-trade key is likewise kept
    // after the Best Trade sub-menu retired, so ?tab=options&research=
    // best-trade still lands on the Custom Thesis tab with the surface.
    // Issue #4168: the autopilot:job-outcomes key is likewise kept —
    // Autopilot has no sub-menu node, so the Job outcomes view is
    // addressed by the `view` param, not by a nav node. Issue #4409
    // extends the same exception to the other five sub-tabs — all six
    // autopilot views are `view`-param addresses, not nav nodes.
    const legacyKeys = new Set([
      "planned",
      "planned:forex",
      "planned:futures",
      "planned:commodities",
      "planned:bonds",
      "options-screener:best-trade",
      "autopilot:performance",
      "autopilot:status",
      "autopilot:limits",
      "autopilot:job-outcomes",
      "autopilot:actions",
      "autopilot:policy-decisions",
    ]);
    for (const key of Object.keys(DEEP_LINK_OVERRIDES)) {
      expect(keys.has(key) || ids.has(key) || legacyKeys.has(key)).toBe(true);
    }
  });

  it("no node silently falls back to autopilot", () => {
    for (const entry of buildDeepLinkCatalog()) {
      if ("tab" in entry.link) {
        expect(entry.link.tab === "autopilot" ? entry.id : "ok").toBe(
          entry.id === "autopilot" ? "autopilot" : "ok",
        );
      }
    }
  });

  it("resolves the known specials to their current destinations", () => {
    // #2624 behavior, preserved through the catalog: admin-prefixed ids
    // route to platform-admin with the section as the view; the bare
    // platform-admin id lands on its default section (ads).
    expect(deepLinkForNavNode(null, "platform-admin:api-keys")).toEqual({
      tab: "platform-admin",
      view: "api-keys",
    });
    expect(deepLinkForNavNode(null, "platform-admin")).toEqual({
      tab: "platform-admin",
      view: "ads",
    });
    expect(deepLinkForNavNode(null, "goal-screen")).toEqual({
      tab: "goal-screen",
    });
    expect(deepLinkForNavNode(null, "sandbox")).toEqual({
      href: "/checkout/sandbox",
      newTab: true,
    });
    expect(deepLinkForNavNode("sandbox", "sandbox-checkout")).toEqual({
      href: "/checkout/sandbox",
      newTab: true,
    });
    // Bare id (NavigationMenu path) resolves identically via the fallback.
    expect(deepLinkForNavNode(null, "sandbox-checkout")).toEqual({
      href: "/checkout/sandbox",
      newTab: true,
    });
    // #2896: the screeners menu became the Stock Hub menu, so the
    // stocks specials resolve under the stock-hub parent now.
    expect(deepLinkForNavNode("stock-hub", "new-screen")).toEqual({
      tab: "stock-hub",
      view: "new-screen",
    });
    expect(deepLinkForNavNode("stock-hub", "screeners")).toEqual({
      tab: "stock-hub",
      view: "stocks",
    });
    // Issue #2954: the options-screener scanner sub is the copy hub's
    // strategy-scanner tab now.
    expect(deepLinkForNavNode("options-screener", "strategy-scanner")).toEqual({
      tab: "options",
      view: "strategy-scanner",
    });
    // Issue #2970: review has its own page now; issue #2971
    // removes the hub tab, so the keyed assets-hub:review override
    // is gone and the hub parent falls through to the own page.
    expect(deepLinkForNavNode("workflow-runs", "review")).toEqual({
      tab: "review",
    });
    expect(deepLinkForNavNode("assets-hub", "review")).toEqual({
      tab: "review",
    });
    expect(deepLinkForNavNode("assets-hub", "goal-screen")).toEqual({
      tab: "goal-screen",
    });
    expect(deepLinkForNavNode("platform-admin", "platform-admin:ads")).toEqual({
      tab: "platform-admin",
      view: "ads",
    });
    expect(deepLinkForNavNode(null, "autopilot")).toEqual({ tab: "autopilot" });
  });

  it("every tab link round-trips through the router's parser", () => {
    for (const entry of buildDeepLinkCatalog()) {
      if (!("tab" in entry.link)) continue;
      const href = deepLinkHref(entry.link);
      expect(parseTabFromSearch(href)).toBe(entry.link.tab);
      const view = new URLSearchParams(href).get("view");
      expect(view).toBe(entry.link.view ?? null);
    }
  });

  it("LeftNavBar navigates through the catalog, not hardcoded branches", () => {
    expect(leftNavSource).toContain("deepLinks");
    expect(leftNavSource).toContain("navigateToDeepLink");
    expect(leftNavSource).toContain("deepLinkForNavNode");
    expect(leftNavSource).not.toContain('navigateToTab("screeners"');
    expect(leftNavSource).not.toContain('window.location.href = "/checkout/sandbox"');
    expect(leftNavSource).not.toContain('navigateToTab("schedules")');
    expect(leftNavSource).not.toContain('navigateToTab("reports")');
  });

  it("LeftNavBar renders nav rows as real links", () => {
    expect(leftNavSource).toContain("deepLinkHref(");
    expect(leftNavSource).toMatch(/href=\{deepLinkHref\(/);
  });
});

describe("Surface wiring (issue #2776)", () => {
  it("newly synced surfaces use the shared hook with their catalog param", () => {
    const checks: Array<[string, string]> = [
      ["src/client/CheckoutPanel.tsx", "checkoutTab"],
      ["src/client/IaaaAdminPanel.tsx", "iaaaTab"],
      ["src/client/ReportsPanel.tsx", "reportsTab"],
      ["src/client/options/RiskAnalysisModal.tsx", "riskTab"],
    ];
    for (const [file, param] of checks) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source).toContain("useUrlSyncedTabs");
      expect(source).toContain(`param: "${param}"`);
    }
  });

  it("the collapsed flyout resolves through the same handler as the submenu", () => {
    expect(leftNavSource).not.toContain("onSelectTab(sub.id");
    expect(leftNavSource).toMatch(/closeFlyout\(\);\s*handleSubItemClick\(e, sub, item\.id\)/);
  });

  it("NavigationMenu resolves nav ids through the catalog", () => {
    const source = readFileSync(join(ROOT, "src/client/components/NavigationMenu.tsx"), "utf8");
    expect(source).toContain("navigateToDeepLink(deepLinkForNavNode(null, id))");
    expect(source).not.toContain("sandboxNavHrefFromNavId");
    expect(source).not.toContain("platformAdminSectionFromNavId");
  });

  it("Button renders an anchor when given an href", () => {
    const source = readFileSync(join(ROOT, "src/client/components/ui/Button.tsx"), "utf8");
    expect(source).toContain("href !== undefined");
    expect(source).toContain("<a");
  });
});
describe("Surface-tab catalog (issue #2776, expanded scope)", () => {
  it("every surface tab has exactly one entry, keys unique", () => {
    const catalog = buildSurfaceTabCatalog();
    const expected = SURFACE_TAB_DEFS.reduce((n, d) => n + d.values.length, 0);
    expect(catalog.length).toBe(expected);
    expect(new Set(catalog.map((e) => e.key)).size).toBe(expected);
  });

  it("every surface href round-trips to its page, view, and tab value", () => {
    for (const entry of buildSurfaceTabCatalog()) {
      const params = new URLSearchParams(entry.href);
      if (entry.page) expect(params.get("tab")).toBe(entry.page);
      // When the surface param IS view, the view param carries the value;
      // otherwise view carries the host pageView (or nothing).
      const expectedView = entry.param === "view" ? entry.value : (entry.pageView ?? null);
      expect(params.get("view") ?? null).toBe(expectedView);
      expect(params.get(entry.param)).toBe(entry.value);
    }
  });

  it("hub and workflows values pass their own validators", () => {
    const hub = SURFACE_TAB_DEFS.find((d) => d.surface === "screeners-hub")!;
    for (const value of hub.values) expect(isValidScreenerTab(value)).toBe(true);
    const workflows = SURFACE_TAB_DEFS.find((d) => d.surface === "workflows")!;
    for (const value of workflows.values) {
      expect(isValidWorkflowsSubTab(value)).toBe(true);
    }
  });

  it("every other surface value appears as a TabPanel in its component", () => {
    const checks: Array<[string, string, string[]]> = [
      ["payments", "src/client/PaymentsPage.tsx", ["create", "gateways", "ledger", "stats", "wallet"]],
      ["social", "src/client/SocialPostingPanel.tsx", ["approvals", "brief", "goal", "posts", "tokens"]],
      ["ads", "src/client/chat/tabs/AdsTab.tsx", ["offers", "submit"]],
      ["referrals", "src/client/chat/tabs/ReferralsTab.tsx", ["activity", "community", "links", "share"]],
      ["revenue", "src/client/chat/tabs/RevenueTab.tsx", ["ads", "categories", "metrics", "placements", "schemas"]],
      ["iaaa-admin", "src/client/IaaaAdminPanel.tsx", ["overview", "members", "api", "mcp", "iaaa", "correlations"]],
      ["risk-analysis", "src/client/options/RiskAnalysisModal.tsx", ["anatomy", "playbook", "scenarios", "ai"]],
    ];
    for (const [surface, file, values] of checks) {
      const source = readFileSync(join(ROOT, file), "utf8");
      const def = SURFACE_TAB_DEFS.find((d) => d.surface === surface)!;
      expect(def.values).toEqual(values);
      for (const value of values) {
        expect(source).toContain(`tabId="${value}"`);
      }
    }
    // Checkout tabs live in the Tabs prop, not TabPanels.
    const checkoutSource = readFileSync(join(ROOT, "src/client/CheckoutPanel.tsx"), "utf8");
    expect(checkoutSource).toContain('{ id: "pay"');
    expect(checkoutSource).toContain('{ id: "subscriptions"');
    // ReportsPanel uses a segmented mode switch, not TabPanels.
    const reportsSource = readFileSync(join(ROOT, "src/client/ReportsPanel.tsx"), "utf8");
    expect(reportsSource).toContain('"reports" | "ideas" | "track"');
  });

  it("the modal surface is host-dependent by design (page null)", () => {
    const risk = SURFACE_TAB_DEFS.find((d) => d.surface === "risk-analysis")!;
    expect(risk.page).toBeNull();
    expect(risk.param).toBe("riskTab");
    // With a host page supplied, its href carries tab + riskTab.
    expect(surfaceTabHref(risk, "scenarios", "screeners")).toBe(
      "?tab=screeners&riskTab=scenarios",
    );
  });
});
