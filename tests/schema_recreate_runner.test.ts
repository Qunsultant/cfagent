/**
 * #4282 P5 — production recreate runner contract.
 *
 * The runner is the production counterpart of the P4 test-side harness
 * (tests/schema_equality_harness.ts): it resolves the combined catalogue
 * to executable steps in the PHASED order, selects only the steps that
 * close a non-empty diff against the store's probed schema, and verifies
 * the run afterwards. The P4 harness stays the independent double — the
 * runner must NOT import it, and these tests cross-check the runner
 * against it (same steps, same pairs, same expected model) so a drift
 * between the production runner and the pin is caught here, not in CI.
 *
 * The four P4 findings are pinned here:
 *  (1) phased order — the DROP runs before the index creation it
 *      reconciles (the P0 planner's catalogue order loses the
 *      generation index);
 *  (2) the DROP is conditional on the index existing (probe), so the
 *      catalogue entry — and the P3 sha256 pin — is untouched;
 *  (3) delta-to-steps — a re-run on a healthy store selects zero
 *      steps, and a partial store selects exactly the closing steps;
 *  (4) seed-dependency ordering — the legacy seed runs before its
 *      source table's DROP; and the rebuild's rename runs only while
 *      the old-shaped table is still there (the rebuilt table reuses
 *      the same name, so a presence check alone would rename the
 *      rebuilt table — the selection compares shapes).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import {
  d1SchemaProbe,
  expectedModelForLeg,
  expectedModelForPlan,
  introspectSchema,
  legOfStep,
  planForLeg,
  resolveRecreatePlan,
  selectSteps,
  UNCREATABLE_LAYERS,
  verifyRecreate,
  type RecreatePlan,
  type SchemaProbe,
} from "../src/data/schemaComponent/recreateRunner";
import {
  combinedExpectedModel,
  resolveCombinedSteps,
  UNCREATABLE_LAYERS as HARNESS_UNCREATABLE_LAYERS,
} from "./schema_equality_harness";
import {
  diffSchema,
  emptySchemaModel,
  isEmptyDiff,
  type SchemaModel,
} from "../src/data/schemaComponent/equalityHarness";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const DROP_INDEX_CODE =
  "schema.index.mas_reports.drop_index_idx_mas_reports_generation";
const CREATE_GENERATION_INDEX_CODE =
  "schema.index.mas_reports.create_unique_index_idx_mas_reports_generation";
const RENAME_CODE =
  "schema.d1.agent_price_catalogue.alter_table_rename_to_agent_price_catalogue_legacy";
const LEGACY_SEED_CODE = "seed.d1.agent_price_catalogue.insert_from_legacy";
const LEGACY_DROP_CODE =
  "schema.d1.agent_price_catalogue_legacy.drop_table";
const SEED_FORM_CODE = "seed.route.orchestrator_migration.insert_or_replace";
const REPORT_ALTER_CODE = "schema.do.mas_reports.alter_table_add_column";
const CONFIRM_ALTER_CODE =
  "schema.do.mas_report_confirmations.alter_table_add_column";

/** The (column, type) pairs a generic ALTER reconciles, read from the frozen P3 base captures — the same ground truth the P3 suite uses. */
function fixturePairs(adapter: string): [string, string][] {
  const captures = (
    JSON.parse(
      readFileSync(
        path.join(HERE, "schema_component_p3_base_sql.json"),
        "utf8",
      ),
    ) as { captures: { adapter: string; queries: string[] }[] }
  ).captures;
  const capture = captures.find((c) => c.adapter === adapter)!;
  const seen = new Set<string>();
  const pairs: [string, string][] = [];
  for (const q of capture.queries) {
    if (!q.trim().startsWith("ALTER TABLE")) continue;
    const m = q.match(/ADD COLUMN\s+([a-z0-9_]+)\s+(.+)$/i);
    if (!m) continue;
    const key = `${m[1]}|${m[2].trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push([m[1], m[2].trim()]);
  }
  return pairs;
}

function plan(): RecreatePlan {
  return resolveRecreatePlan();
}

function codesOf(steps: { code: string }[]): string[] {
  return steps.map((s) => s.code);
}

/** Params with sorted keys, so the comparison ignores key order. */
function canonParams(params: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(params).sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}

describe("P5 runner — plan resolution (P4 finding 1: phased order)", () => {
  it("resolves 459 executable steps and skips the seed-form entry with its reason", () => {
    const p = plan();
    // #5229 adds migration 0069 (referral expiry_period_ms): 419 → 420.
    // #5175 slice 2 adds mas_runs + mas_run_aliases + its index: 421 → 424.
    // #5086 adds migration 0070 (otel_config_overrides table): 424 → 425.
    // #4767 adds migrations 0071/0072 (4 D1 + 4 remainder ALTERs): 425 → 433.
    // #4204 adds migration 0073 (D1 job_run_records recent-read index): 433 → 434.
    // #5865 adds migration 0074 (definition history table in D1 + DO, plus
    // the D1 backfill seed): 434 → 437.
    // Issue #3185 adds the usage_events tenant stamp (DO index +
    // remainder ALTER): 441 → 443.
    // Issue #3185 bridge adds migration 0077 (agent_usage_events
    // mirror table + 2 indexes): 443 → 446.
    // Issue #5423 adds migration 0078 (agent_tenant_settings
    // turn_step_timeout_ms column): 446 → 447.
    // Issue #5425 adds migration 0079 (agent_tenant_settings
    // SLO threshold columns): 447 → 449.
    // Issue #6072 adds migration 0080 (agent_screener_task_entries
    // table, 1 step) and #6099 adds migration 0081 (job_run_records
    // tenant_id + projected_at_ms + unique identity index, 3 steps):
    // 449 → 453.
    // Issue #6141 adds migration 0082 (referral trial-extension: 6
    // rule columns + ledger table + 2 indexes): 453 → 462.
    // Issue #6167 adds the host_version remainder ALTER on
    // mas_async_jobs (1 step): 462 → 463. Issue #5100 (F3 of #5094)
    // adds 13 literal ALTERs (4 job_run_records + 4 mas_trades + 5
    // mas_policy_verdicts): 463 → 476.
    // Issue #5102 (F5 of #5094) adds migration 0084 (job_run_records
    // binding columns: 4 ALTERs + 1 index): 485 → 490.
    // #6151 S3 adds migration 0085 (saved nav presets: 2 tables + 2 indexes): 490 → 494.
    // Issue #6100 adds 5 mas_events envelope ALTERs + 4 indexes:
    // 494 → 503. Issue #6006 adds migration 0086 (job_run_records
    // outcome facts, 9 ALTERs): 503 → 512.
    // #5160 adds migration 0087 (IDP attributes profile: rebuild + index table): 512 → 518.
    expect(p.steps).toHaveLength(518);
    expect(p.skipped).toHaveLength(1);
    expect(p.skipped[0].code).toBe(SEED_FORM_CODE);
    expect(p.skipped[0].reason).toMatch(/call site/i);
  });

  it("matches the P4 harness's phased steps, with the two production moves applied per rebuild", () => {
    const p = plan();
    const harness = resolveCombinedSteps().filter(
      (s) => s.code !== SEED_FORM_CODE,
    );
    // #5229 adds migration 0069: 419 → 420.
    // #5175 slice 2 adds mas_runs + mas_run_aliases + its index: 421 → 424.
    // #5086 adds migration 0070: 424 → 425.
    // #4767 adds migrations 0071/0072 (4 D1 + 4 remainder ALTERs): 425 → 433.
    // #4204 adds migration 0073 (D1 job_run_records recent-read index): 433 → 434.
    // #5865 adds migration 0074 (definition history table in D1 + DO, plus
    // the D1 backfill seed): 434 → 437.
    // Issue #3185 adds the usage_events tenant stamp (DO index +
    // remainder ALTER): 441 → 443.
    // Issue #3185 bridge adds migration 0077 (agent_usage_events
    // mirror table + 2 indexes): 443 → 446.
    // Issue #5423 adds migration 0078 (agent_tenant_settings
    // turn_step_timeout_ms column): 446 → 447.
    // Issue #5425 adds migration 0079 (agent_tenant_settings
    // SLO threshold columns): 447 → 449.
    // Issue #6072 adds migration 0080 (agent_screener_task_entries
    // table, 1 step) and #6099 adds migration 0081 (job_run_records
    // tenant_id + projected_at_ms + unique identity index, 3 steps):
    // 449 → 453.
    // Issue #6141 adds migration 0082 (referral trial-extension: 6
    // rule columns + ledger table + 2 indexes): 453 → 462.
    // Issue #6167 adds the host_version remainder ALTER on
    // mas_async_jobs (1 step): 462 → 463. Issue #5100 (F3 of #5094)
    // adds 13 literal ALTERs (4 job_run_records + 4 mas_trades + 5
    // mas_policy_verdicts): 463 → 476.
    // Issue #5102 (F5 of #5094) adds migration 0084 (job_run_records
    // binding columns: 4 ALTERs + 1 index): 485 → 490.
    // #6151 S3 adds migration 0085 (saved nav presets: 2 tables + 2 indexes): 490 → 494.
    // Issue #6100 adds 5 mas_events envelope ALTERs + 4 indexes:
    // 494 → 503. Issue #6006 adds migration 0086 (job_run_records
    // outcome facts, 9 ALTERs): 503 → 512.
    // #5160 adds migration 0087 (IDP attributes profile: rebuild + index table): 512 → 518.
    expect(harness).toHaveLength(518);    // Production move 1: the rebuild CREATE for agent_price_catalogue
    // must stay after the RENAME that clears its table (a second
    // table-creation for the same table cannot run before the rename
    // on real SQLite). Production move 2: the legacy seed is hoisted
    // to just before its source table's DROP.
    const expected = [...harness];
    const move = (code: string, beforeCode: string) => {
      const from = expected.findIndex((s) => s.code === code);
      const [step] = expected.splice(from, 1);
      const to = expected.findIndex((s) => s.code === beforeCode);
      expected.splice(to, 0, step);
    };
    // Move 1: the m0058 rebuild CREATE goes just after the RENAME.
    const rebuildCode =
      "schema.d1.agent_price_catalogue.create_table_m0058";
    const rebuildIdx = expected.findIndex((s) => s.code === rebuildCode);
    const [rebuild] = expected.splice(rebuildIdx, 1);
    const renameIdx = expected.findIndex((s) => s.code === RENAME_CODE);
    expected.splice(renameIdx + 1, 0, rebuild);
    // Move 2: the legacy seed goes just before the DROP.
    move(LEGACY_SEED_CODE, LEGACY_DROP_CODE);
    // #5160: the same two moves for the m0087 rebuild
    // (agent_user_profiles) — the moves are generic, not specific
    // to the v58 precedent.
    const rebuild87Code = "schema.d1.agent_user_profiles.create_table_m0087";
    const rebuild87Idx = expected.findIndex((s) => s.code === rebuild87Code);
    const [rebuild87] = expected.splice(rebuild87Idx, 1);
    const rename87Idx = expected.findIndex(
      (s) =>
        s.code ===
        "schema.d1.agent_user_profiles.alter_table_rename_to_agent_user_profiles_legacy",
    );
    expected.splice(rename87Idx + 1, 0, rebuild87);
    move(
      "seed.d1.agent_user_profiles.insert_from_legacy",
      "schema.d1.agent_user_profiles_legacy.drop_table",
    );
    expect(
      p.steps.map((s) => `${s.code}|${canonParams(s.params)}`),
    ).toEqual(
      expected.map((s) => `${s.code}|${canonParams(s.params)}`),
    );
  });

  it("is phased: all table creations precede all reconciliations, then indexes, then seeds", () => {
    const p = plan();
    const phaseOf = (s: (typeof p.steps)[number]) => s.phase;
    const maxOrder = (phase: number) =>
      Math.max(...p.steps.filter((s) => phaseOf(s) === phase).map((s) => s.order));
    const minOrder = (phase: number) =>
      Math.min(...p.steps.filter((s) => phaseOf(s) === phase).map((s) => s.order));
    expect(maxOrder(0)).toBeLessThan(minOrder(1));
    expect(maxOrder(1)).toBeLessThan(minOrder(2));
    expect(maxOrder(2)).toBeLessThan(minOrder(3));
  });

  it("runs the DROP before the index creation it reconciles (the P4 loss case)", () => {
    const p = plan();
    const orderOf = (code: string) =>
      p.steps.find((s) => s.code === code)!.order;
    expect(orderOf(DROP_INDEX_CODE)).toBeLessThan(
      orderOf(CREATE_GENERATION_INDEX_CODE),
    );
  });

  it("hoists the legacy seed to immediately before its source table's DROP (P4 finding 4)", () => {
    const p = plan();
    const orderOf = (code: string) =>
      p.steps.find((s) => s.code === code)!.order;
    expect(orderOf(LEGACY_SEED_CODE)).toBe(orderOf(LEGACY_DROP_CODE) - 1);
    expect(orderOf(RENAME_CODE)).toBeLessThan(orderOf(LEGACY_SEED_CODE));
  });

  it("keeps the rebuild table-creation after the RENAME that clears its table (real-SQLite order)", () => {
    const p = plan();
    const orderOf = (code: string) =>
      p.steps.find((s) => s.code === code)!.order;
    expect(
      orderOf("schema.d1.agent_price_catalogue.create_table_m0058"),
    ).toBe(orderOf(RENAME_CODE) + 1);
  });

  it("derives the generic ALTER pairs from the pinned table, matching the P3 fixture", () => {
    const p = plan();
    const pairsOf = (code: string) =>
      p.steps
        .filter((s) => s.code === code)
        .map((s) => [s.params.column, s.params.type] as [string, string]);
    expect(pairsOf(REPORT_ALTER_CODE)).toEqual(
      fixturePairs("CanonicalReportEnsure"),
    );
    expect(pairsOf(CONFIRM_ALTER_CODE)).toEqual(
      fixturePairs("ReportConfirmationEnsure"),
    );
    expect(pairsOf(REPORT_ALTER_CODE)).toHaveLength(11);
    expect(pairsOf(CONFIRM_ALTER_CODE)).toHaveLength(2);
  });

  it("assigns every step a leg, with the report steps on the DO leg and the migration steps on the D1 leg", () => {
    const p = plan();
    for (const step of p.steps) {
      expect(["d1", "do"]).toContain(legOfStep(step));
    }
    const legOf = (code: string) =>
      legOfStep(p.steps.find((s) => s.code === code)!);
    expect(legOf(REPORT_ALTER_CODE)).toBe("do");
    expect(legOf(CREATE_GENERATION_INDEX_CODE)).toBe("do");
    expect(legOf(DROP_INDEX_CODE)).toBe("do");
    expect(legOf(RENAME_CODE)).toBe("d1");
    expect(legOf(LEGACY_SEED_CODE)).toBe("d1");
    expect(legOf(LEGACY_DROP_CODE)).toBe("d1");
  });

  it("reproduces the frozen P4 expected model exactly", () => {
    // Structural equality via the P0 diff (the P4 pin's own
    // comparison): the fixture's column order follows the adapter's
    // ensure order, while the plan executes the catalogue's order,
    // so the two models differ in column ORDER only (mas_async_jobs
    // is the witness) — the diff is empty, which is the equality
    // that matters for the recreate.
    const diff = diffSchema(
      expectedModelForPlan(plan()),
      combinedExpectedModel(),
    );
    expect(isEmptyDiff(diff)).toBe(true);
  });
});

describe("P5 runner — delta-to-steps selection (P4 finding 3, P4 finding 2)", () => {
  // Selection is a per-leg operation: one store per leg, one projected
  // model per leg. A combined plan cannot be selected against a single
  // model — the dual-homed tables exist on two stores — so every
  // selection test below runs on the leg that owns the table it probes.
  it("selects every needed schema step and every seed on a fresh D1 store", () => {
    const legPlan = planForLeg(plan(), "d1");
    const selected = selectSteps(legPlan, emptySchemaModel(), []);
    // 244 schema steps in the leg (#5229 adds migration 0069: 242 → 243;
    // #5086 adds migration 0070: 243 → 244),
    // minus 6 column-adds whose columns
    // a selected creation already provides (the ORM's tenant_id,
    // mas_events' hashes, mas_trades' broker/price_source/mode) — those
    // would fail on real SQLite as duplicate columns, so the
    // projected-model walk skips them. All 11 seeds run: their
    // tables' creations are selected.
    // #5229 adds migration 0069: 236 → 237.
    // #5086 adds migration 0070: 237 → 238.
    // #4767 adds migrations 0071/0072 (4 D1 ALTERs): 238 → 242.
    // #5865 adds migration 0074 (definition history): 242 → 243.
    // #4204 adds migration 0073 (D1 job_run_records recent-read
    // index): the D1 step is selected and the ORM plane's duplicate
    // of the same index is skipped (the projected-model walk already
    // has it), so selected stays 242 and skipped grows 8 → 9.
    // #3185 bridge adds migration 0077 (agent_usage_events mirror
    // table + 2 indexes): 245 → 248.
    // Issue #5423 adds migration 0078 (agent_tenant_settings
    // turn_step_timeout_ms column): 248 → 249.
    // Issue #5425 adds migration 0079 (agent_tenant_settings
    // SLO threshold columns): 249 → 251.
    // Issue #6072 adds migration 0080 (agent_screener_task_entries
    // table, 1 step) and #6099 adds migration 0081 (job_run_records
    // tenant_id + projected_at_ms + unique identity index, 3 steps):
    // 251 → 255 schema statements.
    // Issue #6141 adds migration 0082 (referral trial-extension: 6
    // rule columns + ledger table + 2 indexes): 255 → 264.
    // Issue #6028 adds 2 stage-row steps on the D1 leg: 264 → 266.
    // Issue #6100 adds 4 mas_events envelope indexes on the D1 leg:
    // 266 → 270.
    // Issue #5100 (F3 of #5094) adds 4 mas_trades ORM ALTERs (the
    // binding columns): the projected-model walk already has them
    // (the ORM CREATE carries them), so they are skipped: 9 → 13.
    // Issue #5102 (F5 of #5094) adds migration 0084 (job_run_records
    // binding columns: 4 ALTERs + 1 index): 266 → 271.
    // #6151 S3 adds migration 0085 (saved nav presets: 2 tables + 2 indexes): 271 → 275.
    // Issue #6100 adds 5 mas_events envelope ALTERs: the
    // projected-model walk already has them (the ORM CREATE carries
    // them), so the leg skips five more (13 → 18); its 4 indexes are
    // selected: 275 → 279, plus #6006's 9 ALTERs: 279 → 288.
    // #5160 adds migration 0087 (IDP attributes profile: rebuild + index table): schema 288 → 293, seeds 12 → 13.
    expect(selected.schema).toHaveLength(293);
    expect(selected.seeds).toHaveLength(13);
    expect(selected.skipped).toHaveLength(18);
    expect(
      codesOf(selected.skipped),
    ).toContain("schema.orm.mas_transactions.alter_table_add_column_tenant_id");
    expect(
      codesOf(selected.skipped),
    ).toContain("schema.orm.mas_trades.alter_table_add_column_mode");
  });

  it("selects every needed schema step on a fresh DO store", () => {
    const legPlan = planForLeg(plan(), "do");
    const selected = selectSteps(legPlan, emptySchemaModel(), []);
    // 166 schema steps in the leg (163 + 3 from #5175 slice 2: mas_runs,
    // mas_run_aliases, and its index), minus 2 superseded v1 creations
    // (the full creation precedes them in the plan), 33 column-adds
    // whose columns a selected creation already provides, and the
    // conditional index drop (its index does not exist yet). No seeds
    // live on the DO leg.
    // #4767 adds migrations 0071/0072 (4 remainder ALTERs): 132 → 136.
    // #5865 adds migration 0074 (definition history): 136 → 137.
    // Issue #3185 adds the usage_events tenant index to the DO leg: 139 → 140.
    // Issue #6167 adds the host_version remainder ALTER on mas_async_jobs: 140 → 141.
    expect(selected.schema).toHaveLength(141);
    expect(selected.seeds).toHaveLength(0);
    // Issue #3185 adds one probed DO statement (usage_events.tenant_id):
    // the fresh CREATE TABLE already carries the column, so the ALTER
    // is probed-and-skipped: 36 → 37.
    // Issue #5100 (F3 of #5094) adds 9 probed DO statements (4
    // job_run_records + 5 mas_policy_verdicts literal ALTERs): the
    // fresh CREATE TABLEs already carry the binding columns, so the
    // ALTERs are probed-and-skipped: 37 → 46.
    expect(selected.skipped).toHaveLength(53);
    expect(codesOf(selected.skipped)).toContain(DROP_INDEX_CODE);
  });

  it("selects zero steps on a healthy store — a re-run is a true no-op", () => {
    for (const leg of ["d1", "do"] as const) {
      const legPlan = planForLeg(plan(), leg);
      const selected = selectSteps(
        legPlan,
        expectedModelForLeg(plan(), leg),
        [],
      );
      expect(selected.schema).toHaveLength(0);
      expect(selected.seeds).toHaveLength(0);
      expect(selected.skipped).toHaveLength(legPlan.steps.length);
    }
  });

  it("selects exactly the closing steps on a partial store (missing columns + wrong-shaped index)", () => {
    const legPlan = planForLeg(plan(), "do");
    const actual = JSON.parse(
      JSON.stringify(expectedModelForLeg(plan(), "do")),
    ) as SchemaModel;
    // Drop two columns from the report table and warp the generation index.
    const table = actual.tables["mas_reports"];
    table.columns = table.columns.filter(
      (c) => c.name !== "generation_id" && c.name !== "user_login",
    );
    actual.indexes["idx_mas_reports_generation"] = {
      table: "mas_reports",
      columns: ["id"],
      unique: true,
    };
    const selected = selectSteps(legPlan, actual, []);
    const schemaCodes = codesOf(selected.schema);
    expect(schemaCodes).toHaveLength(4);
    expect(schemaCodes).toContain(REPORT_ALTER_CODE);
    expect(schemaCodes).toContain(DROP_INDEX_CODE);
    expect(schemaCodes).toContain(CREATE_GENERATION_INDEX_CODE);
    // Both missing columns are reconciled, one step per pair.
    expect(schemaCodes.filter((c) => c === REPORT_ALTER_CODE)).toHaveLength(2);
    // No seed re-runs: the missing columns do not re-create any
    // table, and every seed's table already exists.
    expect(selected.seeds).toHaveLength(0);
  });

  it("selects a seed when its table's creation is selected (the table is being rebuilt)", () => {
    const legPlan = planForLeg(plan(), "d1");
    // The table is absent (fresh build of that table only): its
    // creations are selected, so the seed that fills it is selected.
    const actual = JSON.parse(
      JSON.stringify(expectedModelForLeg(plan(), "d1")),
    ) as SchemaModel;
    delete actual.tables["agent_price_catalogue"];
    const selected = selectSteps(legPlan, actual, []);
    expect(codesOf(selected.seeds)).toContain(LEGACY_SEED_CODE);
    expect(codesOf(selected.schema)).toContain(RENAME_CODE);
    expect(codesOf(selected.schema)).toContain(LEGACY_DROP_CODE);
  });

  it("does not select the DROP when the index is absent, and does select it when present with the wrong shape", () => {
    const legPlan = planForLeg(plan(), "do");
    const actual = JSON.parse(
      JSON.stringify(expectedModelForLeg(plan(), "do")),
    ) as SchemaModel;
    delete actual.indexes["idx_mas_reports_generation"];
    const without = selectSteps(legPlan, actual, []);
    expect(codesOf(without.schema)).not.toContain(DROP_INDEX_CODE);
    // The creation step IS selected (the index is missing).
    expect(codesOf(without.schema)).toContain(CREATE_GENERATION_INDEX_CODE);
    // Present but wrong-shaped: the DROP is selected so the creation can
    // rebuild it, and the creation is selected too.
    const warped = JSON.parse(
      JSON.stringify(expectedModelForLeg(plan(), "do")),
    ) as SchemaModel;
    warped.indexes["idx_mas_reports_generation"] = {
      table: "mas_reports",
      columns: ["id"],
      unique: true,
    };
    const warpedSelected = selectSteps(legPlan, warped, []);
    expect(codesOf(warpedSelected.schema)).toContain(DROP_INDEX_CODE);
    expect(codesOf(warpedSelected.schema)).toContain(
      CREATE_GENERATION_INDEX_CODE,
    );
    // Healthy: the index is present with the right shape, so neither the
    // DROP nor the creation is selected — the DROP must not run alone.
    const healthy = selectSteps(
      legPlan,
      expectedModelForLeg(plan(), "do"),
      [],
    );
    expect(codesOf(healthy.schema)).not.toContain(DROP_INDEX_CODE);
    expect(codesOf(healthy.schema)).not.toContain(
      CREATE_GENERATION_INDEX_CODE,
    );
  });

  it("selects the legacy DROP on a fresh store (the rename creates its target mid-run) and neither on a healthy store", () => {
    const legPlan = planForLeg(plan(), "d1");
    const fresh = selectSteps(legPlan, emptySchemaModel(), []);
    expect(codesOf(fresh.schema)).toContain(RENAME_CODE);
    expect(codesOf(fresh.schema)).toContain(LEGACY_DROP_CODE);
    const healthy = selectSteps(
      legPlan,
      expectedModelForLeg(plan(), "d1"),
      [],
    );
    expect(codesOf(healthy.schema)).not.toContain(RENAME_CODE);
    expect(codesOf(healthy.schema)).not.toContain(LEGACY_DROP_CODE);
  });

  it("re-selects only a failed seed on a schema-complete store (last-report re-run)", () => {
    const legPlan = planForLeg(plan(), "d1");
    const selected = selectSteps(
      legPlan,
      expectedModelForLeg(plan(), "d1"),
      [LEGACY_SEED_CODE],
    );
    expect(selected.schema).toHaveLength(0);
    expect(codesOf(selected.seeds)).toEqual([LEGACY_SEED_CODE]);
  });

  it("never selects the seed-form entry", () => {
    const legPlan = planForLeg(plan(), "d1");
    const selected = selectSteps(legPlan, emptySchemaModel(), []);
    expect(codesOf(selected.seeds)).not.toContain(SEED_FORM_CODE);
    expect(codesOf(selected.schema)).not.toContain(SEED_FORM_CODE);
  });
});

describe("P5 runner — per-leg expected models", () => {
  it("splits by leg: the D1 leg owns the D1 tables, the DO leg owns the DO tables", () => {
    const p = plan();
    const d1 = expectedModelForLeg(p, "d1");
    const doModel = expectedModelForLeg(p, "do");
    expect(d1.tables["agent_price_catalogue"]).toBeDefined();
    expect(d1.tables["mas_reports"]).toBeUndefined();
    expect(doModel.tables["mas_reports"]).toBeDefined();
    expect(doModel.tables["mas_reports"].columns).toHaveLength(11);
    expect(doModel.tables["agent_price_catalogue"]).toBeUndefined();
    // Dual-homed tables exist on both legs, and the two copies agree
    // on shape (the D1 copy and the DO copy are the same table).
    const d1Cols = d1.tables["job_pipeline_instances"].columns.map(
      (c) => c.name,
    );
    const doCols = doModel.tables["job_pipeline_instances"].columns.map(
      (c) => c.name,
    );
    expect(d1Cols).toContain("checkpoint_json");
    expect(doCols).toContain("checkpoint_json");
    expect(d1Cols).toContain("run_schedule_id");
    expect(doCols).toContain("run_schedule_id");
    expect([...doCols].sort()).toEqual([...d1Cols].sort());
  });
});

describe("P5 runner — probe (introspectSchema over real SQLite, per leg)", () => {
  function probeOf(db: DatabaseSync): SchemaProbe {
    return {
      query: async (sql: string) =>
        db.prepare(sql).all() as Array<Record<string, unknown>>,
    };
  }

  it("executes each leg's selected steps on real SQLite and reproduces that leg's expected model", async () => {
    const { resolveStatementText } = await import(
      "../src/data/schemaComponent/executor"
    );
    for (const leg of ["d1", "do"] as const) {
      const legPlan = planForLeg(plan(), leg);
      const selected = selectSteps(legPlan, emptySchemaModel(), []);
      const db = new DatabaseSync(":memory:");
      const expected = expectedModelForLeg(plan(), leg);
      // Framework-owned tables: an index in the catalogue whose table
      // has no creation in any catalogue (the Agents SDK creates the
      // table — the app only adds the indexes to it). A real store
      // always has the table, so the probe test models each one with
      // a stub carrying the indexed columns, derived from the leg's
      // expected model so the list stays correct if the catalogue
      // changes. The stub shows up as an extra table in the
      // verification, which is listed, not failed.
      const orphanColumns = new Map<string, string[]>();
      for (const index of Object.values(expected.indexes)) {
        if (index.table in expected.tables) continue;
        const columns = orphanColumns.get(index.table) ?? [];
        for (const column of index.columns) {
          const name = column.replace(/\s+(ASC|DESC)$/i, "");
          if (!columns.includes(name)) columns.push(name);
        }
        orphanColumns.set(index.table, columns);
      }
      for (const [table, columns] of orphanColumns) {
        db.exec(
          `CREATE TABLE ${table} (${columns.map((c) => `${c} TEXT`).join(", ")})`,
        );
      }
      // Execute in plan order (not schema-then-seeds): the legacy
      // seed is hoisted to immediately before its source table's
      // DROP (P4 finding 4), so executing the seeds after all schema
      // steps would read a table the DROP already removed.
      const ordered = [...selected.schema, ...selected.seeds].sort(
        (a, b) => a.order - b.order,
      );
      for (const step of ordered) {
        db.exec(resolveStatementText(step.entry, step.params));
      }
      const actual = await introspectSchema(probeOf(db));
      const result = verifyRecreate(expected, actual);
      expect(
        result.ok,
        `leg ${leg} verification failures: ${result.failures.join("; ")}`,
      ).toBe(true);
      expect(result.knownDifferences).toEqual([]);
    }
  });

  it("d1SchemaProbe reads through prepare/bind/all (the data-layer probe a route uses)", async () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`CREATE TABLE probe_items (id TEXT PRIMARY KEY)`);
    // The D1 client shape: prepare().bind().all() -> { results }.
    const d1 = {
      prepare: (sql: string) => ({
        bind: (..._params: unknown[]) => ({
          all: async () => ({ results: db.prepare(sql).all() }),
        }),
      }),
      batch: async () => [],
    };
    const probe = d1SchemaProbe(d1 as never);
    const rows = await probe.query(
      `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table','index')`,
    );
    expect(rows.map((r) => r.name)).toContain("probe_items");
  });

  it("does not select the redundant column-add whose column a selected creation already provides", () => {
    const legPlan = planForLeg(plan(), "d1");
    const selected = selectSteps(legPlan, emptySchemaModel(), []);
    expect(
      codesOf(selected.schema),
    ).not.toContain("schema.orm.mas_transactions.alter_table_add_column_tenant_id");
  });
});

describe("P5 runner — post-run verification", () => {
  it("passes on an empty diff", () => {
    const model = combinedExpectedModel();
    expect(verifyRecreate(model, model).ok).toBe(true);
  });

  it("fails on a missing table or a changed index", () => {
    const expected = combinedExpectedModel();
    const missing = JSON.parse(JSON.stringify(expected)) as SchemaModel;
    delete missing.tables["mas_reports"];
    expect(verifyRecreate(expected, missing).ok).toBe(false);
    const changed = JSON.parse(JSON.stringify(expected)) as SchemaModel;
    changed.indexes["idx_mas_reports_generation"].columns = ["id"];
    expect(verifyRecreate(expected, changed).ok).toBe(false);
  });

  it("passes with extras listed, not failed (tables outside the catalogue's domain)", () => {
    const expected = combinedExpectedModel();
    const actual = JSON.parse(JSON.stringify(expected)) as SchemaModel;
    actual.tables["_migrations"] = { columns: [], constraints: {} };
    const result = verifyRecreate(expected, actual);
    expect(result.ok).toBe(true);
    expect(result.extras.tables).toEqual(["_migrations"]);
  });

  it("fails when the rebuilt table itself is missing (no rename exception: the table must exist)", () => {
    const expected = combinedExpectedModel();
    const actual = JSON.parse(JSON.stringify(expected)) as SchemaModel;
    delete actual.tables["agent_price_catalogue"];
    const result = verifyRecreate(expected, actual);
    expect(result.ok).toBe(false);
    expect(result.failures).toContain(
      "missing table agent_price_catalogue",
    );
    expect(result.knownDifferences).toHaveLength(0);
  });
});

describe("P5 runner — uncreatable layers", () => {
  it("covers the P4 harness's layers and the three operator-facing ones, each with a reason", () => {
    for (const layer of HARNESS_UNCREATABLE_LAYERS) {
      expect(
        UNCREATABLE_LAYERS.some((l) => l.layer === layer.layer),
        `production list is missing harness layer ${layer.layer}`,
      ).toBe(true);
    }
    const ids = UNCREATABLE_LAYERS.map((l) => l.layer);
    expect(ids).toContain("vectorize:vector-memory");
    expect(ids).toContain("r2:screener:knowledge/");
    expect(ids).toContain("queues:deploy-time");
    expect(ids).toContain("ai-search:index_source");
    expect(ids).toContain("r2:screener:objects");
    for (const layer of UNCREATABLE_LAYERS) {
      expect(layer.reason.length).toBeGreaterThan(20);
      expect(layer.remedy.length).toBeGreaterThan(10);
    }
  });
});
