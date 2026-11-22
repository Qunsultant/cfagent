// @vitest-environment node
/**
 * #2359 (#1976 step 4d) — family census for the orchestrator
 * tables + bypass closure.
 *
 * Mirrors the global D-D census pin's own patterns (surface-1
 * execution sites; writer-set scan with the same comment
 * stripping and constant resolution) over this slice's family:
 *
 *   - every consumer file reaches ZERO surface-1 sites; the
 *     two named remainders are orchestrator.ts (4: the ADR-out
 *     legacy ai-chat lift + the G-7 mas_settings DDL, both
 *     explicitly out of this slice) and reportDispatch.ts (3:
 *     the G-7 mas_settings read/write pair, untouched);
 *   - the new data-layer files carry exactly the moved
 *     statements;
 *   - the writer sets for the closed tables name exactly the
 *     new adapters (plus, for mas_messages / mas_transactions
 *     / mas_ads, the remaining out-of-slice bypasses the
 *     parent's global pin still carries: masRetentionIndexes
 *     for #2362, the payments route for #2360).
 *
 * The parent updates the global pin at ship time from these
 * same numbers.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const STORAGE_EXEC_PATTERN =
  /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/g;
const AS_ANY_EXEC_PATTERN = /\(\s*[\w.[\]]+\s+as\s+any\s*\)\s*\.\s*exec\s*\(/g;

function read(rel: string): string {
  return readFileSync(rel, "utf8");
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

/** Same comment stripping as the global pin (quoted exactly). */
function stripComments(text: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "single" | "double" | "template" =
    "code";
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1] ?? "";
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        state = "block";
        i += 2;
        continue;
      }
      if (c === "'") state = "single";
      else if (c === '"') state = "double";
      else if (c === "`") state = "template";
      out += c;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (c === "\n") {
        state = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (c === "*" && next === "/") {
        state = "code";
        i += 2;
        continue;
      }
      if (c === "\n") out += c;
      i += 1;
      continue;
    }
    if (c === "\\") {
      out += c + next;
      i += 2;
      continue;
    }
    if (
      (state === "single" && c === "'") ||
      (state === "double" && c === '"') ||
      (state === "template" && c === "`")
    ) {
      state = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full.replace(/\\/g, "/"));
  }
  return out;
}

const FAMILY_TABLES = [
  "mas_autopilot",
  "mas_policy_verdicts",
  "mas_report_confirmations",
  "mas_screener_presets",
  "mas_reports",
  "usage_events",
  "mas_messages",
  "mas_memory",
  "mas_transactions",
  "mas_ads",
] as const;

/** The pin's write-verb pattern and constant resolution,
 *  replicated exactly (string form — see the global pin). */
const WRITE_VERB =
  "(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM|CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?|CREATE\\s+(?:UNIQUE\\s+)?INDEX(?:\\s+IF\\s+NOT\\s+EXISTS)?[^;]*?ON)";

const STRIPPED = new Map<string, string>();
for (const f of [...listTsFiles("src"), ...listTsFiles("tests")]) {
  STRIPPED.set(f, stripComments(read(f)));
}

const GLOBAL_CONSTANTS = new Map<string, string>();
for (const text of STRIPPED.values()) {
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=;]+)?=\s*"([a-z_0-9]+)"/g)) {
    if ((FAMILY_TABLES as readonly string[]).includes(m[2]) && m[1].length > 5) {
      GLOBAL_CONSTANTS.set(m[1], m[2]);
    }
  }
}

function fileWritesTable(file: string, table: string): boolean {
  const text = STRIPPED.get(file)!;
  const constants = new Map(GLOBAL_CONSTANTS);
  for (const m of text.matchAll(/(?:const|let|var)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=;]+)?=\s*"([a-z_0-9]+)"/g)) {
    if ((FAMILY_TABLES as readonly string[]).includes(m[2])) constants.set(m[1], m[2]);
  }
  const names = [`${table}(?![\\w])`];
  for (const [name, t] of constants) {
    if (t === table) names.push(`\\$\\{${name}\\}`);
  }
  if (new RegExp(`${WRITE_VERB}\\s+(?:${names.join("|")})`, "gi").test(text)) return true;
  // #4282 P6c (#4386): the DO DML catalogue's repository entries
  // are method descriptors, not write-verb + table-name text —
  // the catalogue declares each table it writes with a
  // `table: "<name>"` entry field. That declaration counts as
  // writing the table, scoped to the catalogue file so no other
  // table's pin moves. (Template entries already match through
  // the write-verb path; the carve-out makes the set uniform.)
  // Mirrors the global census's P6b carve-out.
  if (file === "src/data/schemaComponent/doDmlEntries.ts") {
    return new RegExp(`table:\\s*"${table}"`, "i").test(text);
  }
  return false;
}

function writerSet(table: string): string[] {
  // Like the global pin, writer sets scan src/** only (tests
  // legitimately hold statement strings in their doubles).
  const writers: string[] = [];
  for (const f of STRIPPED.keys()) {
    if (f.startsWith("src/") && fileWritesTable(f, table)) writers.push(f);
  }
  return writers.sort();
}

describe("4d family census: surface-1 execution sites", () => {
  it("every consumer file reaches zero; the two named remainders hold exactly", () => {
    const zero = [
      "src/services/scheduledReports.ts",
      "src/services/reportSemanticIndex.ts",
      "src/services/screenerPresetResolution.ts",
      "src/agents/orchestrator/autopilot.ts",
      "src/agents/orchestrator/chatTurnHelpers.ts",
      "src/agents/routes/autopilot.ts",
      "src/agents/routes/screenerPresets.ts",
      "src/agents/routes/reports.ts",
    ];
    for (const f of zero) {
      expect(count(read(f), STORAGE_EXEC_PATTERN), f).toBe(0);
    }
    // orchestrator.ts remainder: the ADR-out legacy ai-chat
    // lift (2 SELECTs + DROP) and the G-7 mas_settings CREATE.
    // #2390 (step 4g) pin update: the mas_settings CREATE
    // retired to the dedicated settings port's adapter — 4 -> 3.
    // #1776 (#1717 Adapter S2) pin update: the legacy ai-chat
    // lift's SQL moved to SqlLegacyChatStore — 3 -> 0.
    expect(count(read("src/agents/orchestrator.ts"), STORAGE_EXEC_PATTERN)).toBe(0);
    // reportDispatch.ts remainder at 4d: the G-7 mas_settings
    // pair (one read + delete/insert), untouched by 4d.
    // #2390 (step 4g) pin update: the pair delegates to the
    // settings port — 3 -> 0.
    expect(count(read("src/agents/orchestrator/reportDispatch.ts"), STORAGE_EXEC_PATTERN)).toBe(0);
  });

  it("the data layer carries exactly the moved statements; ports and in-memory adapters carry none", () => {
    const layer = new Map<string, number>([
      ["src/data/doSqliteAutopilotStateAdapter.ts", 1],
      // 6 since #5100 (F3 of #5094): the ensureColumn helper's PRAGMA
      // probe + conditional ALTER for the five binding columns (the
      // confirmations adapter at 9 already carries its helper this way).
      ["src/data/doSqlitePolicyVerdictAdapter.ts", 6],
      ["src/data/doSqliteReportConfirmationAdapter.ts", 9],
      ["src/data/doSqliteScreenerPresetAdapter.ts", 6],
      // 21 at step 4d; 22 since #2528 slice 1: updateBody (see
      // global_dd_census_2356 pin note); 23 since #2863:
      // getRowByRunIdForOwner; 25 since #4507: the two dedupe
      // SELECTs (pair scan + per-pair row list).
      ["src/data/doSqliteCanonicalReportStoreAdapter.ts", 25],
      // 5 since #5235: listAllWithDetail SELECT (revenue-summary
      // coverage cut). 9 since #3185: the ensure probe (PRAGMA) +
      // conditional tenant_id ALTER + tenant index exec + the
      // listByTenant SELECT. 13 since #3185 bridge: pruneBefore's
      // COUNT + DELETE, the deleteByUser DELETE, and the
      // countByUser COUNT (retention/DSAR legs).
      ["src/data/doSqliteUsageEventAdapter.ts", 13],
    ]);
    for (const [f, n] of layer) {
      expect(count(read(f), STORAGE_EXEC_PATTERN), f).toBe(n);
    }
    for (const f of [
      "src/data/orchestratorTablePorts.ts",
      "src/data/canonicalReportStorePorts.ts",
      "src/data/inMemoryOrchestratorTableAdapters.ts",
      "src/data/inMemoryCanonicalReportStoreAdapters.ts",
      "src/data/createOrchestratorTablePorts.ts",
      "src/data/createCanonicalReportStorePorts.ts",
    ]) {
      expect(count(read(f), STORAGE_EXEC_PATTERN), f).toBe(0);
      expect(count(read(f), AS_ANY_EXEC_PATTERN), f).toBe(0);
    }
  });
});

describe("4d family census: writer sets", () => {
  it("the four orchestrator tables are written only by their new DO adapters", () => {
    // #4282 P2b: each adapter's CREATE TABLE / CREATE INDEX
    // statements moved into the DO catalogue
    // (src/data/schemaComponent/doCatalogue.ts) — the catalogue
    // is a DDL-only writer, never a row writer; each adapter
    // still executes the statements through doTableSql /
    // doIndexSql. The writer set is the adapter + the
    // statement's home.
    expect(writerSet("mas_autopilot")).toEqual([
      "src/data/schemaComponent/doCatalogue.ts",
      "src/data/schemaComponent/doDmlEntries.ts",
    ]);
    expect(writerSet("mas_policy_verdicts")).toEqual([
      "src/data/doSqlitePolicyVerdictAdapter.ts",
      "src/data/schemaComponent/doCatalogue.ts",
    ]);
    expect(writerSet("mas_report_confirmations")).toEqual([
      "src/data/doSqliteReportConfirmationAdapter.ts",
      "src/data/schemaComponent/doCatalogue.ts",
    ]);
    expect(writerSet("mas_screener_presets")).toEqual([
      "src/data/doSqliteScreenerPresetAdapter.ts",
      "src/data/schemaComponent/doCatalogue.ts",
    ]);
  });

  it("the canonical-report write side and usage_events name exactly the new adapters", () => {
    // #4282 P2b: mas_reports is unchanged — its four catalogue
    // entries are parameterized on ${TABLE}, so no literal table
    // name follows a write verb and the detector does not count
    // the catalogue as its writer. usage_events gains the
    // catalogue as its DDL-only writer (see above).
    expect(writerSet("mas_reports")).toEqual([
      "src/data/doSqliteCanonicalReportStoreAdapter.ts",
    ]);
    expect(writerSet("usage_events")).toEqual([
      "src/data/doSqliteUsageEventAdapter.ts",
      "src/data/schemaComponent/doCatalogue.ts",
    ]);
  });

  it("the closed bypasses leave only the data layer (and the named out-of-slice remainders)", () => {
    // #4282 P2a retarget (disclosed pin update): the schema
    // authority for these tables moved from ormSchema.ts /
    // masRetentionIndexSchema.ts into the ORM catalogue
    // (src/data/schemaComponent/ormCatalogue.ts) — the writer
    // set is unchanged in kind (port + schema authority), only
    // the file moved; the authority consolidates from two files
    // into one for mas_messages.
    // mas_messages: orchestrator.ts bypass CLOSED; the
    // masRetentionIndexes bypass was retired by #2362
    // (step 4f) — the index helper now lives in the data
    // layer.
    // #4386 (P6c): the DML moved from the adapters into the DO
    // DML catalogue as repository entries — the writer set is
    // unchanged in kind (DML home + schema authority), only the
    // file moved.
    expect(writerSet("mas_messages")).toEqual([
      "src/data/schemaComponent/doDmlEntries.ts",
      "src/data/schemaComponent/ormCatalogue.ts",
    ]);
    // mas_memory: unchanged — the layer was already its only
    // writer; this slice closed its READ bypasses instead.
    // #4386 (P6c): the DML moved into the DO DML catalogue
    // (see mas_messages above).
    expect(writerSet("mas_memory")).toEqual([
      "src/data/schemaComponent/doDmlEntries.ts",
      "src/data/schemaComponent/ormCatalogue.ts",
    ]);
    // mas_transactions: orchestrator.ts seed-purge bypass
    // CLOSED by 4d; the payments route bypass was closed by
    // #2360 (step 4d-2) — the writer set is layer-only.
    // #4386 (P6c): the DML moved into the DO DML catalogue
    // (see mas_messages above).
    expect(writerSet("mas_transactions")).toEqual([
      "src/data/schemaComponent/doDmlEntries.ts",
      "src/data/schemaComponent/ormCatalogue.ts",
    ]);
    // mas_ads: orchestrator.ts seed bypass CLOSED.
    expect(writerSet("mas_ads")).toEqual([
      "src/data/doSqliteMarketplaceAdapter.ts",
      "src/data/schemaComponent/ormCatalogue.ts",
    ]);
  });
});
