/**
 * Issue #4530 — retired product-domain URLs redirect to their hub tabs.
 *
 * TDD RED first: legacyProductRedirect maps the retired addresses to
 * ?tab=product-hub&view=<id> (pure function, same shape as the
 * legacySchedulesRedirect precedent). Only product-domain URLs
 * redirect — Billing, Checkout, Payments, Orders, and every other
 * address return null (leave the URL alone).
 *
 * Issue #4582 — Marketing draft preview is a hub tab now, so the
 * retired preview address and the nested `productTab` addresses map
 * to the hub's Marketing draft preview tab (the nested `productTab`
 * mechanism is gone).
 */
import { describe, expect, it } from "vitest";
import { legacyProductRedirect } from "../src/client/router";

describe("legacy product redirect (#4530)", () => {
  it.each([
    ["?tab=products", "products"],
    ["?tab=products&view=catalog", "products"],
    ["?tab=products&view=selling-options", "selling-options"],
    ["?tab=products&view=marketing-draft-preview", "marketing-draft-preview"],
    // An unknown nested view lands on the hub's Products tab.
    ["?tab=products&view=bogus", "products"],
    ["?tab=platform-admin&view=products", "admin-products"],
    ["?tab=platform-admin&view=free-runs", "free-runs"],
    ["?tab=platform-admin:products", "admin-products"],
    ["?tab=platform-admin:free-runs", "free-runs"],
  ])("%s redirects to the %s hub tab", (search, view) => {
    expect(legacyProductRedirect(search)).toEqual({ tab: "product-hub", view });
  });

  it.each([
    ["?tab=product-hub&view=products&productTab=marketing-draft-preview", "marketing-draft-preview"],
    ["?tab=product-hub&view=products&productTab=selling-options", "selling-options"],
    ["?tab=product-hub&view=products&productTab=catalog", "products"],
    // A stale or unknown nested value falls back to the Products tab.
    ["?tab=product-hub&view=products&productTab=bogus", "products"],
  ])("nested %s redirects to the %s hub tab", (search, view) => {
    expect(legacyProductRedirect(search)).toEqual({ tab: "product-hub", view });
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
