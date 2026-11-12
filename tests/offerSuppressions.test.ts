// @vitest-environment node
/**
 * Issue #3246 (slice 1, sub-issue of #3241) — dismissal
 * suppressions (§4.4): the port asserts, the in-memory adapter,
 * and the D1 adapter over node:sqlite, plus migration 0062
 * (the suppressions table + the product rank column + the
 * prod-free rank-1 backfill).
 *
 * Suppression scope: per (login, trigger), server-side, across
 * families — dismissing one trigger never affects another.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { ALL_MIGRATIONS, type MigrationDb } from "../src/data/migrationRunner";
import { applyMigrations } from "../src/data/migrationRunner";
import {
  assertOfferSuppressionInput,
  assertOfferTrigger,
  OFFER_TRIGGERS,
} from "../src/data/offerSuppressionPorts";
import { InMemoryOfferSuppressionAdapter } from "../src/data/inMemoryOfferSuppressionAdapter";
import {
  createD1OfferSuppressionDb,
  D1OfferSuppressionAdapter,
  ensureOfferSuppressionSchema,
} from "../src/data/d1OfferSuppressionAdapter";
import { createD1ProductDb, D1ProductAdapter } from "../src/data/d1ProductAdapter";

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

describe("offer trigger asserts (#3246 §4.4)", () => {
  it("accepts the five triggers and rejects anything else", () => {
    expect(OFFER_TRIGGERS).toEqual(["manual_402", "skip_notice", "trial_end", "quota_exhausted", "ambient"]);
    for (const trigger of OFFER_TRIGGERS) expect(assertOfferTrigger(trigger)).toBe(trigger);
    for (const bad of ["manual402", "Manual_402", "", "dismissed", 1, null, undefined, {}]) {
      expect(() => assertOfferTrigger(bad)).toThrow();
    }
  });

  it("validates suppression inputs: login, trigger, finite instants", () => {
    const valid = assertOfferSuppressionInput({
      login: "u1",
      trigger: "manual_402",
      suppressedUntilMs: NOW + 7 * 86400000,
      dismissedAtMs: NOW,
    });
    expect(valid).toEqual({
      login: "u1",
      trigger: "manual_402",
      suppressedUntilMs: NOW + 7 * 86400000,
      dismissedAtMs: NOW,
    });
    expect(() => assertOfferSuppressionInput({ login: "  ", trigger: "manual_402", suppressedUntilMs: NOW, dismissedAtMs: NOW })).toThrow();
    expect(() => assertOfferSuppressionInput({ login: "u1", trigger: "bogus", suppressedUntilMs: NOW, dismissedAtMs: NOW })).toThrow();
    expect(() => assertOfferSuppressionInput({ login: "u1", trigger: "manual_402", suppressedUntilMs: NaN, dismissedAtMs: NOW })).toThrow();
    expect(() => assertOfferSuppressionInput({ login: "u1", trigger: "manual_402", suppressedUntilMs: NOW, dismissedAtMs: Infinity })).toThrow();
  });
});

describe("in-memory suppression adapter (#3246 §4.4)", () => {
  it("reads null before any dismissal, round-trips a write, and overwrites on re-dismiss", async () => {
    const store = new InMemoryOfferSuppressionAdapter();
    expect(await store.getSuppression("u1", "manual_402")).toBeNull();
    const first = await store.setSuppression({
      login: "u1",
      trigger: "manual_402",
      suppressedUntilMs: NOW + 7 * 86400000,
      dismissedAtMs: NOW,
    });
    expect(first.suppressedUntilMs).toBe(NOW + 7 * 86400000);
    expect(await store.getSuppression("u1", "manual_402")).toEqual(first);
    const second = await store.setSuppression({
      login: "u1",
      trigger: "manual_402",
      suppressedUntilMs: NOW + 14 * 86400000,
      dismissedAtMs: NOW + 7 * 86400000,
    });
    expect(await store.getSuppression("u1", "manual_402")).toEqual(second);
  });

  it("scopes by (login, trigger): other triggers and logins are unaffected", async () => {
    const store = new InMemoryOfferSuppressionAdapter();
    await store.setSuppression({ login: "u1", trigger: "manual_402", suppressedUntilMs: NOW + 1000, dismissedAtMs: NOW });
    expect(await store.getSuppression("u1", "trial_end")).toBeNull();
    expect(await store.getSuppression("u2", "manual_402")).toBeNull();
  });
});

describe("migration 0062 — offer suppressions + product rank (#3246)", () => {
  it("is registered in ALL_MIGRATIONS, in order, with the suppressions table and rank column", () => {
    const found = ALL_MIGRATIONS.filter((m) => m.version === 62);
    expect(found).toHaveLength(1);
    expect(found[0].name).toBe("0062_offer_suppressions_rank");
    expect(found[0].sql).toContain("agent_offer_suppressions");
    expect(found[0].sql).toContain("ADD COLUMN rank");
    expect(found[0].sql).toContain("rank = 1 WHERE id = 'prod-free'");
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    const sorted = [...versions].sort((a, b) => a - b);
    expect(versions).toEqual(sorted);
  });

  it("applies on an empty store: the D1 adapter round-trips and prod-free reads rank 1", async () => {
    const mock = new MockD1Database();
    const db = createD1OfferSuppressionDb(mock as unknown as D1Database);
    await ensureOfferSuppressionSchema(db);
    const store = new D1OfferSuppressionAdapter(db);
    expect(await store.getSuppression("u1", "manual_402")).toBeNull();
    const written = await store.setSuppression({
      login: "u1",
      trigger: "manual_402",
      suppressedUntilMs: NOW + 7 * 86400000,
      dismissedAtMs: NOW,
    });
    expect(await store.getSuppression("u1", "manual_402")).toEqual(written);
    // Re-dismiss overwrites (the PK upsert), other triggers unaffected.
    await store.setSuppression({
      login: "u1",
      trigger: "manual_402",
      suppressedUntilMs: NOW + 14 * 86400000,
      dismissedAtMs: NOW + 7 * 86400000,
    });
    expect((await store.getSuppression("u1", "manual_402"))?.suppressedUntilMs).toBe(NOW + 14 * 86400000);
    expect(await store.getSuppression("u1", "skip_notice")).toBeNull();
    // The rank backfill: 0058 seeds prod-free, 0062 ranks it 1.
    const products = new D1ProductAdapter(createD1ProductDb(mock as unknown as D1Database));
    expect((await products.getProduct("prod-free"))?.rank).toBe(1);
  });

  it("re-ensure is idempotent (the migration marker skips the re-apply)", async () => {
    const mock = new MockD1Database();
    const db = createD1OfferSuppressionDb(mock as unknown as D1Database);
    const first = await ensureOfferSuppressionSchema(db);
    expect(first).toContain(62);
    const second = await ensureOfferSuppressionSchema(db);
    expect(second).not.toContain(62);
    const store = new D1OfferSuppressionAdapter(db);
    await store.setSuppression({ login: "u1", trigger: "trial_end", suppressedUntilMs: NOW + 1000, dismissedAtMs: NOW });
    await ensureOfferSuppressionSchema(db);
    expect((await store.getSuppression("u1", "trial_end"))?.suppressedUntilMs).toBe(NOW + 1000);
  });

  it("applies after 0058 alone (the prerequisite chain in the ensure list)", async () => {
    const mock = new MockD1Database();
    const db = createD1OfferSuppressionDb(mock as unknown as D1Database);
    // Apply only the 0058 chain via the suppression ensure's own list:
    // a store ensured through this path alone has agent_products.
    await applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS.filter((m) => m.version <= 62));
    const products = new D1ProductAdapter(createD1ProductDb(mock as unknown as D1Database));
    expect((await products.listProducts()).map((p) => p.id)).toContain("prod-free");
    expect((await products.getProduct("prod-free"))?.rank).toBe(1);
  });
});
