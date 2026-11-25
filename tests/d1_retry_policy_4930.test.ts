/**
 * Issue #4930 — D1 retry/timeout policy: one shared helper at the D1
 * adapter boundary.
 *
 * Coverage: the error classification (allowlist — an unrecognized error
 * is never retried), the recorded budgets, the retry loop (recovery,
 * exhaustion with the coded error, non-retryable passthrough, the
 * ambiguous/idempotent gate), the DML executor wiring (fault injection
 * at the catalogue level), the catalogue retry census pin (the audited
 * `idempotent` flags), the composition with the transaction aspect's
 * D1 batch unit (a retry re-runs the WHOLE unit, never resumes
 * mid-unit), and the structured-log telemetry.
 *
 * Fault injection uses a recording sleep (no real waiting) everywhere
 * except the executor-wiring tests, where the executor applies the
 * module default with real timers (at most 100ms + 200ms per test).
 * The D1 batch double is the proof test's shape
 * (`tests/transaction_proof_2288.test.ts`): node:sqlite in-memory
 * with a batch() that applies all-or-nothing.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SQL } from "drizzle-orm";
import {
  classifyD1Error,
  delayForAttempt,
  resolveD1RetryPolicy,
  withD1Retry,
  DEFAULT_D1_RETRY_POLICY,
  type D1RetryPolicy,
} from "../src/data/d1RetryPolicy";
import { DML_CATALOGUE_ENTRIES } from "../src/data/schemaComponent/dmlEntries";
import {
  createDmlCatalogue,
  validateDmlEntry,
  type DmlCatalogueEntry,
} from "../src/data/schemaComponent/dmlCatalogue";
import {
  executeDml,
  executeDmlSql,
} from "../src/data/schemaComponent/dmlExecutor";
import {
  createSchemaError,
  SchemaComponentError,
  SchemaErrorCode,
} from "../src/data/schemaComponent/schemaErrors";
import {
  d1BatchTransactionBackend,
  withTransaction,
} from "../src/aspects/transactionAspect";

afterEach(() => {
  vi.restoreAllMocks();
});

/** A recording sleep: no real waiting, the delays are asserted. */
function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms: number): Promise<void> => {
      delays.push(ms);
    },
  };
}

const BUSY = new Error("SQLITE_BUSY: database is locked");
const LOCKED = new Error("database is locked");
const TIMEOUT = new Error("ETIMEDOUT: connection timed out");
const FULL = new Error("SQLITE_FULL: database or disk is full");
const NO_TABLE = new Error("no such table: proof_items: SQLITE_ERROR");
const GENERIC = new Error("boom");

describe("classifyD1Error (#4930)", () => {
  it("classifies lock contention as retryable AND did-not-run", () => {
    expect(classifyD1Error(BUSY)).toEqual({
      retryable: true,
      didNotRun: true,
      reason: "sqlite_busy",
    });
    expect(classifyD1Error(LOCKED).didNotRun).toBe(true);
    expect(classifyD1Error(new Error("SQLITE_LOCKED")).didNotRun).toBe(true);
  });

  it("classifies timeouts and transport failures as retryable but ambiguous", () => {
    for (const err of [
      TIMEOUT,
      new Error("request timed out"),
      new Error("ECONNRESET"),
      new Error("EAI_AGAIN"),
      new Error("fetch failed"),
      new Error("network connection lost"),
      new Error("socket hang up"),
    ]) {
      const c = classifyD1Error(err);
      expect(c.retryable).toBe(true);
      expect(c.didNotRun).toBe(false);
    }
  });

  it("never retries disk-full, schema, constraint, syntax, or generic errors", () => {
    for (const err of [
      FULL,
      NO_TABLE,
      new Error("UNIQUE constraint failed: proof_items.id"),
      new Error('near "FROM": syntax error'),
      GENERIC,
      "a bare string failure",
    ]) {
      expect(classifyD1Error(err).retryable).toBe(false);
    }
  });

  it("never retries an already-coded error — even one quoting a transient cause", () => {
    const wrapped = createSchemaError(
      SchemaErrorCode.EXECUTION_FAILED,
      "code dml.d1.x.y: database is locked",
    );
    expect(classifyD1Error(wrapped).retryable).toBe(false);
    expect(
      classifyD1Error(
        createSchemaError(SchemaErrorCode.RETRY_EXHAUSTED, "exhausted"),
      ).retryable,
    ).toBe(false);
  });

  it("does not match a bare D1_ERROR prefix (it prefixes SQL errors too)", () => {
    expect(
      classifyD1Error(new Error("D1_ERROR: no such table: proof_items"))
        .retryable,
    ).toBe(false);
  });
});

describe("delayForAttempt (#4930)", () => {
  it("doubles from the base and caps at maxDelayMs", () => {
    expect(delayForAttempt(0, DEFAULT_D1_RETRY_POLICY)).toBe(100);
    expect(delayForAttempt(1, DEFAULT_D1_RETRY_POLICY)).toBe(200);
    expect(delayForAttempt(2, DEFAULT_D1_RETRY_POLICY)).toBe(400);
    const capped: D1RetryPolicy = {
      maxAttempts: 5,
      baseDelayMs: 100,
      maxDelayMs: 250,
      jitterRatio: 0,
    };
    expect(delayForAttempt(2, capped)).toBe(250);
  });

  it("applies symmetric jitter from the injected random source", () => {
    const jittered: D1RetryPolicy = {
      maxAttempts: 3,
      baseDelayMs: 100,
      maxDelayMs: 1000,
      jitterRatio: 0.5,
    };
    expect(delayForAttempt(0, jittered, () => 1)).toBe(150);
    expect(delayForAttempt(0, jittered, () => 0)).toBe(50);
  });
});

describe("resolveD1RetryPolicy (#4930)", () => {
  it("returns the recorded defaults with no overrides", () => {
    expect(resolveD1RetryPolicy()).toEqual(DEFAULT_D1_RETRY_POLICY);
  });

  it("takes attempts and delays from env, and settings win over env", () => {
    expect(
      resolveD1RetryPolicy({ D1_RETRY_ATTEMPTS: "2" }),
    ).toMatchObject({ maxAttempts: 2 });
    expect(
      resolveD1RetryPolicy(
        { D1_RETRY_ATTEMPTS: "2", D1_RETRY_BASE_DELAY_MS: "50" },
        { "d1.retry.attempts": "4" },
      ),
    ).toMatchObject({ maxAttempts: 4, baseDelayMs: 50 });
  });

  it("clamps out-of-range budgets instead of throwing", () => {
    expect(
      resolveD1RetryPolicy({ D1_RETRY_ATTEMPTS: "0" }),
    ).toMatchObject({ maxAttempts: 1 });
    expect(
      resolveD1RetryPolicy({ D1_RETRY_ATTEMPTS: "99" }),
    ).toMatchObject({ maxAttempts: 10 });
    expect(
      resolveD1RetryPolicy({
        D1_RETRY_BASE_DELAY_MS: "500",
        D1_RETRY_MAX_DELAY_MS: "100",
      }),
    ).toMatchObject({ baseDelayMs: 500, maxDelayMs: 500 });
  });
});

describe("withD1Retry — recovery and exhaustion (#4930)", () => {
  it("recovers after transient failures: value, 3 calls, delays 100 then 200", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const result = await withD1Retry(
      async () => {
        calls += 1;
        if (calls < 3) throw BUSY;
        return "ok";
      },
      { operationName: "proof.retry.recover", idempotent: false, sleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("exhausts with the coded SCHEMA_RETRY_EXHAUSTED error and the attempt count", async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const error = await withD1Retry(
      async () => {
        calls += 1;
        throw BUSY;
      },
      { operationName: "proof.retry.exhaust", idempotent: false, sleep },
    ).catch((err: unknown) => err);
    expect(calls).toBe(3);
    expect(error).toBeInstanceOf(SchemaComponentError);
    const typed = error as SchemaComponentError;
    expect(typed.code).toBe(SchemaErrorCode.RETRY_EXHAUSTED);
    expect(typed.details).toMatchObject({
      operationName: "proof.retry.exhaust",
      attempts: 3,
    });
    expect(String((typed.details as { lastError: string }).lastError)).toContain(
      "SQLITE_BUSY",
    );
  });

  it("passes a non-retryable error through untouched, with no retry", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const error = await withD1Retry(
      async () => {
        calls += 1;
        throw FULL;
      },
      { operationName: "proof.retry.passthrough", idempotent: true, sleep },
    ).catch((err: unknown) => err);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(error).toBe(FULL);
  });

  it("does not retry an ambiguous failure on a non-idempotent operation", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const error = await withD1Retry(
      async () => {
        calls += 1;
        throw TIMEOUT;
      },
      { operationName: "proof.retry.ambiguous", idempotent: false, sleep },
    ).catch((err: unknown) => err);
    expect(calls).toBe(1);
    expect(delays).toEqual([]);
    expect(error).toBe(TIMEOUT);
  });

  it("retries an ambiguous failure on an idempotent operation", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const result = await withD1Retry(
      async () => {
        calls += 1;
        if (calls < 3) throw TIMEOUT;
        return "ok";
      },
      { operationName: "proof.retry.ambiguous-ok", idempotent: true, sleep },
    );
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(delays).toEqual([100, 200]);
  });

  it("honours a caller-supplied policy (maxAttempts 2)", async () => {
    const { sleep } = recordingSleep();
    let calls = 0;
    const error = await withD1Retry(
      async () => {
        calls += 1;
        throw BUSY;
      },
      {
        operationName: "proof.retry.policy",
        idempotent: true,
        policy: { ...DEFAULT_D1_RETRY_POLICY, maxAttempts: 2 },
        sleep,
      },
    ).catch((err: unknown) => err);
    expect(calls).toBe(2);
    expect((error as SchemaComponentError).code).toBe(
      SchemaErrorCode.RETRY_EXHAUSTED,
    );
  });
});

describe("withD1Retry — telemetry (#4930)", () => {
  /** Collect the structured-log JSON lines from every console stream. */
  function captureStructuredLog() {
    const lines: Record<string, unknown>[] = [];
    const collect = (...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== "string") continue;
        try {
          lines.push(JSON.parse(arg) as Record<string, unknown>);
        } catch {
          // Not a structured-log JSON line — ignore.
        }
      }
    };
    const spies = [
      vi.spyOn(console, "info").mockImplementation(collect),
      vi.spyOn(console, "warn").mockImplementation(collect),
      vi.spyOn(console, "error").mockImplementation(collect),
    ];
    return {
      lines,
      restore: () => spies.forEach((s) => s.mockRestore()),
    };
  }

  it("emits d1_retry.attempt per retry and d1_retry.recovered on success", async () => {
    const cap = captureStructuredLog();
    const { sleep } = recordingSleep();
    try {
      let calls = 0;
      await withD1Retry(
        async () => {
          calls += 1;
          if (calls < 2) throw BUSY;
          return "ok";
        },
        { operationName: "proof.retry.telemetry", idempotent: true, sleep },
      );
    } finally {
      cap.restore();
    }
    const attempts = cap.lines.filter((l) => l.type === "d1_retry.attempt");
    expect(attempts).toHaveLength(1);
    expect(
      (attempts[0].fields as Record<string, unknown>).operationName,
    ).toBe("proof.retry.telemetry");
    expect((attempts[0].fields as Record<string, unknown>).willRetry).toBe(
      true,
    );
    const recovered = cap.lines.filter((l) => l.type === "d1_retry.recovered");
    expect(recovered).toHaveLength(1);
    expect(
      (recovered[0].fields as Record<string, unknown>).operationName,
    ).toBe("proof.retry.telemetry");
  });

  it("emits d1_retry.exhausted with the attempt count", async () => {
    const cap = captureStructuredLog();
    const { sleep } = recordingSleep();
    try {
      await withD1Retry(
        async () => {
          throw BUSY;
        },
        { operationName: "proof.retry.telemetry-exhaust", idempotent: true, sleep },
      ).catch(() => undefined);
    } finally {
      cap.restore();
    }
    const exhausted = cap.lines.filter(
      (l) => l.type === "d1_retry.exhausted",
    );
    expect(exhausted).toHaveLength(1);
    expect(
      (exhausted[0].fields as Record<string, unknown>).attempts,
    ).toBe(3);
  });
});

describe("DML executor retry wiring (#4930)", () => {
  function flakyEntry(
    code: string,
    operation: "read" | "insert" | "upsert",
    failures: Error[],
    value: unknown,
  ): { entry: DmlCatalogueEntry; calls: () => number } {
    let calls = 0;
    const entry: DmlCatalogueEntry = {
      code,
      table: "proof_items",
      operation,
      form: "builder",
      run: async () => {
        calls += 1;
        const failure = failures[calls - 1];
        if (failure) throw failure;
        return value;
      },
    };
    return { entry, calls: () => calls };
  }

  it("retries a read on a did-not-run error through the real executor", async () => {
    const catalogue = createDmlCatalogue();
    const { entry, calls } = flakyEntry(
      "dml.d1.proof_items.read_retry",
      "read",
      [BUSY, BUSY],
      [{ id: "a" }],
    );
    catalogue.register(entry);
    const rows = await executeDml(catalogue, {} as never, entry.code, {});
    expect(rows).toEqual([{ id: "a" }]);
    expect(calls()).toBe(3);
  });

  it("retries an upsert on an ambiguous error (safe by construction)", async () => {
    const catalogue = createDmlCatalogue();
    const { entry, calls } = flakyEntry(
      "dml.d1.proof_items.upsert_retry",
      "upsert",
      [TIMEOUT],
      { ok: true },
    );
    catalogue.register(entry);
    await executeDml(catalogue, {} as never, entry.code, {});
    expect(calls()).toBe(2);
  });

  it("retries a plain insert on a did-not-run error — the statement never ran", async () => {
    const catalogue = createDmlCatalogue();
    const { entry, calls } = flakyEntry(
      "dml.d1.proof_items.insert_busy",
      "insert",
      [BUSY],
      { ok: true },
    );
    catalogue.register(entry);
    await executeDml(catalogue, {} as never, entry.code, {});
    expect(calls()).toBe(2);
  });

  it("does NOT retry a plain insert on an ambiguous error — fails fast, still wrapped as EXECUTION_FAILED", async () => {
    const catalogue = createDmlCatalogue();
    const { entry, calls } = flakyEntry(
      "dml.d1.proof_items.insert_timeout",
      "insert",
      [TIMEOUT],
      { ok: true },
    );
    catalogue.register(entry);
    const error = await executeDml(catalogue, {} as never, entry.code, {}).catch(
      (err: unknown) => err,
    );
    expect(calls()).toBe(1);
    expect(error).toBeInstanceOf(SchemaComponentError);
    expect((error as SchemaComponentError).code).toBe(
      SchemaErrorCode.EXECUTION_FAILED,
    );
    expect((error as Error).message).toContain("ETIMEDOUT");
  });

  it("retries a flagged delete on an ambiguous error (delete by key)", async () => {
    const catalogue = createDmlCatalogue();
    const { entry, calls } = flakyEntry(
      "dml.d1.proof_items.delete_flagged",
      "delete",
      [TIMEOUT],
      { ok: true },
    );
    catalogue.register({ ...entry, idempotent: true });
    await executeDml(catalogue, {} as never, entry.code, {});
    expect(calls()).toBe(2);
  });

  it("retries a build-form read through executeDmlSql", async () => {
    const catalogue = createDmlCatalogue();
    let allCalls = 0;
    const entry: DmlCatalogueEntry = {
      code: "dml.d1.proof_items.find_many",
      table: "proof_items",
      operation: "read",
      form: "build",
      mode: "all",
      build: () => ({}) as unknown as SQL,
    };
    catalogue.register(entry);
    const db = {
      all: async () => {
        allCalls += 1;
        if (allCalls < 2) throw BUSY;
        return [{ id: "a" }];
      },
      run: async () => ({ success: true }),
    };
    const rows = await executeDmlSql(catalogue, db as never, entry.code, {});
    expect(rows).toEqual([{ id: "a" }]);
    expect(allCalls).toBe(2);
  });
});

describe("DML catalogue retry census pin (#4930)", () => {
  /** The audited `idempotent: true` set — delete by key, pure-assignment update. */
  const FLAGGED_CODES = [
    "dml.d1.mas_feed_datasets.prune_delete",
    "dml.d1.mas_index_lists.prune_delete",
    "dml.d1.agent_categories.delete",
    "dml.d1.agent_categories.update",
    "dml.d1.agent_external_ads.delete",
    "dml.d1.agent_external_ads.update",
    "dml.d1.agent_ads.delete",
    "dml.d1.agent_ads.update",
    "dml.d1.agent_referrals.delete",
    "dml.d1.agent_referrals.update",
  ];

  function isFullyRetryable(entry: DmlCatalogueEntry): boolean {
    return (
      entry.operation === "read" ||
      entry.operation === "upsert" ||
      entry.idempotent === true
    );
  }

  it("the catalogue holds 67 entries: 57 executed, 10 fragments", () => {
    expect(DML_CATALOGUE_ENTRIES).toHaveLength(67);
    const executed = DML_CATALOGUE_ENTRIES.filter(
      (e) => e.form === "builder" || e.form === "build",
    );
    const fragments = DML_CATALOGUE_ENTRIES.filter(
      (e) => e.form === "fragment",
    );
    expect(executed).toHaveLength(57);
    expect(fragments).toHaveLength(10);
  });

  it("executed entries split read 26 / upsert 4 / insert 11 / update 10 / delete 6", () => {
    const executed = DML_CATALOGUE_ENTRIES.filter(
      (e) => e.form === "builder" || e.form === "build",
    );
    const byOp = (op: string) =>
      executed.filter((e) => e.operation === op).length;
    expect(byOp("read")).toBe(26);
    expect(byOp("upsert")).toBe(4);
    expect(byOp("insert")).toBe(11);
    expect(byOp("update")).toBe(10);
    expect(byOp("delete")).toBe(6);
  });

  it("40 executed entries are fully retryable; 17 are did-not-run-only", () => {
    const executed = DML_CATALOGUE_ENTRIES.filter(
      (e) => e.form === "builder" || e.form === "build",
    );
    const fully = executed.filter(isFullyRetryable);
    const didNotRunOnly = executed.filter((e) => !isFullyRetryable(e));
    expect(fully).toHaveLength(40);
    expect(didNotRunOnly).toHaveLength(17);
    // The did-not-run-only set is exactly the plain inserts plus the
    // non-idempotent updates (batch transition + counter increments).
    expect(
      didNotRunOnly.map((e) => `${e.operation}:${e.code}`).sort(),
    ).toEqual(
      [
        "insert:dml.d1.agent_ads.create",
        "insert:dml.d1.agent_bundle_purchases.record_purchase",
        "insert:dml.d1.agent_categories.create",
        "insert:dml.d1.agent_external_ads.create",
        "insert:dml.d1.agent_proposals.propose",
        "insert:dml.d1.agent_referrals.create",
        "insert:dml.d1.agent_user_profiles.save_once",
        "insert:dml.d1.mas_events.insert_chained",
        "insert:dml.d1.mas_feed_datasets.insert",
        "insert:dml.d1.mas_index_lists.insert",
        "insert:dml.d1.resource_sql_ops.insert",
        "update:dml.d1.agent_ads.increment_all_impressions",
        "update:dml.d1.agent_ads.increment_counter",
        "update:dml.d1.agent_categories.increment_counter",
        "update:dml.d1.agent_external_ads.increment_counter",
        "update:dml.d1.agent_proposals.transition",
        "update:dml.d1.agent_referrals.increment_counter",
      ].sort(),
    );
  });

  it("the flagged set is exactly the audited ten, all delete or update", () => {
    const flagged = DML_CATALOGUE_ENTRIES.filter(
      (e) => e.idempotent === true,
    ).map((e) => e.code);
    expect(flagged.sort()).toEqual([...FLAGGED_CODES].sort());
    for (const entry of DML_CATALOGUE_ENTRIES.filter(
      (e) => e.idempotent === true,
    )) {
      expect(["delete", "update"]).toContain(entry.operation);
    }
  });

  it("no fragment entry carries the flag (fragments are never executed)", () => {
    for (const entry of DML_CATALOGUE_ENTRIES.filter(
      (e) => e.form === "fragment",
    )) {
      expect(entry.idempotent).toBeUndefined();
    }
  });

  it("no counter-increment entry is flagged (col = col + delta double-counts)", () => {
    for (const entry of DML_CATALOGUE_ENTRIES.filter((e) =>
      e.code.includes("increment"),
    )) {
      expect(entry.idempotent).not.toBe(true);
    }
  });

  it("validation rejects a non-boolean idempotent declaration", () => {
    const entry = {
      ...DML_CATALOGUE_ENTRIES[0],
      idempotent: "yes",
    } as unknown as DmlCatalogueEntry;
    expect(validateDmlEntry(entry).valid).toBe(false);
  });
});

/**
 * D1 double over node:sqlite, in the proof test's shape
 * (`tests/transaction_proof_2288.test.ts`): batch() applies
 * all-or-nothing inside one SQLite transaction.
 */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  batchCalls = 0;
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as never[]));
            return {
              success: true,
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
              results: [],
            };
          },
        };
      },
    };
  }
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    this.batchCalls += 1;
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        await stmt.run();
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return [];
  }
}

/** A D1 double whose batch() fails once, then behaves. */
class FlakyBatchD1 extends MockD1Database {
  constructor(
    private readonly failure: Error,
    private readonly failCount = 1,
  ) {
    super();
  }
  override async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    if (this.batchCalls < this.failCount) {
      // Count the failed attempt exactly like a real batch call: the
      // unit re-runs from scratch, so the next batch is attempt two.
      this.batchCalls += 1;
      throw this.failure;
    }
    return super.batch(statements);
  }
}

function d1Rows(d1: MockD1Database, table: string): unknown[] {
  return d1.sqlite.prepare(`SELECT * FROM ${table}`).all() as unknown[];
}

describe("withD1Retry × withTransaction composition (#4930)", () => {
  function makeD1() {
    const d1 = new MockD1Database();
    d1.sqlite.exec(
      "CREATE TABLE proof_items (id TEXT PRIMARY KEY, note TEXT NOT NULL)",
    );
    return d1;
  }

  it("a retry re-runs the WHOLE unit: batch fails once with SQLITE_BUSY, rows land exactly once", async () => {
    const d1 = new FlakyBatchD1(BUSY, 1);
    d1.sqlite.exec(
      "CREATE TABLE proof_items (id TEXT PRIMARY KEY, note TEXT NOT NULL)",
    );
    const backend = d1BatchTransactionBackend(d1 as never);
    const { sleep } = recordingSleep();
    let unitRuns = 0;
    await withD1Retry(
      () =>
        withTransaction(
          backend,
          { operationName: "proof.retry.unit" },
          (unit) => {
            unitRuns += 1;
            unit.exec(
              "INSERT INTO proof_items (id, note) VALUES (?, ?)",
              "a",
              "first",
            );
            unit.exec(
              "INSERT INTO proof_items (id, note) VALUES (?, ?)",
              "b",
              "second",
            );
          },
        ),
      { operationName: "proof.retry.unit", idempotent: true, sleep },
    );
    // The unit ran twice (once per attempt); the batch applied once.
    expect(unitRuns).toBe(2);
    expect(d1.batchCalls).toBe(2);
    expect(d1Rows(d1, "proof_items")).toHaveLength(2);
  });

  it("a non-retryable error inside the unit never retries: batch is never called", async () => {
    const d1 = makeD1();
    const backend = d1BatchTransactionBackend(d1 as never);
    const { sleep } = recordingSleep();
    let unitRuns = 0;
    const error = await withD1Retry(
      () =>
        withTransaction(
          backend,
          { operationName: "proof.retry.unit-fail" },
          () => {
            unitRuns += 1;
            throw NO_TABLE;
          },
        ),
      { operationName: "proof.retry.unit-fail", idempotent: true, sleep },
    ).catch((err: unknown) => err);
    expect(error).toBe(NO_TABLE);
    expect(unitRuns).toBe(1);
    expect(d1.batchCalls).toBe(0);
    expect(d1Rows(d1, "proof_items")).toHaveLength(0);
  });

  it("an ambiguous batch failure on a non-idempotent unit fails fast — no second batch", async () => {
    const d1 = new FlakyBatchD1(TIMEOUT, 1);
    d1.sqlite.exec(
      "CREATE TABLE proof_items (id TEXT PRIMARY KEY, note TEXT NOT NULL)",
    );
    const backend = d1BatchTransactionBackend(d1 as never);
    const { sleep } = recordingSleep();
    let unitRuns = 0;
    const error = await withD1Retry(
      () =>
        withTransaction(
          backend,
          { operationName: "proof.retry.unit-ambiguous" },
          (unit) => {
            unitRuns += 1;
            unit.exec(
              "INSERT INTO proof_items (id, note) VALUES (?, ?)",
              "a",
              "first",
            );
          },
        ),
      {
        operationName: "proof.retry.unit-ambiguous",
        idempotent: false,
        sleep,
      },
    ).catch((err: unknown) => err);
    expect(error).toBe(TIMEOUT);
    expect(unitRuns).toBe(1);
    expect(d1.batchCalls).toBe(1);
    expect(d1Rows(d1, "proof_items")).toHaveLength(0);
  });
});
