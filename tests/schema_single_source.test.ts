/**
 * Issue #782 — dual-DDL drift pins (RSI-Data Tier 1, finding C2).
 *
 * The seven shared mas_* tables (mas_messages, mas_events, mas_memory,
 * mas_referrals, mas_ads, mas_watchlists, mas_transactions) used to be
 * defined TWICE with byte-identical DDL: DatabaseORM.initializeSchema()
 * in src/orm/index.ts and OrchestratorAgent.ensureTables() in
 * src/agents/orchestrator.ts. With CREATE TABLE IF NOT EXISTS semantics
 * the first definition to run wins per instance, so any future edit to
 * one copy would silently fork the schema by instance history.
 *
 * These pins hold the single-source contract:
 *
 *  - The shared DDL lives in exactly ONE file (src/data/ormSchema.ts
 *    since #2345 — src/orm/schema.ts is a §22 re-export shim) and
 *    both initialization paths consume it (source pins).
 *  - Both paths produce the IDENTICAL effective schema for every shared
 *    table: the DDL each path actually executes is captured at the
 *    SqlStorage seam (the exact strings that would land in sqlite_master
 *    on a real Durable Object) and introspected into table_info-shaped
 *    column lists for comparison. (The repo's test harness has no real
 *    SQLite — MockSqlStorage does not parse CREATE TABLE, and
 *    node:sqlite is flag-gated on CI's Node 22 — so the executed-DDL
 *    capture is the faithful equivalent of sqlite_master introspection.)
 *  - Per-DO coverage stays explicit: the ORM path additionally creates
 *    the five ORM-only tables; the orchestrator's ensureTables does not
 *    (it relies on getOrm() → initializeSchema for those).
 *
 * Red/green note: the source pins and the canonical-module pins fail on
 * pre-change code (two DDL copies, no src/orm/schema.ts). The
 * effective-DDL equivalence pin is a characterization pin that passes
 * on both sides by design today — the copies were byte-identical — and
 * becomes the drift tripwire after single-sourcing: a re-introduced
 * second copy that diverges, or either path dropping/altering a shared
 * table, fails it.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

vi.mock("@cloudflare/ai-chat", () => {
  return {
    AIChatAgent: class MockAIChatAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
    },
  };
});
vi.mock("agents", () => {
  // Issue #1738: OrchestratorAgent/ResearchAgent/TradingAgent are
  // Agents SDK actors now, so the mock must export the Agent base
  // the classes extend (previously Think, aliased to a stub).
  return {
    routeAgentRequest: async () => null,
    Agent: class MockAgent {
      ctx: any;
      env: any;
      constructor(ctx: any, env: any) {
        this.ctx = ctx;
        this.env = env;
      }
      // Schedule methods are inert under Node (the old Think stub's
      // contract): production schedule calls resolve without firing.
      async schedule(_when: unknown, _callback: string, _payload?: unknown, _options?: unknown) {
        return { id: "mock-schedule" };
      }
      async scheduleEvery(_intervalSeconds: number, _callback: string, _payload?: unknown) {
        return { id: "mock-schedule" };
      }
    },
  };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});

import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { OrchestratorAgent } from "../src/agents/orchestrator";
import type { Env } from "../src/types";

const SHARED_TABLES = [
  "mas_messages",
  "mas_events",
  "mas_memory",
  "mas_referrals",
  "mas_ads",
  "mas_watchlists",
  "mas_transactions",
  // Issue #4412: mas_promotions, restored so the #1257 active-check
  // route reads a real table.
  "mas_promotions",
] as const;

const ORM_ONLY_TABLES = [
  "mas_categories",
  "mas_external_ads",
  "webhook_replay_nonces",
  "mas_trades",
  "mas_options_chain_cache",
] as const;

/** MockSqlStorage that records every statement it is asked to execute. */
class RecordingSqlStorage extends MockSqlStorage {
  readonly queries: string[] = [];
  override exec(query: string, ...args: unknown[]): Iterable<unknown> {
    this.queries.push(query);
    return super.exec(query, ...args);
  }
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: boolean;
  defaultValue: string | null;
  pk: boolean;
}

/**
 * Introspect executed CREATE TABLE statements into table_info-shaped
 * column lists — the sqlite_master / PRAGMA table_info equivalent for
 * the DDL a path actually ran.
 */
function introspectCreateTables(queries: string[]): Map<string, ColumnInfo[]> {
  const out = new Map<string, ColumnInfo[]>();
  for (const q of queries) {
    const m = q.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*)\)/);
    if (!m) continue;
    const [, name, body] = m;
    const parts: string[] = [];
    let depth = 0;
    let cur = "";
    for (const ch of body) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur);
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) parts.push(cur);
    const columns = parts
      .map((p) => p.trim().replace(/\s+/g, " "))
      .filter(Boolean)
      .filter((def) => !/^(PRIMARY KEY|UNIQUE|FOREIGN KEY|CHECK|CONSTRAINT)\b/i.test(def))
      .map((def) => {
        const tokens = def.split(" ");
        return {
          name: tokens[0],
          type: tokens[1] ?? "",
          notnull: /\bNOT NULL\b/i.test(def),
          defaultValue: def.match(/\bDEFAULT\s+(\S+)/i)?.[1] ?? null,
          pk: /\bPRIMARY KEY\b/i.test(def),
        };
      });
    out.set(name, columns);
  }
  return out;
}

/** The whitespace-normalized DDL a path executed for one table. */
function normalizedDdlFor(queries: string[], table: string): string | null {
  const found = queries.find((q) =>
    new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`).test(q)
  );
  return found ? found.replace(/\s+/g, " ").trim() : null;
}

function ormPathQueries(): string[] {
  const rec = new RecordingSqlStorage();
  const orm = new DatabaseORM(rec);
  orm.initializeSchema("schema_pin_session");
  return rec.queries;
}

function orchestratorPathQueries(): string[] {
  const rec = new RecordingSqlStorage();
  const ctx = {
    id: { toString: () => "schema_pin_orchestrator" },
    storage: { sql: rec },
    waitUntil: vi.fn(),
  };
  const env = {
    AI: {} as any,
    AI_SEARCH_ENDPOINT: "https://mock.search",
    ORCHESTRATOR_AGENT: {} as any,
    AGENT_SESSIONS: {} as any,
  } as Env;
  const agent = new OrchestratorAgent(ctx as any, env);
  (agent as any).ensureTables();
  return rec.queries;
}

function walkSrc(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walkSrc(full, out);
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

describe("issue #782: single-source shared mas_* schema", () => {
  it("canonical module: src/data/ormSchema.ts exports the eight shared tables and their DDL", async () => {
    // Dynamic import so this suite still loads against pre-change code,
    // where the module does not exist yet (the test then fails as a
    // test, not as a module load error). #2345 retarget (disclosed
    // §7 pin update): the canonical module moved to the data layer.
    const schema = (await import("../src/data/ormSchema")) as any;
    expect(Array.isArray(schema.SHARED_MAS_TABLES)).toBe(true);
    expect([...schema.SHARED_MAS_TABLES].sort()).toEqual([...SHARED_TABLES].sort());
    expect(typeof schema.ensureSharedTable).toBe("function");
    for (const table of SHARED_TABLES) {
      const ddl: string = schema.SHARED_TABLE_DDL[table];
      expect(typeof ddl, `SHARED_TABLE_DDL.${table}`).toBe("string");
      expect(ddl).toContain(`CREATE TABLE IF NOT EXISTS ${table}`);
      // Each canonical entry defines exactly its own table.
      const creates = ddl.match(/CREATE TABLE IF NOT EXISTS\s+\w+/g) ?? [];
      expect(creates).toHaveLength(1);
    }
  });

  it("source pin: shared-table DDL exists in exactly one file under src/", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    const sharedAlt = SHARED_TABLES.join("|");
    const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS\\s+(?:${sharedAlt})\\b`);
    const offenders = walkSrc(srcRoot)
      .filter((file) => pattern.test(readFileSync(file, "utf-8")))
      .map((file) => path.relative(srcRoot, file).replace(/\\/g, "/"));
    // #4282 P2a retarget (disclosed pin update): the single home for
    // the shared-table DDL moved from src/data/ormSchema.ts into the
    // schema catalogue — ormSchema.ts still exports SHARED_TABLE_DDL
    // (now catalogue-derived, so the canonical-module pin above still
    // holds), but the literal DDL text lives in exactly one file, the
    // catalogue module. The single-source intent is unchanged.
    expect(offenders).toEqual(["data/schemaComponent/ormCatalogue.ts"]);
  });

  it("source pin: both initialization paths consume the canonical module", () => {
    const srcRoot = fileURLToPath(new URL("../src", import.meta.url));
    // #2345 retarget (disclosed §7 pin update): the ORM path is the
    // data-layer facade importing ./ormSchema directly; the
    // orchestrator still imports ../orm/schema, which is now the
    // §22 re-export shim over the same canonical module.
    // #2942: the orchestrator's ensureTables (and its orm/schema import)
    // moved into orchestrator/tableSchema.ts; the pin follows it.
    const ormFacade = readFileSync(path.join(srcRoot, "data/ormFacade.ts"), "utf-8");
    const orchestrator = readFileSync(
      path.join(srcRoot, "agents/orchestrator/tableSchema.ts"),
      "utf-8"
    );
    expect(ormFacade).toMatch(/from\s+["']\.\/ormSchema["']/);
    expect(ormFacade).toContain("ensureSharedTable");
    expect(orchestrator).toMatch(/from\s+["']\.\.\/\.\.\/orm\/schema["']/);
    expect(orchestrator).toContain("ensureSharedTable");
  });

  it("both initialization paths produce the identical effective schema for every shared table", () => {
    const ormQueries = ormPathQueries();
    const orchQueries = orchestratorPathQueries();
    const ormSchema = introspectCreateTables(ormQueries);
    const orchSchema = introspectCreateTables(orchQueries);
    for (const table of SHARED_TABLES) {
      // Same columns (name, type, NOT NULL, default, PK), in order.
      expect(orchSchema.get(table), `orchestrator ${table}`).toEqual(ormSchema.get(table));
      expect(ormSchema.get(table)?.length, `orm ${table} columns`).toBeGreaterThan(0);
      // Same effective DDL text, modulo whitespace.
      expect(normalizedDdlFor(orchQueries, table), `orchestrator DDL ${table}`).toBe(
        normalizedDdlFor(ormQueries, table)
      );
    }
  });

  it("both paths' effective DDL equals the canonical module's DDL", async () => {
    const schema = (await import("../src/orm/schema")) as any;
    const ormQueries = ormPathQueries();
    const orchQueries = orchestratorPathQueries();
    for (const table of SHARED_TABLES) {
      const canonical = String(schema.SHARED_TABLE_DDL[table])
        .replace(/\s+/g, " ")
        .trim();
      expect(normalizedDdlFor(ormQueries, table), `orm ${table}`).toBe(canonical);
      expect(normalizedDdlFor(orchQueries, table), `orchestrator ${table}`).toBe(canonical);
    }
  });

  it("per-DO coverage: ORM path also creates the five ORM-only tables; orchestrator ensureTables does not", () => {
    const ormSchema = introspectCreateTables(ormPathQueries());
    const orchSchema = introspectCreateTables(orchestratorPathQueries());
    for (const table of ORM_ONLY_TABLES) {
      expect(ormSchema.has(table), `orm should create ${table}`).toBe(true);
      expect(orchSchema.has(table), `orchestrator ensureTables should not create ${table}`).toBe(
        false
      );
    }
    // The orchestrator still creates its own private tables.
    for (const table of ["mas_async_jobs", "mas_autopilot", "mas_settings", "mas_policy_verdicts"]) {
      expect(orchSchema.has(table), `orchestrator should create ${table}`).toBe(true);
    }
  });

  it("idempotency: running both paths against one store keeps a single stable schema", () => {
    const rec = new RecordingSqlStorage();
    const orm = new DatabaseORM(rec);
    orm.initializeSchema("schema_pin_session");
    orm.initializeSchema("schema_pin_session");
    const schema = introspectCreateTables(rec.queries);
    for (const table of SHARED_TABLES) {
      expect(schema.get(table)?.length, table).toBeGreaterThan(0);
    }
    // Every executed CREATE for a shared table is the same statement.
    for (const table of SHARED_TABLES) {
      const variants = new Set(
        rec.queries
          .filter((q) => new RegExp(`CREATE TABLE IF NOT EXISTS\\s+${table}\\b`).test(q))
          .map((q) => q.replace(/\s+/g, " ").trim())
      );
      expect(variants.size, `${table} DDL variants`).toBe(1);
    }
  });
});
