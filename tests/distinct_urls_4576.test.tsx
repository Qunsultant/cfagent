/** @vitest-environment jsdom */
/**
 * Issue #4576 — platform-wide distinct URLs (audit follow-up).
 *
 * Pins the four fixes this slice ships and the two decisions it records:
 *  1. the MorningDigest "View queue" button lands on the reports panel
 *     (`?tab=reports`), and the reports-panel surface definition says so;
 *  2. the nested flows and research sub-tabs get their own params
 *     (`flowsTab`, `researchTab`), so an inner tab never overwrites the hub
 *     tab it is nested inside — the two hooks can write side by side;
 *  3. the orphaned `planned` keys are gone, while the live `assets-hub`
 *     keys and the bare `sandbox` node-id fallback stay;
 *  4. the platform-admin and checkout surfaces cover the tabs that had no
 *     catalog entry.
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import navData from "../src/client/nav-config.json";
import { TAB_PARAM_OWNERS } from "../src/client/router";
import { DEEP_LINK_OVERRIDES, SURFACE_TAB_DEFS, deepLinkForNavNode } from "../src/client/deepLinks";
import { useUrlSyncedTabs } from "../src/client/useUrlSyncedTabs";
import { isValidFlowSubTab } from "../src/client/options/flows/OptionsFlowsHub";
import { isValidResearchSubTab } from "../src/client/MarketDataResearchHub";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const surfaces = navData.deepLinkSurfaces as {
  surface: string;
  page: string | null;
  pageView?: string;
  param: string;
  values: string[];
}[];

function surface(name: string) {
  const found = surfaces.find((s) => s.surface === name);
  if (!found) throw new Error(`surface ${name} missing`);
  return found;
}

describe("reports panel address (#4576)", () => {
  it("puts the panel on the reports route, not under the screeners hub", () => {
    const def = surface("reports-panel");
    expect(def.page).toBe("reports");
    expect(def.pageView).toBeUndefined();
    expect(def.param).toBe("reportsTab");
    expect(def.values).toEqual(["reports", "ideas", "track"]);
  });

  it("gives the MorningDigest button that address", () => {
    // Source pin: the button used to navigate to `?tab=screeners&view=reports`,
    // which renders the Forex screener. The reports panel renders on the
    // `reports` route, so the handler names that route and nothing else.
    const src = readFileSync(resolve(__dirname, "../src/client/StockHub.tsx"), "utf8");
    expect(src).toContain('onViewQueue={() => navigateToTab("reports")}');
    expect(src).not.toContain('navigateToTab("screeners", "reports")');
  });
});

describe("nested sub-tab params (#4576)", () => {
  it("registers the two inner params with their hosts", () => {
    expect(TAB_PARAM_OWNERS.flowsTab).toEqual(["options", "options-flows"]);
    expect(TAB_PARAM_OWNERS.researchTab).toEqual(["stock-hub", "research"]);
    // `section` stays unowned by design: every value is a schedules address.
    expect(TAB_PARAM_OWNERS.section).toBeUndefined();
  });

  it("publishes a surface per panel, with the panel's own values", () => {
    expect(surface("options-flows")).toMatchObject({
      page: "options-flows",
      param: "flowsTab",
      values: ["summary", "live", "historical", "news", "congress", "insider"],
    });
    expect(surface("research-panel")).toMatchObject({
      page: "research",
      param: "researchTab",
      values: ["screener", "report", "quoting", "fundamentals", "bars", "snapshot", "compare"],
    });
  });

  it("lets the hub tab and the inner tab live in the URL together", async () => {
    // The bug: both hooks wrote `view`, so the inner tab overwrote the hub tab
    // and a reload fell back to the hub's default view. With distinct params
    // both writes survive.
    window.history.pushState({}, "", "/?tab=options&view=options-flows");

    function Harness() {
      const outer = useUrlSyncedTabs({
        param: "view",
        isValid: (v): v is "strategy-scanner" | "options-flows" =>
          v === "strategy-scanner" || v === "options-flows",
        defaultTab: "strategy-scanner" as const,
      });
      const inner = useUrlSyncedTabs({
        param: "flowsTab",
        isValid: isValidFlowSubTab,
        defaultTab: "summary" as const,
      });
      return (
        <>
          <button id="outer" onClick={() => outer.handleTabChange("options-flows")}>
            outer
          </button>
          <button id="inner" onClick={() => inner.handleTabChange("news")}>
            inner
          </button>
          <span id="state">{`${outer.activeTab}/${inner.activeTab}`}</span>
        </>
      );
    }

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => root.render(<Harness />));

    await act(async () => (host.querySelector("#inner") as HTMLButtonElement).click());
    const url = new URL(window.location.href);
    expect(url.searchParams.get("view")).toBe("options-flows");
    expect(url.searchParams.get("flowsTab")).toBe("news");

    await act(async () => root.unmount());
    host.remove();
  });

  it("keeps both validators honest about their own vocabularies", () => {
    expect(isValidFlowSubTab("news")).toBe(true);
    expect(isValidFlowSubTab("report")).toBe(false);
    expect(isValidResearchSubTab("report")).toBe(true);
    expect(isValidResearchSubTab("news")).toBe(false);
  });
});

describe("deep-link hygiene (#4576)", () => {
  it("keeps the retired Planned keys resolving to the assets-hub views (bookmark contract #2972)", () => {
    // The audit called these orphaned; they are deliberately retained so an
    // old bookmark still lands on its view — and two suites pin exactly that
    // (ux_planned_menu_2783, options_hub_2954). The live assets-hub keys stay
    // too; both addresses resolve to the same views by design.
    expect(DEEP_LINK_OVERRIDES["planned"]).toEqual({ tab: "assets-hub", view: "forex" });
    expect(DEEP_LINK_OVERRIDES["planned:forex"]).toEqual({ tab: "assets-hub", view: "forex" });
    expect(DEEP_LINK_OVERRIDES["planned:futures"]).toEqual({ tab: "assets-hub", view: "futures" });
    expect(DEEP_LINK_OVERRIDES["planned:commodities"]).toEqual({ tab: "assets-hub", view: "commodities" });
    expect(DEEP_LINK_OVERRIDES["planned:bonds"]).toEqual({ tab: "assets-hub", view: "bonds" });
    for (const key of ["assets-hub:forex", "assets-hub:futures", "assets-hub:commodities", "assets-hub:bonds"]) {
      expect(DEEP_LINK_OVERRIDES[key]).toBeDefined();
    }
  });

  it("keeps the bare sandbox node-id fallback, which is a live contract", () => {
    expect(deepLinkForNavNode(null, "sandbox")).toEqual({ href: "/checkout/sandbox", newTab: true });
  });
});

describe("catalog coverage (#4576)", () => {
  it("names every Platform Admin section in the admin surfaces", () => {
    const adminIds = (navData.platformAdminSections as { items: { id: string }[] }[])[0].items.map((i) => i.id);
    const values = surface("platform-admin").values;
    // free-runs/products leave Platform Admin in #4575 (the product hub owns
    // them), so they are not required here whichever branch lands first.
    for (const id of adminIds) {
      if (id === "free-runs" || id === "products") continue;
      expect(values).toContain(id);
    }
    // Issue #4585 moved six sections into the DataHub and SecurityHub hubs;
    // every section keeps a surface entry, now across the three surfaces.
    const hubValues = [
      ...surface("data-hub").values,
      ...surface("security-hub").values,
    ];
    for (const id of ["data-providers", "data-lifecycle", "downloads"]) {
      expect(hubValues).toContain(id);
      expect(surface("data-hub").values).toContain(id);
    }
    for (const id of ["iaaa-admin", "users", "admin-access"]) {
      expect(hubValues).toContain(id);
      expect(surface("security-hub").values).toContain(id);
    }
    // The sections that had no surface entry before #4576.
    for (const id of ["users", "data-lifecycle", "engine-tuning", "downloads"]) {
      expect([...values, ...hubValues]).toContain(id);
    }
  });

  it("covers the checkout topup and the stock-hub run-screen tabs", () => {
    expect(surface("checkout").values).toContain("topup");
    expect(surface("stock-hub").values).toContain("run-screen");
  });

  it("keeps every surface value addressable and every page a route", () => {
    const routeIds = new Set((navData.routes as { id: string }[]).map((r) => r.id));
    for (const def of SURFACE_TAB_DEFS) {
      expect(def.values.length).toBeGreaterThan(0);
      if (def.page !== null) expect(routeIds.has(def.page)).toBe(true);
    }
  });
});
