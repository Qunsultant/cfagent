/** @vitest-environment jsdom */
/**
 * Issue #2843: Navigation reorganization and Product Catalog UI modernization.
 *
 * 1. Move tab=workflows to Workflows sub-menu (SUB_MENU_CONFIGS["workflow-runs"])
 *    and SUB_MENU_HOSTED_IDS.
 * 2. Rename Billing section to BILLINGS/PAYMENTS in SECTION_METADATA.
 *    (Issue #2968 renames it again to ORDERS/BILLINGS/PAYMENTS and
 *    groups the pages under Orders/Billing/Payments menus.)
 * 3. Move tab=payment-assurance to category Billing and section-billing (BILLINGS/PAYMENTS).
 * 4. Modernize ProductCatalogPanel UI with container padding, structured cards,
 *    tables for receipts and sales rails, and Notice callouts.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import {
  DEFAULT_LEFT_NAV_CONFIG,
  SUB_MENU_CONFIGS,
} from "../src/client/navConfig";
import { getRoute } from "../src/client/routes";
import { ProductCatalogPanel } from "../src/client/ProductCatalogPanel";

describe("Workflows, Billings/Payments Nav & Products UI (issue #2843)", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
      container = null;
    }
    vi.restoreAllMocks();
  });

  it("hosts workflows under the workflow-runs sub-menu and removes it from top-level platform items", () => {
    const workflowSubItems = SUB_MENU_CONFIGS["workflow-runs"];
    expect(workflowSubItems).toBeDefined();
    const subIds = workflowSubItems.map((s) => s.id);
    expect(subIds).toContain("workflows");

    const workflowsRoute = getRoute("workflows");
    expect(workflowsRoute).toBeDefined();
    // Issue #2974 moved the Workflows family into Platform with the
    // section removal; the FAQ page stays a sub-menu entry, never a
    // top-level Platform item.
    expect(workflowsRoute!.category).toBe("Platform");
    expect(workflowsRoute!.navGroup).toBe("workflow-runs");

    const platformSec = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-platform");
    expect(platformSec).toBeDefined();
    const platformIds = platformSec!.items.map((i) => i.id);
    expect(platformIds).not.toContain("workflows");
  });

  it("renames Billing section to ORDERS/BILLINGS/PAYMENTS with Orders, Billing, Payments menus (#2968)", () => {
    const billingSec = DEFAULT_LEFT_NAV_CONFIG.sections.find((s) => s.id === "section-billing");
    expect(billingSec).toBeDefined();
    expect(billingSec!.title).toBe("ORDERS/BILLINGS/PAYMENTS");
    expect(billingSec!.category).toBe("Billing");

    expect(billingSec!.items.map((i) => i.id)).toEqual(["orders", "billing", "payments"]);
    expect(SUB_MENU_CONFIGS.orders.map((s) => s.id)).toEqual(["checkout", "ledger"]);
    expect(SUB_MENU_CONFIGS.billing.map((s) => s.id)).toEqual(["billing", "revenue"]);
    expect(SUB_MENU_CONFIGS.payments.map((s) => s.id)).toEqual(["payments", "payment-assurance"]);

    const assuranceRoute = getRoute("payment-assurance");
    expect(assuranceRoute).toBeDefined();
    expect(assuranceRoute!.category).toBe("Billing");

    const sandboxSubItems = SUB_MENU_CONFIGS.sandbox;
    expect(sandboxSubItems).toBeDefined();
    const sandboxSubIds = sandboxSubItems.map((s) => s.id);
    expect(sandboxSubIds).not.toContain("payment-assurance");
  });

  it("renders ProductCatalogPanel with structured PageShell and modernized UI elements", async () => {
    const fixture = [
      {
        id: "options:PayPerUse",
        family: "options",
        tier: "PayPerUse",
        canonicalName: "Options Screener",
        servingAgent: "trading",
        priceUSD: 0.05,
        priceSource: "gate",
        priceLabel: "$0.05 per call",
        availability: "purchasable",
        listed: true,
        unlistedReasons: [],
        parityVerdict: "parity",
        parityNotes: [],
        purchasePath: { label: "Pay per call", route: "/api/premium/options-scan", note: "" },
        purchasePathReason: null,
        realVsSimulated: "real (testnet)",
      },
    ];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url === "/api/products/catalog") {
          return { ok: true, status: 200, json: async () => ({ products: fixture }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);

    await act(async () => {
      root!.render(<ProductCatalogPanel />);
    });

    // Flush macro-tasks
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });

    const text = container.textContent ?? "";
    expect(text).toContain("Products");
    expect(text).toContain("Options Screener");
    expect(text).toContain("$0.05 per call");
    expect(text).toContain("Teaser rules");
    expect(text).toContain("Marketing draft preview");
    expect(text).toContain("Selling");

    // Table renders
    const tables = container.querySelectorAll("table");
    expect(tables.length).toBeGreaterThanOrEqual(1);

    // Purchase path link rendered with styling
    const link = container.querySelector('a[href="/api/premium/options-scan"]');
    expect(link).not.toBeNull();
  });
});
