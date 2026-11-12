/**
 * Issue #2337 (#1976 step 2, ADR 0022 D-D) — the no-naked-SQL
 * census pin, family entries for the options/discovery stores.
 *
 * ADR D-D: no SQL above the data layer. The step-2 audit found
 * the census pin the ADR mandates was never landed; this file
 * carries the family's entries in shrink-only form: each of
 * the nine legacy family modules must hold ZERO statement
 * executions on storage-shaped receivers, forever — a future
 * change that re-introduces a direct exec in one of these
 * modules fails here, and the only way to make it pass is to
 * move the statement behind the port (the count can only
 * shrink, and it is already zero).
 *
 * The scan counts receivers, not one literal spelling: the
 * family's statements historically appeared as `sql.exec(`,
 * `this.sql.exec(`, `storage.sql.exec(` and (the step-1
 * adapters' shape) a bare executor variable — the receiver
 * pattern below covers the storage-shaped forms, and a second
 * assertion pins the broader `.exec(` count at zero for these
 * nine files as they stand today.
 *
 * The companion assertion keeps the pin honest: the family's
 * statements live in the data layer's adapters (69 sites at
 * the step-2 base, per the audit §1 census) — the pin cannot
 * be satisfied by deleting SQL.
 *
 * #2358 (#1976 step 4a) count update: 69 -> 70 — the paused-
 * schedule adapter gained ONE statement (clearSync's DELETE)
 * when step 4a added clear() to the PausedScheduleStore port
 * to close the maintenance route's raw-delete bypass of this
 * family's table. The statement moved INTO the layer from
 * routes/maintenance.ts; nothing was deleted.
 *
 * #2390 (#1976 step 4g) count update: 70 -> 67 — the
 * enrichment adapter's three mas_settings statements (the
 * killswitch SELECT + DELETE/INSERT pair) moved OUT of this
 * family to the dedicated settings port's adapter under the
 * G-7 ruling; the statements live on in the layer, in the
 * settings adapter (doSqliteOrmAdapters.ts).
 *
 * #2524 count update: 67 -> 71 — the scan-run adapter gained
 * FOUR statements (updateXlsxKey + updateCsvKey, each mirroring
 * updatePdfKey's summary+result updates) when the options-report
 * recording fix added XLSX/CSV backfills to the ScanRunStore
 * port. The statements live IN the data layer, behind the port,
 * exactly where ADR D-D requires them; the pin rule (gitops §7)
 * updates the pin in the same PR rather than shrinking the fix.
 */
// #3326 count update: 71 -> 74. The IV-history adapter gained THREE
// statements when an observation began recording the broker whose chain
// measured it: the create-time probe now selects the column list (so a table
// created before provenance still reads its broker as etrade), plus one
// statement each for the broker-scoped series and symbol reads. The statements
// live IN the data layer, behind the port, exactly where ADR D-D requires them
// -- and the broker scoping is only possible with them, so the pin moves with
// the change (gitops section 7) rather than the feature being split around a
// census number.
// #3327 count update: 74 -> 75. The scan-run adapter gained ONE statement when a
// saved run began recording the broker whose chains produced it: the
// broker-scoped list reads the same bounded window with the stamp filter applied,
// which needs its own statement rather than filtering in the route (a route-side
// filter would return short pages and hide rows). The statement lives in the data
// layer, behind the port, where ADR D-D requires it.
// #3314 count update: 75 -> 80. The scan-run adapter gained FIVE statements when
// a saved run began recording the §4 linkage (schedule_id, async_job_id,
// workflow_id): three probe-and-ALTER statements (one per column, the issue #103
// pattern already used for user_login in this file) plus the backfill's
// read-modify-write pair (GET + UPDATE_LINKAGE, mirroring updatePdfKey exactly
// as the #2524 XLSX/CSV backfills did). The statements live IN the data layer,
// behind the port, exactly where ADR D-D requires them; the pin moves with the
// change (gitops section 7) rather than the feature being split around a census
// number.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** Statement executions on storage-shaped receivers. */
const STORAGE_EXEC_PATTERN =
  /(?:\bsql|\bstorage|this\.sql|ctx\.storage(?:\.sql)?|\.sql)\s*\.\s*exec\s*\(/g;

const FAMILY_FILES = [
  "src/trading/options/scanRunStore.ts",
  "src/trading/options/discoveryRunStore.ts",
  "src/trading/options/discoverySetupStore.ts",
  "src/trading/options/discoveryAlertStore.ts",
  "src/trading/options/ivHistoryStore.ts",
  "src/trading/options/strategyProfileStore.ts",
  "src/services/feedSnapshotStore.ts",
  "src/services/scheduleManagement.deprecated.ts",
  "src/enrichment/enrichmentStore.ts",
] as const;

const ADAPTER_FILES: Array<[string, number]> = [
  // [file, exec sites at the step-2 landing — the audit's 69]
  // 12 at step 2; 16 since #2524: updateXlsxKey + updateCsvKey
  // backfills mirror updatePdfKey (summary+result each).
  // 9 at the step-2 landing; 10 since #3233; 17 since #3327: the broker-scoped
  // list reads the bounded window with the run's provenance stamp applied.
  // 22 since #3314: three probe-and-ALTER statements (one per §4 linkage
  // column) plus the updateLedgerLinkage backfill's GET + UPDATE pair.
  ["src/data/doSqliteScanRunAdapter.ts", 22],
  ["src/data/doSqliteDiscoveryRunAdapter.ts", 8],
  ["src/data/doSqliteDiscoverySetupAdapter.ts", 9],
  ["src/data/doSqliteDiscoveryAlertAdapter.ts", 4],
  // 8 at step 2; 11 since #3326: the provenance column probe plus the
  // broker-scoped series and symbol reads.
  ["src/data/doSqliteIvHistoryAdapter.ts", 11],
  ["src/data/doSqliteStrategyProfileAdapter.ts", 7],
  ["src/data/doSqliteFeedSnapshotAdapter.ts", 7],
  ["src/data/doSqlitePausedScheduleAdapter.deprecated.ts", 7],
  // 8 at step 2; 5 since #2390 (step 4g): the killswitch
  // SELECT + DELETE/INSERT pair left this adapter for the
  // dedicated settings port (the G-7 ruling).
  ["src/data/doSqliteEnrichmentAdapter.ts", 5],
];

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

describe("#2337 D-D census — options/discovery family entries (shrink-only)", () => {
  it("the nine legacy family modules hold zero storage-shaped exec sites", () => {
    for (const file of FAMILY_FILES) {
      const text = readFileSync(file, "utf8");
      expect(
        countMatches(text, STORAGE_EXEC_PATTERN),
        `${file} must not execute SQL above the data layer (ADR D-D)`,
      ).toBe(0);
    }
  });

  it("the nine legacy family modules hold zero .exec( sites at all", () => {
    for (const file of FAMILY_FILES) {
      const text = readFileSync(file, "utf8");
      expect(
        countMatches(text, /\.exec\(/g),
        `${file} must not execute statements above the data layer (ADR D-D)`,
      ).toBe(0);
    }
  });

  it("the family's statements live in the data layer's adapters (80 sites)", () => {
    let total = 0;
    for (const [file, expected] of ADAPTER_FILES) {
      const text = readFileSync(file, "utf8");
      const count = countMatches(text, /\.exec\(/g);
      expect(count, `${file} holds the family's statements`).toBe(expected);
      total += count;
    }
    expect(total).toBe(80);
  });
});
