/**
 * #2345 (#1976 step 3a) — ORM dissolution census pin.
 *
 * Mirrors the step-2 census (tests/
 * options_discovery_step2_census_2337.test.ts): the ORM
 * family's storage statements may live ONLY in the data
 * layer's adapters/core/facade/schema modules now. The pin:
 *
 *  - src/orm/index.ts + src/orm/schema.ts are §22 re-export
 *    shims: zero storage-exec sites, and their text points at
 *    the data-layer successors;
 *  - the five rewired above-layer consumers (agents/mas.ts,
 *    mcp/commands.ts, agents/routes/memoryReset.ts,
 *    security/storageRetention.ts,
 *    agents/routes/adsRevenueReferrals.ts) hold ZERO
 *    storage-exec sites — every statement they used to run
 *    against the 13 tables (the mas_transactions status
 *    UPDATEs, the mas_memory upsert/DELETE, the mas_messages
 *    DELETE, the retention selectors, the raw marketplace
 *    statements) now goes through a port;
 *  - the data layer's own exec-site counts are pinned exactly,
 *    so the pin cannot be satisfied by deleting SQL: the
 *    statements moved, they did not vanish;
 *  - the facade's retired passthroughs (exec / execQuery /
 *    getSql) carry @deprecated markers naming their
 *    successors (Policy Gate §22 gate (j)).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Statement executions on storage-shaped receivers (step-2 pattern). */
const STORAGE_EXEC_PATTERN =
  /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/g;

const countExecSites = (rel: string): number =>
  (readFileSync(rel, "utf8").match(STORAGE_EXEC_PATTERN) ?? []).length;

const SHIM_FILES = ["src/orm/index.ts", "src/orm/schema.ts"] as const;

const CONSUMER_FILES = [
  "src/agents/mas.ts",
  "src/mcps/openaimp/commands.ts",
  "src/agents/routes/memoryReset.ts",
  "src/security/storageRetention.ts",
  "src/agents/routes/adsRevenueReferrals.ts",
] as const;

const DATA_LAYER_FILES: Array<[string, number]> = [
  // [file, storage-exec sites at the step-3a landing]
  ["src/data/ormRepositoryCore.ts", 7],
  // 9 at 3a; 13 since #2360 (step 4d-2) added the ledger
  // port's four route-transition statements to this adapter;
  // 17 since #2390 (step 4g) added the dedicated settings
  // port's write surface (ensure + DELETE/INSERT set + delete)
  // beside the read adapter in the same module.
  ["src/data/doSqliteOrmAdapters.ts", 17],
  ["src/data/doSqliteMarketplaceAdapter.ts", 2],
  // 15 since #3089 (S3) added the mas_trades broker column's
  // PRAGMA-guarded ALTER (PRAGMA table_info check + ALTER).
  // 17 since #3782 added the mas_trades price_source column's
  // PRAGMA-guarded ALTER (same precedent: check + ALTER).
  ["src/data/ormFacade.ts", 17],
  // 4 at 3a; 5 since #4412 added the mas_promotions index exec
  // (sql.exec(MAS_PROMOTIONS_INDEX_DDL) in ensurePromotionsIndex()).
  ["src/data/ormSchema.ts", 5],
  ["src/data/d1MarketplaceAdapter.ts", 0],
  ["src/data/inMemoryOrmAdapters.ts", 0],
  ["src/data/inMemoryMarketplaceAdapter.ts", 0],
];

describe("step-3a census: src/orm is a shim layer", () => {
  for (const file of SHIM_FILES) {
    it(`${file} holds zero storage-exec sites and re-exports the data layer`, () => {
      expect(countExecSites(file)).toBe(0);
      const text = readFileSync(file, "utf8");
      expect(text).toContain('from "../data/');
      expect(text).toMatch(/@deprecated/);
    });
  }
});

describe("step-3a census: above-layer consumers hold no statements", () => {
  for (const file of CONSUMER_FILES) {
    it(`${file} holds zero storage-exec sites`, () => {
      expect(countExecSites(file)).toBe(0);
    });
  }
});

describe("step-3a census: the statements live in the data layer", () => {
  for (const [file, sites] of DATA_LAYER_FILES) {
    it(`${file} holds exactly ${sites} storage-exec sites`, () => {
      expect(countExecSites(file)).toBe(sites);
    });
  }

  it("the facade's passthroughs are deprecated with named successors", () => {
    const lines = readFileSync("src/data/ormFacade.ts", "utf8").split("\n");
    for (const method of ["exec", "execQuery", "getSql"]) {
      const defIdx = lines.findIndex((l) =>
        new RegExp(`^\\s+(?:public\\s+)?${method}\\s*\\(`).test(l),
      );
      expect(defIdx, method).toBeGreaterThan(-1);
      const docblock = lines.slice(Math.max(0, defIdx - 22), defIdx).join("\n");
      expect(docblock, method).toContain("@deprecated");
      expect(docblock, method).toMatch(/Superseded by/);
    }
  });
});
