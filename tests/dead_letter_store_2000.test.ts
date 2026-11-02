/**
 * Phase 5 Slice 1 (#2000) — dead-letter store port contract.
 *
 * The same contract suite runs against BOTH adapters: the
 * in-memory test double and the Drizzle D1 adapter over a
 * MockD1Database (node:sqlite, mirroring the price-catalogue
 * slice0 harness). A behavior difference between them is a
 * defect in one adapter, not a test difference.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createD1DeadLetterStoreDb, D1DeadLetterStoreAdapter, ensureDeadLetterStoreSchema } from "../src/data/d1DeadLetterStoreAdapter";
import { InMemoryDeadLetterStoreAdapter } from "../src/data/inMemoryDeadLetterStoreAdapter";
import { applyMigrations, MIGRATION_0033_DEAD_LETTER_STORE, type MigrationDb } from "../src/data/migrationRunner";
import type { DeadLetterStore } from "../src/messaging/deadLetterStorePorts";

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

async function adapters(): Promise<Array<{ name: string; store: DeadLetterStore }>> {
  const mock = new MockD1Database();
  const db = createD1DeadLetterStoreDb(mock as unknown as D1Database);
  await ensureDeadLetterStoreSchema(db);
  // ensure() must be idempotent: a second apply changes nothing.
  await ensureDeadLetterStoreSchema(db);
  return [
    { name: "in-memory", store: new InMemoryDeadLetterStoreAdapter() },
    { name: "drizzle", store: new D1DeadLetterStoreAdapter(db) },
  ];
}

async function migratedOnly(): Promise<DeadLetterStore> {
  const mock = new MockD1Database();
  const db = createD1DeadLetterStoreDb(mock as unknown as D1Database);
  await applyMigrations(db as unknown as MigrationDb, [MIGRATION_0033_DEAD_LETTER_STORE]);
  return new D1DeadLetterStoreAdapter(db);
}

const ENVELOPE = {
  specversion: "1.0",
  id: "env-1",
  source: "test",
  type: "options_analysis",
  time: "2026-11-02T00:00:00.000Z",
  data: { taskType: "options_analysis", payload: { userLogin: "op1" } },
  jobid: "job-1",
};

describe("dead-letter store port contract (#2000 slice 1)", () => {
  it("insert stores one row per landing with the envelope as JSON text", async () => {
    for (const { store } of await adapters()) {
      const row = await store.insert({
        queue: "screener-events",
        reason: "no_handler",
        messageId: "env-1",
        runId: "job-1",
        detail: "No handler",
        envelope: ENVELOPE,
        createdAtMs: 1000,
      });
      expect(row.queue).toBe("screener-events");
      expect(row.reason).toBe("no_handler");
      expect(row.messageId).toBe("env-1");
      expect(row.envelopeJson).toBe(JSON.stringify(ENVELOPE));
      // JSON TEXT rule: the stored form parses back to the envelope.
      expect(JSON.parse(row.envelopeJson as string)).toEqual(ENVELOPE);
      expect(row.replayedAtMs).toBeNull();
      expect(await store.unreplayedCount()).toBe(1);
      // A second insert is a second landing: exactly one row each.
      await store.insert({ queue: "screener-events", reason: "no_handler", messageId: "env-1", createdAtMs: 2000 });
      expect(await store.unreplayedCount()).toBe(2);
    }
  });

  it("insert without an envelope stores a null envelope (undecodable drops)", async () => {
    for (const { store } of await adapters()) {
      const row = await store.insert({ queue: "screener-events", reason: "undecodable", createdAtMs: 1000 });
      expect(row.envelopeJson).toBeNull();
      expect(row.messageId).toBeNull();
    }
  });

  it("listUnreplayed is newest-first and honors the limit; getById round-trips", async () => {
    for (const { store } of await adapters()) {
      const a = await store.insert({ queue: "screener-events", reason: "no_handler", messageId: "a", createdAtMs: 1000 });
      await store.insert({ queue: "screener-events", reason: "no_handler", messageId: "b", createdAtMs: 2000 });
      await store.insert({ queue: "screener-events", reason: "denied", messageId: "c", createdAtMs: 3000 });
      const all = await store.listUnreplayed(10);
      expect(all.map((r) => r.messageId)).toEqual(["c", "b", "a"]);
      expect(await store.listUnreplayed(2)).toHaveLength(2);
      expect((await store.getById(a.id))?.messageId).toBe("a");
      expect(await store.getById("nope")).toBeNull();
    }
  });

  it("markReplayed claims exactly once; the row leaves the un-replayed set", async () => {
    for (const { store } of await adapters()) {
      const row = await store.insert({ queue: "screener-events", reason: "no_handler", messageId: "env-1", envelope: ENVELOPE, createdAtMs: 1000 });
      expect(await store.markReplayed({ id: row.id, outcome: "replayed", atMs: 5000, token: "tok-1" })).toBe(true);
      const after = (await store.getById(row.id))!;
      expect(after.replayedAtMs).toBe(5000);
      expect(after.replayOutcome).toBe("replayed");
      expect(await store.unreplayedCount()).toBe(0);
      expect(await store.listUnreplayed(10)).toHaveLength(0);
      // No double-replay: a second claim loses.
      expect(await store.markReplayed({ id: row.id, outcome: "replayed", atMs: 6000, token: "tok-2" })).toBe(false);
      expect((await store.getById(row.id))!.replayedAtMs).toBe(5000);
      expect(await store.markReplayed({ id: "nope", outcome: "replayed", atMs: 5000, token: "tok-3" })).toBe(false);
    }
  });

  it("depth incident claim is exactly-once per incident; clear re-arms it", async () => {
    for (const { store } of await adapters()) {
      expect(await store.clearDepthIncident()).toBe(false);
      expect(await store.claimDepthIncident({ depth: 10, atMs: 1000, token: "d-1" })).toBe(true);
      expect(await store.claimDepthIncident({ depth: 12, atMs: 2000, token: "d-2" })).toBe(false);
      expect(await store.clearDepthIncident()).toBe(true);
      expect(await store.clearDepthIncident()).toBe(false);
      expect(await store.claimDepthIncident({ depth: 10, atMs: 3000, token: "d-3" })).toBe(true);
    }
  });

  it("migration 0033 alone creates a usable store (no seed rows)", async () => {
    const store = await migratedOnly();
    expect(await store.unreplayedCount()).toBe(0);
    const row = await store.insert({ queue: "screener-events-delivery", reason: "no_handler", messageId: "x", createdAtMs: 1000 });
    expect((await store.getById(row.id))?.queue).toBe("screener-events-delivery");
  });
});
