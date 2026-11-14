// @vitest-environment node
/**
 * Issue #2390 (#1976 step 4g, gate G-7 ruled 2026-10-29) —
 * CONFORMANCE for the settings family: the dedicated
 * SettingsPort contract over BOTH adapters (DO-SQLite over a
 * node:sqlite double, composed through createOrmPorts and
 * createSettingsPorts; and the in-memory twin), plus the
 * ownership pins that close the G-7 gate:
 *
 *  - The DO adapter is the ONLY mas_settings value writer and
 *    the ONLY DDL ensurer in src/ (the census G-7 detection,
 *    replicated locally; the global pin records the same sets
 *    at ship time).
 *  - Composition executes NOTHING: the table exists only after
 *    ensureSchema(), which creates exactly mas_settings.
 *  - The read port (step 3a) and the settings port over one
 *    handle see one store — one family, one table.
 *  - Family census at exact counts (the local form of the
 *    deltas the global census pin records at ship time).
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createOrmPorts } from "../src/data/createOrmPorts";
import {
  createSettingsPort,
  createInMemorySettingsPort,
} from "../src/data/createSettingsPorts";
import type { SettingsPort } from "../src/data/settingsReadPorts";

/** node:sqlite-backed SqlStorage double (step-4d harness shape). */
class SqliteTestStorage {
  private db = new DatabaseSync(":memory:");
  exec(query: string, ...args: unknown[]): unknown[] {
    const stmt = this.db.prepare(query);
    const verb = query.trimStart().slice(0, 6).toUpperCase();
    if (verb === "SELECT" || query.trimStart().toUpperCase().startsWith("PRAGMA")) {
      return stmt.all(...(args as any[])) as unknown[];
    }
    const info = stmt.run(...(args as any[]));
    return [{ rowsWritten: Number(info.changes) }];
  }
  tableNames(): string[] {
    const rows = this.exec(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ) as Array<{ name: string }>;
    return rows.map((r) => r.name);
  }
}

interface Harness {
  port: SettingsPort;
  storage?: SqliteTestStorage;
}

const ADAPTERS: Array<[string, () => Harness]> = [
  [
    "do-sqlite (via createOrmPorts)",
    () => {
      const storage = new SqliteTestStorage();
      return { port: createOrmPorts(storage as never).settings, storage };
    },
  ],
  [
    "do-sqlite (via createSettingsPort)",
    () => {
      const storage = new SqliteTestStorage();
      return { port: createSettingsPort(storage as never), storage };
    },
  ],
  ["in-memory", () => ({ port: createInMemorySettingsPort() })],
];

describe("settings port contract (both adapters)", () => {
  for (const [name, make] of ADAPTERS) {
    describe(name, () => {
      it("absent key: get null, has false", () => {
        const { port } = make();
        port.ensureSchema();
        expect(port.get("nope")).toBeNull();
        expect(port.has("nope")).toBe(false);
      });

      it("set/get/has round-trip; overwrite replaces; delete removes", () => {
        const { port } = make();
        port.ensureSchema();
        port.set("k", "v1");
        expect(port.get("k")).toBe("v1");
        expect(port.has("k")).toBe(true);
        port.set("k", "v2");
        expect(port.get("k")).toBe("v2");
        port.delete("k");
        expect(port.get("k")).toBeNull();
        expect(port.has("k")).toBe(false);
        // Deleting an absent key is a no-op, not an error.
        port.delete("k");
      });

      it("keys are independent", () => {
        const { port } = make();
        port.ensureSchema();
        port.set("a", "1");
        port.set("b", "2");
        port.delete("a");
        expect(port.get("b")).toBe("2");
      });

      it("ensureSchema is idempotent and preserves values", () => {
        const { port } = make();
        port.ensureSchema();
        port.set("k", "v");
        port.ensureSchema();
        port.ensureSchema();
        expect(port.get("k")).toBe("v");
      });
    });
  }

  it("do-sqlite: overwrite keeps exactly one row; explicit updatedAt is stored verbatim", () => {
    const storage = new SqliteTestStorage();
    const port = createSettingsPort(storage as never);
    port.ensureSchema();
    port.set("k", "v1", "2026-01-01T00:00:00.000Z");
    port.set("k", "v2", "2026-02-02T00:00:00.000Z");
    const rows = storage.exec(
      "SELECT value, updated_at FROM mas_settings WHERE key = ?",
      "k"
    ) as Array<{ value: string; updated_at: string }>;
    expect(rows).toEqual([{ value: "v2", updated_at: "2026-02-02T00:00:00.000Z" }]);
  });

  it("do-sqlite: composition executes nothing; ensureSchema creates exactly mas_settings", () => {
    const storage = new SqliteTestStorage();
    const ports = createOrmPorts(storage as never);
    expect(storage.tableNames()).toEqual([]);
    ports.settings.ensureSchema();
    expect(storage.tableNames()).toEqual(["mas_settings"]);
  });

  it("read port and settings port over one handle see one store", () => {
    const storage = new SqliteTestStorage();
    const ports = createOrmPorts(storage as never);
    ports.settings.ensureSchema();
    ports.settings.set("theme", "dark");
    expect(ports.settingsRead.get("theme")).toBe("dark");
    expect(ports.settingsRead.has("theme")).toBe(true);
    ports.settings.delete("theme");
    expect(ports.settingsRead.get("theme")).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Ownership pins (the G-7 close)                                      */
/* ------------------------------------------------------------------ */

const SRC_FILES: string[] = [];
function walk(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.name.endsWith(".ts")) SRC_FILES.push(path);
  }
}
walk("src");
const TEXT = new Map(SRC_FILES.map((f) => [f, readFileSync(f, "utf8")]));

/** Strip // and block comments while respecting string literals
 *  (the global census pin's helper, replicated). */
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
const SETTINGS_ADAPTER = "src/data/doSqliteOrmAdapters.ts";

describe("G-7 ownership: one writer, one ensurer", () => {
  it("mas_settings value writers in src/ are exactly the settings adapter", () => {
    const re = /(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+mas_settings(?![\w])/gi;
    const actual = SRC_FILES.filter((f) => re.test(STRIPPED.get(f)!)).sort();
    expect(actual).toEqual([SETTINGS_ADAPTER]);
  });

  it("mas_settings DDL ensurers in src/ are exactly the settings adapter", () => {
    // #4282 P2b: the mas_settings CREATE moved from the adapter
    // into the DO catalogue (src/data/schemaComponent/
    // doCatalogue.ts), so the catalogue is now the SOLE file
    // holding the statement text — the adapter still executes
    // it, through MAS_SETTINGS_DDL. The DDL has exactly one
    // home, as the pin requires; only the file changed.
    const re = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+mas_settings(?![\w])/gi;
    const actual = SRC_FILES.filter((f) => re.test(STRIPPED.get(f)!)).sort();
    expect(actual).toEqual([
      "src/data/schemaComponent/doCatalogue.ts",
    ]);
  });
});

describe("step-4g family census (surface-1 pattern, exact counts)", () => {
  const STORAGE_EXEC_PATTERN =
    /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/g;
  const countIn = (file: string): number =>
    (TEXT.get(file)!.match(STORAGE_EXEC_PATTERN) ?? []).length;

  const EXPECTED: Array<[string, number]> = [
    // The four writers, post-rewire:
    ["src/agents/orchestrator/reportDispatch.ts", 0],
    ["src/services/screeningFlags.ts", 0],
    ["src/data/governedHalt.ts", 0],
    // The ensurer retirement in orchestrator.ts (4 -> 3: the
    // ADR-out legacy ai-chat lift remains):
    // #1776 (#1717 Adapter S2) pin update: the legacy ai-chat
    // lift's SQL moved to SqlLegacyChatStore — 3 -> 0.
    ["src/agents/orchestrator.ts", 0],
    // In-layer homes after the move:
    ["src/data/doSqliteOrmAdapters.ts", 17],
    ["src/data/doSqliteStrategyWeightsAdapter.ts", 11],
    ["src/data/doSqliteEnrichmentAdapter.ts", 5],
    ["src/data/inMemoryOrmAdapters.ts", 0],
    ["src/data/settingsReadPorts.ts", 0],
    ["src/data/createSettingsPorts.ts", 0],
  ];
  for (const [file, sites] of EXPECTED) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countIn(file)).toBe(sites);
    });
  }
});
