/**
 * Issue #4530 — retired product-domain URLs redirect to their hub tabs.
 *
 * TDD RED first: legacyProductRedirect maps the retired addresses to
 * ?tab=product-hub&view=<id> (pure function, same shape as the
 * legacySchedulesRedirect precedent). Only product-domain URLs
 * redirect — Billing, Checkout, Payments, Orders, and every other
 * address return null (leave the URL alone).
 */
import { describe, expect, it } from "vitest";
import { legacyProductRedirect } from "../src/client/router";

describe("legacy product redirect (#4530)", () => {
  it.each([
    ["?tab=products", "products"],
    ["?tab=products&view=catalog", "products"],
    ["?tab=products&view=selling-options", "selling-options"],
    // An unknown nested view lands on the hub's Products tab.
    ["?tab=products&view=bogus", "products"],
    ["?tab=platform-admin&view=products", "admin-products"],
    ["?tab=platform-admin&view=free-runs", "free-runs"],
    ["?tab=platform-admin:products", "admin-products"],
    ["?tab=platform-admin:free-runs", "free-runs"],
  ])("%s redirects to the %s hub tab", (search, view) => {
    expect(legacyProductRedirect(search)).toEqual({ tab: "product-hub", view });
  });

  it("keeps the catalog's Marketing draft preview sub-tab without claiming the hub's `view`", () => {
    // #4530: the preview is a NESTED sub-tab of the hub's Products tab. Mapping
    // it onto `view` would name a hub tab that does not exist (and, with the
    // shared param, made a sub-tab click switch the hub tab).
    expect(legacyProductRedirect("?tab=products&view=marketing-draft-preview")).toEqual({
      tab: "product-hub",
      view: "products",
      params: { productTab: "marketing-draft-preview" },
    });
  });

  it.each([
    "?tab=billing",
    "?tab=checkout",
    "?tab=payments",
    "?tab=orders",
    "?tab=ledger",
    "?tab=revenue",
    "?tab=platform-admin&view=tenants",
    "?tab=platform-admin&view=accounts",
    "?tab=autopilot",
    "",
  ])("%s does not redirect", (search) => {
    expect(legacyProductRedirect(search)).toBeNull();
  });
});
