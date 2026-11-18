/**
 * Pinning test for #5035 — D1 catalogue Drizzle coverage & export map (D-3, D-11).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import * as drizzleSchema from "../src/data/drizzleSchema";
import { D1_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/d1Catalogue";

describe("#5035 D1 Drizzle coverage and table map", () => {
  it("D-3: every CREATE TABLE in D1_CATALOGUE_ENTRIES has a Drizzle sqliteTable definition", () => {
    const drizzleByTable = new Map<string, string>();
    for (const [exportName, val] of Object.entries(drizzleSchema)) {
      if (val && typeof val === "object") {
        try {
          const tableName = getTableName(val as never);
          if (tableName) drizzleByTable.set(tableName, exportName);
        } catch {
          // non-table export
        }
      }
    }

    const d1Tables = new Set<string>();
    for (const entry of D1_CATALOGUE_ENTRIES) {
      const m = entry.statement.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-zA-Z0-9_]+)/i);
      if (m?.[1]) d1Tables.add(m[1]);
    }

    const missing = [...d1Tables].filter((t) => !drizzleByTable.has(t)).sort();
    expect(missing).toEqual([]);
    expect(d1Tables.size).toBeGreaterThanOrEqual(101);
  });

  it("D-11: resolves Drizzle exports cleanly from drizzleSchema.ts", () => {
    const src = readFileSync(resolve(process.cwd(), "src/data/drizzleSchema.ts"), "utf8");
    const defs = [...src.matchAll(/export const (\w+)\s*=\s*sqliteTable\(\s*"([^"]+)"/g)];
    expect(defs.length).toBeGreaterThanOrEqual(100);
  });
});
