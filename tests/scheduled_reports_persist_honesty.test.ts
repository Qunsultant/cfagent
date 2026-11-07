/**
 * Issue #876 (production hotfix): scheduled screens failed loudly from
 * 2026-10-21T03:30Z because `persistScheduledReportSql` returned null —
 * while the underlying SQL error was destroyed by a bare `catch {}` and
 * `ensureScheduledReportsTable` was not self-healing against accumulated
 * table state (duplicate generation_id values break its UNIQUE INDEX;
 * legacy shapes can lack columns the INSERTs name).
 *
 * Pins (Red on pristine main, noted per test):
 *  - duplicate non-null generation_id rows: persist succeeds, the index
 *    failure is logged (naming the index), nothing throws [RED: null];
 *  - legacy-shaped table missing a column the INSERT needs (body):
 *    persist succeeds after additive reconciliation [RED: null];
 *  - store throwing on INSERT: persist returns null AND console.error
 *    carries the error's message [RED: nothing logged]; same for
 *    storeReportAtGeneration [RED: nothing logged];
 *  - recordUsageEvent (the module's other write seam) also logs [RED];
 *  - source pin: the persist seams contain logging and no bare catch.
 *
 * Characterization (passes both sides, disclosed): the healthy-store
 * test — persist returns the id, the row reads back, store dedupes on
 * generation id, and NO error is logged.
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
import type { SqlStorage } from "../src/orm";
import {
  ensureScheduledReportsTable,
  persistScheduledReportSql,
  storeReportAtGeneration,
  getCanonicalReport,
  recordUsageEvent,
  type ScheduledReportInput,
} from "../src/services/scheduledReports";

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

function loggedText(): string {
  return errSpy.mock.calls
    .map((args: unknown[]) =>
      args.map((a) => (a instanceof Error ? a.message : String(a))).join(" ")
    )
    .join("\n");
}

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
  it("duplicate generation_id rows: persist succeeds, index failure is logged, nothing throws", () => {
    const sql = new StrictMasReportsSql();
    sql.seedTable(FULL_COLS, [
      seedRow({ id: "rep_a", generation_id: "gen-dup" }),
      seedRow({ id: "rep_b", generation_id: "gen-dup" }),
    ]);

    expect(() => ensureScheduledReportsTable(sql)).not.toThrow();
    expect(loggedText()).toContain("idx_mas_reports_generation");

    const id = persistScheduledReportSql(sql, input());
    expect(id).toBeTruthy();
    const stored = getCanonicalReport(sql, id as string);
    expect(stored?.title).toBe("Autonomous market screen — Technology");
  });

  it("legacy-shaped table missing `body`: persist succeeds after additive reconciliation", () => {
    const sql = new StrictMasReportsSql();
    const legacyCols = FULL_COLS.filter(
      (c) => !["body", "generation_id", "user_login"].includes(c.name)
    );
    const legacyRow = seedRow({ id: "rep_legacy" });
    delete legacyRow.body;
    delete legacyRow.generation_id;
    delete legacyRow.user_login;
    sql.seedTable(legacyCols, [legacyRow]);

    const id = persistScheduledReportSql(sql, input());
    expect(id).toBeTruthy();

    const cols = Array.from(sql.exec("PRAGMA table_info(mas_reports)")) as Array<{
      name?: unknown;
    }>;
    const names = cols.map((c) => String(c?.name));
    for (const expected of ["body", "generation_id", "user_login"]) {
      expect(names).toContain(expected);
    }
    expect(getCanonicalReport(sql, id as string)?.runId).toBe(input().runId);
  });

  it("store throwing on INSERT: persist returns null AND the error is logged with its message", () => {
    const sql = new StrictMasReportsSql();
    sql.failInsertsWith = new Error("simulated store failure: SQLITE_FULL");
    expect(persistScheduledReportSql(sql, input())).toBeNull();
    // #3515 S3: the failure now travels as structured events on the
    // console-info JSON fallback. The inner seam logs the underlying
    // error; the outer seam logs that it returned null (attributable
    // to this door, pointing at the inner line for the cause).
    const events = structuredEvents();
    const inner = events.find((e) => e.operation === "storeReportAtGeneration.failed");
    expect(inner).toBeDefined();
    expect(inner?.level).toBe("error");
    expect(String(inner?.fields.error ?? "")).toContain("SQLITE_FULL");
    expect(String(inner?.fields.message ?? "")).toContain("storeReportAtGeneration");
    const outer = events.find((e) => e.operation === "persistScheduledReportSql.seam_returned_null");
    expect(outer).toBeDefined();
    expect(outer?.level).toBe("error");
    expect(String(outer?.fields.message ?? "")).toContain("persistScheduledReportSql");
  });

  it("storeReportAtGeneration failure also logs (never a silent null)", () => {
    const sql = new StrictMasReportsSql();
    sql.failInsertsWith = new Error("simulated store failure: SQLITE_FULL");
    expect(storeReportAtGeneration(sql, input({ generationId: "gen-x" }))).toBeNull();
    const failed = structuredEvents().find((e) => e.operation === "storeReportAtGeneration.failed");
    expect(failed).toBeDefined();
    expect(failed?.level).toBe("error");
    expect(String(failed?.fields.message ?? "")).toContain("storeReportAtGeneration");
    expect(String(failed?.fields.error ?? "")).toContain("SQLITE_FULL");
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

  it("healthy store: persist returns the id, row reads back, store dedupes, NO error logged (characterization)", () => {
    const sql = new StrictMasReportsSql();
    const id = persistScheduledReportSql(sql, input());
    expect(id).toBeTruthy();
    expect(getCanonicalReport(sql, id as string)?.title).toBe(input().title);

    const first = storeReportAtGeneration(sql, input({ generationId: "gen-h" }));
    expect(first?.created).toBe(true);
    const second = storeReportAtGeneration(sql, input({ generationId: "gen-h" }));
    expect(second?.created).toBe(false);
    expect(second?.reportId).toBe(first?.reportId);

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

  it("persist seams log and contain no bare catch", () => {
    const persistSrc = slice(
      "export function persistScheduledReportSql",
      "export interface ScheduledReportHit"
    );
    // #3515 S3: the seam now logs via the structured logger — the
    // structuredLog.error call with the same message content, not a
    // console.error line. The pin keeps the same strength: the seam
    // must log the failure (named operation + message) and must not
    // swallow it in a bare catch.
    expect(persistSrc).toContain('structuredLog.error("persistScheduledReportSql.failed"');
    expect(persistSrc).toContain("[scheduledReports] persistScheduledReportSql failed");
    expect(persistSrc).not.toMatch(/catch\s*\{/);

    const storeSrc = slice(
      "export function storeReportAtGeneration",
      "/** Read back the canonical stored copy"
    );
    expect(storeSrc).toContain('structuredLog.error("storeReportAtGeneration.failed"');
    expect(storeSrc).toContain("[scheduledReports] storeReportAtGeneration failed");
    expect(storeSrc).not.toMatch(/catch\s*\{/);
  });

  it("the generation UNIQUE INDEX creation sits inside a guarded try with logging", () => {
    // ADAPTED for #2359 (#1976 step 4d, §7 — in-file
    // justification): the ensure DDL moved behind the
    // canonical-report write port; the seam's
    // ensureScheduledReportsTable is now a delegate. The pin's
    // invariant is unchanged — the UNIQUE INDEX creation sits
    // inside a guarded try with the same log line — asserted
    // at its new home, the write port's DO adapter.
    const adapterSrc = readFileSync(
      fileURLToPath(
        new URL("../src/data/doSqliteCanonicalReportStoreAdapter.ts", import.meta.url)
      ),
      "utf-8"
    );
    const start = adapterSrc.indexOf("ensureSchema(): void");
    expect(start).toBeGreaterThan(-1);
    const ensureSrc = adapterSrc.slice(start, adapterSrc.indexOf("findIdByGeneration", start));
    const idxPos = ensureSrc.indexOf("CREATE UNIQUE INDEX");
    expect(idxPos).toBeGreaterThan(-1);
    expect(ensureSrc.lastIndexOf("try {", idxPos)).toBeGreaterThan(-1);
    expect(ensureSrc.indexOf("catch (err)", idxPos)).toBeGreaterThan(idxPos);
    expect(ensureSrc).toContain("console.error");
    expect(ensureSrc).toContain("idx_mas_reports_generation");
    // The seam keeps its public ensure door as the delegate.
    expect(src).toContain("storePorts(sql).write.ensureSchema()");
  });
});
