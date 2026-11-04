/**
 * Migration registry — the ONE test that owns "latest" (#3189, sub-issue
 * of #2323).
 *
 * Every D1 migration used to break unrelated tests that pin "latest is N"
 * (PR #3176 failed CI shards 1+4 on three such pins for migration 0038).
 * Those pins are undiscoverable from the diff, and their count grows with
 * every slice. The fix is ownership, not vigilance: this file alone may
 * assert on ALL_MIGRATIONS[last] or the max version, and every assertion
 * below is derived from the registry itself — a well-formed new migration
 * passes with zero updates. scripts/check-migration-pins.sh enforces the
 * ownership in CI (Fast gates) and in scripts/verify-before-merge.sh;
 * see gitops §7, pin rule 5.
 *
 * Per-feature migration tests assert only their own migration's
 * registration (position-independent containment) and their own
 * DDL/schema parity. They never assert on "latest".
 */
import { describe, expect, it } from "vitest";
import { getTableName, isTable } from "drizzle-orm";
import { ALL_MIGRATIONS } from "../src/data/migrationRunner";
import * as drizzleSchema from "../src/data/drizzleSchema";

function tableTargets(sql: string): string[] {
  const targets = new Set<string>();
  for (const re of [
    /CREATE TABLE IF NOT EXISTS (\w+)/g,
    /ALTER TABLE (\w+)/g,
  ]) {
    for (const m of sql.matchAll(re)) targets.add(m[1]);
  }
  return [...targets];
}

describe("migration registry (canonical latest owner, #3189)", () => {
  it("registry is non-empty; versions are positive integers, unique, and strictly increasing in registry order", () => {
    expect(ALL_MIGRATIONS.length).toBeGreaterThan(0);
    const versions = ALL_MIGRATIONS.map((m) => m.version);
    for (const v of versions) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThan(0);
    }
    expect(new Set(versions).size).toBe(versions.length);
    for (let i = 0; i < versions.length - 1; i++) {
      expect(versions[i]).toBeLessThan(versions[i + 1]);
    }
  });

  it("every migration name carries its zero-padded version", () => {
    for (const m of ALL_MIGRATIONS) {
      expect(m.name.startsWith(`${String(m.version).padStart(4, "0")}_`)).toBe(true);
    }
  });

  it("every migration has non-empty SQL", () => {
    for (const m of ALL_MIGRATIONS) {
      expect(m.sql.trim().length).toBeGreaterThan(0);
    }
  });

  it("the latest migration's tables exist in the drizzle schema", () => {
    // This last-index access is allowed ONLY here: this file is the
    // canonical owner, and the lint exempts it (see the header).
    const latest = ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1];
    const targets = tableTargets(latest.sql);
    // A latest migration that touches no table would make this test
    // vacuous; fail loudly instead of passing silently.
    expect(targets.length).toBeGreaterThan(0);
    const drizzleNames = new Set(
      Object.values(drizzleSchema)
        .filter(isTable)
        .map((t) => getTableName(t)),
    );
    for (const table of targets) {
      expect(drizzleNames.has(table)).toBe(true);
    }
  });
});
