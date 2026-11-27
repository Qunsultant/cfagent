/**
 * Issue #876 (production hotfix): scheduled screens failed loudly from
 * 2026-10-21T03:30Z because `persistScheduledReportSql` returned null —
 * while the underlying SQL error was destroyed by a bare `catch {}` and
 * `ensureScheduledReportsTable` was not self-healing against accumulated
 * table state (duplicate generation_id values break its UNIQUE INDEX;
 * legacy shapes can lack columns the INSERTs name).
 *
 * Pins (Red on pristine main, noted per test):
 *  - duplicate non-null generation_id rows: the frozen DO ensure still
 *    self-heals (the index failure is logged, nothing throws);
 *  - legacy-shaped table missing a column the INSERT needs (body):
 *    the frozen DO ensure still reconciles additively;
 *  - D1 store throwing on INSERT: storeReportAtGeneration returns null
 *    AND console.error carries the error's message;
 *  - recordUsageEvent (the module's other write seam) also logs [RED];
 *  - source pin: the D1 store seam contains logging and no bare catch.
 *
 * Characterization (passes both sides, disclosed): the healthy-store
 * test — persist returns the id, the row reads back, store dedupes on
 * generation id, and NO error is logged.
 *
 * Issue #6101 (step 8): the persist seam moved to D1 agent_reports.
 * `persistScheduledReportSql` is DELETED — its honesty contract now
 * lives on storeReportAtGeneration (D1). The two DO tests keep ONLY
 * their ensure halves: the frozen mas_reports table's ensure still
 * runs (maintenance), but no seam writes it anymore. The "generation
 * UNIQUE INDEX creation sits inside a guarded try" source pin is
 * DELETED: D1 agent_reports carries PK (tenant_id, report_id,
 * version) and no generation UNIQUE index — dedupe is SELECT-then-
 * INSERT, so there is no runtime index creation to guard; the
 * no-second-live-row invariant is pinned by the dedupe tests
 * (tests/reports_d1_6101.test.ts + the healthy-store test here).
 *
 * The double below extends MockSqlStorage with the strict SQLite
 * semantics plain MockSqlStorage does not model (pattern of
 * tests/orm-mas-reports-migration.test.ts): CREATE TABLE registers the
 * parsed column shape, INSERT enforces unknown columns / NOT NULL /
 * live UNIQUE indexes, and CREATE UNIQUE INDEX over duplicate non-null
 * values throws, exactly like the DO runtime.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { MockSqlStorage } from "./mock-sql";
import { MockD1Database } from "./mock-d1";
import type { SqlStorage } from "../src/orm";
import {
  ensureScheduledReportsTable,
  storeReportAtGeneration,
  getCanonicalReport,
  recordUsageEvent,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";

type D1Database = any;

interface ColMeta {
  name: string;
  notnull: boolean;
}

type SchemaMap = Map<string, Array<{ name: string; type: string; pk: number }>>;
type TablesMap = Map<string, Array<Record<string, unknown>>>;

class StrictMasReportsSql extends MockSqlStorage {
  private reportsCols: ColMeta[] | null = null;
  private uniqueIndexCols = new Map<string, string[]>(); // index name -> columns
  private createdIndexNames = new Set<string>();
  /** When set, every INSERT INTO mas_reports throws this error. */
  failInsertsWith: Error | null = null;

  private setReportsSchema(cols: ColMeta[], pkCol = "id"): void {
    this.reportsCols = cols.map((c) => ({ ...c }));
    const schema = (this as unknown as { schema: SchemaMap }).schema;
    schema.set(
      "mas_reports",
      cols.map((c) => ({ name: c.name, type: "TEXT", pk: c.name === pkCol ? 1 : 0 }))
    );
    const tables = (this as unknown as { tables: TablesMap }).tables;
    if (!tables.has("mas_reports")) tables.set("mas_reports", []);
  }

  private reportRows(): Array<Record<string, unknown>> {
    const tables = (this as unknown as { tables: TablesMap }).tables;
    return tables.get("mas_reports") ?? [];
  }

  /** Seed a pre-existing table shape + rows, bypassing exec enforcement. */
  seedTable(cols: ColMeta[], rows: Array<Record<string, unknown>>): void {
    this.setReportsSchema(cols);
    const tables = (this as unknown as { tables: TablesMap }).tables;
    tables.set("mas_reports", rows.map((r) => ({ ...r })));
  }

  exec(query: string, ...args: unknown[]): Iterable<unknown> {
    const q = query.trim();

    // CREATE TABLE IF NOT EXISTS mas_reports ( ... ) — register the
    // parsed shape only when the table does not already exist.
    const createMatch = q.match(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+mas_reports\s*\(([\s\S]*)\)/i);
    if (createMatch) {
      if (!this.reportsCols) {
        const cols: ColMeta[] = createMatch[1]
          .split(",")
          .map((def) => def.trim())
          .filter(Boolean)
          .map((def) => {
            const name = def.split(/\s+/)[0];
            return {
              name,
              notnull: /NOT\s+NULL/i.test(def) || /PRIMARY\s+KEY/i.test(def),
            };
          });
        this.setReportsSchema(cols);
      }
      return [];
    }

    // ALTER TABLE mas_reports ADD COLUMN <col> <type>
    const alterMatch = q.match(/ALTER\s+TABLE\s+mas_reports\s+ADD\s+COLUMN\s+(\w+)\s+(\w+)/i);
    if (alterMatch) {
      if (this.reportsCols && !this.reportsCols.some((c) => c.name === alterMatch[1])) {
        const next = [...this.reportsCols, { name: alterMatch[1], notnull: false }];
        this.setReportsSchema(next);
      }
      return [];
    }

    // CREATE [UNIQUE] INDEX ... ON mas_reports (<col>, ...)
    // ADAPTED for #2398 (§7): the generation index is composite
    // — (user_login, generation_id) — so the double parses the
    // full column list and detects duplicates over the column
    // TUPLE (a NULL in any indexed column makes the row
    // distinct), exactly as real SQLite does. Single-column
    // indexes behave as before.
    const idxMatch = q.match(
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(\w+)\s+ON\s+mas_reports\s*\(([\w\s,]+)\)/i
    );
    if (idxMatch) {
      const unique = !!idxMatch[1];
      const name = idxMatch[2];
      const columns = idxMatch[3]
        .split(",")
        .map((s) => s.trim().split(/\s+/)[0])
        .filter(Boolean);
      if (this.createdIndexNames.has(name)) return [];
      for (const col of columns) {
        if (!this.reportsCols?.some((c) => c.name === col)) {
          throw new Error(`no such column: ${col}`);
        }
      }
      if (unique) {
        const seen = new Set<string>();
        for (const row of this.reportRows()) {
          const tuple = columns.map((c) => row[c]);
          if (tuple.some((v) => v === null || v === undefined)) continue;
          const key = JSON.stringify(tuple);
          if (seen.has(key)) {
            throw new Error(`UNIQUE constraint failed: index '${name}'`);
          }
          seen.add(key);
        }
        this.uniqueIndexCols.set(name, columns);
      }
      this.createdIndexNames.add(name);
      return [];
    }

    // INSERT INTO mas_reports (cols) VALUES (...) — strict enforcement.
    const insertMatch = q.match(/INSERT\s+INTO\s+mas_reports\s*\(([^)]*)\)\s*VALUES/i);
    if (insertMatch) {
      if (this.failInsertsWith) throw this.failInsertsWith;
      const cols = insertMatch[1].split(",").map((c) => c.trim());
      const known = new Set((this.reportsCols ?? []).map((c) => c.name));
      for (const c of cols) {
        if (!known.has(c)) {
          throw new Error(`table mas_reports has no column named ${c}`);
        }
      }
      const values = new Map<string, unknown>();
      cols.forEach((c, i) => values.set(c, args[i]));
      for (const meta of this.reportsCols ?? []) {
        if (meta.notnull) {
          const v = values.get(meta.name);
          if (v === undefined || v === null) {
            throw new Error(`NOT NULL constraint failed: mas_reports.${meta.name}`);
          }
        }
      }
      for (const columns of this.uniqueIndexCols.values()) {
        const tuple = columns.map((c) => values.get(c));
        if (tuple.some((v) => v === null || v === undefined)) continue;
        if (
          this.reportRows().some((r) =>
            columns.every((c, i) => r[c] === tuple[i])
          )
        ) {
          throw new Error(
            `UNIQUE constraint failed: ${columns.map((c) => `mas_reports.${c}`).join(", ")}`
          );
        }
      }
      return super.exec(query, ...args);
    }

    return super.exec(query, ...args);
  }
}

const FULL_COLS: ColMeta[] = [
  { name: "id", notnull: true },
  { name: "run_id", notnull: true },
  { name: "title", notnull: true },
  { name: "source", notnull: true },
  { name: "summary", notnull: true },
  { name: "body", notnull: true },
  { name: "created_at", notnull: true },
  { name: "generation_id", notnull: false },
  { name: "user_login", notnull: false },
];

function seedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "rep_seed",
    run_id: "run-seed",
    title: "Seed report",
    source: "screener",
    summary: "seed summary",
    body: "{}",
    created_at: "2026-10-01T00:00:00.000Z",
    generation_id: null,
    user_login: "default",
    ...over,
  };
}

function input(over: Partial<ScheduledReportInput> = {}): ScheduledReportInput {
  return {
    runId: "screener:2026-10-21T03:30:00Z",
    title: "Autonomous market screen — Technology",
    source: "screener",
    summary: "Scanned 100 symbols, 4 matched.",
    body: { opportunities: [{ symbol: "NVDA" }] },
    createdAt: "2026-10-21T03:30:00.000Z",
    userLogin: "tenant@example.com",
    ...over,
  };
}

let errSpy: ReturnType<typeof vi.spyOn>;
let infoSpy: ReturnType<typeof vi.spyOn>;

// #3515 S3: the persist seams now log via the structured logger, whose
// fallback sink writes every event as one JSON line via console.info.
// Parse those lines into { operation, level, fields } events (batch-1
// precedent, tests/feature_flags_1806.test.ts).
function structuredEvents(): Array<{ operation: string; level: string; fields: Record<string, unknown> }> {
  const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
  for (const call of infoSpy.mock.calls) {
    try {
      const parsed = JSON.parse(String(call[0])) as {
        operation?: unknown;
        level?: unknown;
        fields?: unknown;
      };
      if (parsed && typeof parsed.operation === "string") {
        events.push({
          operation: parsed.operation,
          level: typeof parsed.level === "string" ? parsed.level : "",
          fields:
            parsed.fields && typeof parsed.fields === "object"
              ? (parsed.fields as Record<string, unknown>)
              : {},
        });
      }
    } catch {
      // Non-JSON console.info lines are not structured events.
    }
  }
  return events;
}

beforeEach(() => {
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  errSpy.mockRestore();
  infoSpy.mockRestore();
});

describe("issue #876 — persist seams surface the real error", () => {
  it("duplicate generation_id rows: the frozen DO ensure still self-heals (index failure logged, nothing throws)", () => {
    const sql = new StrictMasReportsSql();
    sql.seedTable(FULL_COLS, [
      seedRow({ id: "rep_a", generation_id: "gen-dup" }),
      seedRow({ id: "rep_b", generation_id: "gen-dup" }),
    ]);

    expect(() => ensureScheduledReportsTable(sql)).not.toThrow();
    // #3515 S3 batch 7: the index-failure log rides the S2 structured
    // logger — the console-info JSON fallback carries the
    // doSqliteCanonicalReportStore.unique_index_creation_failed error event.
    const failed = structuredEvents().filter(
      (e) => e.operation === "doSqliteCanonicalReportStore.unique_index_creation_failed",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.level).toBe("error");
    expect(String(failed[0]?.fields.message ?? "")).toContain("idx_mas_reports_generation");
    // #6101 step 8: the DO table is frozen — no seam writes it anymore,
    // so there is no persist half to this test; the ensure half above
    // is the whole pin.
  });

  it("legacy-shaped table missing `body`: the frozen DO ensure still reconciles additively", () => {
    const sql = new StrictMasReportsSql();
    const legacyCols = FULL_COLS.filter(
      (c) => !["body", "generation_id", "user_login"].includes(c.name)
    );
    const legacyRow = seedRow({ id: "rep_legacy" });
    delete legacyRow.body;
    delete legacyRow.generation_id;
    delete legacyRow.user_login;
    sql.seedTable(legacyCols, [legacyRow]);

    expect(() => ensureScheduledReportsTable(sql)).not.toThrow();

    const cols = Array.from(sql.exec("PRAGMA table_info(mas_reports)")) as Array<{
      name?: unknown;
    }>;
    const names = cols.map((c) => String(c?.name));
    for (const expected of ["body", "generation_id", "user_login"]) {
      expect(names).toContain(expected);
    }
    // #6101 step 8: the persist half (persistScheduledReportSql) died
    // with the DO seam — the D1 store is pinned by the healthy-store
    // test below instead.
  });

  it("D1 store throwing on INSERT: storeReportAtGeneration returns null AND the error is logged with its message", async () => {
    // Fail at the agent_reports INSERT (after the migrations run):
    // the seam must still return null and log the failure. Drizzle
    // wraps the underlying error (the log carries the failing
    // statement, not the raw cause), so the pin asserts what
    // survives the wrap — the seam name, the REPORT_FANOUT_FAILED
    // code, and the failing statement or the raw cause.
    class FailingInsertD1 extends MockD1Database {
      override prepare(sql: string) {
        const stmt = super.prepare(sql) as {
          bind(...params: unknown[]): {
            run(): Promise<unknown>;
            all(): Promise<unknown>;
            first(): Promise<unknown>;
            raw(): Promise<unknown>;
          };
        };
        if (/INSERT\s+INTO\s+["`]?agent_reports["`]?/i.test(sql)) {
          return {
            bind(...params: unknown[]) {
              const bound = stmt.bind(...params);
              return {
                ...bound,
                async run() {
                  throw new Error("simulated store failure: SQLITE_FULL");
                },
              };
            },
          };
        }
        return stmt;
      }
    }
    const brokenEnv = {
      AGENT_DB: new FailingInsertD1() as unknown as D1Database,
    };
    expect(await storeReportAtGeneration(input(), brokenEnv)).toBeNull();
    // #3515 S3: the failure travels as structured events on the
    // console-info JSON fallback. The seam logs the underlying error
    // before returning null (never a silent null).
    const events = structuredEvents();
    const failed = events.find((e) => e.operation === "storeReportAtGeneration.failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("error");
    expect(String(failed?.fields.message ?? "")).toContain("storeReportAtGeneration failed");
    expect(String(failed?.fields.message ?? "")).toContain("REPORT_FANOUT_FAILED");
    expect(String(failed?.fields.error ?? "")).toMatch(/agent_reports|SQLITE_FULL/);
  });

  it("recordUsageEvent failure is logged before returning null", () => {
    const throwingSql = {
      exec: (query: string): Iterable<unknown> => {
        if (/INSERT\s+INTO\s+usage_events/i.test(query)) {
          throw new Error("simulated metering failure: SQLITE_BUSY");
        }
        return [];
      },
    } as unknown as SqlStorage;
    expect(
      recordUsageEvent(throwingSql, {
        userLogin: "trader1",
        runId: "run-1",
        category: "research_run",
      })
    ).toBeNull();
    const failed = structuredEvents().find((e) => e.operation === "recordUsageEvent.failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("error");
    expect(String(failed?.fields.message ?? "")).toContain("recordUsageEvent");
    expect(String(failed?.fields.error ?? "")).toContain("SQLITE_BUSY");
  });

  it("healthy D1 store: persist returns the id, row reads back, store dedupes, NO error logged (characterization)", async () => {
    const mock = new MockD1Database();
    const env = { AGENT_DB: mock as unknown as D1Database };

    const first = await storeReportAtGeneration(input(), env);
    expect(first?.reportId).toBeTruthy();
    expect(first?.created).toBe(true);
    expect(await getCanonicalReport(env, first!.reportId))?.toMatchObject({
      title: input().title,
    });

    const second = await storeReportAtGeneration(input({ generationId: "gen-h" }), env);
    expect(second?.created).toBe(true);
    const third = await storeReportAtGeneration(input({ generationId: "gen-h" }), env);
    expect(third?.created).toBe(false);
    expect(third?.reportId).toBe(second?.reportId);

    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe("issue #876 — source pin", () => {
  const src = readFileSync(
    fileURLToPath(new URL("../src/services/scheduledReports.ts", import.meta.url)),
    "utf-8"
  );
  const slice = (from: string, to: string): string => {
    const start = src.indexOf(from);
    const end = src.indexOf(to, start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return src.slice(start, end);
  };

  it("the D1 store seam logs and contains no bare catch", () => {
    // #6101 step 8: the seam's body lives in the D1 writer core
    // (storeReportAtGenerationD1); the exported seam is a thin
    // delegate. The pin slices exactly the core function.
    const storeSrc = slice(
      "async function storeReportAtGenerationD1",
      "export async function storeReportAtGeneration"
    );
    // #3515 S3: the seam logs via the structured logger — the
    // structuredLog.error call with the same message content, not a
    // console.error line. The pin keeps the same strength: the seam
    // must log the failure (named operation + message) and must not
    // swallow it in a bare catch.
    // #6101 step 8: the persistScheduledReportSql half died with the
    // deleted wrapper — the D1 seam is the only persist seam left.
    // The operation is dynamic (`${seam}.failed`, seam =
    // "storeReportAtGeneration" / "storeReportAtGenerationWithR2").
    expect(storeSrc).toContain("structuredLog.error(`${seam}.failed`");
    expect(storeSrc).toContain("[scheduledReports] ${seam} failed");
    expect(storeSrc).not.toMatch(/catch\s*\{/);
  });

  // DELETED #6101 step 8: "the generation UNIQUE INDEX creation sits
  // inside a guarded try with logging" — D1 agent_reports carries PK
  // (tenant_id, report_id, version) and no generation UNIQUE index;
  // dedupe is SELECT-then-INSERT, so there is no runtime index
  // creation to guard. The no-second-live-row invariant is pinned by
  // the dedupe tests (tests/reports_d1_6101.test.ts + the
  // healthy-store test above).
});
