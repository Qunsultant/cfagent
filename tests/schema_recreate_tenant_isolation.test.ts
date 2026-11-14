/**
 * #4282 P4 — recreate + tenant isolation (red team).
 *
 * What this suite pins:
 *  - recreate twice: the second run is a provable no-op report — zero
 *    statements executed, the report lists zero changes. The runner
 *    diff-gates at the run level: it introspects first, and an empty
 *    diff plans zero steps. (It does NOT yet select only the steps
 *    that close a non-empty diff — that delta-to-steps mapping is a
 *    P5 production requirement, named in the P4 build report; the
 *    harness cannot prove real-SQLite re-execution safety, only
 *    harness-level idempotence.)
 *  - tenant isolation: a recreate in one tenant cannot create/alter
 *    another tenant's tables. Isolation is structural — one executor
 *    is bound to one tenant's instance, and the runner receives
 *    exactly one executor. The pin proves it by execution: two
 *    instances, a recreate through one leaves the other byte-empty.
 *  - sabotage: a cross-tenant scope is rejected before anything
 *    executes; an unknown statement code is rejected before anything
 *    executes (P0 enforcement point: executeStatement in
 *    src/data/schemaComponent/executor.ts — "there is no raw-SQL
 *    entry point in this component"); a step forced to fail mid-run
 *    leaves a truthful partial report and a safe re-run.
 *  - the silent-degrade index path (survey §4.8) is REPORTED as a
 *    recreate failure, never silently continued. Decision (P4):
 *    REPORT, not FIX. In the recreate path the unique-index CREATE
 *    failure is an honest EXECUTION_FAILED in the report — this suite
 *    forces exactly that failure and proves the report names it and
 *    the post-run equality check fails visibly. The adapter's own
 *    ensureSchema guard (doSqliteCanonicalReportStoreAdapter) stays
 *    in P4: rethrowing there would break every report write for a DO
 *    holding legacy duplicate rows, and the safe fix needs a dedupe
 *    decision. Named follow-up for the parent to file: #4282
 *    follow-up — adapter ensureSchema silent-degrade guard
 *    (dedupe-or-report decision for the production ensure path).
 *
 * Tenant model: there is no "tenant" concept in the schema component
 * (grep: only tenant_id columns/indexes in D1 entries). A tenant is
 * one InMemorySchemaInstance + the executor bound to it. The runner
 * takes the tenant scope and the executor together and refuses a
 * mismatch before executing anything.
 */
import { describe, expect, it } from "vitest";
import {
  buildCombinedCatalogue,
  combinedExpectedModel,
  runTenantRecreate,
  TenantExecutor,
  TenantScopeError,
  UNCREATABLE_LAYERS,
} from "./schema_equality_harness";
import {
  diffSchema,
  InMemorySchemaInstance,
  isEmptyDiff,
} from "../src/data/schemaComponent/equalityHarness";
import { SchemaComponentError } from "../src/data/schemaComponent/schemaErrors";

const UNIQUE_INDEX_CODE =
  "schema.index.mas_reports.create_unique_index_idx_mas_reports_generation";

describe("recreate + tenant isolation (#4282 P4)", () => {
  it("recreate twice: the second run is a provable no-op report", async () => {
    const instance = new InMemorySchemaInstance();
    const executor = new TenantExecutor("tenant-a", instance);
    const first = await runTenantRecreate({
      catalogue: buildCombinedCatalogue(),
      expected: combinedExpectedModel(),
      tenant: "tenant-a",
      executor,
      uncreatable: UNCREATABLE_LAYERS,
    });
    expect(first.summary.totalSteps).toBe(412);
    expect(first.summary.executed).toBe(412);
    expect(first.summary.failed).toBe(0);
    expect(first.summary.skipped).toBe(0);
    expect(first.executed).toHaveLength(412);
    expect(first.failed).toEqual([]);
    expect(first.skipped).toEqual([]);
    // Uncreatable layers are deployment facts, not changes: they are
    // listed on every run, including the no-op.
    expect(first.uncreatable).toEqual(UNCREATABLE_LAYERS);
    expect(
      isEmptyDiff(diffSchema(instance.introspect(), combinedExpectedModel())),
    ).toBe(true);

    const second = await runTenantRecreate({
      catalogue: buildCombinedCatalogue(),
      expected: combinedExpectedModel(),
      tenant: "tenant-a",
      executor,
      uncreatable: UNCREATABLE_LAYERS,
    });
    expect(second.summary.totalSteps).toBe(0);
    expect(second.summary.executed).toBe(0);
    expect(second.executed).toEqual([]);
    expect(second.failed).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(second.uncreatable).toEqual(UNCREATABLE_LAYERS);
    expect(
      isEmptyDiff(diffSchema(instance.introspect(), combinedExpectedModel())),
    ).toBe(true);
  });

  it("tenant isolation: a recreate in one tenant cannot create/alter another tenant's tables", async () => {
    const instanceA = new InMemorySchemaInstance();
    const instanceB = new InMemorySchemaInstance();
    const executorA = new TenantExecutor("tenant-a", instanceA);
    await runTenantRecreate({
      catalogue: buildCombinedCatalogue(),
      expected: combinedExpectedModel(),
      tenant: "tenant-a",
      executor: executorA,
      uncreatable: UNCREATABLE_LAYERS,
    });
    expect(
      isEmptyDiff(diffSchema(instanceA.introspect(), combinedExpectedModel())),
    ).toBe(true);
    // Tenant B is byte-empty: zero tables, zero indexes.
    const modelB = instanceB.introspect();
    expect(Object.keys(modelB.tables)).toEqual([]);
    expect(Object.keys(modelB.indexes)).toEqual([]);

    // And the reverse: recreating B leaves A exactly as it was.
    const executorB = new TenantExecutor("tenant-b", instanceB);
    await runTenantRecreate({
      catalogue: buildCombinedCatalogue(),
      expected: combinedExpectedModel(),
      tenant: "tenant-b",
      executor: executorB,
      uncreatable: UNCREATABLE_LAYERS,
    });
    expect(
      isEmptyDiff(diffSchema(instanceB.introspect(), combinedExpectedModel())),
    ).toBe(true);
    expect(
      isEmptyDiff(diffSchema(instanceA.introspect(), combinedExpectedModel())),
    ).toBe(true);
  });

  it("sabotage: a cross-tenant scope is rejected before anything executes", async () => {
    const instanceA = new InMemorySchemaInstance();
    const instanceB = new InMemorySchemaInstance();
    // Scope says tenant-a; the executor is bound to tenant-b.
    const executorB = new TenantExecutor("tenant-b", instanceB);
    const error = await runTenantRecreate({
      catalogue: buildCombinedCatalogue(),
      expected: combinedExpectedModel(),
      tenant: "tenant-a",
      executor: executorB,
      uncreatable: UNCREATABLE_LAYERS,
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TenantScopeError);
    expect((error as Error).message).toMatch(/tenant-a/);
    expect((error as Error).message).toMatch(/tenant-b/);
    // Zero statements executed on either instance.
    expect(Object.keys(instanceA.introspect().tables)).toEqual([]);
    expect(Object.keys(instanceB.introspect().tables)).toEqual([]);
  });

  it("sabotage: an unknown statement code is rejected before anything executes", async () => {
    const instance = new InMemorySchemaInstance();
    const executor = new TenantExecutor("tenant-a", instance);
    // A plan step naming a code the catalogue never registered.
    // Enforcement point (P0): executeStatement in
    // src/data/schemaComponent/executor.ts — an uncoded statement
    // cannot execute; there is no raw-SQL entry point.
    const error = await runTenantRecreate({
      catalogue: buildCombinedCatalogue(),
      expected: combinedExpectedModel(),
      tenant: "tenant-a",
      executor,
      uncreatable: UNCREATABLE_LAYERS,
      extraSteps: [
        {
          code: "schema.do.nope.create_table",
          params: {},
          order: 999,
        },
      ],
    }).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SchemaComponentError);
    expect((error as SchemaComponentError).code).toBe("SCHEMA_UNKNOWN_CODE");
    expect(Object.keys(instance.introspect().tables)).toEqual([]);
  });

  it("sabotage + silent-degrade: a forced failure at the generation unique index leaves a truthful partial report and a safe re-run", async () => {
    const instance = new InMemorySchemaInstance();
    const throwing = new TenantExecutor("tenant-a", instance, (sql: string) => {
      // The real duplicate-values failure, simulated at the executor:
      // the unique-index CREATE throws exactly as SQLite would when
      // legacy duplicate (user_login, generation_id) pairs exist.
      return (
        sql.includes("idx_mas_reports_generation") &&
        sql.includes("CREATE UNIQUE INDEX")
      );
    });
    const partial = await runTenantRecreate({
      catalogue: buildCombinedCatalogue(),
      expected: combinedExpectedModel(),
      tenant: "tenant-a",
      executor: throwing,
      uncreatable: UNCREATABLE_LAYERS,
    });
    // The report is truthful: everything before the failing step
    // executed, the failing step is named, everything after it is
    // skipped — and the three counts sum to the 412 resolved steps.
    expect(partial.summary.failed).toBe(1);
    expect(partial.failed).toHaveLength(1);
    expect(partial.failed[0].code).toBe(UNIQUE_INDEX_CODE);
    expect(
      partial.summary.executed +
        partial.summary.failed +
        partial.summary.skipped,
    ).toBe(412);
    expect(partial.summary.totalSteps).toBe(412);
    // The degradation is VISIBLE, never silent: the post-run equality
    // check fails. The missing indexes are exactly the failed step's
    // index plus the indexes of the skipped steps (the run stopped in
    // the index phase, so every index after the failing one was never
    // created) — derived from the report, not assumed.
    const diff = diffSchema(instance.introspect(), combinedExpectedModel());
    expect(isEmptyDiff(diff)).toBe(false);
    const catalogue = buildCombinedCatalogue();
    const expectedMissing = new Set<string>();
    for (const code of [partial.failed[0].code, ...partial.skipped]) {
      const entry = catalogue.get(code);
      if (entry.index) expectedMissing.add(entry.index);
    }
    expect(expectedMissing.has("idx_mas_reports_generation")).toBe(true);
    expect(new Set(diff.missingIndexes)).toEqual(expectedMissing);
    expect(diff.missingTables).toEqual([]);

    // Safe re-run: a healthy executor completes the recreate and the
    // model equals the expected schema.
    const healthy = new TenantExecutor("tenant-a", instance);
    const rerun = await runTenantRecreate({
      catalogue: buildCombinedCatalogue(),
      expected: combinedExpectedModel(),
      tenant: "tenant-a",
      executor: healthy,
      uncreatable: UNCREATABLE_LAYERS,
    });
    expect(rerun.summary.failed).toBe(0);
    expect(rerun.summary.skipped).toBe(0);
    expect(
      isEmptyDiff(diffSchema(instance.introspect(), combinedExpectedModel())),
    ).toBe(true);
  });
});
