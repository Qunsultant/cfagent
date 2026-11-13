/**
 * #4282 P0 — executor: the ONLY path that executes catalogue SQL.
 *
 * Enforcement point (decided in this phase): executeStatement refuses
 * any code that is not registered in the catalogue, and there is no
 * raw-SQL entry point in this component. A statement without a code
 * cannot execute, because there is no function to hand it to. P4's
 * red-team pin exercises this (unknown code, tampered catalogue,
 * bypass attempt); the behavioural proof lives in
 * tests/schema_component_executor.test.ts.
 *
 * Every execution runs through withAspects with the catalogue code as
 * the operationName, so the structured log carries the code on every
 * statement. Failures are typed (SchemaComponentError) and honestly
 * reported: executeCatalogue either stops at the first failure with
 * the partial report attached, or — when asked — continues and returns
 * the partial report. Nothing is ever silently partial.
 *
 * Atomicity note (NOT claimed here): multi-statement atomicity via
 * transactionAspect is P4's proof — the aspect has no production
 * consumer yet, and the recreate is its first. This executor reports
 * exactly which statements completed and which failed; it does not
 * pretend a partial run was atomic.
 */
import { withAspects } from "../../aspects/loggingAspect";
import type { SchemaCatalogue } from "./catalogue";
import {
  createSchemaError,
  SchemaComponentError,
  SchemaErrorCode,
} from "./schemaErrors";

export interface SqlExecutor {
  exec(sql: string): Promise<void> | void;
}

export interface StatementResult {
  code: string;
  table: string;
  executed: boolean;
  durationMs: number;
  sql: string;
}

export interface StatementFailure {
  code: string;
  error: string;
}

export interface ExecutionReport {
  results: StatementResult[];
  failures: StatementFailure[];
  completed: number;
  failed: number;
}

export type ExecutionAudit = (
  event: string,
  category: string,
  payload: Record<string, unknown>,
) => void;

const PLACEHOLDER = /\$\{([A-Za-z0-9_]+)\}/g;

/** Resolve a parameterized statement from the caller's parameters. */
export function resolveStatementText(
  entry: { statement: string; form: string; parameters?: string[] },
  params: Record<string, string> = {},
): string {
  if (entry.form === "literal") return entry.statement;
  return entry.statement.replace(PLACEHOLDER, (_match, name: string) => {
    const value = params[name];
    if (value === undefined) {
      throw createSchemaError(
        SchemaErrorCode.MISSING_PARAMETER,
        `parameter "${name}" is required to execute this statement`,
      );
    }
    return value;
  });
}

export async function executeStatement(
  catalogue: SchemaCatalogue,
  code: string,
  executor: SqlExecutor,
  params: Record<string, string> = {},
  audit?: ExecutionAudit,
): Promise<StatementResult> {
  const entry = catalogue.get(code);
  const sql = resolveStatementText(entry, params);
  const start = performance.now();
  try {
    await withAspects(
      { operationName: code, audit },
      () => executor.exec(sql),
    );
  } catch (err) {
    if (err instanceof SchemaComponentError) throw err;
    const cause = err instanceof Error ? err.message : String(err);
    throw createSchemaError(
      SchemaErrorCode.EXECUTION_FAILED,
      `code ${code}: ${cause}`,
    );
  }
  return {
    code,
    table: entry.table,
    executed: true,
    durationMs: Math.round(performance.now() - start),
    sql,
  };
}

export interface ExecuteCatalogueOptions {
  /** "stop" (default) throws at the first failure with the partial report attached; "continue" returns it. */
  onError?: "stop" | "continue";
  paramsByCode?: Record<string, Record<string, string>>;
  audit?: ExecutionAudit;
}

export async function executeCatalogue(
  catalogue: SchemaCatalogue,
  executor: SqlExecutor,
  options: ExecuteCatalogueOptions = {},
): Promise<ExecutionReport> {
  const onError = options.onError ?? "stop";
  const results: StatementResult[] = [];
  const failures: StatementFailure[] = [];
  for (const entry of catalogue.entries()) {
    try {
      const result = await executeStatement(
        catalogue,
        entry.code,
        executor,
        options.paramsByCode?.[entry.code] ?? {},
        options.audit,
      );
      results.push(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failures.push({ code: entry.code, error: message });
      if (onError === "stop") {
        const report: ExecutionReport = {
          results,
          failures,
          completed: results.length,
          failed: failures.length,
        };
        throw createSchemaError(
          SchemaErrorCode.EXECUTION_FAILED,
          `stopped at ${entry.code} after ${results.length} completed statement(s)`,
          report,
        );
      }
    }
  }
  return {
    results,
    failures,
    completed: results.length,
    failed: failures.length,
  };
}
