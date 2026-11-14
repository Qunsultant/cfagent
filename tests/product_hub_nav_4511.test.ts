/**
 * Issue #4511 (superseded by #4530) — the "products" sub-menu this
 * file used to pin is gone. The Product Hub replaced the standalone
 * products page (#4530): the product surfaces live under the
 * "product-hub" sub-menu, the old "products:selling-options" deep-link
 * override is removed (the retired URL redirects — see
 * product_hub_redirect_4530.test.ts), and there is no products nav
 * item. Billing, Checkout, and Payments were never hub tabs under
 * the final #4530 scope; they resolve to their standalone pages.
 */
import { describe, expect, it } from "vitest";
import navData from "../src/client/nav-config.json";
import { buildDefaultLeftNavConfig } from "../src/client/navConfig";
import { DEEP_LINK_OVERRIDES, deepLinkForNavNode, deepLinkHref } from "../src/client/deepLinks";

const subMenus = navData.subMenus as Record<string, { id: string; label: string }[]>;

describe("Product Hub menu (#4511, superseded by #4530)", () => {
  it("the products sub-menu is gone; the product-hub sub-menu carries the product surfaces", () => {
    expect(subMenus["products"]).toBeUndefined();
    const group = subMenus["product-hub"];
    expect(group).toBeDefined();
    expect(group.map((item) => item.id)).toEqual([
      "products",
      "selling-options",
      "marketing-draft-preview",
      "admin-products",
      "free-runs",
    ]);
  });

  it("there is no products nav item; the Product Hub nav item carries the sub-menu", () => {
    const config = buildDefaultLeftNavConfig();
    const items = config.sections.flatMap((s) => s.items);
    expect(items.find((item) => item.id === "products")).toBeUndefined();
    const hub = items.find((item) => item.id === "product-hub");
    expect(hub).toBeDefined();
    expect((hub!.subItems ?? []).map((s) => s.id)).toEqual([
      "products",
      "selling-options",
      "marketing-draft-preview",
      "admin-products",
      "free-runs",
    ]);
  });

  it("the Selling options deep link moved under product-hub; the old override is gone", () => {
    expect(DEEP_LINK_OVERRIDES["products:selling-options"]).toBeUndefined();
    expect(deepLinkForNavNode("product-hub", "selling-options")).toEqual({
      tab: "product-hub",
      view: "selling-options",
    });
    expect(deepLinkHref(deepLinkForNavNode("product-hub", "selling-options"))).toBe(
      "?tab=product-hub&view=selling-options",
    );
  });

  it("Billing, Checkout, and Payments resolve to their standalone pages", () => {
    expect(deepLinkHref(deepLinkForNavNode("billing", "billing"))).toBe("?tab=billing");
    expect(deepLinkHref(deepLinkForNavNode("orders", "checkout"))).toBe("?tab=checkout");
    expect(deepLinkHref(deepLinkForNavNode("payments", "payments"))).toBe("?tab=payments");
  });
});
