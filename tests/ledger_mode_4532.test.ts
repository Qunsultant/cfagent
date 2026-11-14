// @vitest-environment node
/**
 * Issue #4532 (slice 2) — the trade mode is persisted server-side.
 *
 * mas_trades gains a nullable `mode` column via the PRAGMA-guarded
 * ALTER pattern (broker / price_source precedent): fresh tables get
 * the column from the catalogue DDL, legacy tables gain it on
 * initializeSchema, and legacy rows keep NULL — never invented.
 * The preview stamp (TEST -> paper, PROD -> live) is pinned in
 * tests/broker_orders_3089.test.ts; this file pins the storage side:
 * the column exists, the ORM maps it through on create / read /
 * list, and a second initializeSchema is a no-op for the ALTER.
 */
import { describe, expect, it } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { DatabaseORM } from "../src/orm";
import type { TradeRecord } from "../src/types";

function trade(over: Partial<TradeRecord> = {}): TradeRecord {
  return {
    id: "ord-1",
    sessionId: "sess-1",
    symbol: "AAPL",
    action: "BUY",
    orderType: "MARKET",
    quantity: 10,
    price: 150,
    totalValue: 1500,
    status: "previewed",
    orderRef: "ref-1",
    proposerDid: "did:agent:openaimp:proposer-1",
    createdAt: "2026-11-14T10:00:00.000Z",
    updatedAt: "2026-11-14T10:00:00.000Z",
    ...over,
  };
}

function tableColumns(sql: MockSqlStorage, table: string): string[] {
  return Array.from(sql.exec(`PRAGMA table_info(${table})`) as Iterable<{ name?: unknown }>).map(
    (c) => String(c.name),
  );
}

describe("mas_trades mode column (#4532 slice 2)", () => {
  it("initializeSchema adds the mode column to a legacy table", () => {
    const sql = new MockSqlStorage();
    // The mock preseeds mas_trades without the mode column (legacy).
    expect(tableColumns(sql, "mas_trades")).not.toContain("mode");
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    expect(tableColumns(sql, "mas_trades")).toContain("mode");
  });

  it("a trade created with a mode reads it back, and findMany carries it", () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    orm.trades.create(trade({ id: "live-1", mode: "live" }));
    orm.trades.create(trade({ id: "paper-1", mode: "paper" }));
    expect(orm.trades.findById("live-1")?.mode).toBe("live");
    expect(orm.trades.findById("paper-1")?.mode).toBe("paper");
    const modes = orm.trades
      .findMany({ orderBy: "created_at DESC" })
      .map((t) => [t.id, t.mode ?? null]);
    expect(modes).toContainEqual(["live-1", "live"]);
    expect(modes).toContainEqual(["paper-1", "paper"]);
  });

  it("a trade created without a mode reads back unknown, never invented", () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    orm.trades.create(trade({ id: "legacy-1" }));
    const stored = orm.trades.findById("legacy-1");
    expect(stored).not.toBeNull();
    expect(stored!.mode ?? null).toBeNull();
  });

  it("the mode ALTER is idempotent: a second initializeSchema is a no-op for it", () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    expect(() => orm.initializeSchema("test_session_user")).not.toThrow();
    const modes = tableColumns(sql, "mas_trades").filter((c) => c === "mode");
    expect(modes).toHaveLength(1);
    // The store still works after the second pass.
    orm.trades.create(trade({ id: "after-second", mode: "live" }));
    expect(orm.trades.findById("after-second")?.mode).toBe("live");
  });

  it("updating a draft's mode re-stamps it", () => {
    const sql = new MockSqlStorage();
    const orm = new DatabaseORM(sql);
    orm.initializeSchema("test_session_user");
    orm.trades.create(trade({ id: "restamp-1", mode: "paper" }));
    orm.trades.update("restamp-1", { mode: "live", updatedAt: "2026-11-14T11:00:00.000Z" });
    expect(orm.trades.findById("restamp-1")?.mode).toBe("live");
  });
});
