/**
 * Issue #1776 (#1717 Adapter S2) — DO-SQLite remainder.
 *
 * TDD Red first: the SqlLegacyChatStore does not exist yet, so this
 * suite fails at import time until the slice lands it. The store
 * owns the three legacy cf_ai_chat_agent_messages statements
 * statement-for-statement (sqlite_master probe, ordered lift
 * select, drop-on-clean-lift); the validation / import /
 * drop-only-when-clean logic stays in OrchestratorAgent.
 *
 * The session-memory site (scan orchestrator.ts:1375) needs no
 * new test here: it already serves through the step-3a memory
 * port — createOrmPorts(sql).memory.listRecent(8) in
 * configureContext — pinned by tests/orm_step3a_conformance_2345.test.ts
 * (memory.listRecent) and tests/orchestrator-actor-cutover.test.ts
 * (the session-memory context block). This suite pins the lift
 * site and the zero-inline-sites acceptance for orchestrator.ts.
 *
 * #CISO-bhdm
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { SqlLegacyChatStore } from "../src/data/doSqliteLegacyChatAdapter";
import type { SqlStorage } from "../src/data/repositoryPorts";

function makeSql(opts: { tableExists: boolean; rows: Array<Record<string, unknown>> }): {
  sql: SqlStorage;
  seen: string[];
  dropped: boolean;
} {
  const seen: string[] = [];
  let dropped = false;
  const sql: SqlStorage = {
    exec: (query: string, ..._args: unknown[]) => {
      seen.push(query);
      if (query.includes("sqlite_master")) {
        return opts.tableExists ? [{ name: "cf_ai_chat_agent_messages" }] : [];
      }
      if (query.startsWith("DROP TABLE")) {
        dropped = true;
        return [];
      }
      return opts.rows;
    },
  };
  return {
    sql,
    seen,
    get dropped() {
      return dropped;
    },
  };
}

describe("#1776 S2 — SqlLegacyChatStore (lift site)", () => {
  it("probes sqlite_master with the exact legacy query", () => {
    const { sql, seen } = makeSql({ tableExists: true, rows: [] });
    const store = new SqlLegacyChatStore(sql);
    expect(store.tableExists()).toBe(true);
    expect(seen).toEqual([
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cf_ai_chat_agent_messages'",
    ]);
  });

  it("reports a missing legacy table as absent", () => {
    const { sql } = makeSql({ tableExists: false, rows: [] });
    expect(new SqlLegacyChatStore(sql).tableExists()).toBe(false);
  });

  it("lists legacy rows with the exact legacy ordered select", () => {
    const rows = [
      { id: "legacy-1", message: "{}", created_at: "2026-01-01T00:00:00.000Z" },
      { id: "legacy-2", message: "{}", created_at: "2026-01-01T00:01:00.000Z" },
    ];
    const { sql, seen } = makeSql({ tableExists: true, rows });
    expect(new SqlLegacyChatStore(sql).listLegacyRows()).toEqual(rows);
    expect(seen).toEqual([
      "SELECT id, message, created_at FROM cf_ai_chat_agent_messages ORDER BY created_at ASC, rowid ASC",
    ]);
  });

  it("drops the legacy table with the exact legacy statement", () => {
    const fake = makeSql({ tableExists: true, rows: [] });
    new SqlLegacyChatStore(fake.sql).dropTable();
    expect(fake.seen).toEqual(["DROP TABLE cf_ai_chat_agent_messages"]);
    expect(fake.dropped).toBe(true);
  });

  it("orchestrator.ts carries zero inline sql.exec sites (acceptance)", () => {
    const src = readFileSync("src/agents/orchestrator.ts", "utf8");
    // The lift's SQL lives in the store now; the class only passes
    // this.ctx.storage.sql into ports/stores, never execs it.
    expect(src).not.toMatch(/\.exec\(/);
    expect(src).toContain("new SqlLegacyChatStore(this.ctx.storage.sql)");
    expect(src).toContain("liftLegacyChatMessages");
  });
});
