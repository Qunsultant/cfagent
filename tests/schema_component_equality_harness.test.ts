/**
 * #4282 P0 — schema-equality harness.
 *
 * The harness executes a catalogue against a clean instance and diffs
 * the resulting schema against an expected schema. The clean instance
 * is the InMemorySchemaInstance: it captures executed DDL at the
 * statement seam and parses it into a schema model (tables → columns,
 * indexes, constraints) — the same executed-DDL-capture idiom the
 * #782 drift pin uses (tests/schema_single_source.test.ts), because
 * this repo's test harness has no real SQLite (node:sqlite is
 * flag-gated on CI's Node 22).
 *
 * Two test levels:
 *  - Mechanism (fixture): the parser, the instance, and the diff are
 *    proven against hand-written models and the REAL shared-table DDL
 *    from src/data/ormSchema.ts — the parser must reproduce the
 *    canonical mas_* columns exactly.
 *  - Full diff (real tree): the empty P0 catalogue run against the
 *    tree-derived expected schema reports the whole current schema as
 *    missing. This test is RED by design at P0 (see the last test);
 *    P4 flips it green when the catalogue is complete.
 */
import { describe, expect, it } from "vitest";
import { createCatalogue } from "../src/data/schemaComponent/catalogue";
import {
  diffSchema,
  emptySchemaModel,
  formatDiffReport,
  InMemorySchemaInstance,
  isEmptyDiff,
  parseSchemaStatement,
  runEqualityCheck,
  type SchemaModel,
} from "../src/data/schemaComponent/equalityHarness";
import { SHARED_TABLE_DDL } from "../src/data/ormSchema";
import { extractTableNames, REPO_ROOT } from "./schema_component_scan";
import {
  INDEX_ENTRY,
  SEED_ENTRY,
  TABLE_ENTRY,
} from "./schema_component_fixtures";

/** Expected schema built from the tree: tables by name, columns unknown. */
function expectedSchemaFromTree(): {
  model: SchemaModel;
  unresolvedLines: number;
  scannedLines: number;
} {
  const { tables, unresolvedLines, scannedLines } = extractTableNames(REPO_ROOT);
  const model = emptySchemaModel();
  for (const table of tables) {
    model.tables[table] = { columns: [], constraints: {} };
  }
  return { model, unresolvedLines, scannedLines };
}

describe("DDL parser — real shared-table DDL (#4282 P0)", () => {
  it("reproduces the canonical mas_* columns exactly", () => {
    const model = emptySchemaModel();
    for (const ddl of Object.values(SHARED_TABLE_DDL)) {
      parseSchemaStatement(ddl, model);
    }
    const columns = (table: string): string[] =>
      model.tables[table].columns.map((c) => `${c.name}:${c.type}:pk${c.pk}`);
    expect(Object.keys(model.tables).sort()).toEqual([
      "mas_ads",
      "mas_events",
      "mas_memory",
      "mas_messages",
      "mas_promotions",
      "mas_referrals",
      "mas_transactions",
      "mas_watchlists",
    ]);
    expect(columns("mas_messages")).toEqual([
      "id:TEXT:pk1",
      "session_id:TEXT:pk0",
      "role:TEXT:pk0",
      "content:TEXT:pk0",
      "agent:TEXT:pk0",
      "created_at:TEXT:pk0",
    ]);
    // Issue #4412: the restored mas_promotions table, exact #760 columns.
    expect(columns("mas_promotions")).toEqual([
      "id:TEXT:pk1",
      "candidate_id:TEXT:pk0",
      "stage:TEXT:pk0",
      "stage_started_at:TEXT:pk0",
      "baseline_json:TEXT:pk0",
      "applied_json:TEXT:pk0",
      "last_check_json:TEXT:pk0",
      "created_at:TEXT:pk0",
    ]);
    expect(columns("mas_events")).toEqual([
      "id:TEXT:pk1",
      "session_id:TEXT:pk0",
      "type:TEXT:pk0",
      "agent:TEXT:pk0",
      "payload:TEXT:pk0",
      "created_at:TEXT:pk0",
      "previous_event_hash:TEXT:pk0",
      "event_hash:TEXT:pk0",
    ]);
    expect(columns("mas_memory")).toEqual([
      "key:TEXT:pk1",
      "value:TEXT:pk0",
      "updated_at:TEXT:pk0",
    ]);
    expect(columns("mas_referrals")).toEqual([
      "id:TEXT:pk1",
      "session_id:TEXT:pk0",
      "title:TEXT:pk0",
      "url:TEXT:pk0",
      "category:TEXT:pk0",
      "reward_text:TEXT:pk0",
      "clicks:INTEGER:pk0",
      "signups:INTEGER:pk0",
      "created_at:TEXT:pk0",
    ]);
    expect(columns("mas_transactions")).toEqual([
      "id:TEXT:pk1",
      "session_id:TEXT:pk0",
      "action:TEXT:pk0",
      "amount:REAL:pk0",
      "currency:TEXT:pk0",
      "customer:TEXT:pk0",
      "gateway:TEXT:pk0",
      "gateway_ref:TEXT:pk0",
      "status:TEXT:pk0",
      "checkout_url:TEXT:pk0",
      "proposer_did:TEXT:pk0",
      "authorizer_did:TEXT:pk0",
      "proof_signature:TEXT:pk0",
      "note:TEXT:pk0",
      "created_at:TEXT:pk0",
      "updated_at:TEXT:pk0",
    ]);
  });
});

describe("InMemorySchemaInstance (#4282 P0)", () => {
  it("builds tables, indexes, and added columns from executed DDL", async () => {
    const instance = new InMemorySchemaInstance();
    await instance.exec(
      "CREATE TABLE IF NOT EXISTS probe_a (id TEXT PRIMARY KEY, label TEXT NOT NULL)",
    );
    await instance.exec(
      "CREATE INDEX IF NOT EXISTS probe_a_label_idx ON probe_a (label)",
    );
    await instance.exec("ALTER TABLE probe_a ADD COLUMN note TEXT");
    const model = await instance.introspect();
    expect(Object.keys(model.tables)).toEqual(["probe_a"]);
    expect(
      model.tables.probe_a.columns.map((c) => c.name),
    ).toEqual(["id", "label", "note"]);
    expect(model.indexes.probe_a_label_idx).toEqual({
      table: "probe_a",
      columns: ["label"],
      unique: false,
    });
  });

  it("removes a dropped index and ignores seed DML (seeds do not change schema)", async () => {
    const instance = new InMemorySchemaInstance();
    await instance.exec(
      "CREATE TABLE IF NOT EXISTS probe_b (id TEXT PRIMARY KEY)",
    );
    await instance.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS probe_b_id_uidx ON probe_b (id)",
    );
    await instance.exec(
      "INSERT OR IGNORE INTO probe_b (id) VALUES ('x')",
    );
    await instance.exec("DROP INDEX IF EXISTS probe_b_id_uidx");
    const model = await instance.introspect();
    expect(Object.keys(model.tables)).toEqual(["probe_b"]);
    expect(model.indexes).toEqual({});
  });

  it("parses a table-level PRIMARY KEY and UNIQUE into constraints", async () => {
    const instance = new InMemorySchemaInstance();
    await instance.exec(
      "CREATE TABLE IF NOT EXISTS probe_c (a TEXT NOT NULL, b TEXT NOT NULL, PRIMARY KEY (a, b), UNIQUE (a))",
    );
    const model = await instance.introspect();
    expect(model.tables.probe_c.constraints.primary_key).toEqual({
      kind: "primaryKey",
      columns: ["a", "b"],
    });
    expect(model.tables.probe_c.constraints["unique:a"]).toEqual({
      kind: "unique",
      columns: ["a"],
    });
  });
});

describe("diffSchema (#4282 P0)", () => {
  function modelWith(
    tables: Record<string, string[]>,
    indexes: Record<string, { table: string; columns: string[]; unique: boolean }> = {},
  ): SchemaModel {
    const model = emptySchemaModel();
    for (const [table, cols] of Object.entries(tables)) {
      model.tables[table] = {
        columns: cols.map((name) => ({ name, type: "TEXT", pk: 0 })),
        constraints: {},
      };
    }
    for (const [name, index] of Object.entries(indexes)) {
      model.indexes[name] = index;
    }
    return model;
  }

  it("names missing and extra tables, columns, and indexes exactly", () => {
    const actual = modelWith(
      { shared: ["id", "label"], only_actual: ["id"] },
      { shared_idx: { table: "shared", columns: ["label"], unique: false } },
    );
    const expected = modelWith(
      { shared: ["id", "label", "note"], only_expected: ["id"] },
      {
        shared_idx: { table: "shared", columns: ["label"], unique: false },
        missing_idx: { table: "shared", columns: ["note"], unique: false },
      },
    );
    const diff = diffSchema(actual, expected);
    expect(diff.missingTables).toEqual(["only_expected"]);
    expect(diff.extraTables).toEqual(["only_actual"]);
    expect(diff.missingColumns).toEqual([
      { table: "shared", column: "note" },
    ]);
    expect(diff.extraColumns).toEqual([]);
    expect(diff.missingIndexes).toEqual(["missing_idx"]);
    expect(diff.extraIndexes).toEqual([]);
    expect(diff.changedColumns).toEqual([]);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("reports a changed column type and an extra column", () => {
    const actual = modelWith({ t: ["id", "amount"] });
    actual.tables.t.columns[1].type = "INTEGER";
    const expected = modelWith({ t: ["id", "amount"] });
    expected.tables.t.columns[1].type = "REAL";
    const diff = diffSchema(actual, expected);
    expect(diff.changedColumns).toEqual([
      {
        table: "t",
        column: "amount",
        actualType: "INTEGER",
        expectedType: "REAL",
        actualPk: 0,
        expectedPk: 0,
      },
    ]);
    expect(diff.missingColumns).toEqual([]);
  });

  it("reports a changed index and missing/extra constraints", () => {
    const actual = modelWith(
      { t: ["id", "label"] },
      { t_label_idx: { table: "t", columns: ["label"], unique: false } },
    );
    actual.tables.t.constraints["unique:label"] = {
      kind: "unique",
      columns: ["label"],
    };
    const expected = modelWith(
      { t: ["id", "label"] },
      { t_label_idx: { table: "t", columns: ["label"], unique: true } },
    );
    expected.tables.t.constraints.primary_key = {
      kind: "primaryKey",
      columns: ["id"],
    };
    const diff = diffSchema(actual, expected);
    expect(diff.changedIndexes).toHaveLength(1);
    expect(diff.changedIndexes[0].name).toBe("t_label_idx");
    expect(diff.changedIndexes[0].actual.unique).toBe(false);
    expect(diff.changedIndexes[0].expected.unique).toBe(true);
    expect(diff.missingConstraints).toEqual([
      { table: "t", constraint: "primary_key" },
    ]);
    expect(diff.extraConstraints).toEqual([
      { table: "t", constraint: "unique:label" },
    ]);
  });

  it("an identical model diffs empty", () => {
    const model = modelWith({ t: ["id"] });
    expect(isEmptyDiff(diffSchema(model, model))).toBe(true);
    expect(formatDiffReport(diffSchema(model, model))).toMatch(/no differences/);
  });

  it("the report names the missing tables and the counts", () => {
    const diff = diffSchema(
      emptySchemaModel(),
      modelWith({ alpha: ["id"], beta: ["id"] }),
    );
    const report = formatDiffReport(diff);
    expect(report).toContain("missing tables (2): alpha, beta");
    expect(report).toContain("missing columns (0)");
  });
});

describe("runEqualityCheck (#4282 P0)", () => {
  it("produces an empty diff when the catalogue builds exactly the expected schema", async () => {
    const catalogue = createCatalogue();
    catalogue.register(TABLE_ENTRY);
    catalogue.register(INDEX_ENTRY);
    const expected: SchemaModel = {
      tables: {
        schema_probe_widgets: {
          columns: [
            { name: "id", type: "TEXT", pk: 1 },
            { name: "label", type: "TEXT", pk: 0 },
            { name: "created_at", type: "TEXT", pk: 0 },
          ],
          constraints: {},
        },
      },
      indexes: {
        schema_probe_widgets_label_idx: {
          table: "schema_probe_widgets",
          columns: ["label"],
          unique: false,
        },
      },
    };
    const { diff, report } = await runEqualityCheck(catalogue, expected);
    expect(isEmptyDiff(diff)).toBe(true);
    expect(report).toMatch(/no differences/);
  });

  it("seed entries execute without changing the schema diff", async () => {
    const catalogue = createCatalogue();
    catalogue.register(TABLE_ENTRY);
    catalogue.register(SEED_ENTRY);
    const expected: SchemaModel = {
      tables: {
        schema_probe_widgets: {
          columns: [
            { name: "id", type: "TEXT", pk: 1 },
            { name: "label", type: "TEXT", pk: 0 },
            { name: "created_at", type: "TEXT", pk: 0 },
          ],
          constraints: {},
        },
      },
      indexes: {},
    };
    const { diff } = await runEqualityCheck(catalogue, expected);
    expect(isEmptyDiff(diff)).toBe(true);
  });
});

describe("equality harness — full diff on the unmigrated tree (#4282 P0)", () => {
  it("reports the whole current schema as missing: the empty P0 catalogue builds nothing", async () => {
    const { model, unresolvedLines, scannedLines } = expectedSchemaFromTree();
    expect(Object.keys(model.tables).length).toBeGreaterThan(0);
    // Diagnostic, not an assertion on a magic number: template-assembled
    // DDL (e.g. mas_reports' ${TABLE}) cannot be extracted by name, so
    // those lines are unresolved — P3's parameterized entries are their
    // answer, and the count is reported, not hidden.
    console.log(
      `equality-harness: expected schema from tree: ${Object.keys(model.tables).length} tables from ${scannedLines} CREATE TABLE lines, ${unresolvedLines} unresolved (template-assembled)`,
    );
    const catalogue = createCatalogue();
    const { diff, report } = await runEqualityCheck(catalogue, model);
    console.log(report);
    // The report must enumerate the full current schema as missing —
    // every table the tree defines, nothing extra, nothing silently dropped.
    expect(diff.missingTables).toEqual(Object.keys(model.tables).sort());
    expect(diff.extraTables).toEqual([]);
    expect(report).toContain(
      `missing tables (${Object.keys(model.tables).length})`,
    );
    expect(report).toContain("missing columns (0)");
    // The equality assertion itself (an empty diff) lands at P4, when
    // the catalogue is complete: the zero-tolerance form of this test
    // fails on the unmigrated tree by design — see the red run in
    // ~/workspace/w4282/evidence-p0/red-run-3-assertions.log.
    expect(isEmptyDiff(diff)).toBe(false);
  });
});
