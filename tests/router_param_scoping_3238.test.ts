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
    expect(buildSearchWithTab("?tab=autopilot&riskTab=anatomy", "risk-analysis")).toBe(
      "?tab=risk-analysis&riskTab=anatomy",
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
    expect(buildSearchWithTab("?tab=platform-admin&iaaaTab=members", "platform-admin")).toBe(
      "?tab=platform-admin&iaaaTab=members",
    );
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

  it("drops unknown params on a tab change", () => {
    expect(buildSearchWithTab("?tab=order&orderTab=risk&mystery=1", "portfolio")).toBe(
      "?tab=portfolio",
    );
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
      "screenerTab",
      "research",
      "discoveryView",
      "checkoutTab",
    ]) {
      expect(Object.keys(TAB_PARAM_OWNERS)).toContain(key);
    }
  });
});
