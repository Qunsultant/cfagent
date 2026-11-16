/** @vitest-environment jsdom */
/**
 * Issue #4696 — operator-created products never appear in the product
 * catalog. TDD RED first: buildCreatedProductRows, the route's new
 * listPlans/listProducts inputs, the "plan-approved" price source, and
 * the familyMemberPrices / cfpayChannelOptions helpers do not exist yet.
 *
 * Listing shape (decided, recorded in ~/workspace/4696-PLAN.md and the PR
 * body): one row per created SUBSCRIPTION product — the effective version
 * for the default segment only, via the one resolver. Row id
 * `created:<productId>`; tier Subscribed; family null; price only when the
 * effective version is APPROVED (priceSource "plan-approved"); unlisted rows
 * included with a named reason; purchase path is the Selling tab.
 */
import { describe, expect, it, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { buildCreatedProductRows } from "../src/data/productCatalogue";
import type { PriceEntry } from "../src/data/priceCataloguePorts";
import type { SubscriptionPlanRecord } from "../src/data/subscriptionPorts";
import type { ProductRecord } from "../src/data/productPorts";
import { buildCatalogDisplay, type CatalogDisplayEntry } from "../src/data/productMarketing";
import { resolveProductAccess } from "../src/data/productAccess";
import { familyMemberPrices, cfpayChannelOptions } from "../src/data/productSelling";
import { handleProductCatalogRoute } from "../src/agents/productCatalogRoute";
import { ProductCatalogPanel } from "../src/client/ProductCatalogPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = 1_800_000_000_000;

const PRICE_FIXTURE: PriceEntry[] = [
  { family: "stock", priceUSD: 0.02, updatedAtMs: 1, approvalStatus: "approved", approvedBy: "op", approvedAtMs: 1 },
  { family: "goal", priceUSD: 0.1, updatedAtMs: 1, approvalStatus: "proposed", approvedBy: null, approvedAtMs: null },
  { family: "options", priceUSD: 0.05, updatedAtMs: 1, approvalStatus: "approved", approvedBy: "op", approvedAtMs: 1 },
  { family: "strategy", priceUSD: 0.1, updatedAtMs: 1, approvalStatus: "proposed", approvedBy: null, approvedAtMs: null },
] as PriceEntry[];

function plan(overrides: Partial<SubscriptionPlanRecord> = {}): SubscriptionPlanRecord {
  return {
    id: "plan-test-subs-v1",
    name: "Test-Subs",
    priceUSD: 1,
    periodDays: 30,
    includedRuns: 0,
    trialDays: null,
    approvalStatus: "approved",
    approvedBy: "OpenAIMP",
    approvedAtMs: 1,
    active: true,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    productId: "prod-sub-test-subs",
    segment: "default",
    version: 1,
    effectiveFromMs: 0,
    effectiveToMs: null,
    billingPeriod: "monthly",
    featuresJson: null,
    stripePriceId: null,
    ...overrides,
  };
}

function product(
  overrides: Partial<ProductRecord> = {},
): ProductRecord {
  return {
    id: "prod-sub-test-subs",
    name: "Test-Subs",
    kind: "subscription",
    description: null,
    rank: null,
    createdAtMs: 1000,
    updatedAtMs: 1000,
    ...overrides,
  };
}

const TEST_SUBS_PLANS = [plan()];
const TEST_SUBS_PRODUCTS = [product()];

async function catalogRoute(
  listPlans: (() => Promise<SubscriptionPlanRecord[]>) | null = async () => TEST_SUBS_PLANS,
  listProducts: (() => Promise<ProductRecord[]>) | null = async () => TEST_SUBS_PRODUCTS,
) {
  return handleProductCatalogRoute({
    session: { login: "u1" },
    method: "GET",
    listPrices: async () => PRICE_FIXTURE,
    listPlans,
    listProducts,
  });
}

async function catalogBody(
  listPlans?: (() => Promise<SubscriptionPlanRecord[]>) | null,
  listProducts?: (() => Promise<ProductRecord[]>) | null,
) {
  const res = await catalogRoute(listPlans, listProducts);
  expect(res.status).toBe(200);
  return (await res.json()) as { products: CatalogDisplayEntry[] };
}

describe("created-product rows: builder (#4696)", () => {
  it("builds one row per subscription product from its effective version", () => {
    const rows = buildCreatedProductRows({
      plans: TEST_SUBS_PLANS,
      products: TEST_SUBS_PRODUCTS,
      nowMs: NOW,
    });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe("created:prod-sub-test-subs");
    expect(row.family).toBeNull();
    expect(row.tier).toBe("Subscribed");
    expect(row.canonicalName).toBe("Test-Subs");
    expect(row.servingAgent).toBeNull();
    expect(row.gateEndpoint).toBeNull();
    expect(row.priceUSD).toBe(1);
    expect(row.priceSource).toBe("plan-approved");
    expect(row.periodDays).toBe(30);
    expect(row.listed).toBe(true);
    expect(row.availability).toBe("purchasable");
    expect(row.unlistedReasons).toEqual([]);
  });

  it("a PROPOSED effective version lists the row unlisted, never as chargeable", () => {
    const rows = buildCreatedProductRows({
      plans: [plan({ approvalStatus: "approved", approvedBy: null, approvedAtMs: null })],
      products: TEST_SUBS_PRODUCTS,
      nowMs: NOW,
    });
    // Approved-but-unrecorded is still approved (grandfathered shape); use
    // a genuinely proposed version for the refusal case.
    expect(rows[0]!.listed).toBe(true);
    const proposed = buildCreatedProductRows({
      plans: [plan({ approvalStatus: "proposed", approvedBy: null, approvedAtMs: null })],
      products: TEST_SUBS_PRODUCTS,
      nowMs: NOW,
    });
    expect(proposed).toHaveLength(1);
    expect(proposed[0]!.listed).toBe(false);
    expect(proposed[0]!.priceUSD).toBeNull();
    expect(proposed[0]!.priceSource).toBeNull();
    expect(proposed[0]!.unlistedReasons.join(" ")).toMatch(/not approved/i);
  });

  it("a superseded version never wins over the effective one", () => {
    const v1 = plan({ id: "plan-test-subs-v1", version: 1, effectiveFromMs: 0, priceUSD: 1 });
    const v2 = plan({
      id: "plan-test-subs-v2", version: 2, effectiveFromMs: NOW - 1000, priceUSD: 2,
    });
    const rows = buildCreatedProductRows({ plans: [v1, v2], products: TEST_SUBS_PRODUCTS, nowMs: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.priceUSD).toBe(2);
  });

  it("a product with no effective version for the default segment is unlisted with a named reason", () => {
    const future = buildCreatedProductRows({
      plans: [plan({ effectiveFromMs: NOW + 1000 })],
      products: TEST_SUBS_PRODUCTS,
      nowMs: NOW,
    });
    expect(future).toHaveLength(1);
    expect(future[0]!.listed).toBe(false);
    expect(future[0]!.unlistedReasons.join(" ")).toMatch(/no effective version/i);
    const otherSegment = buildCreatedProductRows({
      plans: [plan({ segment: "eu" })],
      products: TEST_SUBS_PRODUCTS,
      nowMs: NOW,
    });
    expect(otherSegment[0]!.listed).toBe(false);
    expect(otherSegment[0]!.unlistedReasons.join(" ")).toMatch(/no effective version/i);
    const deactivated = buildCreatedProductRows({
      plans: [plan({ active: false })],
      products: TEST_SUBS_PRODUCTS,
      nowMs: NOW,
    });
    expect(deactivated[0]!.listed).toBe(false);
    expect(deactivated[0]!.unlistedReasons.join(" ")).toMatch(/no effective version/i);
  });

  it("a product with no versions at all is unlisted as 'no versions yet'", () => {
    const rows = buildCreatedProductRows({ plans: [], products: TEST_SUBS_PRODUCTS, nowMs: NOW });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.listed).toBe(false);
    expect(rows[0]!.unlistedReasons.join(" ")).toMatch(/no versions yet/i);
  });

  it("per_run and runs_pack products get no created row; prod-free gets none", () => {
    const rows = buildCreatedProductRows({
      plans: TEST_SUBS_PLANS,
      products: [
        product(),
        product({ id: "prod-per-run-stock", name: "Stock", kind: "per_run" }),
        product({ id: "prod-pack-10", name: "Pack 10", kind: "runs_pack" }),
        product({ id: "prod-free", name: "Free", kind: "subscription", createdAtMs: 0, updatedAtMs: 0 }),
      ],
      nowMs: NOW,
    });
    expect(rows.map((r) => r.id)).toEqual(["created:prod-sub-test-subs"]);
  });

  it("orders created rows by product creation, tiebreak product id", () => {
    const rows = buildCreatedProductRows({
      plans: [
        plan({ id: "p-b", productId: "prod-sub-b", name: "B", createdAtMs: 2000 }),
        plan({ id: "p-a", productId: "prod-sub-a", name: "A", createdAtMs: 1000 }),
        plan({ id: "p-c", productId: "prod-sub-c", name: "C", createdAtMs: 1000 }),
      ],
      products: [
        product({ id: "prod-sub-b", name: "B", createdAtMs: 2000, updatedAtMs: 2000 }),
        product({ id: "prod-sub-a", name: "A", createdAtMs: 1000, updatedAtMs: 1000 }),
        product({ id: "prod-sub-c", name: "C", createdAtMs: 1000, updatedAtMs: 1000 }),
      ],
      nowMs: NOW,
    });
    expect(rows.map((r) => r.id)).toEqual([
      "created:prod-sub-a",
      "created:prod-sub-c",
      "created:prod-sub-b",
    ]);
  });
});

describe("created-product rows: catalog route (#4696)", () => {
  it("Test-Subs appears in the catalog table after creation + approval", async () => {
    const body = await catalogBody();
    const testSubs = body.products.find((p) => p.id === "created:prod-sub-test-subs");
    expect(testSubs).toBeDefined();
    expect(testSubs!.canonicalName).toBe("Test-Subs");
    expect(testSubs!.tier).toBe("Subscribed");
    expect(testSubs!.family).toBeNull();
    expect(testSubs!.priceUSD).toBe(1);
    expect(testSubs!.priceSource).toBe("plan-approved");
    expect(testSubs!.priceLabel).toBe("$1.00 / 30 days — approved plan price");
    expect(testSubs!.listed).toBe(true);
    expect(testSubs!.availability).toBe("purchasable");
    expect(testSubs!.purchasePath?.route).toContain("selling-options");
    expect(testSubs!.parityVerdict).toBe("not-routable");
    expect(testSubs!.realVsSimulated).toBe("approved plan price");
  });

  it("family rows are unchanged: still exactly the 12 family rows, then created rows", async () => {
    const body = await catalogBody();
    const familyRows = body.products.filter((p) => p.family !== null);
    expect(familyRows).toHaveLength(12);
    expect(new Set(familyRows.map((p) => p.id)).size).toBe(12);
    for (const family of ["stock", "goal", "options", "strategy"]) {
      for (const tier of ["Free", "PayPerUse", "Subscribed"]) {
        expect(familyRows.some((p) => p.id === `${family}:${tier}`)).toBe(true);
      }
    }
    expect(body.products).toHaveLength(13);
    expect(body.products[12]!.id).toBe("created:prod-sub-test-subs");
  });

  it("a PROPOSED Test-Subs is in the table unlisted, never purchasable", async () => {
    const body = await catalogBody(
      async () => [plan({ approvalStatus: "proposed", approvedBy: null, approvedAtMs: null })],
    );
    const testSubs = body.products.find((p) => p.id === "created:prod-sub-test-subs");
    expect(testSubs!.listed).toBe(false);
    expect(testSubs!.priceUSD).toBeNull();
    expect(testSubs!.availability).toBe("unlisted");
    expect(testSubs!.unlistedReasons.join(" ")).toMatch(/not approved/i);
  });

  it("fails closed with 503 when a created-product source is unavailable", async () => {
    const noPlans = await catalogRoute(null);
    expect(noPlans.status).toBe(503);
    const noProducts = await catalogRoute(async () => TEST_SUBS_PLANS, null);
    expect(noProducts.status).toBe(503);
    const plansThrow = await catalogRoute(async () => {
      throw new Error("store down");
    });
    expect(plansThrow.status).toBe(503);
    const productsThrow = await catalogRoute(async () => TEST_SUBS_PLANS, async () => {
      throw new Error("store down");
    });
    expect(productsThrow.status).toBe(503);
  });
});

describe("created-product rows: display + access (#4696)", () => {
  it("buildCatalogDisplay renders the created row's price, label, and Selling path", () => {
    const entries = buildCreatedProductRows({
      plans: TEST_SUBS_PLANS,
      products: TEST_SUBS_PRODUCTS,
      nowMs: NOW,
    });
    const access = entries.map((e) => resolveProductAccess(e, []));
    const display = buildCatalogDisplay(entries, access);
    expect(display).toHaveLength(1);
    expect(display[0]!.priceLabel).toBe("$1.00 / 30 days — approved plan price");
    expect(display[0]!.realVsSimulated).toBe("approved plan price");
    expect(display[0]!.purchasePath?.route).toContain("selling-options");
    expect(display[0]!.parityVerdict).toBe("not-routable");
    expect(display[0]!.parityNotes.join(" ")).toMatch(/Selling/i);
  });

  it("resolveProductAccess is not-routable for created rows, naming the Selling checkout", () => {
    const entries = buildCreatedProductRows({
      plans: TEST_SUBS_PLANS,
      products: TEST_SUBS_PRODUCTS,
      nowMs: NOW,
    });
    const access = resolveProductAccess(entries[0]!, []);
    expect(access.routable).toBe(false);
    expect(access.parity.verdict).toBe("not-routable");
    expect(access.panel.trigger).toMatch(/selling-options/i);
    expect(access.chat).toBeNull();
  });
});

describe("created-product rows: family-keyed guards (#4696)", () => {
  const rows: CatalogDisplayEntry[] = [
    {
      id: "stock:PayPerUse", family: "stock", tier: "PayPerUse",
      canonicalName: "Stock", servingAgent: "screener",
      priceUSD: 0.02, priceSource: "gate", priceLabel: "$0.02 per call — real (testnet) x402 gate",
      availability: "purchasable", listed: true, unlistedReasons: [],
      parityVerdict: "parity", parityNotes: [],
      purchasePath: { label: "Pay per call", route: "/api/premium/stock-signals", note: "" },
      purchasePathReason: null, realVsSimulated: "real (testnet)",
    },
    {
      id: "created:prod-sub-test-subs", family: null, tier: "Subscribed",
      canonicalName: "Test-Subs", servingAgent: null,
      priceUSD: 1, priceSource: "plan-approved", priceLabel: "$1.00 / 30 days — approved plan price",
      availability: "purchasable", listed: true, unlistedReasons: [],
      parityVerdict: "not-routable", parityNotes: [],
      purchasePath: { label: "Buy in Selling options", route: "?tab=product-hub&view=selling-options", note: "" },
      purchasePathReason: null, realVsSimulated: "approved plan price",
    },
  ];

  it("bundle member prices never include a null-family row", () => {
    expect(familyMemberPrices(rows)).toEqual({ stock: 0.02 });
  });

  it("the cfpay channel select never offers a created product", () => {
    const options = cfpayChannelOptions(rows);
    expect(options).toHaveLength(1);
    expect(options[0]!.family).toBe("stock");
  });
});

describe("created-product rows: catalog panel (#4696)", () => {
  let container: HTMLDivElement;
  let root: Root;

  async function flush(ms = 50) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
    });
  }

  afterEach(async () => {
    if (root) await act(async () => root.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("renders the created row in the catalog table with a Subscribe button", async () => {
    const fixture: CatalogDisplayEntry[] = [
      {
        id: "created:prod-sub-test-subs", family: null, tier: "Subscribed",
        canonicalName: "Test-Subs", servingAgent: null,
        priceUSD: 1, priceSource: "plan-approved", priceLabel: "$1.00 / 30 days — approved plan price",
        availability: "purchasable", listed: true, unlistedReasons: [],
        parityVerdict: "not-routable", parityNotes: ["sold through the Selling checkout"],
        purchasePath: { label: "Buy in Selling options", route: "?tab=product-hub&view=selling-options", note: "" },
        purchasePathReason: null, realVsSimulated: "approved plan price",
      },
    ];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ products: fixture }) })),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<ProductCatalogPanel onSubscribe={vi.fn()} onPreviewDraft={vi.fn()} />);
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Test-Subs");
    expect(text).toContain("$1.00 / 30 days");
    expect(text).toContain("Subscribe");
  });
});
