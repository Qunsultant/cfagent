/**
 * Pinning test for #5044 — Migration mechanism consolidation:
 *  - D-15: DO managed-migration adapter coverage (6 opt-in adapters vs ensureSchema)
 *  - D-13: D1 ALL_MIGRATIONS completeness + D1_CATALOGUE_ENTRIES table parity
 */
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as migrationRunner from "../src/data/migrationRunner";
import { D1_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/d1Catalogue";

const DO_MANAGED_MIGRATION_ADAPTERS = [
  "doSqliteAnalyzedDatasetAdapter.ts",
  "doSqliteDeliveryDatasetAdapter.ts",
  "doSqliteEnrichedDatasetAdapter.ts",
  "doSqliteGeneratedDatasetAdapter.ts",
  "doSqliteJobPipelineAdapter.ts",
  "doSqliteScreenRunLockAdapter.ts",
].sort();

describe("#5044 migration mechanism consolidation", () => {
  it("D-15: pins the exact set of DO adapters opted into applyDoSchemaMigrations", () => {
    const dataDir = resolve(process.cwd(), "src/data");
    const managed = readdirSync(dataDir)
      .filter((f) => f.startsWith("doSqlite") && f.endsWith("Adapter.ts"))
      .filter((f) =>
        readFileSync(resolve(dataDir, f), "utf8").includes("applyDoSchemaMigrations"),
      )
      .sort();
    expect(managed).toEqual(DO_MANAGED_MIGRATION_ADAPTERS);
  });

  it("D-13: every exported MIGRATION_00* is registered in ALL_MIGRATIONS", () => {
    const exportedMigrations = Object.entries(migrationRunner)
      .filter(([name]) => /^MIGRATION_\d+/.test(name))
      .map(([, val]) => (val as { version: number }).version)
      .sort((a, b) => a - b);
    const allVersions = migrationRunner.ALL_MIGRATIONS.map((m) => m.version).sort(
      (a, b) => a - b,
    );
    expect(allVersions).toEqual(exportedMigrations);
  });

  it("D-13: every CREATE TABLE in ALL_MIGRATIONS is catalogued in D1_CATALOGUE_ENTRIES", () => {
    const catalogueSql = D1_CATALOGUE_ENTRIES.map((e) => e.statement).join("\n");
    const migrationTables = new Set<string>();
    for (const m of migrationRunner.ALL_MIGRATIONS) {
      const raw = typeof m.statements === "function" ? m.statements() : m.statements;
      const stmts = Array.isArray(raw) ? raw : [raw];
      for (const stmt of stmts) {
        if (typeof stmt !== "string") continue;
        const match = stmt.match(/CREATE TABLE(?:\s+IF NOT EXISTS)?\s+([a-zA-Z0-9_]+)/i);
        if (match?.[1]) migrationTables.add(match[1]);
      }
    }
    const missing: string[] = [];
    for (const table of migrationTables) {
      const re = new RegExp(`CREATE TABLE(?:\\s+IF NOT EXISTS)?\\s+${table}\\b`, "i");
      if (!re.test(catalogueSql)) missing.push(table);
    }
    expect(missing).toEqual([]);
  });
});
