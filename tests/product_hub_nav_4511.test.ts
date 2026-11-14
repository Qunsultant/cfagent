/**
 * Issue #4511 — Product Hub: the product-related pages grouped under
 * one Products menu with sub-menus.
 *
 * TDD RED first: nav-config.json gains a "products" subMenus group
 * (Products, Selling options, Platform Admin Products, Billing,
 * Checkout, Payments) and a "products:selling-options" deep link.
 * The products nav item picks the sub-menu up automatically via
 * SUB_MENU_CONFIGS (the Billing precedent). Resolution follows the
 * existing deep-link rules: the keyed override for selling-options,
 * the platform-admin rule for "platform-admin:products", the default
 * route rule for the rest.
 */
import { describe, expect, it } from "vitest";
import navData from "../src/client/nav-config.json";
import { buildDefaultLeftNavConfig } from "../src/client/navConfig";
import { deepLinkForNavNode, deepLinkHref } from "../src/client/deepLinks";

const subMenus = navData.subMenus as Record<string, { id: string; label: string }[]>;

describe("Product Hub menu (#4511)", () => {
  it("nav-config carries a products sub-menu with the product surfaces", () => {
    const group = subMenus["products"];
    expect(group).toBeDefined();
    const ids = group.map((item) => item.id);
    expect(ids).toEqual([
      "products",
      "selling-options",
      "platform-admin:products",
      "billing",
      "checkout",
      "payments",
    ]);
    for (const item of group) {
      expect(item.label).toBeTruthy();
    }
  });

  it("the products nav item carries the sub-menu", () => {
    const config = buildDefaultLeftNavConfig();
    const products = config.sections
      .flatMap((s) => s.items)
      .find((item) => item.id === "products");
    expect(products).toBeDefined();
    expect((products!.subItems ?? []).map((s) => s.id)).toEqual([
      "products",
      "selling-options",
      "platform-admin:products",
      "billing",
      "checkout",
      "payments",
    ]);
  });

  it("the Selling options sub-item deep-links to the selling-options sub-tab", () => {
    expect(deepLinkForNavNode("products", "selling-options")).toEqual({
      tab: "products",
      view: "selling-options",
    });
    expect(deepLinkHref(deepLinkForNavNode("products", "selling-options"))).toBe(
      "?tab=products&view=selling-options",
    );
  });

  it("the Products sub-item lands on the catalog page, not Platform Admin", () => {
    expect(deepLinkHref(deepLinkForNavNode("products", "products"))).toBe("?tab=products");
  });

  it("the Platform Admin Products sub-item lands on the admin products section", () => {
    expect(deepLinkHref(deepLinkForNavNode("products", "platform-admin:products"))).toBe(
      "?tab=platform-admin&view=products",
    );
  });

  it("Billing, Checkout, and Payments resolve to their pages", () => {
    expect(deepLinkHref(deepLinkForNavNode("products", "billing"))).toBe("?tab=billing");
    expect(deepLinkHref(deepLinkForNavNode("products", "checkout"))).toBe("?tab=checkout");
    expect(deepLinkHref(deepLinkForNavNode("products", "payments"))).toBe("?tab=payments");
  });
});
