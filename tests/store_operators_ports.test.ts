/**
 * Issue #2680 — store operator list port contract.
 *
 * The port suite runs UNCHANGED against the Drizzle D1 adapter
 * (over a MockD1Database backed by node:sqlite — no Cloudflare
 * credentials, no live D1 calls) and the in-memory adapter.
 * Mirrors tests/price_catalogue_ports.test.ts.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createD1StoreOperatorsDb,
  D1StoreOperatorsAdapter,
  ensureStoreOperatorsSchema,
} from "../src/data/d1StoreOperatorsAdapter";
import { InMemoryStoreOperatorsAdapter } from "../src/data/inMemoryStoreOperatorsAdapter";
import type { StoreOperators } from "../src/data/storeOperatorsPorts";

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

async function adapters(): Promise<Array<{ name: string; operators: StoreOperators }>> {
  const mock = new MockD1Database();
  const db = createD1StoreOperatorsDb(mock as unknown as D1Database);
  await ensureStoreOperatorsSchema(db);
  return [
    { name: "in-memory", operators: new InMemoryStoreOperatorsAdapter() },
    { name: "drizzle", operators: new D1StoreOperatorsAdapter(db) },
  ];
}

describe("store operator list port contract (#2680)", () => {
  it("starts empty; add/list/remove round-trips; remove of absent returns false", async () => {
    for (const { operators } of await adapters()) {
      expect(await operators.listOperators()).toEqual([]);
      const added = await operators.addOperator({ login: "op2", addedBy: "op1" });
      expect(added.login).toBe("op2");
      expect(added.addedBy).toBe("op1");
      expect(typeof added.addedAtMs).toBe("number");
      expect(await operators.listOperators()).toHaveLength(1);
      expect(await operators.removeOperator({ login: "ghost" })).toBe(false);
      expect(await operators.removeOperator({ login: "op2" })).toBe(true);
      expect(await operators.listOperators()).toEqual([]);
    }
  });

  it("add is idempotent: re-adding returns the existing row unchanged", async () => {
    for (const { operators } of await adapters()) {
      const first = await operators.addOperator({ login: "op2", addedBy: "op1" });
      const second = await operators.addOperator({ login: "op2", addedBy: "op9" });
      expect(second).toEqual(first);
      expect(await operators.listOperators()).toHaveLength(1);
    }
  });

  it("blank logins are rejected", async () => {
    for (const { operators } of await adapters()) {
      await expect(operators.addOperator({ login: "  ", addedBy: "op1" })).rejects.toThrow();
      await expect(operators.addOperator({ login: "op2", addedBy: "" })).rejects.toThrow();
      await expect(operators.removeOperator({ login: "" })).rejects.toThrow();
    }
  });

  it("list is sorted by login", async () => {
    for (const { operators } of await adapters()) {
      await operators.addOperator({ login: "zeta", addedBy: "op1" });
      await operators.addOperator({ login: "alpha", addedBy: "op1" });
      expect((await operators.listOperators()).map((e) => e.login)).toEqual(["alpha", "zeta"]);
    }
  });
});
