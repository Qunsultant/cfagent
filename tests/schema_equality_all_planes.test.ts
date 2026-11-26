/**
 * #4282 P4 — schema-equality pin: all planes, one clean instance.
 *
 * What this suite pins (measured, never assumed):
 *  - the combined catalogue (D1 + DO + ORM + remainder, 452 entries)
 *    builds the frozen combined model exactly: 185 tables / 109 indexes.
 *  - the frozen combined model is the deterministic union of the four
 *    per-plane fixtures, with ZERO cross-plane disagreements (column
 *    type / pk / constraint / index). The union is recomputed from the
 *    four fixtures in this suite and compared deep-equal to the frozen
 *    file, so a stale or edited baseline fails here instead of being
 *    silently absorbed.
 *  - the recreate order is load-bearing: base CREATEs first, then
 *    ALTER reconciliation / DROPs, then indexes (the P3 rule, applied
 *    across planes). The P0 planner's catalogue order loses the
 *    generation unique index — that defect is characterized, not
 *    hidden (see the ordering test), and P5's production planner must
 *    adopt the phased order before the recreate ships.
 *
 * Baseline provenance (the PR #3734 lesson: a baseline that measures
 * the tree it will guard must be produced from that tree):
 *  - seeded in the CLEAN checkout ~/workspace/w4282/wt-4282-p4-clean
 *    at 190e362a (the P3 merge tip), by unioning the four per-plane
 *    fixtures checked in at that SHA — never in the candidate
 *    worktree. Deterministic: two seed runs produced the identical
 *    sha256 (see COMBINED_FIXTURE_SHA256). The per-plane fixtures
 *    themselves were each seeded from their phase's base.
 *  - RE-SEEDED at ship time in the CLEAN checkout
 *    ~/workspace/w4282/wt-4282-p4-clean-ship at bcbc45df: main's
 *    #2781 commercial-bundle commits added 3 D1 tables + 3 D1
 *    indexes (agent_product_bundles, agent_bundle_purchases,
 *    agent_bundle_entitlements) after the build seed, so the 190e362a
 *    baseline failed the pin on the ship tree — the pin doing its
 *    job. Same procedure (two seed runs, identical sha256
 *    15bb7e54…), same sorted format; the re-seed diff is pure
 *    addition (238 lines, 0 removed).
 *  - the clean instance is a fresh InMemorySchemaInstance per run:
 *    fresh D1 + fresh DO, constructed from the tip, not from the
 *    branch. There is no real SQLite in the test harness (node:sqlite
 *    is flag-gated on CI's Node 22) — the P0 harness models the
 *    schema, not the storage engine; the harness fidelity limits are
 *    listed in the P4 build report.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COMBINED_CATALOGUE_ENTRIES,
  COMBINED_FIXTURE_SHA256,
  combinedExpectedModel,
  computeCombinedUnion,
  executeCombinedInPlanOrder,
  executeCombinedPhased,
  perPlaneExpectedModel,
} from "./schema_equality_harness";
import {
  diffSchema,
  InMemorySchemaInstance,
  isEmptyDiff,
} from "../src/data/schemaComponent/equalityHarness";

const HERE = path.dirname(fileURLToPath(import.meta.url));

function fixtureSha256(name: string): string {
  // Hash the LF form: the fixture is committed with LF and checked out with
  // CRLF on Windows, so the pin must not depend on the checkout eol config.
  return createHash("sha256")
    .update(readFileSync(path.join(HERE, name), "utf8").replace(/\r\n/g, "\n"))
    .digest("hex");
}

describe("schema equality — all planes (#4282 P4)", () => {
  it("the frozen combined baseline is the clean-checkout seed (191 tables / 119 indexes)", () => {
    const model = combinedExpectedModel();
    // #6072 adds migration 0080 (agent_screener_task_entries table):
    // 183 → 184 tables. #6099 adds migration 0081 (job_run_records
    // unique identity index): 106 → 107 indexes.
    // #6141 adds migration 0082 (referral trial-extension ledger
    // table + 2 indexes): 184 → 185 tables, 107 → 109 indexes;
    // migration 0083 (job_stage_events + 1 index) then took
    // indexes 109 → 110. #5102 adds migration 0084
    // (job_run_records binding tuple: no new table, +1 index):
    // indexes 110 → 111.
    // #6151 S3 adds migration 0085 (saved nav presets: agent_nav_presets + agent_nav_preset_state + 2 indexes): 185 → 187 tables, 111 → 113 indexes.
    // Issue #6100 adds 4 mas_events envelope indexes: 113 → 117.
    // Issue #6006 adds columns only (no new table or index): unchanged.
    // #6151 S4 adds migration 0087 (nav admin config: 3 tables + 1 index): 187 → 190 tables, 117 → 118 indexes.
    // #5160 adds migration 0088 (IDP attributes profile: rebuild + lookup-index table + 1 unique index): 187 → 188 tables, 117 → 118 indexes.
    // Union: 191 tables, 119 indexes.
    expect(Object.keys(model.tables).length).toBe(191);
    expect(Object.keys(model.indexes).length).toBe(119);
    expect(fixtureSha256("schema_component_combined_expected_model.json")).toBe(
      COMBINED_FIXTURE_SHA256,
    );
  });

  it("per-plane fixtures hold their phase counts", () => {
    // #5865 adds migration 0074 (definition history) in the D1 and DO
    // residencies: d1 tables 101 → 102, do tables 69 → 70, no index change.
    // #3185 (stamp slice): do indexes 40 → 41 (idx_usage_events_tenant).
    // #3185 bridge adds migration 0077 (agent_usage_events mirror
    // table + 2 indexes): d1 tables 102 → 103, d1 indexes 60 → 62.
    // #6072 adds migration 0080 (agent_screener_task_entries
    // table): d1 tables 103 → 104. #6099 adds migration 0081
    // (job_run_records unique identity index): d1 indexes 62 → 63.
    // #6141 adds migration 0082 (referral trial-extension ledger
    // table + 2 indexes): d1 tables 104 → 105, d1 indexes 63 → 65;
    // migration 0083 (job_stage_events + 1 index) then took d1
    // indexes 65 → 66. #5102 adds migration 0084
    // (job_run_records binding tuple: 4 columns + 1 index):
    // d1 indexes 66 → 67.
    // #6151 S3 adds migration 0085 (saved nav presets: 2 tables + 2 indexes): d1 tables 106 → 108, d1 indexes 67 → 69.
    // Issue #6100's envelope columns and indexes land on the ORM
    // plane (see the orm row), so the d1 counts are unchanged by it.
    // #6151 S4 adds migration 0087 (nav admin config: 3 tables + 1 index): d1 tables 108 → 111, d1 indexes 69 → 70.
    // #5160 adds migration 0088 (IDP attributes profile: lookup-index table + 1 unique index): d1 tables 108 → 109, d1 indexes 69 → 70.
    // #6102 adds migration 0089 (mas_events D1 table + 6 indexes): d1 tables 112 → 113, d1 indexes 71 → 77.
    // #6503 adds migration 0092 (unified_schedules table + 3 indexes):
    // d1 tables 113 → 114, d1 indexes 77 → 80. (The table already
    // lived on the DO plane, so the union counts below do not move.)
    // Union: d1 [114, 80].
    const counts: Record<string, [number, number]> = {
      d1: [114, 80],
      do: [70, 41],
      orm: [13, 14],
      remainder: [19, 15],
    };
    for (const [plane, [tables, indexes]] of Object.entries(counts)) {
      const model = perPlaneExpectedModel(
        plane as "d1" | "do" | "orm" | "remainder",
      );
      expect(Object.keys(model.tables).length, plane).toBe(tables);
      expect(Object.keys(model.indexes).length, plane).toBe(indexes);
    }
  });

  it("cross-plane agreement: the union recomputed from the four fixtures equals the frozen baseline with zero disagreements", () => {
    const { union, disagreements, overlapTables, overlapIndexes } =
      computeCombinedUnion();
    expect(disagreements).toEqual([]);
    // 22 tables and 27 indexes appear in more than one plane; every
    // overlap agrees (the union absorbs column-set differences from
    // ALTER reconciliation — e.g. job_run_records gains broker_id /
    // data_provider_id / mode / mode_source from DO ALTERs).
    // #6102: mas_events now lives on both the d1 and orm planes, so
    // the table overlap grows by one: 20 → 21.
    // #6102: migration 0089's six mas_events indexes carry the same
    // names on the d1 plane as on the orm plane, so the index overlap
    // grows by six: 19 → 25.
    // #6503: unified_schedules + its kind/state indexes now overlap
    // d1 ∩ DO (the table + those indexes already lived on the DO
    // plane; migration 0092 adds them to d1) — overlaps 21 → 22
    // tables, 25 → 27 indexes. The created-ordering index is D1-only.
    expect(overlapTables).toBe(22);
    expect(overlapIndexes).toBe(27);
    expect(union).toEqual(combinedExpectedModel());
  });

  it("equality pin: the combined catalogue builds the frozen model exactly", async () => {
    const instance = new InMemorySchemaInstance();
    const { executedCodes, executedStatements } =
      await executeCombinedPhased(instance);
    // Every catalogue entry executes at least once in the phased run.
    expect(new Set(executedCodes).size).toBe(
      COMBINED_CATALOGUE_ENTRIES.length,
    );
    expect(COMBINED_CATALOGUE_ENTRIES.length).toBe(535);    // #6503 adds migration 0092 (unified_schedules table + 3 indexes + 6 seeds): 525 → 535 entries.
    // Issue #6167 adds 1 entry (the host_version remainder ALTER
    // on mas_async_jobs): 452 → 453. Issue #5100 (F3 of #5094) adds 13:
    // 453 → 466 entries. Issue #5102 (F5 of #5094) adds 5 entries
    // (migration 0084: 4 job_run_records ALTERs + 1 index):
    // 475 → 480 entries.
    // #6151 S3 adds migration 0085 (saved nav presets: 2 tables + 2 indexes): 480 → 484 entries.
    // Issue #6100 adds 9 entries (5 mas_events envelope ALTERs + 4
    // indexes): 484 → 493 entries. Issue #6006 adds 9 entries
    // (migration 0086: job_run_records outcome facts, 9 ALTERs): 493 → 502 entries.
    // #6151 S4 adds migration 0087 (nav admin config: 3 tables + 1 index): 502 → 506 entries.
    // #5160 adds migration 0088 (IDP attributes profile: rebuild + index table): 506 → 512 entries.
    // #6102 adds migration 0089 (mas_events D1 table + 6 indexes): 512 → 519 entries.
    // Issue #5229 adds migration 0069 (agent_referral_rules
    // expiry_period_ms column): 410 entries resolve to 421 statements.
    // Issue #5086 adds migration 0070 (otel_config_overrides table):
    // 412 entries resolve to 423 statements.
    // The mas_reports generic ALTER expands to 11 pairs and the
    // confirmations generic ALTER to 2, each pair one statement.
    // Issue #5229 adds migration 0069 (agent_referral_rules
    // expiry_period_ms column): 410 entries resolve to 421 statements.
    // Issue #5086 adds migration 0070 (otel_config_overrides table):
    // 412 entries resolve to 423 statements.
    // Issue #5175 slice 2 adds 3 entries (mas_runs, mas_run_aliases
    // + its index): 414 entries resolve to 425 statements.
    // Issue #4767 adds 8 entries (migrations 0071/0072: 4 D1 ALTERs
    // + 4 remainder ALTERs): 423 entries resolve to 434 statements.
    // Issue #5865 adds 3 entries (migration 0074: the definition history
    // table in both residencies, plus the D1 backfill seed): 427 entries
    // resolve to 438 statements.
    // Issue #3185 (stamp slice) adds 2 entries (the usage_events
    // tenant index in DO + the tenant_id ALTER in remainder),
    // each one statement: 442 → 444 statements.
    // Issue #3185 bridge adds 3 entries (migration 0077: the
    // agent_usage_events mirror table + 2 indexes): 444 → 447.
    // Issue #5423 adds 1 entry (migration 0078:
    // agent_tenant_settings turn_step_timeout_ms column): 447 → 448.
    // Issue #5425 adds 2 entries (migration 0079:
    // agent_tenant_settings SLO threshold columns): 448 → 450.
    // Issue #6072 adds 1 entry (migration 0080:
    // agent_screener_task_entries table) and #6099 adds 3 entries
    // (migration 0081: job_run_records tenant_id + projected_at_ms
    // + unique identity index): 450 → 454.
    // Issue #6141 adds 9 entries (migration 0082: 6 rule columns +
    // ledger table + 2 indexes): 454 → 463.
    // Issue #6167 adds 1 entry (the host_version remainder ALTER
    // on mas_async_jobs), one statement: 463 → 464. Issue #5100 (F3 of
    // #5094) adds 13 entries (4 job_run_records + 4 mas_trades + 5
    // mas_policy_verdicts literal ALTERs): 464 → 477 statements.
    // Issue #5102 (F5 of #5094) adds 5 entries (migration 0084:
    // 4 job_run_records ALTERs + 1 index), each one statement:
    // 486 → 491 statements.
    // #6151 S3 adds migration 0085 (saved nav presets: 2 tables + 2 indexes), each one statement:
    // 491 → 495 statements.
    // Issue #6100 adds 9 entries (5 mas_events envelope ALTERs + 4
    // indexes), each one statement: 495 → 504 statements.
    // Issue #6006 adds 9 entries (migration 0086: job_run_records outcome
    // facts, 9 ALTERs), each one statement: 504 → 513 statements.
    // #6151 S4 adds migration 0087 (nav admin config: 3 tables + 1 index), each one statement:
    // 513 → 517 statements.
    // #5160 adds migration 0088 (IDP attributes profile: rebuild + index table), each one statement:
    // 517 → 523 statements.
    // #6102 adds migration 0089 (mas_events D1 table + 6 indexes), each one statement:
    // 523 → 530 statements.
    // Issue #6557 adds 6 entries, each one statement: 530 → 536 statements.
    // #6503 adds migration 0092 (unified_schedules table + 3 indexes + 6 seeds), each one statement:
    // 536 → 546 statements.
    expect(executedStatements).toBe(546);
    const actual = instance.introspect();
    const diff = diffSchema(actual, combinedExpectedModel());
    expect(isEmptyDiff(diff)).toBe(true);
    expect(diff.missingTables).toEqual([]);
    expect(diff.extraTables).toEqual([]);
    expect(diff.missingColumns).toEqual([]);
    expect(diff.extraColumns).toEqual([]);
    expect(diff.changedColumns).toEqual([]);
    expect(diff.missingIndexes).toEqual([]);
    expect(diff.extraIndexes).toEqual([]);
    expect(diff.changedIndexes).toEqual([]);
    expect(diff.missingConstraints).toEqual([]);
    expect(diff.extraConstraints).toEqual([]);
  });

  it("ordering pin: the generation unique index survives only when its DROP precedes its CREATE", async () => {
    const instance = new InMemorySchemaInstance();
    await executeCombinedPhased(instance);
    const model = instance.introspect();
    const index = model.indexes["idx_mas_reports_generation"];
    expect(index).toBeDefined();
    expect(index.table).toBe("mas_reports");
    expect(index.columns).toEqual(["user_login", "generation_id"]);
    expect(index.unique).toBe(true);
  });

  it("ordering characterization: the P0 planner's catalogue order LOSES the generation unique index (P5 must adopt the phased order)", async () => {
    const instance = new InMemorySchemaInstance();
    await executeCombinedInPlanOrder(instance);
    const diff = diffSchema(instance.introspect(), combinedExpectedModel());
    // The remainder DROP runs after the DO CREATE in catalogue order,
    // so the index the DO section just created is dropped and nothing
    // re-creates it. Exactly one index is missing.
    // Issue #6099 adds a second catalogue-order loss: the DO CREATE
    // TABLE job_run_records runs after the D1 ALTERs and replaces the
    // table (the harness models CREATE TABLE as a replace, ignoring
    // IF NOT EXISTS), wiping the D1-only projection columns
    // tenant_id + projected_at_ms. kind / origin_run_id /
    // definition_version survive because the remainder plane re-adds
    // them after the DO CREATE; the 0079 columns have no remainder
    // ALTER (the DO table has no tenant column by design). The
    // identity index survives the replace — indexes live in a
    // separate map, and only DROP TABLE clears them.
    expect(isEmptyDiff(diff)).toBe(false);
    expect(diff.missingIndexes).toEqual(["idx_mas_reports_generation"]);
    expect(diff.missingTables).toEqual([]);
    expect(diff.extraTables).toEqual([]);
    // Issue #6006 adds nine more D1-only ALTERs (the outcome-facts
    // migration 0086) that the DO CREATE also wipes: eleven columns in
    // catalogue order (the harness sorts them by column name).
    expect(diff.missingColumns).toEqual([
      { table: "job_run_records", column: "coded_error" },
      { table: "job_run_records", column: "csv_key" },
      { table: "job_run_records", column: "delivery_states_json" },
      { table: "job_run_records", column: "matched" },
      { table: "job_run_records", column: "origin" },
      { table: "job_run_records", column: "pdf_key" },
      { table: "job_run_records", column: "projected_at_ms" },
      { table: "job_run_records", column: "report_url" },
      { table: "job_run_records", column: "scanned" },
      { table: "job_run_records", column: "tenant_id" },
      { table: "job_run_records", column: "xlsx_key" },
    ]);
    expect(diff.extraColumns).toEqual([]);
    expect(diff.changedColumns).toEqual([]);
    expect(diff.extraIndexes).toEqual([]);
    expect(diff.changedIndexes).toEqual([]);
  });
});
