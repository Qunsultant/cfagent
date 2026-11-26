// @vitest-environment node
/**
 * #4282 P5 — transactionAspect as first production consumer.
 *
 * The recreate is the aspect's first production consumer, and this
 * suite PROVES it under the recreate's failure modes — it does not
 * merely call it. The D1 leg commits through ONE batch() call (the
 * aspect's D1 primitive); a failure anywhere in the leg — mid-DDL
 * or mid-seed — discards the whole batch, so no partial schema
 * ever lands. The DO leg cannot use the aspect at all: the DO
 * backend refuses async work and the executor is async, so the DO
 * leg stops at the first failure with an honest partial report and
 * claims no atomicity; a failed run is re-run safely because
 * selection is diff-based.
 *
 * The doubles are the #2288 idiom (MockD1Database with batchCalls;
 * MockDoStorage with transactionSync), copied here so this suite
 * stands alone against the recreate's own steps. Fidelity caveat
 * (same as #2288): these pins prove the aspect and the runner USE
 * the primitives correctly; they cannot detect the real D1/DO
 * facades deviating from the doubles' contract — that residual
 * proof runs only under workerd (#2348). The control block proves
 * the rollback pins would go RED against a lying primitive.
 */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  withTransaction,
  doSqlTransactionBackend,
  type TransactionOutcome,
} from "../src/aspects/transactionAspect";
import {
  DataFoundationCode,
  DataFoundationError,
} from "../src/aspects/errorCodes";
import {
  buildCombinedCatalogue,
  executeD1Leg,
  executeDoLeg,
  planForLeg,
  resolveRecreatePlan,
  selectSteps,
  type RecreateStep,
} from "../src/data/schemaComponent/recreateRunner";
import { emptySchemaModel } from "../src/data/schemaComponent/equalityHarness";

const REBUILD_CREATE_CODE =
  "schema.d1.agent_price_catalogue.create_table_m0058";
const LEGACY_SEED_CODE = "seed.d1.agent_price_catalogue.insert_from_legacy";
const GENERATION_INDEX_CODE =
  "schema.index.mas_reports.create_unique_index_idx_mas_reports_generation";

/* ------------------------------------------------------------------ */
/* Doubles (the #2288 idiom)                                           */
/* ------------------------------------------------------------------ */

/** D1 double over node:sqlite, in the data_foundation_slice0 shape. */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  batchCalls = 0;
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
        };
      },
    };
  }
  async batch(statements: any[]) {
    this.batchCalls += 1;
    const results: any[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

/** Sabotaged D1 primitive for the control block: no transaction at all. */
class LyingD1Database extends MockD1Database {
  override async batch(statements: any[]) {
    this.batchCalls += 1;
    const results: any[] = [];
    for (const stmt of statements) {
      results.push(await stmt.run());
    }
    return results;
  }
}

/** DO storage double over node:sqlite (the #2288 shape). */
class MockDoStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  readonly sql = {
    exec: (query: string, ...params: unknown[]) => this.execSql(query, params),
  };

  private execSql(query: string, params: unknown[]) {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*SELECT/i.test(query)) {
      const rows = stmt.all(...(params as any[]));
      return { toArray: () => rows, rowsRead: rows.length, rowsWritten: 0 };
    }
    const info = stmt.run(...(params as any[]));
    return { toArray: () => [], rowsRead: 0, rowsWritten: info.changes };
  }

  transactionSync<T>(closure: () => T): T {
    this.sqlite.exec("BEGIN");
    try {
      const result = closure();
      this.sqlite.exec("COMMIT");
      return result;
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
  }
}

function outcomeRecorder() {
  const outcomes: TransactionOutcome[] = [];
  return {
    outcomes,
    emit: (o: TransactionOutcome) => outcomes.push(o),
  };
}

function stepByCode(plan: ReturnType<typeof resolveRecreatePlan>, code: string): RecreateStep {
  const step = plan.steps.find((s) => s.code === code);
  if (!step) throw new Error(`test setup: no step with code ${code}`);
  return step;
}

/** The D1 leg's selected steps on a fresh store, in plan order. */
function freshD1Steps(): RecreateStep[] {
  const plan = resolveRecreatePlan();
  const legPlan = planForLeg(plan, "d1");
  const selected = selectSteps(legPlan, emptySchemaModel(), []);
  return [...selected.schema, ...selected.seeds].sort(
    (a, b) => a.order - b.order,
  );
}

/** The framework-owned tables the D1 leg's indexes attach to. */
function createFrameworkStubs(d1: MockD1Database): void {
  d1.sqlite.exec(
    `CREATE TABLE cf_agents_jobs (time TEXT, exclusive TEXT, singleflight TEXT, running TEXT, execution_started_at TEXT, hung_timeout_seconds TEXT)`,
  );
  // #6503 — migration 0092 owns the full unified_schedules table
  // in the D1 leg (CREATE TABLE IF NOT EXISTS + seed INSERTs), so
  // the stub must carry the full 12-column shape: the old 2-column
  // stub let the CREATE no-op, then the seed INSERTs failed with
  // "no such column: kind" and the whole batch rolled back. Same
  // full shape as tests/data_lifecycle_recreate_4383.test.ts.
  d1.sqlite.exec(`CREATE TABLE unified_schedules (id TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, callback TEXT, operation TEXT, definition_json TEXT NOT NULL, owner_login TEXT, provenance_json TEXT, alarm_id TEXT, paused_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
}

function tableExists(d1: MockD1Database, table: string): boolean {
  return (
    d1.sqlite
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(table) !== undefined
  );
}

/* ------------------------------------------------------------------ */
/* D1 leg — one batch, all-or-nothing                                  */
/* ------------------------------------------------------------------ */

describe("#4383 proof — D1 leg commits through ONE batch() call", () => {
  it("commits the whole fresh D1 leg through exactly one batch, TX_COMMITTED", async () => {
    const d1 = new MockD1Database();
    createFrameworkStubs(d1);
    const rec = outcomeRecorder();
    const steps = freshD1Steps();
    const report = await executeD1Leg(d1 as any, buildCombinedCatalogue(), steps, {
      emit: rec.emit,
    });
    expect(report.outcome).toBe("succeeded");
    expect(report.selected).toHaveLength(steps.length);
    expect(report.executed).toEqual(report.selected);
    expect(report.failed).toEqual([]);
    expect(report.rolledBack).toEqual([]);
    expect(d1.batchCalls).toBe(1);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_COMMITTED,
    ]);
    // The leg's tables actually landed.
    expect(tableExists(d1, "agent_price_catalogue")).toBe(true);
    expect(tableExists(d1, "mas_reports")).toBe(false); // DO-only table
    expect(tableExists(d1, "mas_transactions")).toBe(true);
  });

  it("a mid-DDL throw discards the whole batch: the batch runs and fails whole, nothing lands, TX_ROLLED_BACK", async () => {
    const d1 = new MockD1Database();
    createFrameworkStubs(d1);
    // The rebuild creation fails on real SQLite when the table
    // already exists (no IF NOT EXISTS) — a genuine DDL failure
    // mode for the leg. The failure surfaces at batch time (the
    // statements are only validated when the batch runs), so the
    // batch IS called once and fails whole — D1's all-or-nothing
    // contract means nothing was applied — and the report attributes
    // the failure to the batch as a whole (its error text carries
    // the cause) rather than pretending to name one step.
    d1.sqlite.exec(
      `CREATE TABLE agent_price_catalogue (id TEXT PRIMARY KEY)`,
    );
    const plan = resolveRecreatePlan();
    const first = stepByCode(
      plan,
      "schema.d1.agent_referral_rules.create_table",
    );
    const failing = stepByCode(plan, REBUILD_CREATE_CODE);
    const rec = outcomeRecorder();
    const report = await executeD1Leg(
      d1 as any,
      buildCombinedCatalogue(),
      [first, failing],
      { emit: rec.emit },
    );
    expect(report.outcome).toBe("failed");
    expect(report.executed).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].code).toBe("schema.recreate.d1");
    expect(report.failed[0].error).toContain("already exists");
    expect(report.rolledBack).toEqual([first.code, failing.code]);
    expect(report.skipped).toEqual([]);
    expect(d1.batchCalls).toBe(1);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_ROLLED_BACK,
    ]);
    // The buffered creation never landed — the batch failed whole,
    // not partially.
    expect(tableExists(d1, "agent_referral_rules")).toBe(false);
  });

  it("a mid-seed failure after DDL discards the DDL too: the whole batch fails, TX_ROLLED_BACK", async () => {
    const d1 = new MockD1Database();
    createFrameworkStubs(d1);
    // The target table exists, but the legacy source table does
    // not — so the seed fails at its SELECT, after the DDL step
    // was buffered. The failure surfaces at batch time, so the
    // batch is called once and fails whole.
    d1.sqlite.exec(
      `CREATE TABLE agent_price_catalogue (id TEXT PRIMARY KEY, family TEXT, price_usd REAL, updated_at_ms INTEGER, approval_status TEXT, approved_by TEXT, approved_at_ms INTEGER, product_id TEXT, segment TEXT, version INTEGER, effective_from_ms INTEGER, effective_to_ms INTEGER)`,
    );
    const plan = resolveRecreatePlan();
    const ddl = stepByCode(
      plan,
      "schema.d1.agent_referral_rules.create_table",
    );
    const seed = stepByCode(plan, LEGACY_SEED_CODE);
    const rec = outcomeRecorder();
    const report = await executeD1Leg(d1 as any, buildCombinedCatalogue(), [ddl, seed], {
      emit: rec.emit,
    });
    expect(report.outcome).toBe("failed");
    expect(report.executed).toEqual([]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].code).toBe("schema.recreate.d1");
    expect(report.failed[0].error).toContain("no such table");
    expect(report.rolledBack).toEqual([ddl.code, seed.code]);
    expect(report.skipped).toEqual([]);
    expect(d1.batchCalls).toBe(1);
    expect(rec.outcomes.map((o) => o.code)).toEqual([
      DataFoundationCode.TX_ROLLED_BACK,
    ]);
    expect(tableExists(d1, "agent_referral_rules")).toBe(false);
  });

  it("a failed leg is re-runnable: the same steps succeed once the store is repaired", async () => {
    const d1 = new MockD1Database();
    createFrameworkStubs(d1);
    const plan = resolveRecreatePlan();
    const ddl = stepByCode(
      plan,
      "schema.d1.agent_referral_rules.create_table",
    );
    const seed = stepByCode(plan, LEGACY_SEED_CODE);
    const failed = await executeD1Leg(
      d1 as any,
      buildCombinedCatalogue(),
      [ddl, seed],
    );
    expect(failed.outcome).toBe("failed");
    expect(d1.batchCalls).toBe(1); // the failed batch ran once
    // Repair: the legacy table now exists with a row to copy, and
    // the target table exists — so the seed can run.
    d1.sqlite.exec(
      `CREATE TABLE agent_price_catalogue (id TEXT PRIMARY KEY, family TEXT, price_usd REAL, updated_at_ms INTEGER, approval_status TEXT, approved_by TEXT, approved_at_ms INTEGER, product_id TEXT, segment TEXT, version INTEGER, effective_from_ms INTEGER, effective_to_ms INTEGER)`,
    );
    d1.sqlite.exec(
      `CREATE TABLE agent_price_catalogue_legacy (family TEXT, price_usd REAL, updated_at_ms INTEGER, approval_status TEXT, approved_by TEXT, approved_at_ms INTEGER)`,
    );
    d1.sqlite.exec(
      `INSERT INTO agent_price_catalogue_legacy VALUES ('stock', 1.5, 0, 'approved', NULL, NULL)`,
    );
    const retried = await executeD1Leg(
      d1 as any,
      buildCombinedCatalogue(),
      [ddl, seed],
    );
    expect(retried.outcome).toBe("succeeded");
    expect(d1.batchCalls).toBe(2); // one failed batch, one successful
    expect(tableExists(d1, "agent_referral_rules")).toBe(true);
    expect(
      d1.sqlite
        .prepare(`SELECT COUNT(*) AS n FROM agent_price_catalogue`)
        .get() as { n: number },
    ).toMatchObject({ n: 1 });
  });
});

/* ------------------------------------------------------------------ */
/* DO leg — no aspect, honest partial report                           */
/* ------------------------------------------------------------------ */

describe("#4383 proof — DO leg refuses the aspect and reports partial honestly", () => {
  it("an async executor inside doSqlTransactionBackend is refused with TX_CANNOT_HONOUR", async () => {
    const storage = new MockDoStorage();
    const backend = doSqlTransactionBackend(storage as any);
    // The recreate's executor is async (withAspects is async), so
    // the DO backend refuses it — this is the documented limit,
    // not a defect: the DO leg never claims atomicity.
    await expect(
      withTransaction(
        backend,
        { operationName: "schema.recreate.do" },
        async (unit) => {
          unit.exec("CREATE TABLE proof_items (id TEXT PRIMARY KEY)");
          await Promise.resolve();
        },
      ),
    ).rejects.toMatchObject({
      code: DataFoundationCode.TX_CANNOT_HONOUR,
    });
    expect(
      storage.sqlite
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'proof_items'`,
        )
        .get(),
    ).toBeUndefined();
  });

  it("a mid-leg DO failure leaves an honest partial report — earlier steps stay, later steps never run", async () => {
    const sqlite = new DatabaseSync(":memory:");
    const executor = {
      exec: (sql: string) => {
        sqlite.exec(sql);
      },
    };
    const plan = resolveRecreatePlan();
    // A creation that succeeds, then an index creation whose table
    // was never created — a genuine DO failure mode.
    const create = stepByCode(
      plan,
      "schema.do.mas_data_captures.create_table",
    );
    const failingIndex = stepByCode(plan, GENERATION_INDEX_CODE);
    const report = await executeDoLeg(executor, buildCombinedCatalogue(), [
      create,
      failingIndex,
    ]);
    expect(report.outcome).toBe("failed");
    expect(report.executed).toEqual([create.code]);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0].code).toBe(GENERATION_INDEX_CODE);
    expect(report.skipped).toEqual([]);
    expect(report.rolledBack).toEqual([]);
    // No rollback is claimed or performed: the successful creation
    // stays, and the report says so. A re-run is safe because
    // selection is diff-based (the creation is no longer selected).
    expect(
      sqlite
        .prepare(
          `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'mas_data_captures'`,
        )
        .get(),
    ).toBeDefined();
  });
});

/* ------------------------------------------------------------------ */
/* Control — the rollback pins detect a lying primitive                */
/* ------------------------------------------------------------------ */

describe("#4383 proof — control: the D1 rollback pins go red against a lying batch", () => {
  it("a batch that applies without a transaction leaves the buffered DDL in place", async () => {
    const d1 = new LyingD1Database();
    createFrameworkStubs(d1);
    d1.sqlite.exec(
      `CREATE TABLE agent_price_catalogue (id TEXT PRIMARY KEY)`,
    );
    const plan = resolveRecreatePlan();
    const first = stepByCode(
      plan,
      "schema.d1.agent_referral_rules.create_table",
    );
    const failing = stepByCode(plan, REBUILD_CREATE_CODE);
    const report = await executeD1Leg(
      d1 as any,
      buildCombinedCatalogue(),
      [first, failing],
    );
    expect(report.outcome).toBe("failed");
    // Against the honest batch this table does not exist (the pin
    // above). Against the lying one the buffered creation survives
    // — which is exactly what makes the real rollback pin a proof
    // and not a tautology.
    expect(tableExists(d1, "agent_referral_rules")).toBe(true);
  });

  it("the cannot-honour error is a typed catalog error, never a bare string", () => {
    const err = new DataFoundationError(DataFoundationCode.TX_CANNOT_HONOUR);
    expect(err.code).toBe("DATA_TX_CANNOT_HONOUR");
    expect(err.toJSON().code).toBe("DATA_TX_CANNOT_HONOUR");
  });
});
