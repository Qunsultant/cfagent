// @vitest-environment node
/**
 * Issue #2185 (sub-issue of #2012) — externalized price catalogue
 * port conformance + gate wiring + operator route + structural
 * pins, TDD.
 *
 * The port suite runs UNCHANGED against the Drizzle D1 adapter
 * (over a MockD1Database backed by node:sqlite — no Cloudflare
 * credentials, no live D1 calls) and the in-memory adapter. A
 * behavior that passes on one adapter and fails on the other is
 * a layer defect, not an application bug.
 *
 * Pinned contracts:
 *  - Seed defaults (PROPOSED, pending owner approval): stock
 *    $0.02, goal $0.10, options $0.05, strategy $0.10 — written
 *    by ensure (D1) or construction (in-memory), never read
 *    from code by the gate.
 *  - Missing/empty price data reads as null, and the gate fails
 *    closed on it: no checkout is minted, no coverage consumed.
 *  - An operator price change is honored by the gate with no code
 *    deploy, and survives a re-ensure (INSERT OR IGNORE seeding).
 *  - Gate tenant checks still hold; flag-OFF free path unchanged.
 *  - Migration 0011 owns the catalogue DDL; the Drizzle schema
 *    maps it (column parity pinned here).
 *  - Port modules never import a store client; the gate module
 *    never imports a store client and holds no price table
 *    (structural grep pins, ADR 0002 R1).
 *  - Operator upsert route: COMMERCIAL_STORE_OPERATORS gating
 *    (empty = deny all), 400 on invalid input, 503 when the
 *    store is unbound.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import {
  createD1PriceCatalogueDb,
  D1PriceCatalogueAdapter,
  ensurePriceCatalogueSchema,
} from "../src/data/d1PriceCatalogueAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { createPriceCatalogueAdapter } from "../src/data/createPriceCataloguePorts";
import {
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  applyMigrations,
  type MigrationDb,
} from "../src/data/migrationRunner";
import { agentPriceCatalogue } from "../src/data/drizzleSchema";
import {
  PROPOSED_SEED_PRICES,
  type PriceCatalogue,
} from "../src/data/priceCataloguePorts";
import {
  CfPayMonetizationGate,
  type CfPayCheckoutClient,
  type CommercialAccount,
} from "../src/services/cfpayMonetization";
import {
  handleAgenticPaymentsRoutes,
  type AgenticPaymentsRouteContext,
} from "../src/agents/routes/agenticPayments";
import type { DatabaseORM } from "../src/orm";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice0). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

async function seededAdapters(): Promise<Array<{ name: string; catalogue: PriceCatalogue }>> {
  const mock = new MockD1Database();
  const db = createD1PriceCatalogueDb(mock as unknown as D1Database);
  await ensurePriceCatalogueSchema(db);
  return [
    { name: "in-memory", catalogue: new InMemoryPriceCatalogueAdapter() },
    { name: "drizzle", catalogue: new D1PriceCatalogueAdapter(db) },
  ];
}

async function emptyAdapters(): Promise<Array<{ name: string; catalogue: PriceCatalogue }>> {
  const mock = new MockD1Database();
  const db = createD1PriceCatalogueDb(mock as unknown as D1Database);
  // Migrations only, no ensure seeding: the table exists (at the
  // current schema, 0011 + the #2547 approval columns of 0027)
  // but holds no rows.
  await applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0011_PRICE_CATALOGUE,
    MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  ]);
  return [
    { name: "in-memory", catalogue: new InMemoryPriceCatalogueAdapter({}) },
    { name: "drizzle", catalogue: new D1PriceCatalogueAdapter(db) },
  ];
}

describe("price catalogue port contract (#2185)", () => {
  it("seeds the proposed defaults", async () => {
    for (const { catalogue } of await seededAdapters()) {
      expect(await catalogue.getPrice("stock")).toBe(0.02);
      expect(await catalogue.getPrice("goal")).toBe(0.1);
      expect(await catalogue.getPrice("options")).toBe(0.05);
      expect(await catalogue.getPrice("strategy")).toBe(0.1);
      expect(await catalogue.getPrice("nope")).toBeNull();
      const all = await catalogue.getAllPrices();
      expect(all.map((e) => e.family).sort()).toEqual(["goal", "options", "stock", "strategy"]);
      expect(Object.fromEntries(all.map((e) => [e.family, e.priceUSD]))).toEqual({
        ...PROPOSED_SEED_PRICES,
      });
    }
  });

  it("rejects invalid families and prices, rounds to the cent", async () => {
    for (const { catalogue } of await seededAdapters()) {
      await expect(catalogue.setPrice({ family: "nope", priceUSD: 0.1 })).rejects.toThrow(/family/);
      await expect(catalogue.setPrice({ family: "goal", priceUSD: 0 })).rejects.toThrow(/priceUSD/);
      await expect(catalogue.setPrice({ family: "goal", priceUSD: -1 })).rejects.toThrow(/priceUSD/);
      await expect(catalogue.setPrice({ family: "goal", priceUSD: Number.NaN })).rejects.toThrow(/priceUSD/);
      const entry = await catalogue.setPrice({ family: "goal", priceUSD: 0.125 });
      expect(entry.priceUSD).toBe(0.13);
      expect(await catalogue.getPrice("goal")).toBe(0.13);
    }
  });

  it("reads missing/empty price data as null, never a guessed price", async () => {
    for (const { catalogue } of await emptyAdapters()) {
      expect(await catalogue.getPrice("stock")).toBeNull();
      expect(await catalogue.getPrice("goal")).toBeNull();
      expect(await catalogue.getAllPrices()).toEqual([]);
    }
  });

  it("an operator edit survives re-ensure on D1", async () => {
    const mock = new MockD1Database();
    const db = createD1PriceCatalogueDb(mock as unknown as D1Database);
    await ensurePriceCatalogueSchema(db);
    const catalogue = new D1PriceCatalogueAdapter(db);
    await catalogue.setPrice({ family: "goal", priceUSD: 0.25 });
    await ensurePriceCatalogueSchema(db);
    expect(await catalogue.getPrice("goal")).toBe(0.25);
    expect(await catalogue.getPrice("stock")).toBe(0.02);
  });

  it("an invalid stored row reads as missing on D1 (fail-closed read)", async () => {
    const mock = new MockD1Database();
    const db = createD1PriceCatalogueDb(mock as unknown as D1Database);
    await ensurePriceCatalogueSchema(db);
    // Bypass adapter validation: write a bad row straight through Drizzle.
    await db.insert(agentPriceCatalogue).values({ family: "goal", priceUSD: -5, updatedAtMs: Date.now() }).onConflictDoUpdate({
      target: agentPriceCatalogue.family,
      set: { priceUSD: -5, updatedAtMs: Date.now() },
    });
    const catalogue = new D1PriceCatalogueAdapter(db);
    expect(await catalogue.getPrice("goal")).toBeNull();
  });

  it("composition root returns null when AGENT_DB is unbound", () => {
    expect(createPriceCatalogueAdapter({})).toBeNull();
    expect(createPriceCatalogueAdapter({ AGENT_DB: undefined })).toBeNull();
    const mock = new MockD1Database();
    expect(createPriceCatalogueAdapter({ AGENT_DB: mock })).not.toBeNull();
  });
});

describe("gate prices from the catalogue port (#2185)", () => {
  function stubCfpay() {
    const calls: string[] = [];
    const client: CfPayCheckoutClient = {
      createCheckout: async () => {
        calls.push("createCheckout");
        return { checkoutId: "chk-1" };
      },
      checkoutStatus: async () => ({ status: "fulfilled" }),
    };
    return { client, calls };
  }

  function account(overrides: Partial<CommercialAccount> = {}): CommercialAccount {
    return {
      userId: "u1",
      email: "u1@example.com",
      tenantId: "t1",
      tier: "Free",
      creditsUSD: 0,
      includedRunsRemaining: 0,
      ...overrides,
    };
  }

  it("charges the catalogue price, not a code price", async () => {
    for (const { catalogue } of await seededAdapters()) {
      // #2547: seeded prices are proposals; an operator approval
      // is what makes the goal price chargeable.
      await catalogue.approvePrice({ family: "goal", approverId: "test-operator" });
      const { client } = stubCfpay();
      const gate = new CfPayMonetizationGate(client, {
        monetizationEnabled: true,
        network: "base-sepolia",
        priceCatalogue: catalogue,
      });
      const decision = await gate.check({
        id: "run-1",
        family: "goal",
        trigger: "manual",
        tenantId: "t1",
        account: account(),
      });
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error("expected payment_required");
      expect(decision.priceUSD).toBe(0.1);
    }
  });

  it("honors an operator price change with no code deploy", async () => {
    for (const { catalogue } of await seededAdapters()) {
      await catalogue.setPrice({ family: "goal", priceUSD: 0.25 });
      // #2547: the changed price is a new proposal until approved.
      await catalogue.approvePrice({ family: "goal", approverId: "test-operator" });
      const { client } = stubCfpay();
      const gate = new CfPayMonetizationGate(client, {
        monetizationEnabled: true,
        network: "base-sepolia",
        priceCatalogue: catalogue,
      });
      // 0.10 credits covered the old price; they must not cover the new one.
      const decision = await gate.check({
        id: "run-2",
        family: "goal",
        trigger: "manual",
        tenantId: "t1",
        account: account({ creditsUSD: 0.1 }),
      });
      expect(decision.allowed).toBe(false);
      if (decision.allowed) throw new Error("expected payment_required");
      expect(decision.priceUSD).toBe(0.25);
    }
  });

  it("fail-closed: missing/empty price data mints no checkout and consumes nothing", async () => {
    for (const { catalogue } of await emptyAdapters()) {
      const { client, calls } = stubCfpay();
      const gate = new CfPayMonetizationGate(client, {
        monetizationEnabled: true,
        network: "base-sepolia",
        priceCatalogue: catalogue,
      });
      await expect(
        gate.check({ id: "run-3", family: "goal", trigger: "manual", tenantId: "t1", account: account() }),
      ).rejects.toThrow(/No valid stored price/);
      expect(calls).toEqual([]);
    }
  });

  it("fail-closed: no catalogue configured mints no checkout", async () => {
    const { client, calls } = stubCfpay();
    const gate = new CfPayMonetizationGate(client, {
      monetizationEnabled: true,
      network: "base-sepolia",
      priceCatalogue: null,
    });
    await expect(
      gate.check({ id: "run-4", family: "goal", trigger: "manual", tenantId: "t1", account: account() }),
    ).rejects.toThrow(/not configured/);
    expect(calls).toEqual([]);
  });

  it("gate tenant checks still hold", async () => {
    for (const { catalogue } of await seededAdapters()) {
      const { client } = stubCfpay();
      const gate = new CfPayMonetizationGate(client, {
        monetizationEnabled: true,
        network: "base-sepolia",
        priceCatalogue: catalogue,
      });
      await expect(
        gate.check({ id: "run-5", family: "goal", trigger: "manual", tenantId: "other", account: account() }),
      ).rejects.toThrow(/Tenant mismatch/);
      await expect(
        gate.check({ id: "run-6", family: "goal", trigger: "manual", tenantId: "t1", account: account({ userId: "" }) }),
      ).rejects.toThrow(/Verified user id/);
    }
  });

  it("flag-OFF free path is unchanged with a catalogue present", async () => {
    for (const { catalogue } of await seededAdapters()) {
      const { client } = stubCfpay();
      const gate = new CfPayMonetizationGate(client, {
        monetizationEnabled: false,
        network: "base-sepolia",
        priceCatalogue: catalogue,
      });
      const decision = await gate.check({
        id: "run-7",
        family: "goal",
        trigger: "manual",
        tenantId: "t1",
        account: account(),
      });
      expect(decision).toEqual({ allowed: true, status: "free_flag_off", runRequestId: "run-7", priceUSD: 0 });
    }
  });
});

describe("operator price upsert route (#2185)", () => {
  const req = (method: string, path: string, login: string | null, body?: unknown) =>
    new Request(`https://agent.internal${path}`, {
      method,
      headers: {
        ...(login ? { "x-user-login": login } : {}),
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });

  const call = (
    ctx: AgenticPaymentsRouteContext,
    method: string,
    path: string,
    login: string | null,
    body?: unknown,
  ) => {
    const url = new URL(`https://agent.internal${path}`);
    return handleAgenticPaymentsRoutes(req(method, path, login, body), url, url.pathname, "sess-1", ctx);
  };

  function ctxWith(env: Record<string, unknown>) {
    return {
      env,
      getOrm: () => ({}) as DatabaseORM,
      audit: vi.fn(),
    } as unknown as AgenticPaymentsRouteContext;
  }

  it("operator upserts; the pricing route then reflects the edit; others are refused", async () => {
    const mock = new MockD1Database();
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    const upserted = await call(ctx, "POST", "/payments/agentic/commercial/prices", "op1", {
      family: "goal",
      priceUSD: 0.25,
    });
    expect(upserted?.status).toBe(200);
    expect(((await upserted?.json()) as { entry: { family: string; priceUSD: number } }).entry).toEqual(
      expect.objectContaining({ family: "goal", priceUSD: 0.25 }),
    );
    const pricing = await call(ctx, "GET", "/payments/agentic/commercial/pricing", "u1");
    expect(pricing?.status).toBe(200);
    expect((((await pricing?.json()) as { prices: Record<string, number> }).prices).goal).toBe(0.25);

    const denied = await call(ctx, "POST", "/payments/agentic/commercial/prices", "u1", {
      family: "goal",
      priceUSD: 0.3,
    });
    expect(denied?.status).toBe(403);
    const anon = await call(ctx, "POST", "/payments/agentic/commercial/prices", null, {
      family: "goal",
      priceUSD: 0.3,
    });
    expect(anon?.status).toBe(403);
  });

  it("empty operator list denies all; invalid input is 400; unbound store is 503", async () => {
    const mock = new MockD1Database();
    const noOps = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "" });
    expect(
      (await call(noOps, "POST", "/payments/agentic/commercial/prices", "op1", { family: "goal", priceUSD: 0.2 }))?.status,
    ).toBe(403);
    const ctx = ctxWith({ AGENT_DB: mock, COMMERCIAL_STORE_OPERATORS: "op1" });
    expect(
      (await call(ctx, "POST", "/payments/agentic/commercial/prices", "op1", { family: "nope", priceUSD: 0.2 }))?.status,
    ).toBe(400);
    expect(
      (await call(ctx, "POST", "/payments/agentic/commercial/prices", "op1", { family: "goal", priceUSD: 0 }))?.status,
    ).toBe(400);
    const unbound = ctxWith({ COMMERCIAL_STORE_OPERATORS: "op1" });
    expect(
      (await call(unbound, "POST", "/payments/agentic/commercial/prices", "op1", { family: "goal", priceUSD: 0.2 }))?.status,
    ).toBe(503);
  });
});

describe("price catalogue structural pins (#2185, ADR 0002 R1)", () => {
  function importLines(file: string): string[] {
    return readFileSync(resolve(__dirname, `../src/${file}`), "utf8")
      .split("\n")
      .filter((line) => line.startsWith("import "));
  }

  function fullText(file: string): string {
    return readFileSync(resolve(__dirname, `../src/${file}`), "utf8");
  }

  it("port module imports no store client and writes no SQL", () => {
    const imports = importLines("data/priceCataloguePorts.ts").join("\n");
    expect(imports).not.toContain("drizzle-orm");
    expect(imports).not.toContain("D1Database");
    expect(imports).not.toContain("d1PriceCatalogueAdapter");
    expect(imports).not.toContain("inMemoryPriceCatalogueAdapter");
    const text = fullText("data/priceCataloguePorts.ts");
    expect(text).not.toContain("AGENT_DB");
    expect(text).not.toContain("CREATE TABLE");
    expect(text).not.toContain("SELECT ");
  });

  it("gate module imports no store client, references no env binding, holds no price table", () => {
    const imports = importLines("services/cfpayMonetization.ts").join("\n");
    expect(imports).not.toContain("drizzle-orm");
    expect(imports).not.toContain("D1Database");
    expect(imports).not.toContain("d1PriceCatalogueAdapter");
    expect(imports).not.toContain("inMemoryPriceCatalogueAdapter");
    const text = fullText("services/cfpayMonetization.ts");
    expect(text).not.toContain("AGENT_DB");
    expect(text).not.toContain("FAMILY_PRICES");
    expect(text).toContain("priceCatalogue");
  });

  it("migration DDL and Drizzle schema agree on columns", () => {
    const rawColumns = getTableConfig(agentPriceCatalogue).columns as any;
    const schemaColumns = Array.isArray(rawColumns)
      ? rawColumns.map((c: any) => c.name as string)
      : Object.keys(rawColumns).map((s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    const block = MIGRATION_0011_PRICE_CATALOGUE.sql.split(
      "CREATE TABLE IF NOT EXISTS agent_price_catalogue (",
    )[1].split(");")[0];
    const ddlColumns = [...block.matchAll(/^\s{2}(\w+) /gm)].map((m) => m[1]);
    // #2547: migration 0027 adds the approval columns by ALTER.
    const alterColumns = [...MIGRATION_0027_PRICE_CATALOGUE_APPROVAL.sql.matchAll(/ADD COLUMN (\w+)/g)].map(
      (m) => m[1],
    );
    expect([...ddlColumns, ...alterColumns].sort()).toEqual(schemaColumns.sort());
  });
});
