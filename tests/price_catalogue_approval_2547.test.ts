// @vitest-environment node
/**
 * Issue #2547 — price approval state, TDD.
 *
 * Seeded catalogue prices are proposals. A monetization gate may
 * charge only a price whose catalogue entry is APPROVED, with the
 * approver and approval time recorded on the entry. Changing a
 * price returns the entry to PROPOSED (a new price is a new
 * proposal), and both monetization gates fail closed on a
 * proposed price exactly as they do on a missing one.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  createD1PriceCatalogueDb,
  D1PriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
} from "../src/data/d1PriceCatalogueAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import type { PriceCatalogue } from "../src/data/priceCataloguePorts";
import {
  NativeMonetizationGate,
  type NativeMonetizationConfig,
} from "../src/services/nativeMonetization";
import {
  CfPayMonetizationGate,
  type CfPayCheckoutClient,
  type CommercialAccount,
} from "../src/services/cfpayMonetization";

class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid }, results: [] };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db.prepare(sql).all(...(params as any[])).map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

async function catalogues(): Promise<Array<{ name: string; catalogue: PriceCatalogue }>> {
  const mock = new MockD1Database();
  const db = createD1PriceCatalogueDb(mock as unknown as D1Database);
  await ensurePriceCatalogueSchema(db);
  return [
    { name: "in-memory", catalogue: new InMemoryPriceCatalogueAdapter() },
    { name: "drizzle-d1", catalogue: new D1PriceCatalogueAdapter(db) },
  ];
}

function account(): CommercialAccount {
  return { userId: "u1", email: "u1@example.com", tenantId: "t1", tier: "Free", creditsUSD: 0, includedRunsRemaining: 0 };
}

function cfpayClient(): CfPayCheckoutClient {
  return {
    createCheckout: async () => ({ checkoutId: "chk-1" }),
    checkoutStatus: async () => ({ status: "fulfilled" }),
  };
}

describe("price approval state (#2547)", () => {
  it("seeds land as PROPOSED with no approver recorded", async () => {
    for (const { catalogue } of await catalogues()) {
      const entries = await catalogue.getAllPrices();
      expect(entries.length).toBe(4);
      for (const entry of entries) {
        expect(entry.approvalStatus).toBe("proposed");
        expect(entry.approvedBy).toBeNull();
        expect(entry.approvedAtMs).toBeNull();
      }
      expect(await catalogue.getApprovedPrice("stock")).toBeNull();
    }
  });

  it("approvePrice records approver + timestamp and makes the price chargeable", async () => {
    for (const { catalogue } of await catalogues()) {
      const before = Date.now();
      const entry = await catalogue.approvePrice({ family: "stock", approverId: "cpo-operator" });
      expect(entry.approvalStatus).toBe("approved");
      expect(entry.approvedBy).toBe("cpo-operator");
      expect(entry.approvedAtMs).toBeGreaterThanOrEqual(before);
      expect(await catalogue.getApprovedPrice("stock")).toBe(0.02);
      // Other families stay proposed.
      expect(await catalogue.getApprovedPrice("goal")).toBeNull();
    }
  });

  it("approvePrice refuses an unknown family, a blank approver, and a family with no stored price", async () => {
    for (const { catalogue } of await catalogues()) {
      await expect(catalogue.approvePrice({ family: "nope", approverId: "op" })).rejects.toThrow(/family/);
      await expect(catalogue.approvePrice({ family: "stock", approverId: "  " })).rejects.toThrow(/approver/);
    }
    const empty = new InMemoryPriceCatalogueAdapter({});
    await expect(empty.approvePrice({ family: "stock", approverId: "op" })).rejects.toThrow(/No stored price/);
  });

  it("setPrice returns the entry to PROPOSED and clears the approval record", async () => {
    for (const { catalogue } of await catalogues()) {
      await catalogue.approvePrice({ family: "goal", approverId: "cpo-operator" });
      expect(await catalogue.getApprovedPrice("goal")).toBe(0.1);
      const entry = await catalogue.setPrice({ family: "goal", priceUSD: 0.25 });
      expect(entry.approvalStatus).toBe("proposed");
      expect(entry.approvedBy).toBeNull();
      expect(entry.approvedAtMs).toBeNull();
      expect(await catalogue.getApprovedPrice("goal")).toBeNull();
    }
  });

  it("NativeMonetizationGate refuses a proposed price and charges an approved one", async () => {
    for (const { catalogue } of await catalogues()) {
      const config: NativeMonetizationConfig = {
        monetizationEnabled: true,
        priceCatalogue: catalogue,
        checkout: null,
      };
      const gate = new NativeMonetizationGate(config);
      await expect(gate.priceFor("stock")).rejects.toThrow(/not approved|No approved/);
      await catalogue.approvePrice({ family: "stock", approverId: "cpo-operator" });
      await expect(gate.priceFor("stock")).resolves.toBe(0.02);
    }
  });

  it("flag OFF stays free with only proposed prices (approval gates charging, not free runs)", async () => {
    for (const { catalogue } of await catalogues()) {
      const gate = new CfPayMonetizationGate(cfpayClient(), {
        monetizationEnabled: false,
        network: "base-sepolia",
        priceCatalogue: catalogue,
      });
      const decision = await gate.check({ id: "run-free", family: "goal", trigger: "manual", tenantId: "t1", account: account() });
      expect(decision).toEqual({ allowed: true, status: "free_flag_off", runRequestId: "run-free", priceUSD: 0 });
    }
  });

  it("CfPayMonetizationGate refuses a proposed price and prices an approved one", async () => {
    for (const { catalogue } of await catalogues()) {
      const gate = new CfPayMonetizationGate(cfpayClient(), {
        monetizationEnabled: true,
        network: "base-sepolia",
        priceCatalogue: catalogue,
      });
      await expect(gate.priceFor("goal")).rejects.toThrow(/not approved|No approved/);
      await catalogue.approvePrice({ family: "goal", approverId: "cpo-operator" });
      await expect(gate.priceFor("goal")).resolves.toBe(0.1);
      const decision = await gate.check({ id: "run-approved", family: "goal", trigger: "manual", tenantId: "t1", account: account() });
      expect(decision.allowed).toBe(false);
      if (!decision.allowed) expect(decision.priceUSD).toBe(0.1);
    }
  });
});
