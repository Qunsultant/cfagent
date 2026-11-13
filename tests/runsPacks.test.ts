// @vitest-environment node
/**
 * Issue #3246 (slice 3, sub-issue of #3241) — runs packs: the
 * port asserts, the in-memory adapters, and the D1 adapters over
 * node:sqlite, plus migration 0063 (versions + balances + drafts).
 *
 * A pack is a prepaid bundle of runs with NO tier, NO
 * subscription row, and NO expiry in v1: buying one credits a
 * dedicated per-login balance, and the gate spends that balance
 * AFTER subscription included runs and BEFORE credits. A version
 * lands PROPOSED (only an operator approval makes its price
 * buyable); the version NUMBER is server-assigned (max + 1 per
 * product+segment). The balance spend is a single conditional
 * decrement, so a concurrent double-spend is refused; the draft
 * claim is a single conditional transition, so exactly one
 * confirmer can own the credit.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ALL_MIGRATIONS, applyMigrations, type MigrationDb } from "../src/data/migrationRunner";
import {
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0012_NATIVE_LEDGER,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
} from "../src/data/migrationRunner";
import { createD1ProductDb, D1ProductAdapter } from "../src/data/d1ProductAdapter";
import {
  createD1RunsPackDb,
  D1RunsPackBalanceAdapter,
  D1RunsPackDraftAdapter,
  D1RunsPackVersionAdapter,
  ensureRunsPackSchema,
} from "../src/data/d1RunsPackAdapter";
import {
  InMemoryRunsPackBalanceAdapter,
  InMemoryRunsPackDraftAdapter,
  InMemoryRunsPackVersionAdapter,
} from "../src/data/inMemoryRunsPackAdapter";
import {
  assertRunsPackPriceUSD,
  assertRunsPackRuns,
  assertRunsPackVersionInput,
  RunsPackClaimRefusedError,
  type RunsPackDraft,
} from "../src/data/runsPackPorts";
import { resolveEffectiveVersion } from "../src/data/productPorts";

const NOW = Date.UTC(2026, 10, 12, 12, 0, 0);

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

function makeDraft(overrides: Partial<RunsPackDraft> = {}): RunsPackDraft {
  return {
    id: "pack-1",
    userLogin: "u1",
    tenantId: "t1",
    email: "u1@example.com",
    versionId: "packver-1",
    productId: "prod-pack-10",
    runs: 10,
    priceUSD: 4.99,
    rail: "card",
    status: "minted",
    createdAtMs: NOW,
    creditedAtMs: null,
    paymentIntentId: null,
    checkoutSessionId: "cs_test_1",
    challengeNonce: null,
    ...overrides,
  };
}

/**
 * A D1 store with the pack tables applied. Migration 0058's own
 * prerequisite note (migrationRunner.ts) requires 0007, 0008,
 * 0009, 0011, 0012 and 0027 before 0058 — so the prerequisites
 * are applied first, exactly as the route path does via
 * ensureStores, and then ensureRunsPackSchema applies 0058 +
 * 0063. See the dedicated discrepancy test below for the gap:
 * ensureRunsPackSchema alone on an empty store does NOT carry
 * those prerequisites.
 */
async function makeD1() {
  const mock = new MockD1Database();
  const db = createD1RunsPackDb(mock as unknown as D1Database);
  await applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0007_COMMERCIAL_STORE,
    MIGRATION_0008_SUBSCRIPTIONS,
    MIGRATION_0009_JOURNAL,
    MIGRATION_0011_PRICE_CATALOGUE,
    MIGRATION_0012_NATIVE_LEDGER,
    MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  ]);
  await ensureRunsPackSchema(db);
  return {
    mock,
    versions: new D1RunsPackVersionAdapter(db),
    balance: new D1RunsPackBalanceAdapter(db),
    drafts: new D1RunsPackDraftAdapter(db),
  };
}

describe("runs-pack input validation (#3246 slice 3)", () => {
  it("runs must be a positive integer", () => {
    expect(assertRunsPackRuns(10)).toBe(10);
    for (const bad of [0, -1, 1.5, "10", null, undefined, NaN]) {
      expect(() => assertRunsPackRuns(bad)).toThrow(/positive integer/);
    }
  });

  it("price must be finite, positive, and at most two decimals (whole cents)", () => {
    expect(assertRunsPackPriceUSD(4.99)).toBe(4.99);
    expect(assertRunsPackPriceUSD(5)).toBe(5);
    for (const bad of [0, -1, 10.555, 10.005, NaN, Infinity, "4.99", null, undefined]) {
      expect(() => assertRunsPackPriceUSD(bad)).toThrow();
    }
  });

  it("valid 2-decimal prices validate (binary-float tolerance: 2.49 * 100 is 249.00000000000003)", () => {
    // assertRunsPackPriceUSD compares with a tolerance, not an
    // exact `Math.round(n * 100) !== n * 100` — the exact compare
    // rejects valid whole-cent prices (2.49, 0.29, 19.99) on
    // binary floating-point error.
    expect(assertRunsPackPriceUSD(2.49)).toBe(2.49);
    expect(assertRunsPackPriceUSD(0.29)).toBe(0.29);
    expect(assertRunsPackPriceUSD(19.99)).toBe(19.99);
  });

  it("version input defaults the segment and effectiveFromMs, and rejects bad terms", () => {
    const valid = assertRunsPackVersionInput(
      { productId: "prod-pack-10", runs: 10, priceUSD: 4.99 },
      NOW,
    );
    expect(valid).toEqual({
      productId: "prod-pack-10",
      segment: "default",
      runs: 10,
      priceUSD: 4.99,
      effectiveFromMs: NOW,
      effectiveToMs: null,
    });
    expect(() =>
      assertRunsPackVersionInput({ productId: "  ", runs: 10, priceUSD: 4.99 }, NOW),
    ).toThrow(/productId is required/);
    expect(() =>
      assertRunsPackVersionInput({ productId: "prod-pack-10", runs: 0, priceUSD: 4.99 }, NOW),
    ).toThrow(/positive integer/);
    expect(() =>
      assertRunsPackVersionInput({ productId: "prod-pack-10", runs: 10, priceUSD: 10.555 }, NOW),
    ).toThrow(/two decimal places/);
    expect(() =>
      assertRunsPackVersionInput(
        { productId: "prod-pack-10", runs: 10, priceUSD: 4.99, effectiveToMs: NOW - 1 },
        NOW,
      ),
    ).toThrow(/after effectiveFromMs/);
  });
});

describe("runs-pack versions (in-memory)", () => {
  it("a created version lands PROPOSED, active, version 1, with the default segment", async () => {
    const store = new InMemoryRunsPackVersionAdapter();
    const version = await store.createVersion({
      productId: "prod-pack-10",
      runs: 10,
      priceUSD: 4.99,
      effectiveFromMs: NOW,
    });
    expect(version.id).toMatch(/^packver-/);
    expect(version).toMatchObject({
      productId: "prod-pack-10",
      version: 1,
      segment: "default",
      runs: 10,
      priceUSD: 4.99,
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
      active: true,
      effectiveFromMs: NOW,
      effectiveToMs: null,
    });
    expect(await store.getVersion(version.id)).toEqual(version);
  });

  it("version numbers increment per product+segment, never across them", async () => {
    const store = new InMemoryRunsPackVersionAdapter();
    const a1 = await store.createVersion({ productId: "prod-a", runs: 10, priceUSD: 4.99, effectiveFromMs: NOW - 3000 });
    const a2 = await store.createVersion({ productId: "prod-a", runs: 20, priceUSD: 8.99, effectiveFromMs: NOW - 2000 });
    const aEnt = await store.createVersion({
      productId: "prod-a",
      segment: "enterprise",
      runs: 10,
      priceUSD: 4.99,
      effectiveFromMs: NOW - 1000,
    });
    const b1 = await store.createVersion({ productId: "prod-b", runs: 10, priceUSD: 4.99, effectiveFromMs: NOW });
    expect([a1.version, a2.version, aEnt.version, b1.version]).toEqual([1, 2, 1, 1]);
    // No segment filter reads every segment of the product, in
    // effectiveFromMs order.
    expect((await store.listVersions("prod-a")).map((v) => `${v.segment}:v${v.version}`)).toEqual([
      "default:v1",
      "default:v2",
      "enterprise:v1",
    ]);
    expect((await store.listVersions("prod-a", "default")).map((v) => v.version)).toEqual([1, 2]);
    expect((await store.listVersions("prod-a", "enterprise")).map((v) => v.version)).toEqual([1]);
    expect(await store.getVersion("packver-missing")).toBeNull();
  });

  it("approve makes the price buyable and records the approver; deactivate blocks new purchases", async () => {
    const store = new InMemoryRunsPackVersionAdapter();
    const version = await store.createVersion({ productId: "prod-pack-10", runs: 10, priceUSD: 4.99 });
    const approved = await store.approveVersion(version.id, "op1");
    expect(approved).toMatchObject({
      approvalStatus: "approved",
      approvedBy: "op1",
    });
    expect(typeof approved.approvedAtMs).toBe("number");
    const deactivated = await store.deactivateVersion(version.id);
    expect(deactivated.active).toBe(false);
    expect(deactivated.approvalStatus).toBe("approved");
    await expect(store.approveVersion("packver-missing", "op1")).rejects.toThrow(/No runs-pack version/);
    await expect(store.deactivateVersion("packver-missing")).rejects.toThrow(/No runs-pack version/);
  });

  it("createVersion rejects invalid terms (runs <= 0, price <= 0 or > 2 decimals)", async () => {
    const store = new InMemoryRunsPackVersionAdapter();
    await expect(
      store.createVersion({ productId: "prod-pack-10", runs: 0, priceUSD: 4.99 }),
    ).rejects.toThrow(/positive integer/);
    await expect(
      store.createVersion({ productId: "prod-pack-10", runs: 10, priceUSD: 0 }),
    ).rejects.toThrow(/positive number/);
    await expect(
      store.createVersion({ productId: "prod-pack-10", runs: 10, priceUSD: 10.555 }),
    ).rejects.toThrow(/two decimal places/);
  });

  it("effective resolution picks the latest effective version and skips inactive and future ones", async () => {
    const store = new InMemoryRunsPackVersionAdapter();
    const old = await store.createVersion({
      productId: "prod-pack-10",
      runs: 10,
      priceUSD: 4.99,
      effectiveFromMs: NOW - 2000,
    });
    const current = await store.createVersion({
      productId: "prod-pack-10",
      runs: 20,
      priceUSD: 8.99,
      effectiveFromMs: NOW - 1000,
    });
    const future = await store.createVersion({
      productId: "prod-pack-10",
      runs: 30,
      priceUSD: 12.99,
      effectiveFromMs: NOW + 1000,
    });
    const versions = await store.listVersions("prod-pack-10");
    expect(resolveEffectiveVersion(versions, "default", NOW)?.id).toBe(current.id);
    await store.deactivateVersion(current.id);
    const afterDeactivate = await store.listVersions("prod-pack-10");
    expect(resolveEffectiveVersion(afterDeactivate, "default", NOW)?.id).toBe(old.id);
    expect(resolveEffectiveVersion(versions, "enterprise", NOW)).toBeNull();
    expect(future.id).not.toBe(resolveEffectiveVersion(versions, "default", NOW)?.id);
  });
});

describe("runs-pack balance (in-memory)", () => {
  it("reads 0 before any purchase and accumulates credited runs", async () => {
    const balance = new InMemoryRunsPackBalanceAdapter();
    expect(await balance.getBalance("u1")).toBe(0);
    expect(await balance.addPackRuns("u1", 10)).toBe(10);
    expect(await balance.addPackRuns("u1", 5)).toBe(15);
    expect(await balance.getBalance("u1")).toBe(15);
    expect(await balance.getBalance("u2")).toBe(0);
  });

  it("consume spends one run; a second consume on a balance of 1 is refused", async () => {
    const balance = new InMemoryRunsPackBalanceAdapter();
    await balance.addPackRuns("u1", 1);
    expect(await balance.consumePackRun({ login: "u1" })).toEqual({ allowed: true, remaining: 0 });
    expect(await balance.consumePackRun({ login: "u1" })).toEqual({ allowed: false, remaining: 0 });
    expect(await balance.getBalance("u1")).toBe(0);
  });

  it("consume on an empty balance is refused and never goes negative", async () => {
    const balance = new InMemoryRunsPackBalanceAdapter();
    expect(await balance.consumePackRun({ login: "u1" })).toEqual({ allowed: false, remaining: 0 });
    expect(await balance.getBalance("u1")).toBe(0);
  });

  it("addPackRuns rejects non-positive runs", async () => {
    const balance = new InMemoryRunsPackBalanceAdapter();
    await expect(balance.addPackRuns("u1", 0)).rejects.toThrow(/positive integer/);
    await expect(balance.addPackRuns("u1", -5)).rejects.toThrow(/positive integer/);
  });
});

describe("runs-pack drafts (in-memory)", () => {
  it("round-trips a draft and lists by user in creation order", async () => {
    const drafts = new InMemoryRunsPackDraftAdapter();
    expect(await drafts.getDraft("pack-missing")).toBeNull();
    expect(await drafts.listByUser("u1")).toEqual([]);
    const first = await drafts.createDraft(makeDraft({ id: "pack-1", createdAtMs: NOW }));
    const second = await drafts.createDraft(makeDraft({ id: "pack-2", createdAtMs: NOW + 1000 }));
    expect(await drafts.getDraft("pack-1")).toEqual(first);
    expect((await drafts.listByUser("u1")).map((d) => d.id)).toEqual(["pack-1", "pack-2"]);
    expect(await drafts.listByUser("u2")).toEqual([]);
    expect(second.status).toBe("minted");
  });

  it("claim-twice is refused; a credited draft cannot be claimed again", async () => {
    const drafts = new InMemoryRunsPackDraftAdapter();
    await drafts.createDraft(makeDraft());
    const claimed = await drafts.claimForCredit("pack-1");
    expect(claimed.status).toBe("crediting");
    await expect(drafts.claimForCredit("pack-1")).rejects.toThrowError(RunsPackClaimRefusedError);
    const marked = await drafts.markCredited("pack-1", {
      creditedAtMs: NOW + 1000,
      paymentIntentId: "pi_test_1",
      checkoutSessionId: "cs_test_1",
    });
    expect(marked.status).toBe("credited");
    expect(marked.creditedAtMs).toBe(NOW + 1000);
    expect(marked.paymentIntentId).toBe("pi_test_1");
    await expect(drafts.claimForCredit("pack-1")).rejects.toThrowError(RunsPackClaimRefusedError);
    await expect(
      drafts.markCredited("pack-1", { creditedAtMs: NOW + 2000, paymentIntentId: null, checkoutSessionId: null }),
    ).rejects.toThrow(/already credited/);
  });

  it("release-then-claim works; release on a minted draft is refused", async () => {
    const drafts = new InMemoryRunsPackDraftAdapter();
    await drafts.createDraft(makeDraft());
    await expect(drafts.releaseClaim("pack-1")).rejects.toThrowError(RunsPackClaimRefusedError);
    await drafts.claimForCredit("pack-1");
    const released = await drafts.releaseClaim("pack-1");
    expect(released.status).toBe("minted");
    const claimed = await drafts.claimForCredit("pack-1");
    expect(claimed.status).toBe("crediting");
  });

  it("markCredited on a minted (unclaimed) draft is refused", async () => {
    const drafts = new InMemoryRunsPackDraftAdapter();
    await drafts.createDraft(makeDraft());
    await expect(
      drafts.markCredited("pack-1", { creditedAtMs: NOW, paymentIntentId: null, checkoutSessionId: null }),
    ).rejects.toThrow(/not crediting/);
    await expect(drafts.claimForCredit("pack-missing")).rejects.toThrow(/Unknown runs-pack draft/);
  });
});

describe("migration 0063 — runs packs (#3246 slice 3)", () => {
  it("is registered in ALL_MIGRATIONS, in order, with the three pack tables", () => {
    const found = ALL_MIGRATIONS.filter((m) => m.version === 63);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("0063_runs_packs");
    expect(found[0].sql).toContain("agent_runs_pack_versions");
    expect(found[0].sql).toContain("agent_runs_pack_balances");
    expect(found[0].sql).toContain("agent_runs_pack_drafts");
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    const sorted = [...versions].sort((a, b) => a - b);
    expect(versions).toEqual(sorted);
  });

  it("applies on an empty store: the D1 adapters round-trip versions, balances, and drafts", async () => {
    const { versions, balance, drafts } = await makeD1();
    const version = await versions.createVersion({
      productId: "prod-pack-10",
      runs: 10,
      priceUSD: 4.99,
      effectiveFromMs: NOW,
    });
    expect(version).toMatchObject({
      version: 1,
      approvalStatus: "proposed",
      active: true,
    });
    expect(await versions.getVersion(version.id)).toEqual(version);
    const approved = await versions.approveVersion(version.id, "op1");
    expect(approved.approvalStatus).toBe("approved");
    expect((await versions.listVersions("prod-pack-10")).map((v) => v.id)).toEqual([version.id]);

    expect(await balance.getBalance("u1")).toBe(0);
    expect(await balance.addPackRuns("u1", 10)).toBe(10);
    expect(await balance.consumePackRun({ login: "u1" })).toEqual({ allowed: true, remaining: 9 });

    await drafts.createDraft(makeDraft());
    expect((await drafts.getDraft("pack-1"))?.status).toBe("minted");
    await drafts.claimForCredit("pack-1");
    const marked = await drafts.markCredited("pack-1", {
      creditedAtMs: NOW,
      paymentIntentId: "pi_test_1",
      checkoutSessionId: "cs_test_1",
    });
    expect(marked.status).toBe("credited");
    expect((await drafts.listByUser("u1")).map((d) => d.id)).toEqual(["pack-1"]);
  });

  it("D1 balance: a second consume on a balance of 1 is refused (no double-spend)", async () => {
    const { balance } = await makeD1();
    await balance.addPackRuns("u1", 1);
    expect(await balance.consumePackRun({ login: "u1" })).toEqual({ allowed: true, remaining: 0 });
    expect(await balance.consumePackRun({ login: "u1" })).toEqual({ allowed: false, remaining: 0 });
    expect(await balance.getBalance("u1")).toBe(0);
  });

  it("D1 drafts: claim-twice is refused and release-then-claim works", async () => {
    const { drafts } = await makeD1();
    await drafts.createDraft(makeDraft());
    await drafts.claimForCredit("pack-1");
    await expect(drafts.claimForCredit("pack-1")).rejects.toThrowError(RunsPackClaimRefusedError);
    const released = await drafts.releaseClaim("pack-1");
    expect(released.status).toBe("minted");
    expect((await drafts.claimForCredit("pack-1")).status).toBe("crediting");
    await expect(drafts.releaseClaim("pack-missing")).rejects.toThrow(/Unknown runs-pack draft/);
  });

  it("ensureRunsPackSchema alone on an empty store applies 0063 (carries 0058's prerequisites)", async () => {
    // The ensure list carries 0058's prerequisites (0009, 0011,
    // 0012, 0027 — the migrationRunner.ts prerequisite note):
    // without them 0058 fails on an empty store at `ALTER TABLE
    // agent_price_catalogue RENAME TO
    // agent_price_catalogue_legacy` (no such table:
    // agent_price_catalogue, created by 0011).
    const mock = new MockD1Database();
    const db = createD1RunsPackDb(mock as unknown as D1Database);
    const applied = await ensureRunsPackSchema(db);
    expect(applied).toContain(63);
    const versions = new D1RunsPackVersionAdapter(db);
    const version = await versions.createVersion({ productId: "prod-pack-10", runs: 10, priceUSD: 4.99 });
    expect(version.version).toBe(1);
  });

  it("re-ensure is idempotent (the migration marker skips the re-apply)", async () => {
    const mock = new MockD1Database();
    const db = createD1RunsPackDb(mock as unknown as D1Database);
    await applyMigrations(db as unknown as MigrationDb, [
      MIGRATION_0007_COMMERCIAL_STORE,
      MIGRATION_0008_SUBSCRIPTIONS,
      MIGRATION_0009_JOURNAL,
      MIGRATION_0011_PRICE_CATALOGUE,
      MIGRATION_0012_NATIVE_LEDGER,
      MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
    ]);
    const first = await ensureRunsPackSchema(db);
    expect(first).toContain(63);
    const second = await ensureRunsPackSchema(db);
    expect(second).not.toContain(63);
    const versions = new D1RunsPackVersionAdapter(db);
    const version = await versions.createVersion({ productId: "prod-pack-10", runs: 10, priceUSD: 4.99 });
    await ensureRunsPackSchema(db);
    expect(await versions.getVersion(version.id)).toEqual(version);
  });

  it("applies after 0058 alone (the prerequisite chain in the ensure list)", async () => {
    const mock = new MockD1Database();
    const db = createD1RunsPackDb(mock as unknown as D1Database);
    // A store ensured through this path alone still has the
    // product tables the pack routes read (0058 seeds prod-free).
    await applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS.filter((m) => m.version <= 63));
    const products = new D1ProductAdapter(createD1ProductDb(mock as unknown as D1Database));
    expect((await products.listProducts()).map((p) => p.id)).toContain("prod-free");
    const versions = new D1RunsPackVersionAdapter(db);
    const version = await versions.createVersion({ productId: "prod-pack-10", runs: 10, priceUSD: 4.99 });
    expect(version.version).toBe(1);
  });
});
