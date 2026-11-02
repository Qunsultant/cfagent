/**
 * Phase 5 Slice 2 (#2000) — breaker state store port contract.
 *
 * The same contract suite runs against BOTH adapters: the
 * in-memory test double and the Drizzle D1 adapter over a
 * MockD1Database (node:sqlite, mirroring the slice-1 harness).
 * A behavior difference between them is a defect in one
 * adapter, not a test difference.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createD1BreakerStateStoreDb, D1BreakerStateStoreAdapter, ensureBreakerStateSchema } from "../src/data/d1BreakerStateStoreAdapter";
import { InMemoryBreakerStateStoreAdapter } from "../src/data/inMemoryBreakerStateStoreAdapter";
import { applyMigrations, MIGRATION_0034_BREAKER_STATE, type MigrationDb } from "../src/data/migrationRunner";
import type { BreakerPersistedState, BreakerStateStore } from "../src/breakers/breakerStateStorePorts";

/** Minimal D1Database stand-in over node:sqlite (test-only, mirrors slice 1). */
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

async function adapters(): Promise<Array<{ name: string; store: BreakerStateStore }>> {
  const mock = new MockD1Database();
  const db = createD1BreakerStateStoreDb(mock as unknown as D1Database);
  await ensureBreakerStateSchema(db);
  // ensure() must be idempotent: a second apply changes nothing.
  await ensureBreakerStateSchema(db);
  return [
    { name: "in-memory", store: new InMemoryBreakerStateStoreAdapter() },
    { name: "drizzle", store: new D1BreakerStateStoreAdapter(db) },
  ];
}

function row(providerId = "yahoo", over: Partial<BreakerPersistedState> = {}): BreakerPersistedState {
  return {
    providerId,
    state: "open",
    consecutiveFailures: 3,
    openedAtMs: 1_000_000,
    lastFailureAtMs: 999_000,
    totalCalls: 10,
    totalSuccesses: 7,
    totalFailures: 3,
    totalTrips: 1,
    totalFallbacks: 2,
    totalRejected: 1,
    transitionSeq: 4,
    updatedAtMs: 1_000_000,
    ...over,
  };
}

describe("breaker state store port contract (#2000 slice 2)", () => {
  it("load of an unknown provider returns null", async () => {
    for (const { store } of await adapters()) {
      expect(await store.load("nope")).toBeNull();
    }
  });

  it("save then load round-trips every field", async () => {
    for (const { store } of await adapters()) {
      const input = row("etrade");
      await store.save(input);
      expect(await store.load("etrade")).toEqual(input);
    }
  });

  it("save overwrites the same provider (one row per provider)", async () => {
    for (const { store } of await adapters()) {
      await store.save(row("nasdaq", { state: "open", transitionSeq: 1 }));
      await store.save(row("nasdaq", { state: "closed", transitionSeq: 2, openedAtMs: null }));
      const loaded = await store.load("nasdaq");
      expect(loaded?.state).toBe("closed");
      expect(loaded?.transitionSeq).toBe(2);
    }
  });

  it("providers are independent rows", async () => {
    for (const { store } of await adapters()) {
      await store.save(row("yahoo", { state: "open" }));
      await store.save(row("public", { state: "closed", openedAtMs: null }));
      expect((await store.load("yahoo"))?.state).toBe("open");
      expect((await store.load("public"))?.state).toBe("closed");
    }
  });

  it("trip-alert claim: first token wins; a different token loses; the same token re-claims idempotently (slice-1 token semantics)", async () => {
    for (const { store } of await adapters()) {
      const id = "breaker-state:yahoo:open:1";
      expect(await store.claimTripAlert(id, 1_000_000, "tok-a")).toBe(true);
      expect(await store.claimTripAlert(id, 1_000_001, "tok-b")).toBe(false);
      expect(await store.claimTripAlert(id, 1_000_002, "tok-a")).toBe(true);
    }
  });

  it("trip-alert claims are independent per transition id", async () => {
    for (const { store } of await adapters()) {
      expect(await store.claimTripAlert("breaker-state:yahoo:open:1", 1, "t1")).toBe(true);
      expect(await store.claimTripAlert("breaker-state:yahoo:open:2", 2, "t2")).toBe(true);
      expect(await store.claimTripAlert("breaker-state:etrade:open:1", 3, "t3")).toBe(true);
    }
  });

  it("migration 0034 applies via the shared runner and is last", async () => {
    const mock = new MockD1Database();
    const db = createD1BreakerStateStoreDb(mock as unknown as D1Database);
    const applied = await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0034_BREAKER_STATE]);
    expect(applied).toContain(34);
    const store = new D1BreakerStateStoreAdapter(db);
    await store.save(row("yahoo"));
    expect((await store.load("yahoo"))?.transitionSeq).toBe(4);
  });
});
