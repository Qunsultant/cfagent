/**
 * Issue #4933 — Drizzle query observability: one shared wiring point for
 * the drizzle() construction path, emitting statement + duration through
 * the structured-logging seam.
 *
 * Coverage: the construction-path pin (every drizzle() site routes through
 * createDrizzleD1Db — no per-adapter drizzle() calls, no logger option
 * smuggled past the wrapper); statement + duration emission through a
 * capturing sink; slow-query threshold behavior (info vs warn); the
 * externalized threshold resolution (settings > env > default, clamped);
 * statement redaction (string literals masked, param values never
 * logged); zero behavior change (wrapped vs plain drizzle results
 * deep-equal, errors propagate as the original error); batch unwrapping
 * (statements reach the real batch unproxied — the fake's private fields
 * throw when a Proxy crosses, the same brand check native D1 applies).
 *
 * The D1 double is the proof test's shape
 * (`tests/transaction_proof_2288.test.ts`): node:sqlite in-memory.
 * Prepared statements use #private fields on purpose: a Proxy cannot
 * satisfy a private-field brand check, so a statement that reaches
 * batch() still proxied throws — exactly what native D1 batch() does
 * with a non-genuine D1PreparedStatement.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/d1";
import { eq, sql } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import {
  createD1QueryLogger,
  createDrizzleD1Db,
  redactD1Statement,
  resolveD1QueryLoggerPolicy,
  DEFAULT_D1_QUERY_LOGGER_POLICY,
} from "../src/data/d1QueryLogger";
import type {
  ObservabilityEvent,
  ObservabilitySink,
} from "../src/observability/observabilityPorts";

/** Capturing sink: records every event the logger emits. */
class CapturingSink implements ObservabilitySink {
  readonly events: ObservabilityEvent[] = [];
  write(event: ObservabilityEvent): void {
    this.events.push(event);
  }
  writeBatch(events: readonly ObservabilityEvent[]): void {
    this.events.push(...events);
  }
}

/**
 * D1 double over node:sqlite. Statement methods read #private fields, so
 * calling them with `this` set to a Proxy throws — the native brand
 * check, simulated. The wrapper's batch() must therefore unwrap
 * statements before handing them to the real batch.
 */
class FakeD1Statement {
  readonly #sqlite: DatabaseSync;
  readonly #sql: string;
  readonly #params: unknown[];

  constructor(sqlite: DatabaseSync, sql: string, params: unknown[] = []) {
    this.#sqlite = sqlite;
    this.#sql = sql;
    this.#params = params;
  }

  bind(...params: unknown[]): FakeD1Statement {
    return new FakeD1Statement(this.#sqlite, this.#sql, params);
  }

  async run(): Promise<{ success: boolean; meta: Record<string, unknown>; results: unknown[] }> {
    const info = this.#sqlite.prepare(this.#sql).run(...(this.#params as never[]));
    return {
      success: true,
      meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
      results: [],
    };
  }

  async all(): Promise<{ success: boolean; meta: Record<string, unknown>; results: unknown[] }> {
    const rows = this.#sqlite.prepare(this.#sql).all(...(this.#params as never[])) as unknown[];
    return { success: true, meta: {}, results: rows };
  }

  async first<T = unknown>(colName?: string): Promise<T | null> {
    const rows = this.#sqlite.prepare(this.#sql).all(...(this.#params as never[])) as Record<string, unknown>[];
    if (rows.length === 0) return null;
    const row = rows[0] as Record<string, unknown>;
    return (colName === undefined ? row : row[colName]) as T;
  }

  async raw<T = unknown>(): Promise<T[]> {
    const rows = this.#sqlite.prepare(this.#sql).all(...(this.#params as never[])) as Record<string, unknown>[];
    return rows.map((row) => Object.values(row)) as T[];
  }
}

class FakeD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  batchCalls = 0;
  batchSizes: number[] = [];

  prepare(sql: string): FakeD1Statement {
    return new FakeD1Statement(this.sqlite, sql);
  }

  async batch(statements: FakeD1Statement[]): Promise<unknown[]> {
    this.batchCalls += 1;
    this.batchSizes.push(statements.length);
    const results: unknown[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }

  async exec(query: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(query);
    return { count: 0, duration: 0 };
  }
}

const probeItems = sqliteTable("probe_items", {
  id: text("id").primaryKey(),
  note: text("note").notNull(),
  n: integer("n").notNull().default(0),
});

function makeD1(): FakeD1Database {
  const d1 = new FakeD1Database();
  d1.sqlite.exec(
    "CREATE TABLE probe_items (id TEXT PRIMARY KEY, note TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0)",
  );
  return d1;
}

/** Deterministic clock: returns the queued times in order. */
function queuedClock(times: number[]): () => number {
  let i = 0;
  return () => times[Math.min(i++, times.length - 1)];
}

describe("construction-path pin (#4933)", () => {
  function listTsFiles(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (entry === "node_modules") continue;
        listTsFiles(path, out);
      } else if (entry.endsWith(".ts")) {
        out.push(path);
      }
    }
    return out;
  }

  /** Strip // and block comments, respecting string literals. */
  function stripComments(source: string): string {
    let out = "";
    let i = 0;
    let quote: string | null = null;
    while (i < source.length) {
      const ch = source[i];
      const next = source[i + 1];
      if (quote !== null) {
        out += ch;
        if (ch === "\\") {
          out += next ?? "";
          i += 2;
          continue;
        }
        if (ch === quote) quote = null;
        i += 1;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === "`") {
        quote = ch;
        out += ch;
        i += 1;
        continue;
      }
      if (ch === "/" && next === "/") {
        while (i < source.length && source[i] !== "\n") i += 1;
        continue;
      }
      if (ch === "/" && next === "*") {
        i += 2;
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i += 1;
        i += 2;
        continue;
      }
      out += ch;
      i += 1;
    }
    return out;
  }

  it("every drizzle() construction site routes through createDrizzleD1Db", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const directCallers: string[] = [];
    for (const file of listTsFiles(srcDir)) {
      const code = stripComments(readFileSync(file, "utf-8"));
      if (/(?<![\w$.])drizzle\s*\(/.test(code)) {
        // Normalise separators: the pin asserts a repo-relative path
        // ("data/d1QueryLogger.ts"), and Windows hands back backslashes.
        directCallers.push(file.slice(srcDir.length + 1).split("\\").join("/"));
      }
    }
    // The one shared wiring point is the ONLY direct caller.
    expect(directCallers).toEqual(["data/d1QueryLogger.ts"]);
  });

  it("no drizzle() call passes a logger option", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    const loggerPath = join(srcDir, "data", "d1QueryLogger.ts");
    const code = stripComments(readFileSync(loggerPath, "utf-8"));
    expect(code).not.toMatch(/drizzle\([^)]*logger\s*:/);
  });
});

describe("d1_query emission (#4933)", () => {
  it("emits statement + duration for a query, at info level when fast", async () => {
    const d1 = makeD1();
    const sink = new CapturingSink();
    const logger = createD1QueryLogger({ sink, nowMs: queuedClock([1000, 1005]) });
    const db = createDrizzleD1Db(d1 as never, { schema: { probeItems } }, { logger });
    await db.insert(probeItems).values({ id: "a", note: "first", n: 1 }).run();
    expect(sink.events).toHaveLength(1);
    const event = sink.events[0] as ObservabilityEvent;
    expect(event.operation).toBe("d1_query");
    expect(event.level).toBe("info");
    const fields = event.fields as Record<string, unknown>;
    expect(typeof fields.statement).toBe("string");
    expect(String(fields.statement).toLowerCase()).toContain("insert into");
    expect(fields.durationMs).toBe(5);
    expect(fields.slow).toBe(false);
    expect(fields.kind).toBe("run");
    expect(fields.paramCount).toBe(3);
  });

  it("emits warn + slow:true when the duration meets the threshold", async () => {
    const d1 = makeD1();
    const sink = new CapturingSink();
    const logger = createD1QueryLogger({ sink, nowMs: queuedClock([2000, 2150]) });
    const db = createDrizzleD1Db(d1 as never, { schema: { probeItems } }, { logger });
    await db.select().from(probeItems).all();
    expect(sink.events).toHaveLength(1);
    const event = sink.events[0] as ObservabilityEvent;
    expect(event.level).toBe("warn");
    const fields = event.fields as Record<string, unknown>;
    expect(fields.durationMs).toBe(150);
    expect(fields.slow).toBe(true);
    // A select with fields executes through stmt.raw() (drizzle's all()
    // delegates to values() when fields exist) — kind names the D1
    // execution method, not the builder call.
    expect(fields.kind).toBe("raw");
  });

  it("a policy override changes the threshold", async () => {
    const d1 = makeD1();
    const sink = new CapturingSink();
    const logger = createD1QueryLogger({
      sink,
      policy: { slowQueryThresholdMs: 200 },
      nowMs: queuedClock([3000, 3150]),
    });
    const db = createDrizzleD1Db(d1 as never, { schema: { probeItems } }, { logger });
    await db.select().from(probeItems).all();
    const fields = sink.events[0]?.fields as Record<string, unknown>;
    expect(fields.slow).toBe(false);
    expect(sink.events[0]?.level).toBe("info");
  });

  it("batch() emits one batch event and the statements land unproxied", async () => {
    const d1 = makeD1();
    const sink = new CapturingSink();
    const logger = createD1QueryLogger({ sink, nowMs: queuedClock([4000, 4010]) });
    const db = createDrizzleD1Db(d1 as never, { schema: { probeItems } }, { logger });
    await db.batch([
      db.insert(probeItems).values({ id: "b1", note: "one", n: 1 }),
      db.insert(probeItems).values({ id: "b2", note: "two", n: 2 }),
    ]);
    expect(d1.batchCalls).toBe(1);
    expect(d1.batchSizes).toEqual([2]);
    // Exactly one event for the whole batch (not one per statement).
    expect(sink.events).toHaveLength(1);
    const fields = sink.events[0]?.fields as Record<string, unknown>;
    expect(fields.kind).toBe("batch");
    expect(fields.statementCount).toBe(2);
    expect(fields.durationMs).toBe(10);
    const rows = await db.select().from(probeItems).all();
    expect(rows.map((r) => r.id).sort()).toEqual(["b1", "b2"]);
  });

  it("exec() on the wrapped client emits one exec event", async () => {
    const d1 = makeD1();
    const sink = new CapturingSink();
    const logger = createD1QueryLogger({ sink, nowMs: queuedClock([5000, 5003]) });
    const wrapped = logger.wrapD1(d1 as never);
    await wrapped.exec("CREATE TABLE exec_probe (id TEXT PRIMARY KEY)");
    expect(sink.events).toHaveLength(1);
    const fields = sink.events[0]?.fields as Record<string, unknown>;
    expect(fields.kind).toBe("exec");
    expect(fields.durationMs).toBe(3);
  });
});

describe("threshold resolution (#4933)", () => {
  it("defaults to the recorded 100ms budget", () => {
    expect(DEFAULT_D1_QUERY_LOGGER_POLICY).toEqual({ slowQueryThresholdMs: 100 });
    expect(resolveD1QueryLoggerPolicy()).toEqual({ slowQueryThresholdMs: 100 });
  });

  it("settings win over env, env wins over the default", () => {
    expect(
      resolveD1QueryLoggerPolicy({ D1_QUERY_SLOW_MS: "250" }, { "d1.query.slowMs": "50" }),
    ).toEqual({ slowQueryThresholdMs: 50 });
    expect(resolveD1QueryLoggerPolicy({ D1_QUERY_SLOW_MS: "250" })).toEqual({
      slowQueryThresholdMs: 250,
    });
  });

  it("out-of-range values clamp instead of throwing; non-numeric falls back", () => {
    expect(resolveD1QueryLoggerPolicy({}, { "d1.query.slowMs": "-5" })).toEqual({
      slowQueryThresholdMs: 0,
    });
    expect(resolveD1QueryLoggerPolicy({ D1_QUERY_SLOW_MS: "999999" })).toEqual({
      slowQueryThresholdMs: 120000,
    });
    expect(resolveD1QueryLoggerPolicy({ D1_QUERY_SLOW_MS: "not-a-number" })).toEqual({
      slowQueryThresholdMs: 100,
    });
  });
});

describe("statement redaction (#4933)", () => {
  it("masks string literals in the statement text", () => {
    expect(redactD1Statement("SELECT 'sk-live-SECRET123' AS v")).not.toContain("SECRET123");
    expect(redactD1Statement("SELECT 'sk-live-SECRET123' AS v")).toBe("SELECT ? AS v");
    expect(redactD1Statement("WHERE note = 'it''s a secret'")).not.toContain("secret");
    expect(redactD1Statement("select * from probe_items where id = ?")).toBe(
      "select * from probe_items where id = ?",
    );
  });

  it("never logs param values — only count and types", async () => {
    const d1 = makeD1();
    const sink = new CapturingSink();
    const logger = createD1QueryLogger({ sink, nowMs: queuedClock([6000, 6001]) });
    const db = createDrizzleD1Db(d1 as never, { schema: { probeItems } }, { logger });
    await db
      .insert(probeItems)
      .values({ id: "s1", note: "SECRET-PARAM-xyz", n: 7 })
      .run();
    const event = sink.events[0] as ObservabilityEvent;
    const serialized = JSON.stringify(event);
    expect(serialized).not.toContain("SECRET-PARAM-xyz");
    const fields = event.fields as Record<string, unknown>;
    expect(fields.paramCount).toBe(3);
    expect(fields.paramTypes).toEqual(["string", "string", "number"]);
  });

  it("a literal-bearing raw statement is masked in the emitted event", async () => {
    const d1 = makeD1();
    const sink = new CapturingSink();
    const logger = createD1QueryLogger({ sink, nowMs: queuedClock([7000, 7002]) });
    const db = createDrizzleD1Db(d1 as never, { schema: { probeItems } }, { logger });
    await db.run(sql`select 'sk-live-RAWSECRET' as v`);
    const serialized = JSON.stringify(sink.events);
    expect(serialized).not.toContain("RAWSECRET");
  });
});

describe("zero behavior change (#4933)", () => {
  it("wrapped and plain drizzle return byte-identical results", async () => {
    const d1a = makeD1();
    const d1b = makeD1();
    const sink = new CapturingSink();
    const logger = createD1QueryLogger({ sink, nowMs: () => 8000 });
    const wrapped = createDrizzleD1Db(d1a as never, { schema: { probeItems } }, { logger });
    const plain = drizzle(d1b as never, { schema: { probeItems } });
    const values = [
      { id: "w1", note: "alpha", n: 1 },
      { id: "w2", note: "beta", n: 2 },
    ];
    for (const v of values) {
      await wrapped.insert(probeItems).values(v).run();
      await plain.insert(probeItems).values(v).run();
    }
    const wrappedRows = await wrapped.select().from(probeItems).all();
    const plainRows = await plain.select().from(probeItems).all();
    expect(wrappedRows).toEqual(plainRows);
    const wrappedOne = await wrapped
      .select()
      .from(probeItems)
      .where(eq(probeItems.id, "w2"))
      .get();
    const plainOne = await plain.select().from(probeItems).where(eq(probeItems.id, "w2")).get();
    expect(wrappedOne).toEqual(plainOne);
    expect(wrappedRows).toHaveLength(2);
  });

  it("a failing query rethrows the original error and emits an error event", async () => {
    const d1 = makeD1();
    const sink = new CapturingSink();
    const logger = createD1QueryLogger({ sink, nowMs: queuedClock([9000, 9001]) });
    const db = createDrizzleD1Db(d1 as never, { schema: { probeItems } }, { logger });
    await expect(db.select().from(probeItems).where(eq(probeItems.id, "x")).all()).resolves.toEqual([]);
    // A query against a missing table fails identically on both dbs:
    // drizzle wraps the underlying error, and the wrapper must not
    // change the thrown error — only the logged event carries the root
    // cause ("no such table").
    const missing = drizzle(d1 as never, { schema: { probeItems } });
    const plainError = await missing
      .run(sql`select * from no_such_table_xyz`)
      .then(
        () => null,
        (err: unknown) => err,
      );
    const wrappedError = await db
      .run(sql`select * from no_such_table_xyz`)
      .then(
        () => null,
        (err: unknown) => err,
      );
    expect(plainError).toBeInstanceOf(Error);
    expect(wrappedError).toBeInstanceOf(Error);
    expect((wrappedError as Error).message).toBe((plainError as Error).message);
    const errorEvents = sink.events.filter((e) => e.level === "error");
    expect(errorEvents).toHaveLength(1);
    expect(String((errorEvents[0]?.fields as Record<string, unknown>).error)).toContain(
      "no such table",
    );
  });

  it("an unbound binding constructs exactly like bare drizzle() (no Proxy TypeError)", () => {
    // Regression: the first PR CI run failed feed_parity_3941's
    // "no AGENT_DB in workflow residency still refuses by name" case —
    // feedStepDepsForWorkflow calls createD1IndexListDb(undefined) and
    // the wrapper's `new Proxy(undefined, …)` threw at construction,
    // where a bare drizzle(undefined) constructs fine and the refusal
    // surfaces downstream by name. A missing binding is not a query
    // to observe: it passes through untouched.
    const sink = new CapturingSink();
    const logger = createD1QueryLogger({ sink, nowMs: () => 9500 });
    const wrapped = createDrizzleD1Db(undefined as never, { schema: { probeItems } }, { logger });
    expect(wrapped.$client).toBeUndefined();
    const plain = drizzle(undefined as never, { schema: { probeItems } });
    expect(plain.$client).toBeUndefined();
    expect(sink.events).toHaveLength(0);
  });
});
