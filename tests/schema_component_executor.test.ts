/**
 * #4282 P0 — executor: AOP-logged statement execution, fail-closed.
 *
 * Enforcement point (decided in this phase, per the P0 body): the
 * executor IS the only path that executes catalogue SQL, and it refuses
 * any code that is not registered. There is no raw-SQL entry point in
 * this component — a statement without a code cannot execute, because
 * there is no function to hand it to. P4's red-team pin exercises this
 * (unknown code, tampered catalogue, bypass attempt); the behavioural
 * proof lives here.
 *
 * AOP-log presence: withAspects logs through the module-level structured
 * logger, whose unbound sink is the console sink (createObservabilitySink
 * with no OBSERVABILITY binding writes JSON to console.info). The test
 * spies on console.info and parses the JSON lines — the catalogue code
 * must appear as fields.operationName on the aspect.completed event.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCatalogue } from "../src/data/schemaComponent/catalogue";
import {
  executeCatalogue,
  executeStatement,
  resolveStatementText,
  type SqlExecutor,
} from "../src/data/schemaComponent/executor";
import {
  SchemaComponentError,
  SchemaErrorCode,
} from "../src/data/schemaComponent/schemaErrors";
import {
  INDEX_ENTRY,
  PARAMETERIZED_ENTRY,
  SEED_ENTRY,
  TABLE_ENTRY,
} from "./schema_component_fixtures";

function capturingExecutor(): {
  executor: SqlExecutor;
  executed: string[];
} {
  const executed: string[] = [];
  return {
    executed,
    executor: {
      exec: (sql: string) => {
        executed.push(sql);
      },
    },
  };
}

function failingExecutor(failOnSubstring: string): {
  executor: SqlExecutor;
  executed: string[];
} {
  const executed: string[] = [];
  return {
    executed,
    executor: {
      exec: (sql: string) => {
        executed.push(sql);
        if (sql.includes(failOnSubstring)) {
          throw new Error(`synthetic executor failure on ${failOnSubstring}`);
        }
      },
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveStatementText (#4282 P0)", () => {
  it("returns a literal statement unchanged", () => {
    expect(resolveStatementText(TABLE_ENTRY)).toBe(TABLE_ENTRY.statement);
  });

  it("substitutes declared parameters in a parameterized statement", () => {
    expect(
      resolveStatementText(PARAMETERIZED_ENTRY, {
        TABLE: "schema_probe_reports",
      }),
    ).toBe(
      "CREATE TABLE IF NOT EXISTS schema_probe_reports (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
    );
  });

  it("throws SCHEMA_MISSING_PARAMETER when a declared parameter is absent", () => {
    expect(() => resolveStatementText(PARAMETERIZED_ENTRY, {})).toThrowError(
      SchemaComponentError,
    );
    try {
      resolveStatementText(PARAMETERIZED_ENTRY, {});
    } catch (err) {
      expect((err as SchemaComponentError).code).toBe(
        SchemaErrorCode.MISSING_PARAMETER,
      );
      expect((err as SchemaComponentError).message).toMatch(/TABLE/);
    }
  });
});

describe("executeStatement (#4282 P0)", () => {
  it("executes the resolved SQL and reports code, table, and duration", async () => {
    const catalogue = createCatalogue();
    catalogue.register(TABLE_ENTRY);
    const { executor, executed } = capturingExecutor();
    const result = await executeStatement(
      catalogue,
      TABLE_ENTRY.code,
      executor,
    );
    expect(executed).toEqual([TABLE_ENTRY.statement]);
    expect(result.code).toBe(TABLE_ENTRY.code);
    expect(result.table).toBe("schema_probe_widgets");
    expect(result.executed).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.sql).toBe(TABLE_ENTRY.statement);
  });

  it("executes a parameterized entry with the caller's parameters", async () => {
    const catalogue = createCatalogue();
    catalogue.register(PARAMETERIZED_ENTRY);
    const { executor, executed } = capturingExecutor();
    await executeStatement(catalogue, PARAMETERIZED_ENTRY.code, executor, {
      TABLE: "schema_probe_reports",
    });
    expect(executed).toEqual([
      "CREATE TABLE IF NOT EXISTS schema_probe_reports (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
    ]);
  });

  it("rejects an unregistered code — an uncoded statement cannot execute", async () => {
    const catalogue = createCatalogue();
    catalogue.register(TABLE_ENTRY);
    const { executor, executed } = capturingExecutor();
    // Single run: the assertion and the code check share one execution,
    // so the executed-statements list is not double-counted.
    const error = await executeStatement(
      catalogue,
      "schema.do.nope.create_table",
      executor,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SchemaComponentError);
    expect((error as SchemaComponentError).code).toBe(
      SchemaErrorCode.UNKNOWN_CODE,
    );
    expect(executed).toEqual([]);
  });

  it("carries the catalogue code as the withAspects operationName in the structured log", async () => {
    const catalogue = createCatalogue();
    catalogue.register(TABLE_ENTRY);
    const { executor } = capturingExecutor();
    // withAspects runs the executor synchronously inside the aspect;
    // capture the console.info lines emitted by the call.
    const lines: Record<string, unknown>[] = [];
    const spy = vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      for (const arg of args) {
        if (typeof arg !== "string") continue;
        try {
          const parsed = JSON.parse(arg) as Record<string, unknown>;
          if (parsed.type === "aspect.completed") lines.push(parsed);
        } catch {
          // Not a structured-log JSON line — ignore.
        }
      }
    });
    try {
      await executeStatement(catalogue, TABLE_ENTRY.code, executor);
    } finally {
      spy.mockRestore();
    }
    const forCode = lines.filter(
      (line) =>
        (line.fields as Record<string, unknown> | undefined)
          ?.operationName === TABLE_ENTRY.code,
    );
    expect(forCode.length).toBeGreaterThanOrEqual(1);
    expect(
      (forCode[0].fields as Record<string, unknown>).message as string,
    ).toContain(`[Aspect][${TABLE_ENTRY.code}]`);
  });

  it("wraps an executor failure as SCHEMA_EXECUTION_FAILED, never silently partial", async () => {
    const catalogue = createCatalogue();
    catalogue.register(TABLE_ENTRY);
    const { executor } = failingExecutor("schema_probe_widgets");
    const error = await executeStatement(
      catalogue,
      TABLE_ENTRY.code,
      executor,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SchemaComponentError);
    const typed = error as SchemaComponentError;
    expect(typed.code).toBe(SchemaErrorCode.EXECUTION_FAILED);
    expect(typed.message).toMatch(/schema_probe_widgets/);
  });
});

describe("executeCatalogue (#4282 P0)", () => {
  function threeEntryCatalogue() {
    const catalogue = createCatalogue();
    catalogue.register(TABLE_ENTRY);
    catalogue.register(INDEX_ENTRY);
    catalogue.register(SEED_ENTRY);
    return catalogue;
  }

  it("executes every entry in registration order and reports all completed", async () => {
    const { executor, executed } = capturingExecutor();
    const report = await executeCatalogue(threeEntryCatalogue(), executor);
    expect(report.completed).toBe(3);
    expect(report.failed).toBe(0);
    expect(report.failures).toEqual([]);
    expect(report.results.map((r) => r.code)).toEqual([
      TABLE_ENTRY.code,
      INDEX_ENTRY.code,
      SEED_ENTRY.code,
    ]);
    expect(executed).toHaveLength(3);
  });

  it("stops at the first failure by default and reports exactly what completed", async () => {
    const { executor, executed } = failingExecutor("schema_probe_widgets_label_idx");
    // Single run: the assertion and the partial-report check share one
    // execution, so the executed-statements list is not double-counted.
    const error = await executeCatalogue(
      threeEntryCatalogue(),
      executor,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(SchemaComponentError);
    const typed = error as SchemaComponentError;
    expect(typed.code).toBe(SchemaErrorCode.EXECUTION_FAILED);
    const partial = typed.details as {
      completed: number;
      failed: number;
      failures: { code: string }[];
    };
    expect(partial.completed).toBe(1);
    expect(partial.failed).toBe(1);
    expect(partial.failures[0].code).toBe(INDEX_ENTRY.code);
    // The seed entry after the failure never ran.
    expect(executed).toHaveLength(2);
  });

  it("continues past a failure when asked and reports the honest partial result", async () => {
    const { executor, executed } = failingExecutor("schema_probe_widgets_label_idx");
    const report = await executeCatalogue(threeEntryCatalogue(), executor, {
      onError: "continue",
    });
    expect(report.completed).toBe(2);
    expect(report.failed).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].code).toBe(INDEX_ENTRY.code);
    expect(report.failures[0].error).toMatch(/synthetic executor failure/);
    expect(executed).toHaveLength(3);
  });

  it("executes an empty catalogue as a zero-statement report, not an error", async () => {
    const { executor } = capturingExecutor();
    const report = await executeCatalogue(createCatalogue(), executor);
    expect(report.completed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.results).toEqual([]);
  });
});
