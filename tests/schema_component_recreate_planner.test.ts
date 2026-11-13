/**
 * #4282 P0 — recreate planner + report.
 *
 * The planner turns a catalogue into an ordered recreate plan: schema
 * entries first (catalogue order), then seed entries (catalogue order).
 * The ordering rule the later phases need — base CREATE, then ALTER
 * reconciliation, then indexes — is a P3 refinement of this planner;
 * P0 orders by kind only, and says so.
 *
 * The report is the honest-failure artefact: executed, failed, and
 * skipped (steps never reached because an earlier step failed) are
 * listed separately, and layers the component cannot create (Vectorize
 * re-index, corpus bytes, queues — survey §5) are reported with a
 * reason and a remedy, never faked as recreated. The planner does not
 * hard-code that list: the caller supplies the uncreatable layers, so
 * the list stays a deployment fact, not a component constant.
 */
import { describe, expect, it } from "vitest";
import { createCatalogue } from "../src/data/schemaComponent/catalogue";
import {
  buildRecreateReport,
  planRecreate,
  type UncreatableLayer,
} from "../src/data/schemaComponent/recreatePlanner";
import type { ExecutionReport } from "../src/data/schemaComponent/executor";
import {
  INDEX_ENTRY,
  PARAMETERIZED_ENTRY,
  SEED_ENTRY,
  TABLE_ENTRY,
} from "./schema_component_fixtures";

const UNCREATABLE_FIXTURE: UncreatableLayer[] = [
  {
    layer: "vectorize:vector-memory",
    reason: "No re-index / rebuild flow exists; the index is deploy-time provisioned.",
    remedy: "Re-embed from source rows via a dedicated re-embed design (own sub-issue).",
  },
  {
    layer: "r2:screener:knowledge/",
    reason: "Corpus bytes are not in the repo — only hashes + source URLs in the manifest.",
    remedy: "Owner uploads from the Corpus tab (POST /api/knowledge/corpus).",
  },
];

function mixedOrderCatalogue() {
  const catalogue = createCatalogue();
  catalogue.register(SEED_ENTRY);
  catalogue.register(TABLE_ENTRY);
  catalogue.register(INDEX_ENTRY);
  catalogue.register(PARAMETERIZED_ENTRY);
  return catalogue;
}

describe("planRecreate (#4282 P0)", () => {
  it("orders schema entries before seed entries, keeping catalogue order within each kind", () => {
    const plan = planRecreate(mixedOrderCatalogue());
    expect(plan.steps.map((s) => s.code)).toEqual([
      TABLE_ENTRY.code,
      INDEX_ENTRY.code,
      PARAMETERIZED_ENTRY.code,
      SEED_ENTRY.code,
    ]);
    expect(plan.steps.map((s) => s.order)).toEqual([0, 1, 2, 3]);
    expect(plan.summary).toEqual({
      schemaSteps: 3,
      seedSteps: 1,
      totalSteps: 4,
      uncreatableLayers: 0,
    });
  });

  it("carries each step's kind, plane, and table", () => {
    const plan = planRecreate(mixedOrderCatalogue());
    expect(plan.steps[0]).toMatchObject({
      code: TABLE_ENTRY.code,
      kind: "schema",
      plane: "do",
      table: "schema_probe_widgets",
    });
    expect(plan.steps[3]).toMatchObject({
      code: SEED_ENTRY.code,
      kind: "seed",
      plane: "d1",
      table: "schema_probe_rules",
    });
  });

  it("reports caller-supplied uncreatable layers with reason and remedy, never as steps", () => {
    const plan = planRecreate(mixedOrderCatalogue(), {
      uncreatableLayers: UNCREATABLE_FIXTURE,
    });
    expect(plan.uncreatable).toEqual(UNCREATABLE_FIXTURE);
    expect(plan.summary.uncreatableLayers).toBe(2);
    expect(
      plan.steps.some((s) => s.code.includes("vectorize")),
    ).toBe(false);
  });

  it("plans an empty catalogue as zero steps (P0's real catalogue is empty)", () => {
    const plan = planRecreate(createCatalogue());
    expect(plan.steps).toEqual([]);
    expect(plan.summary).toEqual({
      schemaSteps: 0,
      seedSteps: 0,
      totalSteps: 0,
      uncreatableLayers: 0,
    });
  });
});

describe("buildRecreateReport (#4282 P0)", () => {
  it("reports executed, failed, and skipped separately on a partial run", () => {
    const plan = planRecreate(mixedOrderCatalogue(), {
      uncreatableLayers: UNCREATABLE_FIXTURE,
    });
    // The run stopped after the index entry failed: the seed step never ran.
    const execution: ExecutionReport = {
      results: [
        {
          code: TABLE_ENTRY.code,
          table: "schema_probe_widgets",
          executed: true,
          durationMs: 1,
          sql: TABLE_ENTRY.statement,
        },
      ],
      failures: [
        {
          code: INDEX_ENTRY.code,
          error: "SCHEMA_EXECUTION_FAILED: synthetic executor failure",
        },
      ],
      completed: 1,
      failed: 1,
    };
    const report = buildRecreateReport(plan, execution);
    expect(report.executed).toEqual([TABLE_ENTRY.code]);
    expect(report.failed).toEqual([
      {
        code: INDEX_ENTRY.code,
        error: "SCHEMA_EXECUTION_FAILED: synthetic executor failure",
      },
    ]);
    // The parameterized table step and the seed step were never reached.
    expect(report.skipped).toEqual([
      PARAMETERIZED_ENTRY.code,
      SEED_ENTRY.code,
    ]);
    expect(report.uncreatable).toEqual(UNCREATABLE_FIXTURE);
    expect(report.summary).toEqual({
      totalSteps: 4,
      executed: 1,
      failed: 1,
      skipped: 2,
      uncreatableLayers: 2,
    });
  });

  it("reports a clean run with nothing failed and nothing skipped", () => {
    const plan = planRecreate(mixedOrderCatalogue());
    const execution: ExecutionReport = {
      results: plan.steps.map((s) => ({
        code: s.code,
        table: s.table,
        executed: true,
        durationMs: 1,
        sql: "statement",
      })),
      failures: [],
      completed: 4,
      failed: 0,
    };
    const report = buildRecreateReport(plan, execution);
    expect(report.executed).toHaveLength(4);
    expect(report.failed).toEqual([]);
    expect(report.skipped).toEqual([]);
    expect(report.summary).toEqual({
      totalSteps: 4,
      executed: 4,
      failed: 0,
      skipped: 0,
      uncreatableLayers: 0,
    });
  });
});
