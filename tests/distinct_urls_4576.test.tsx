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
 *     keys stay; the bare `sandbox` key is gone with them (issue 4630
 *     supersedes the #2972 bookmark contract) and the checkout sub-item
 *     keeps the canonical `sandbox-checkout` address;
 *  4. the platform-admin and checkout surfaces cover the tabs that had no
 *     catalog entry.
 *
 * Issue #4629 (S4 of #4625) reverses the recorded `section` decision
 * below: the param is now owned by the schedules home (scoped to
 * ["schedules"]), which preserves the drop-on-tab-change behavior while
 * making the section surfaces addressable.
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
    // Issue #4626: the standalone hosts are retired, so each param is
    // owned by its nested home only.
    expect(TAB_PARAM_OWNERS.flowsTab).toEqual(["options"]);
    expect(TAB_PARAM_OWNERS.researchTab).toEqual(["stock-hub"]);
    // Issue #4629 (S4 of #4625): `section` is owned by the schedules
    // home — scoped to ["schedules"] it still drops on a tab change,
    // and the section surfaces are addressable through the registry.
    expect(TAB_PARAM_OWNERS.section).toEqual(["schedules"]);
  });

  it("publishes a surface per panel, with the panel's own values", () => {
    expect(surface("options-flows")).toMatchObject({
      page: "options",
      pageView: "options-flows",
      param: "flowsTab",
      values: ["summary", "live", "historical", "news", "congress", "insider"],
    });
    expect(surface("research-panel")).toMatchObject({
      page: "stock-hub",
      pageView: "research",
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
  it("the retired Planned keys are gone (bookmark contract superseded, issue 4630)", () => {
    // The audit called these orphaned; the #2972 contract retained them
    // so an old bookmark still landed on its view. Issue 4630 removes
    // them as duplicates of the assets-hub:* keys — the canonical keys
    // are the only addresses. The live assets-hub keys stay.
    for (const key of ["planned", "planned:forex", "planned:futures", "planned:commodities", "planned:bonds"]) {
      expect(DEEP_LINK_OVERRIDES[key]).toBeUndefined();
    }
    for (const key of ["assets-hub:forex", "assets-hub:futures", "assets-hub:commodities", "assets-hub:bonds"]) {
      expect(DEEP_LINK_OVERRIDES[key]).toBeDefined();
    }
  });

  it("the bare sandbox key is gone; only sandbox-checkout resolves (issue 4630)", () => {
    // The bare key duplicated sandbox-checkout. The sandbox parent is a
    // toggle-only menu in both nav surfaces, so resolving it falls
    // through to the unknown-id fallback — never a rendered link. Its
    // checkout sub-item keeps the canonical address.
    expect(DEEP_LINK_OVERRIDES["sandbox"]).toBeUndefined();
    expect(deepLinkForNavNode(null, "sandbox")).toEqual({ tab: "autopilot" });
    expect(DEEP_LINK_OVERRIDES["sandbox-checkout"]).toEqual({
      href: "/checkout/sandbox",
      newTab: true,
    });
    expect(deepLinkForNavNode("sandbox", "sandbox-checkout")).toEqual({
      href: "/checkout/sandbox",
      newTab: true,
    });
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
