/**
 * Param scoping (#3238): each menu/sub-menu tab/sub-tab shows a URL
 * carrying only its own params. The reported case: navigating from
 * `?tab=order&orderTab=risk` to `?tab=portfolio` landed on
 * `?tab=portfolio&orderTab=risk`, and `?tab=autopilot&orderTab=risk`
 * showed a foreign param on the autopilot URL. Pure functions only —
 * no window needed.
 */
import { describe, it, expect } from "vitest";
import { buildSearchWithTab, TAB_PARAM_OWNERS } from "../src/client/router";

describe("router param scoping (#3238)", () => {
  it("drops the order page's params when leaving order", () => {
    expect(buildSearchWithTab("?tab=order&orderTab=risk", "portfolio")).toBe(
      "?tab=portfolio",
    );
    expect(buildSearchWithTab("?tab=order&orderTab=risk", "autopilot")).toBe(
      "?tab=autopilot",
    );
    expect(buildSearchWithTab("?tab=order&orderTab=options&assetClass=options", "reports")).toBe(
      "?tab=reports",
    );
  });

  it("keeps a page's own params when navigating to that page", () => {
    expect(buildSearchWithTab("?tab=autopilot&orderTab=risk", "order")).toBe(
      "?tab=order&orderTab=risk",
    );
    // The one-shot seed must survive the navigation that carries it.
    expect(buildSearchWithTab("?tab=autopilot&assetClass=options", "order")).toBe(
      "?tab=order&assetClass=options",
    );
    // S1 #4626 retired the standalone risk-analysis tab: riskTab is
    // owned by order now, so navigating to the retired address drops it.
    expect(buildSearchWithTab("?tab=autopilot&riskTab=anatomy", "risk-analysis")).toBe(
      "?tab=risk-analysis",
    );
    expect(buildSearchWithTab("?tab=autopilot&riskTab=anatomy", "order")).toBe(
      "?tab=order&riskTab=anatomy",
    );
  });

  it("scopes the screener alias to the screener hubs", () => {
    expect(buildSearchWithTab("?tab=screeners&screenerTab=scanner", "options")).toBe(
      "?tab=options&screenerTab=scanner",
    );
    expect(buildSearchWithTab("?tab=screeners&screenerTab=scanner", "portfolio")).toBe(
      "?tab=portfolio",
    );
  });

  it("scopes options, workflow, admin, checkout and reports params to their pages", () => {
    expect(buildSearchWithTab("?tab=options&research=best-trade&discoveryView=builder", "options")).toBe(
      "?tab=options&research=best-trade&discoveryView=builder",
    );
    expect(buildSearchWithTab("?tab=options&research=best-trade", "portfolio")).toBe(
      "?tab=portfolio",
    );
    expect(buildSearchWithTab("?tab=workflow-runs&run=abc&q=abc", "workflow-runs")).toBe(
      "?tab=workflow-runs&run=abc&q=abc",
    );
    expect(buildSearchWithTab("?tab=workflow-runs&run=abc", "reports")).toBe(
      "?tab=reports",
    );
    // Issue #6164: iaaaTab is owned by security-hub now (the IAAA Admin
    // panel lives there), not platform-admin — it survives navigation
    // to security-hub and drops on the way out, like providerTab.
    expect(buildSearchWithTab("?tab=security-hub&iaaaTab=members", "security-hub")).toBe(
      "?tab=security-hub&iaaaTab=members",
    );
    expect(buildSearchWithTab("?tab=security-hub&iaaaTab=members", "platform-admin")).toBe(
      "?tab=platform-admin",
    );
    expect(buildSearchWithTab("?tab=security-hub&iaaaTab=members", "portfolio")).toBe(
      "?tab=portfolio",
    );
    expect(
      buildSearchWithTab("?tab=security-hub&iaaaSection=audit-events", "security-hub"),
    ).toBe("?tab=security-hub&iaaaSection=audit-events");
    // Issue #3978: the data-providers inner tab param is owned by
    // platform-admin — it survives navigation to the page and drops
    // on the way out, like iaaaTab.
    expect(buildSearchWithTab("?tab=platform-admin&providerTab=yahoo", "platform-admin")).toBe(
      "?tab=platform-admin&providerTab=yahoo",
    );
    expect(buildSearchWithTab("?tab=platform-admin&providerTab=yahoo", "portfolio")).toBe(
      "?tab=portfolio",
    );
    expect(buildSearchWithTab("?tab=checkout&checkoutTab=pay", "checkout")).toBe(
      "?tab=checkout&checkoutTab=pay",
    );
    expect(buildSearchWithTab("?tab=reports&reportsTab=ideas", "reports")).toBe(
      "?tab=reports&reportsTab=ideas",
    );
  });

  it("scopes the Admin Products nested param to the product hub (#4689)", () => {
    // adminTab names a sub-tab of the hub's admin-products view: it
    // survives navigation within the hub and drops on the way out,
    // like every other page-owned param. (buildSearchWithTab keeps
    // `view` itself — the destination's own view handling drops it in
    // navigateToTab — so the drop cases below carry no view.)
    expect(
      buildSearchWithTab(
        "?tab=product-hub&view=admin-products&adminTab=create-version",
        "product-hub",
      ),
    ).toBe("?tab=product-hub&view=admin-products&adminTab=create-version");
    expect(buildSearchWithTab("?tab=product-hub&adminTab=create-version", "portfolio")).toBe(
      "?tab=portfolio",
    );
    expect(buildSearchWithTab("?tab=portfolio&adminTab=create-product", "product-hub")).toBe(
      "?tab=product-hub&adminTab=create-product",
    );
  });

  it("drops unknown params on a tab change", () => {
    expect(buildSearchWithTab("?tab=order&orderTab=risk&mystery=1", "portfolio")).toBe(
      "?tab=portfolio",
    );
  });

  it("scopes the Marketing Hub's nested params to the hub (issue 4682)", () => {
    // adsTab / referralsTab / socialTab name the inner tab of the
    // hub's ads / referrals / social section: they survive navigation
    // to the hub and drop on the way out, like every other page-owned
    // param.
    expect(
      buildSearchWithTab("?tab=marketing-hub&view=ads&adsTab=submit", "marketing-hub"),
    ).toBe("?tab=marketing-hub&view=ads&adsTab=submit");
    expect(
      buildSearchWithTab(
        "?tab=marketing-hub&view=referrals&referralsTab=activity",
        "marketing-hub",
      ),
    ).toBe("?tab=marketing-hub&view=referrals&referralsTab=activity");
    expect(
      buildSearchWithTab("?tab=marketing-hub&view=social&socialTab=posts", "marketing-hub"),
    ).toBe("?tab=marketing-hub&view=social&socialTab=posts");
    // buildSearchWithTab keeps `view` itself (the destination's own
    // view handling drops it in navigateToTab), so the drop cases
    // below carry no view — the nested param is what must drop.
    expect(
      buildSearchWithTab("?tab=marketing-hub&adsTab=submit", "portfolio"),
    ).toBe("?tab=portfolio");
    expect(
      buildSearchWithTab("?tab=portfolio&adsTab=submit", "marketing-hub"),
    ).toBe("?tab=marketing-hub&adsTab=submit");
  });

  it("the registry covers every page-owned param the client reads", () => {
    for (const key of [
      "orderTab",
      "assetClass",
      "riskTab",
      "reportsTab",
      "iaaaTab",
      "providerTab",
      "run",
      "q",
      "schedule",
      "section",
      "screenerTab",
      "research",
      "discoveryView",
      "checkoutTab",
      "adminTab",
      // Issue 4682: the Marketing Hub's nested section params.
      "adsTab",
      "referralsTab",
      "socialTab",
    ]) {
      expect(Object.keys(TAB_PARAM_OWNERS)).toContain(key);
    }
  });
});
