/**
 * Issue #2337 (#1976 step 2) — CUTOVER WIRING pins (the
 * cutover's second half). Part 1 of the cutover flipped the
 * env-aware composition's default (the conformance suite's
 * CUTOVER GATE pins): buildOptionsDiscoveryPorts now selects
 * the D1 IV-history adapter whenever AGENT_DB is bound. But
 * the builder had no production caller — every production IV
 * site still composed the sync root, whose IV store is the
 * DO adapter unconditionally. A flipped default in dead code
 * is not a cutover. These pins prove the wiring:
 *
 *  1. Read path, end to end: the /etrade/options/iv-history
 *     handler serves from D1 when AGENT_DB is bound — a cold
 *     D1 store reports the honest warming-up state even when
 *     the abandoned DO store holds data, a D1-only row is
 *     what serves when both stores hold a row for the same
 *     day, and the rollback lever ("false") serves the DO
 *     row end to end.
 *  2. The D1 schema ensure is memoized per AGENT_DB binding
 *     inside the composition root, so per-request composition
 *     does not re-run DDL per request; a failed ensure is
 *     evicted, never memoized, so the next build retries.
 *  3. Wiring census: the four production IV sites compose
 *     through buildOptionsDiscoveryPorts, and no file outside
 *     the composition root reads .ivHistory without doing
 *     so — the cutover cannot silently unwire.
 *
 * Red (pristine tree): the handler serves the DO store, the
 * ensure re-runs on every build, and all four sites compose
 * the sync root — pins 1a, 1b, 2a and both census pins fail.
 * Pin 1c passes on both trees by design (on the pristine
 * tree the handler ignores env entirely and serves DO, which
 * is what the lever demands; the pin guards the lever
 * against a rewire that always serves D1). Pin 2b passes on
 * the pristine tree vacuously (no memoization exists to
 * evict a failure from); it binds the eviction semantics of
 * the memoization introduced alongside it.
 */
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { handleOptionsIvHistory } from "../src/agents/routes/etradeOptionsRuns";
import {
  buildOptionsDiscoveryPorts,
} from "../src/data/createOptionsDiscoveryPorts";
import { SqlIvHistoryStore } from "../src/data/doSqliteIvHistoryAdapter";
import {
  createD1IvHistoryDb,
  D1IvHistoryStore,
  ensureIvHistorySchema,
} from "../src/data/d1IvHistoryAdapter";

/* ------------------------------------------------------------------ */
/* Storage doubles (the conformance suite's shapes)                    */
/* ------------------------------------------------------------------ */

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

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
  async batch(statements: any[]) {
    const results: any[] = [];
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
}

/** A D1 double that counts every statement prepared through it. */
class CountingD1Database extends MockD1Database {
  prepareCount = 0;
  batchCount = 0;
  override prepare(sql: string) {
    this.prepareCount += 1;
    return super.prepare(sql);
  }
  override async batch(statements: any[]) {
    this.batchCount += 1;
    return super.batch(statements);
  }
}

/** A D1 double whose first `failures` migration statements throw. */
class FlakyD1Database extends MockD1Database {
  private failuresRemaining: number;
  constructor(failures: number) {
    super();
    this.failuresRemaining = failures;
  }
  override prepare(sql: string) {
    if (this.failuresRemaining > 0 && sql.includes("_migrations")) {
      this.failuresRemaining -= 1;
      throw new Error("injected D1 failure on _migrations");
    }
    return super.prepare(sql);
  }
}

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function ivFixture(date: string, atmIv: number): never {
  return {
    symbol: "AAPL",
    date,
    atmIv,
    spot: 200,
    expiryDate: "2026-11-20",
    dte: 30,
    collectedAt: `${date}T14:00:00.000Z`,
  } as never;
}

async function seedDoStore(storage: SqliteTestStorage, date: string, atmIv: number): Promise<void> {
  await new SqlIvHistoryStore(storage as never).record(ivFixture(date, atmIv));
}

async function seedD1Store(mock: MockD1Database, date: string, atmIv: number): Promise<void> {
  const db = createD1IvHistoryDb(mock as never);
  await ensureIvHistorySchema(db);
  await new D1IvHistoryStore(db).record(ivFixture(date, atmIv));
}

function routeCtx(env: Record<string, unknown>): never {
  return {
    // Issue #3937: the IV-history read serves the selected broker's
    // series, so the test tenant selects etrade explicitly (an explicit
    // env wins) — the platform default is alpaca now.
    env: { BROKER_ID: "etrade", ...env },
    getOrm: () => ({ watchlists: { findMany: () => [] } }),
  } as never;
}

const IV_HISTORY_URL = new URL("https://agent.test/etrade/options/iv-history?symbol=AAPL");

/* ------------------------------------------------------------------ */
/* 1. The read path serves the cutover store, end to end               */
/* ------------------------------------------------------------------ */

describe("#2337 cutover wiring — the iv-history read handler", () => {
  it("cold D1 reports the warming-up state; the abandoned DO series is invisible", async () => {
    const doStorage = new SqliteTestStorage();
    await seedDoStore(doStorage, "2026-10-20", 0.55);
    const res = await handleOptionsIvHistory(
      IV_HISTORY_URL,
      routeCtx({ AGENT_DB: new MockD1Database() }),
      doStorage as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      symbol: string;
      observations: number;
      warmingUp: boolean;
      latest: unknown;
    };
    expect(body.symbol).toBe("AAPL");
    expect(body.observations).toBe(0);
    expect(body.warmingUp).toBe(true);
    expect(body.latest).toBeNull();
  });

  it("a row held only in D1 serves; the DO row for the same day does not", async () => {
    const doStorage = new SqliteTestStorage();
    await seedDoStore(doStorage, "2026-10-20", 0.55);
    const mock = new MockD1Database();
    await seedD1Store(mock, "2026-10-20", 0.3);
    const res = await handleOptionsIvHistory(
      IV_HISTORY_URL,
      routeCtx({ AGENT_DB: mock }),
      doStorage as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      observations: number;
      latest: { atmIv: number } | null;
    };
    expect(body.observations).toBe(1);
    expect(body.latest?.atmIv).toBe(0.3);
  });

  it("the rollback lever end to end: flag \"false\" serves the DO row, D1 invisible", async () => {
    const doStorage = new SqliteTestStorage();
    await seedDoStore(doStorage, "2026-10-20", 0.55);
    const mock = new MockD1Database();
    await seedD1Store(mock, "2026-10-20", 0.3);
    const res = await handleOptionsIvHistory(
      IV_HISTORY_URL,
      routeCtx({ AGENT_DB: mock, IV_HISTORY_D1_ENABLED: "false" }),
      doStorage as never,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      observations: number;
      latest: { atmIv: number } | null;
    };
    expect(body.observations).toBe(1);
    expect(body.latest?.atmIv).toBe(0.55);
  });
});

/* ------------------------------------------------------------------ */
/* 2. The schema ensure is memoized per AGENT_DB binding               */
/* ------------------------------------------------------------------ */

describe("#2337 cutover wiring — D1 schema-ensure memoization", () => {
  // The envs below pin IV_HISTORY_D1_ENABLED: "true" so D1 is
  // selected under BOTH the step-2 semantics and the post-
  // cutover default — these pins bind the ensure's
  // memoization, not the selection rule (the handler pins
  // above bind the selection rule, flag-free).
  it("the ensure runs once per binding across builds; a different binding ensures independently", async () => {
    const counting = new CountingD1Database();
    const storage = new SqliteTestStorage();
    const first = await buildOptionsDiscoveryPorts(
      { AGENT_DB: counting, IV_HISTORY_D1_ENABLED: "true" },
      { sql: storage as never },
    );
    expect(first.ivHistory).toBeInstanceOf(D1IvHistoryStore);
    const afterFirst = counting.prepareCount + counting.batchCount;
    expect(afterFirst).toBeGreaterThan(0);
    const second = await buildOptionsDiscoveryPorts(
      { AGENT_DB: counting, IV_HISTORY_D1_ENABLED: "true" },
      { sql: storage as never },
    );
    expect(second.ivHistory).toBeInstanceOf(D1IvHistoryStore);
    expect(counting.prepareCount + counting.batchCount).toBe(afterFirst);
    const other = new CountingD1Database();
    await buildOptionsDiscoveryPorts(
      { AGENT_DB: other, IV_HISTORY_D1_ENABLED: "true" },
      { sql: storage as never },
    );
    expect(other.prepareCount + other.batchCount).toBeGreaterThan(0);
  });

  it("a failed ensure is evicted: the next build over the same binding retries and succeeds", async () => {
    const flaky = new FlakyD1Database(1);
    const storage = new SqliteTestStorage();
    // The rejection's message is the driver's wrapper ("Failed
    // to run the query …") around the injected failure — the
    // pin binds THAT it rejects, not the wrapper's wording.
    await expect(
      buildOptionsDiscoveryPorts({ AGENT_DB: flaky, IV_HISTORY_D1_ENABLED: "true" }, { sql: storage as never }),
    ).rejects.toThrow();
    const retried = await buildOptionsDiscoveryPorts(
      { AGENT_DB: flaky, IV_HISTORY_D1_ENABLED: "true" },
      { sql: storage as never },
    );
    expect(retried.ivHistory).toBeInstanceOf(D1IvHistoryStore);
  });
});

/* ------------------------------------------------------------------ */
/* 3. Wiring census (the global census suite's scanning idiom)         */
/* ------------------------------------------------------------------ */

const SRC_FILES: string[] = [];
function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) SRC_FILES.push(path);
  }
}
walk("src");
const TEXT = new Map(SRC_FILES.map((f) => [f, readFileSync(f, "utf8")]));

/** Strip // and block comments while respecting string literals. */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  let mode: string | null = null;
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1] ?? "";
    if (mode === "line") {
      if (c === "\n") { mode = null; out += c; } else out += " ";
      i++; continue;
    }
    if (mode === "block") {
      if (c === "*" && n === "/") { mode = null; out += "  "; i += 2; }
      else { out += c === "\n" ? "\n" : " "; i++; }
      continue;
    }
    if (mode) {
      out += c;
      if (c === "\\") { out += n; i += 2; continue; }
      if (c === mode) mode = null;
      i++; continue;
    }
    if (c === "/" && n === "/") { mode = "line"; out += "  "; i += 2; continue; }
    if (c === "/" && n === "*") { mode = "block"; out += "  "; i += 2; continue; }
    if (c === "'" || c === '"' || c === "`") mode = c;
    out += c; i++;
  }
  return out;
}
const STRIPPED = new Map(SRC_FILES.map((f) => [f, stripComments(TEXT.get(f)!)]));
const COMPOSITION_ROOT = "src/data/createOptionsDiscoveryPorts.ts";
const IV_SITE_FILES = [
  "src/agents/routes/etradeOptionsRuns.ts",
  "src/agents/orchestrator/scheduledCallbacks.ts",
  "src/agents/routes/schedules.ts",
  "src/services/discoveryService.ts",
];

describe("#2337 cutover wiring — census", () => {
  it("the four production IV sites compose through buildOptionsDiscoveryPorts", () => {
    for (const file of IV_SITE_FILES) {
      expect(STRIPPED.get(file), file).toContain("buildOptionsDiscoveryPorts(");
    }
  });

  it("no file outside the composition root reads .ivHistory without composing through the env-aware build", () => {
    for (const file of SRC_FILES) {
      if (file === COMPOSITION_ROOT) continue;
      const text = STRIPPED.get(file)!;
      if (/\.ivHistory\b/.test(text)) {
        expect(text, file).toContain("buildOptionsDiscoveryPorts(");
      }
    }
  });
});
