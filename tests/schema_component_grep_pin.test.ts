/**
 * #4282 P0 — DDL grep pin (seeded baseline form).
 *
 * The pin's rule: zero CREATE TABLE / CREATE INDEX / CREATE UNIQUE
 * INDEX / ALTER TABLE lines in src/ outside the schema component and
 * migrationRunner.ts — plus a fifth form, parameterized DDL: a line
 * carrying a DDL verb AND a `${...}` placeholder (#4282 P3), so
 * template-assembled DDL cannot slip past a verb-only pin. That is the
 * P3 gate, not the P0 gate — on the unmigrated tree the zero-tolerance
 * form FAILS (see the red run in
 * ~/workspace/w4282/evidence-p0/red-run-3-assertions.log: 208
 * violations), and a red test cannot ship because CI runs the full
 * suite. So this pin ships in the repo's census-pin form: it asserts
 * the violation set equals the seeded baseline exactly. Any new inline
 * DDL trips it, and P1–P3 drive the baseline to zero by updating it
 * in the migration PR — never silently, always reviewed in the diff.
 * The fifth form was proved against the unmodified base dd6df86a
 * before the zero refresh (evidence-p3/grep-baseline-base-dd6df86a.json:
 * parameterizedDdl 30 across 12 files, verb totals 37/7/1/40).
 * Parameterized DML (`INSERT ... ${table} ...`, no DDL verb) does NOT
 * match this pin; its entry form is defined by the P3 remainder
 * catalogue and its DML moves in P6d.
 *
 * Seeded from a CLEAN checkout of the base (d1a370ab) by:
 *   SCHEMA_DDL_BASELINE_WRITE=1 npx vitest run tests/schema_component_grep_pin.test.ts
 * Refresh only from a clean checkout, and review the refreshed
 * baseline in the PR diff — a refresh that shrinks the baseline
 * without a migration is a defect, not a cleanup.
 *
 * Scope decision (made in this phase, per the P0 body — not discovered
 * at P3): the pin scopes to src/ only. tests/ carries 200 CREATE TABLE
 * lines on the base (re-measured in this phase) that are fixtures and
 * testkits, not using code — they are EXEMPT by scope, not by
 * allow-list, and the count is recorded here so a future fixture-count
 * change is visible, not silent. The named route files
 * (src/agents/routes/maintenance.ts, orchestratorMigration.ts) are
 * inside src/ and therefore inside the pin's scope already.
 *
 * DROP TABLE / DROP INDEX lines are enumerated informationally: P3
 * decides whether DROP joins the zero-tolerance set; P0 records the
 * count so the decision is made from a number.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateDdlCounts,
  countByPattern,
  REPO_ROOT,
  scanDdlOccurrences,
  scanDropStatements,
  type DdlBaselineCounts,
  type DdlPatternName,
} from "./schema_component_scan";

/** Re-measured on the base d1a370ab (2026-11-13): test fixtures, exempt by scope. */
export const EXEMPT_TEST_FIXTURE_CREATE_TABLE_LINES = 200;

const BASELINE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "schema_component_ddl_baseline.json",
);

interface DdlBaseline {
  generatedFrom: string;
  generatedAt: string;
  totals: Record<DdlPatternName, number>;
  files: DdlBaselineCounts;
}

function totalsOf(files: DdlBaselineCounts): Record<DdlPatternName, number> {
  const totals: Record<DdlPatternName, number> = {
    createTable: 0,
    createIndex: 0,
    createUniqueIndex: 0,
    alterTable: 0,
    parameterizedDdl: 0,
  };
  for (const counts of Object.values(files)) {
    for (const key of Object.keys(totals) as DdlPatternName[]) {
      totals[key] += counts[key];
    }
  }
  return totals;
}

describe("DDL grep pin — zero DDL in using code (#4282 P0)", () => {
  it("matches the seeded baseline exactly; any drift is a new violation or an unrecorded migration", () => {
    const violations = scanDdlOccurrences(REPO_ROOT);
    const files = aggregateDdlCounts(violations);
    const totals = countByPattern(violations);
    const drops = scanDropStatements(REPO_ROOT);
    console.log(
      `grep-pin: violations ${violations.length} ` +
        `(createTable ${totals.createTable}, createIndex ${totals.createIndex}, ` +
        `createUniqueIndex ${totals.createUniqueIndex}, alterTable ${totals.alterTable}, ` +
        `parameterizedDdl ${totals.parameterizedDdl}); ` +
        `informational DROP lines ${drops.length}; ` +
        `exempt test-fixture CREATE TABLE lines ${EXEMPT_TEST_FIXTURE_CREATE_TABLE_LINES}`,
    );

    if (process.env.SCHEMA_DDL_BASELINE_WRITE === "1") {
      const baseline: DdlBaseline = {
        // Provenance is the tree the scan actually measured. Pass
        // SCHEMA_DDL_BASELINE_FROM=<full SHA> on the refresh command;
        // the fallback is the P0 seed only so an unflagged refresh
        // cannot silently claim a base it never measured.
        generatedFrom:
          process.env.SCHEMA_DDL_BASELINE_FROM ??
          "d1a370ab6365f6a595cd36eb1ed6162aef8ad7a3",
        generatedAt: new Date().toISOString().slice(0, 10),
        totals,
        files,
      };
      writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
      console.log(`grep-pin: baseline written to ${BASELINE_PATH}`);
      return;
    }

    const baseline = JSON.parse(
      readFileSync(BASELINE_PATH, "utf8"),
    ) as DdlBaseline;
    expect(totalsOf(baseline.files)).toEqual(baseline.totals);
    expect(files).toEqual(baseline.files);
  });
});
