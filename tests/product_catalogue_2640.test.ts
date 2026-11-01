/**
 * #2640 (Platform Phase 2) — product catalog: derivation, naming identity,
 * onboarding gate, no-second-list, and the A2A wire verification.
 *
 * RED first: src/data/productCatalogue.ts does not exist yet.
 */
import { describe, it, expect } from "vitest";
import {
  buildProductCatalog,
  listedProducts,
  getProduct,
  PRODUCT_SERVING_AGENTS,
  canonicalProductName,
} from "../src/data/productCatalogue";
import type { PriceEntry } from "../src/data/priceCataloguePorts";
import { AGENT_CARDS } from "../src/a2a/agent-cards";
import { handleA2A } from "../src/a2a/index";

function entry(
  family: PriceEntry["family"],
  priceUSD: number,
  approvalStatus: PriceEntry["approvalStatus"],
): PriceEntry {
  return {
    family,
    priceUSD,
    updatedAtMs: 0,
    approvalStatus,
    approvedBy: approvalStatus === "approved" ? "operator-test" : null,
    approvedAtMs: approvalStatus === "approved" ? 1 : null,
  };
}

/** Catalogue state as seeded today: every family PROPOSED, none approved. */
const PROPOSED_SEEDS: PriceEntry[] = [
  entry("stock", 0.02, "proposed"),
  entry("goal", 0.1, "proposed"),
  entry("options", 0.05, "proposed"),
  entry("strategy", 0.1, "proposed"),
];

describe("product catalog derivation (#2640)", () => {
  it("builds exactly families × tiers rows, computed from sources", () => {
    const catalog = buildProductCatalog(PROPOSED_SEEDS);
    expect(catalog).toHaveLength(12);
    const ids = new Set(catalog.map((p) => p.id));
    for (const family of ["stock", "goal", "options", "strategy"]) {
      for (const tier of ["Free", "PayPerUse", "Subscribed"]) {
        expect(ids.has(`${family}:${tier}`)).toBe(true);
      }
    }
  });

  it("lists exactly the gate-backed PayPerUse products with gate prices", () => {
    const catalog = buildProductCatalog(PROPOSED_SEEDS);
    const listed = listedProducts(catalog);
    expect(listed.map((p) => p.id).sort()).toEqual([
      "options:PayPerUse",
      "stock:PayPerUse",
    ]);
    const stock = getProduct(catalog, "stock:PayPerUse")!;
    expect(stock.priceUSD).toBe(0.02);
    expect(stock.priceSource).toBe("gate");
    expect(stock.gateEndpoint).toBe("/api/premium/stock-signals");
    expect(stock.canonicalName).toBe("Real-Time Quant Anomaly Signals");
    expect(stock.servingAgent).toBe("screener");
    const options = getProduct(catalog, "options:PayPerUse")!;
    expect(options.priceUSD).toBe(0.05);
    expect(options.gateEndpoint).toBe("/api/premium/options-scan");
    expect(options.canonicalName).toBe(
      "E*TRADE Institutional Options & Greeks Screener",
    );
    expect(options.servingAgent).toBe("trading");
  });

  it("the MARKET_RESEARCH service has no family row: it is gate-sold, not a family product", () => {
    const catalog = buildProductCatalog(PROPOSED_SEEDS);
    expect(catalog.some((p) => p.family === ("research" as never))).toBe(false);
    expect(getProduct(catalog, "research:PayPerUse")).toBeUndefined();
    // Its gate, metering, and receipt path are unchanged from slices 1–4;
    // it enters the catalog only if a research family is ever defined in
    // the price catalogue — the machinery needs no gate-logic change then.
  });

  it("never presents a PROPOSED catalogue price as chargeable", () => {
    const catalog = buildProductCatalog(PROPOSED_SEEDS);
    const goal = getProduct(catalog, "goal:PayPerUse")!;
    expect(goal.priceUSD).toBeNull();
    expect(goal.listed).toBe(false);
    expect(goal.unlistedReasons.join(" ")).toMatch(/price/i);
    const strategy = getProduct(catalog, "strategy:PayPerUse")!;
    expect(strategy.priceUSD).toBeNull();
    expect(strategy.listed).toBe(false);
    expect(strategy.unlistedReasons.join(" ")).toMatch(/price/i);
    expect(strategy.unlistedReasons.join(" ")).toMatch(/serving card/i);
  });

  it("an APPROVED catalogue price lists only with a gate endpoint too", () => {
    const catalog = buildProductCatalog([
      entry("stock", 0.02, "proposed"),
      entry("goal", 0.1, "approved"),
      entry("options", 0.05, "proposed"),
      entry("strategy", 0.1, "proposed"),
    ]);
    const goal = getProduct(catalog, "goal:PayPerUse")!;
    expect(goal.priceUSD).toBe(0.1);
    expect(goal.priceSource).toBe("catalogue-approved");
    // Approval alone does not list: goal has no gated endpoint / metering.
    expect(goal.listed).toBe(false);
    expect(goal.unlistedReasons.join(" ")).toMatch(/gate endpoint/i);
  });

  it("a gate price always wins over an approved catalogue price", () => {
    const catalog = buildProductCatalog([
      entry("stock", 0.99, "approved"),
      entry("goal", 0.1, "proposed"),
      entry("options", 0.05, "proposed"),
      entry("strategy", 0.1, "proposed"),
    ]);
    const stock = getProduct(catalog, "stock:PayPerUse")!;
    expect(stock.priceUSD).toBe(0.02);
    expect(stock.priceSource).toBe("gate");
  });

  it("Subscribed rows are registered, never listed as purchasable, no price asserted", () => {
    const catalog = buildProductCatalog(PROPOSED_SEEDS);
    const sub = getProduct(catalog, "stock:Subscribed")!;
    expect(sub.listed).toBe(false);
    expect(sub.priceUSD).toBeNull();
    expect(sub.availability).toBe("entitlement-pending");
    expect(sub.unlistedReasons.join(" ")).toMatch(/#2405 Phase 2/);
  });

  it("Free rows are registered as ungated discovery, no price asserted", () => {
    const catalog = buildProductCatalog(PROPOSED_SEEDS);
    const free = getProduct(catalog, "stock:Free")!;
    expect(free.listed).toBe(false);
    expect(free.priceUSD).toBeNull();
    expect(free.availability).toBe("ungated-discovery");
  });

  it("a missing run-status surface blocks every PayPerUse listing", () => {
    const catalog = buildProductCatalog(PROPOSED_SEEDS, {
      runStatusSurfacePresent: false,
    });
    expect(listedProducts(catalog)).toEqual([]);
    const stock = getProduct(catalog, "stock:PayPerUse")!;
    expect(stock.unlistedReasons.join(" ")).toMatch(/run-status/i);
  });
});

describe("product naming registry (#2640)", () => {
  it("one canonical name per product id, deterministic across builds", () => {
    const a = buildProductCatalog(PROPOSED_SEEDS);
    const b = buildProductCatalog(PROPOSED_SEEDS);
    for (const row of a) {
      expect(getProduct(b, row.id)!.canonicalName).toBe(row.canonicalName);
    }
    expect(canonicalProductName("stock", "PayPerUse")).toBe(
      "Real-Time Quant Anomaly Signals",
    );
  });

  it("every listed product's serving agent resolves to a served agent card", () => {
    const catalog = buildProductCatalog(PROPOSED_SEEDS);
    const cardNames = new Set(AGENT_CARDS.map((c) => c.name));
    for (const row of listedProducts(catalog)) {
      expect(row.servingAgent).not.toBeNull();
      expect(cardNames.has(row.servingAgent!)).toBe(true);
      expect(PRODUCT_SERVING_AGENTS[row.family]).toBe(row.servingAgent);
    }
  });
});

describe("A2A publication wire (#2640)", () => {
  it("GET /.well-known/agent-card.json serves the serving agents of listed products", async () => {
    const catalog = buildProductCatalog(PROPOSED_SEEDS);
    const needed = new Set(
      listedProducts(catalog).map((p) => p.servingAgent!),
    );
    const res = await handleA2A(
      new Request("https://example.test/.well-known/agent-card.json"),
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: { name: string; endpoint: string }[] };
    const served = new Map(body.agents.map((c) => [c.name, c.endpoint]));
    for (const name of needed) {
      expect(served.has(name)).toBe(true);
      expect(served.get(name)!).toMatch(/^\/a2a\//);
    }
  });

  it("GET /.well-known/agent.json serves the same cards", async () => {
    const res = await handleA2A(
      new Request("https://example.test/.well-known/agent.json"),
      {},
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: unknown[] };
    expect(body.agents.length).toBeGreaterThan(0);
  });
});
