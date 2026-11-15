/**
 * #4282 P6b (#4385) — DO DML executor: the ONLY path that executes
 * catalogue DO DML.
 *
 * Enforcement point (the DDL executor's rule, carried over):
 * executeDoDml refuses any code that is not registered in the DO
 * DML catalogue, and there is no raw-SQL entry point in this
 * component. A statement without a code cannot execute, because there
 * is no function to hand it to. The P6b pin test exercises this
 * (unknown code, duplicate registration, tampered entry).
 *
 * SYNC, by design: the DO adapters and their ports are synchronous
 * (SqlStorage.exec is sync; the discovery/run ports are sync
 * methods). Making this executor async would ripple async through
 * every port method — out of scope for this slice. withAspects
 * (aspects/loggingAspect) is async-only and cannot return a sync
 * result, so the executor logs through the SAME structured-logger
 * seam withAspects uses, emitting the SAME records — `aspect.completed`
 * on success, `aspect.unhandled_exception` on failure, each carrying
 * the catalogue code as operationName and the execution duration —
 * so log consumers see no difference between a DO DML execution and
 * any other aspect-logged execution. Only the execution itself is
 * inside the logged region: lookup, re-validation and param checks
 * are caller errors, not executions (the same boundary P6a's
 * executor draws).
 *
 * Repository entries dispatch a RepositoryPort method; template
 * entries run their statement with the params bound in declared
 * order. A template "run" returns rowsWritten when the store reports
 * it, else null — never a silent 0.
 */
import { createStructuredLogger } from "../../observability/structuredLogger";
import { createObservabilitySink } from "../../observability/createObservabilityPorts";
import { Repository } from "../ormRepositoryCore";
import type {
  RepositoryQueryOptions,
  RepositoryWhere,
  SqlStorage,
} from "../repositoryPorts";
import type {
  DoDmlCatalogue,
  DoDmlParams,
} from "./doDmlCatalogue";
import { validateDoDmlEntry } from "./doDmlCatalogue";
import {
  createSchemaError,
  SchemaComponentError,
  SchemaErrorCode,
} from "./schemaErrors";

/** The module logger — the same seam withAspects logs through. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "data/schemaComponent/doDmlExecutor",
});

/** Re-validate the resolved entry before running it (tamper guard). */
function revalidate(code: string, entry: unknown): void {
  const validation = validateDoDmlEntry(entry);
  if (!validation.valid) {
    throw createSchemaError(
      SchemaErrorCode.INVALID_ENTRY,
      `code ${code}: ${validation.reason}`,
    );
  }
}

function requireObject(params: DoDmlParams, name: string, code: string): Record<string, unknown> {
  const value = params[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw createSchemaError(
      SchemaErrorCode.INVALID_ENTRY,
      `code ${code}: param "${name}" must be an object`,
    );
  }
  return value as Record<string, unknown>;
}

function requireId(params: DoDmlParams, code: string): string {
  const value = params.id;
  if (typeof value !== "string" && typeof value !== "number") {
    throw createSchemaError(
      SchemaErrorCode.INVALID_ENTRY,
      `code ${code}: param "id" must be a string or number`,
    );
  }
  return String(value);
}

/** Dispatch a repository-form entry to its RepositoryPort method. */
function dispatchRepository(
  entry: ReturnType<DoDmlCatalogue["get"]>,
  sql: SqlStorage,
  code: string,
  params: DoDmlParams,
): unknown {
  // The Repository is a thin dispatcher over the passed storage;
  // construction is cheap and stateless, so one is built per call
  // rather than cached (a cached Repository would pin one storage).
  const repository = new Repository<Record<string, any>>(
    sql,
    entry.table,
    entry.idField ?? "id",
    entry.columnMap ?? {},
  );
  switch (entry.method) {
    case "create":
      return repository.create(requireObject(params, "record", code));
    case "createOrIgnore":
      return repository.createOrIgnore(requireObject(params, "record", code));
    case "upsert":
      return repository.upsert(requireObject(params, "record", code));
    case "update":
      return repository.update(requireId(params, code), requireObject(params, "updates", code));
    case "updateWhere":
      return repository.updateWhere(
        requireObject(params, "where", code) as RepositoryWhere,
        requireObject(params, "set", code),
      );
    case "delete":
      return repository.delete(requireId(params, code));
    case "deleteWhere":
      return repository.deleteWhere(requireObject(params, "where", code) as RepositoryWhere);
    case "findMany":
      return repository.findMany(params as RepositoryQueryOptions);
    case "findById":
      return repository.findById(requireId(params, code));
    case "findOne":
      return repository.findOne(requireObject(params, "where", code) as RepositoryWhere);
    case "count": {
      const where = params.where;
      if (where !== undefined && (typeof where !== "object" || where === null || Array.isArray(where))) {
        throw createSchemaError(
          SchemaErrorCode.INVALID_ENTRY,
          `code ${code}: param "where" must be an object`,
        );
      }
      return repository.count(where as RepositoryWhere | undefined);
    }
    default:
      throw createSchemaError(
        SchemaErrorCode.INVALID_ENTRY,
        `code ${code}: unknown repository method "${String(entry.method)}"`,
      );
  }
}

/** Run a template-form entry's statement with its params bound in declared order. */
function dispatchTemplate(
  entry: ReturnType<DoDmlCatalogue["get"]>,
  sql: SqlStorage,
  code: string,
  params: DoDmlParams,
): unknown {
  const args = (entry.params ?? []).map((name) => {
    const value = params[name];
    if (value === undefined) {
      throw createSchemaError(
        SchemaErrorCode.INVALID_ENTRY,
        `code ${code}: missing param "${name}" for template entry`,
      );
    }
    return value;
  });
  const cursor = sql.exec(entry.statement!, ...args) as Iterable<unknown> & {
    rowsWritten?: number;
  };
  if (entry.mode === "all") {
    return Array.from(cursor);
  }
  // "run": drain the cursor; rowsWritten when the store reports it,
  // else null — never a silent 0.
  Array.from(cursor);
  return typeof cursor.rowsWritten === "number" ? cursor.rowsWritten : null;
}

/**
 * Execute a DO DML catalogue entry by code. Synchronous — the DO
 * path is sync (see the module header). The result type is the
 * caller's to assert (rows for reads, rowsWritten-or-null for
 * template writes, the Repository's return for repository entries).
 */
export function executeDoDml<T = unknown>(
  catalogue: DoDmlCatalogue,
  sql: SqlStorage,
  code: string,
  params: DoDmlParams = {},
): T {
  const entry = catalogue.get(code);
  revalidate(code, entry);
  const start = performance.now();
  try {
    const result =
      entry.form === "repository"
        ? dispatchRepository(entry, sql, code, params)
        : dispatchTemplate(entry, sql, code, params);
    const durationMs = Math.round(performance.now() - start);
    structuredLog.info("aspect.completed", {
      message: `[Aspect][${code}] Completed in ${durationMs}ms`,
      operationName: code,
      durationMs,
    });
    return result as T;
  } catch (err) {
    const durationMs = Math.round(performance.now() - start);
    if (err instanceof SchemaComponentError) throw err;
    const rawMessage = err instanceof Error ? err.message : String(err);
    structuredLog.error("aspect.unhandled_exception", {
      message: `[Aspect][${code}] Unhandled exception (${durationMs}ms): ${rawMessage}`,
      operationName: code,
      error: rawMessage,
      durationMs,
    });
    throw createSchemaError(
      SchemaErrorCode.EXECUTION_FAILED,
      `code ${code}: ${rawMessage}`,
    );
  }
}
