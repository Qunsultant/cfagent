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
    expect(hub.navEntry?.navOrder).toBe(28);
    // Nav entries stay 31 with orders exactly 0..30.
    const orders = routes
      .filter((r) => r.navEntry !== undefined)
      .map((r) => r.navEntry!.navOrder)
      .sort((a, b) => a - b);
    expect(orders).toEqual(Array.from({ length: 31 }, (_, i) => i));
  });

  it("nav-config carries a product-hub sub-menu with the four hub tabs plus the marketing preview", () => {
    const group = subMenus["product-hub"];
    expect(group).toBeDefined();
    expect(group.map((item) => item.id)).toEqual([
      "products",
      "selling-options",
      "marketing-draft-preview",
      "admin-products",
      "free-runs",
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
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "marketing-draft-preview"))).toBe(
      "?tab=product-hub&view=marketing-draft-preview",
    );
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "admin-products"))).toBe(
      "?tab=product-hub&view=admin-products",
    );
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "free-runs"))).toBe(
      "?tab=product-hub&view=free-runs",
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
    expect(subMenus["billing"].map((i) => i.id)).toEqual(["billing", "revenue"]);
    expect(subMenus["orders"].map((i) => i.id)).toEqual(["checkout", "ledger"]);
    expect(subMenus["payments"].map((i) => i.id)).toEqual(["payments", "payment-assurance"]);
    expect(deepLinkHref(deepLinkForNavNode("billing", "billing"))).toBe("?tab=billing");
    expect(deepLinkHref(deepLinkForNavNode("orders", "checkout"))).toBe("?tab=checkout");
    expect(deepLinkHref(deepLinkForNavNode("payments", "payments"))).toBe("?tab=payments");
  });
});
