/**
 * Issue #4530 — Product Hub nav wiring as per stock-hub.
 *
 * TDD RED first: nav-config.json gains a "product-hub" route (navOrder
 * 28, taking the retired "products" route's slot) and a "product-hub"
 * subMenus group whose items deep-link to ?tab=product-hub&view=<id>.
 * The "products" route and its sub-menu are gone — the hub is the
 * ONLY place for product-domain URLs.
 *
 * Domain boundary (owner, 2026-11-14): Billing, Checkout, Payments,
 * and Orders stay standalone, exactly as they are — their routes,
 * nav entries, and sub-menus are pinned intact below.
 */
import { describe, expect, it } from "vitest";
import navData from "../src/client/nav-config.json";
import { buildDefaultLeftNavConfig } from "../src/client/navConfig";
import { deepLinkForNavNode, deepLinkHref } from "../src/client/deepLinks";

const routes = navData.routes as { id: string; navGroup?: string; navEntry?: { navOrder: number } }[];
const subMenus = navData.subMenus as Record<string, { id: string; label: string; icon?: string }[]>;

function navItem(id: string) {
  return buildDefaultLeftNavConfig().sections
    .flatMap((s) => s.items)
    .find((item) => item.id === id);
}

describe("Product Hub nav (#4530)", () => {
  it("nav-config carries a product-hub route at navOrder 28 and no products route", () => {
    const ids = routes.map((r) => r.id);
    expect(ids).toContain("product-hub");
    expect(ids).not.toContain("products");
    expect(ids.length).toBe(44);
    const hub = routes.find((r) => r.id === "product-hub")!;
    expect(hub.navGroup).toBe("product-hub");
    // #4574 retired the queues route (navOrders 12..30 down one) and #4575
    // merged audit + NLQ (navOrders 21..29 down one): the hub keeps the
    // #4585 added the DataHub + SecurityHub entries (navOrder 29, 30);
    // #4626 retired the approvals + options-flows entries, shifting
    // 4..21 down one and 23..30 down two — the hub keeps the products
    // route's slot, now 24 in a 0..28 run.
    expect(hub.navEntry?.navOrder).toBe(24);
    // Nav entries are 29 with orders exactly 0..28.
    const orders = routes
      .filter((r) => r.navEntry !== undefined)
      .map((r) => r.navEntry!.navOrder)
      .sort((a, b) => a - b);
    expect(orders).toEqual(Array.from({ length: 29 }, (_, i) => i));
  });

  it("nav-config carries a product-hub sub-menu with the five hub tabs plus the two admin sub-tabs (#4689)", () => {
    const group = subMenus["product-hub"];
    expect(group).toBeDefined();
    expect(group.map((item) => item.id)).toEqual([
      "products",
      "selling-options",
      "marketing-draft-preview",
      "admin-products",
      "free-runs",
      "create-product",
      "create-version",
    ]);
    for (const item of group) {
      expect(item.label).toBeTruthy();
      expect(item.icon).toBeTruthy();
    }
    expect(subMenus["products"]).toBeUndefined();
  });

  it("the Product Hub nav item carries the sub-menu", () => {
    const hub = navItem("product-hub");
    expect(hub).toBeDefined();
    expect((hub!.subItems ?? []).map((s) => s.id)).toEqual([
      "products",
      "selling-options",
      "marketing-draft-preview",
      "admin-products",
      "free-runs",
      "create-product",
      "create-version",
    ]);
    expect(navItem("products")).toBeUndefined();
  });

  it("every product-hub sub-item deep-links to its hub tab", () => {
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "products"))).toBe(
      "?tab=product-hub&view=products",
    );
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "selling-options"))).toBe(
      "?tab=product-hub&view=selling-options",
    );
    // #4582: Marketing draft preview is a hub tab of its own now, so
    // the deep link names that tab directly — no nested `productTab`.
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "marketing-draft-preview"))).toBe(
      "?tab=product-hub&view=marketing-draft-preview",
    );
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "admin-products"))).toBe(
      "?tab=product-hub&view=admin-products",
    );
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "free-runs"))).toBe(
      "?tab=product-hub&view=free-runs",
    );
    // #4689: the Admin Products sub-tabs are deep-linkable — the
    // nested adminTab param names the sub-tab under admin-products.
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "create-product"))).toBe(
      "?tab=product-hub&view=admin-products&adminTab=create-product",
    );
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "create-version"))).toBe(
      "?tab=product-hub&view=admin-products&adminTab=create-version",
    );
  });

  it("Billing, Checkout, Payments, and Orders stay standalone with their own nav entries and sub-menus", () => {
    for (const id of ["billing", "checkout", "payments", "orders"]) {
      expect(routes.map((r) => r.id)).toContain(id);
    }
    // The Billing section renders three parents (issue #2968); Checkout
    // is a sub-item of Orders, not a top-level nav item.
    for (const id of ["orders", "billing", "payments"]) {
      expect(navItem(id)).toBeDefined();
    }
    expect((navItem("orders")!.subItems ?? []).map((s) => s.id)).toContain("checkout");
    // Issue #4638: the billing sub-menu is one entry per Billing
    // section tab plus the Revenue Analytics sibling route.
    expect(subMenus["billing"].map((i) => i.id)).toEqual([
      "overview",
      "refund-policy",
      "refund-flow",
      "usage-billing",
      "referral-codes",
      "approved-free-quota",
      "top-up-limits",
      "offer-rules",
      "plan-stripe-price",
      "support-snapshot",
      "revenue",
    ]);
    expect(subMenus["orders"].map((i) => i.id)).toEqual(["checkout", "ledger"]);
    expect(subMenus["payments"].map((i) => i.id)).toEqual(["payments", "payment-assurance"]);
    expect(deepLinkHref(deepLinkForNavNode("billing", "billing"))).toBe("?tab=billing");
    expect(deepLinkHref(deepLinkForNavNode("orders", "checkout"))).toBe("?tab=checkout");
    expect(deepLinkHref(deepLinkForNavNode("payments", "payments"))).toBe("?tab=payments");
  });
});
