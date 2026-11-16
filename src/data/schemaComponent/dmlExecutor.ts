/**
 * #4282 P6a (#4384) — DML executor: the ONLY path that executes
 * catalogue DML.
 *
 * Enforcement point (the DDL executor's rule, carried over):
 * executeDml / executeDmlSql refuse any code that is not registered
 * in the DML catalogue, and there is no raw-SQL entry point in this
 * component. A statement without a code cannot execute, because there
 * is no function to hand it to. The P6a pin test exercises this
 * (unknown code, duplicate registration, tampered entry).
 *
 * Every builder/build execution runs through withAspects with the
 * catalogue code as the operationName, so the structured log carries
 * the code on every statement. Failures are typed
 * (SchemaComponentError) and honestly reported.
 *
 * Fragment entries are resolved, not executed, here: dmlFragment
 * returns the fragment, and the fragment executes as part of the
 * caller's builder call — the enclosing call is either a catalogue
 * builder entry (logged) or an inline builder call (the ADR 0032
 * standard idiom, unlogged like every other inline builder call).
 * Resolving a fragment is pure assembly; logging the resolution
 * would log something that is not an execution.
 */
import { withAspects } from "../../aspects/loggingAspect";
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type {
  DmlCatalogue,
  DmlCatalogueEntry,
  DmlDb,
  DmlParams,
} from "./dmlCatalogue";
import { validateDmlEntry } from "./dmlCatalogue";
import {
  createSchemaError,
  SchemaComponentError,
  SchemaErrorCode,
} from "./schemaErrors";
import { withD1Retry } from "../d1RetryPolicy";

/** Re-validate the resolved entry before running it (tamper guard). */
function revalidate(code: string, entry: unknown): void {
  const validation = validateDmlEntry(entry);
  if (!validation.valid) {
    throw createSchemaError(
      SchemaErrorCode.INVALID_ENTRY,
      `code ${code}: ${validation.reason}`,
    );
  }
}

/**
 * #4930 — whether re-executing this entry is a no-op under redelivery
 * (ADR 0033 R-1). A read never writes; an upsert carries its ON
 * CONFLICT guard; anything else needs the audited `idempotent: true`
 * declaration on the entry. An entry that is not safe here is still
 * retried for did-not-run errors (the statement never executed), just
 * never for ambiguous ones — that half of the decision lives in the
 * retry helper, not here.
 */
function isSafeToRetryEntry(entry: DmlCatalogueEntry): boolean {
  return (
    entry.operation === "read" ||
    entry.operation === "upsert" ||
    entry.idempotent === true
  );
}

/**
 * Execute a builder-form entry: the thunk runs the operation via
 * Drizzle and its result is returned to the caller.
 *
 * The db is generic over any Drizzle D1 handle: Drizzle's schema
 * parameter is invariant (the session and transaction members
 * carry it), so a schema-open parameter cannot accept a
 * table-typed handle. The constraint admits any Drizzle D1 handle
 * — a non-Drizzle value does not satisfy it — and the single cast
 * to the open handle happens here, the one boundary (the same
 * `as unknown as` shape createD1MarketplaceDb uses).
 *
 * Callers must NOT pass an explicit result type argument: TDb is
 * inferred from the db, and an explicit T pins TDb to its default.
 * Assert the awaited result instead
 * (`(await executeDml(...)) as RowType[]`).
 */
export async function executeDml<T = unknown, TDb extends DrizzleD1Database<any> = DmlDb>(
  catalogue: DmlCatalogue,
  db: TDb,
  code: string,
  params: DmlParams = {},
): Promise<T> {
  const entry = catalogue.get(code);
  revalidate(code, entry);
  if (entry.form !== "builder" || typeof entry.run !== "function") {
    throw createSchemaError(
      SchemaErrorCode.INVALID_ENTRY,
      `code ${code}: form "${entry.form}" cannot execute through executeDml (builder entries only)`,
    );
  }
  try {
    return (await withD1Retry(
      () =>
        withAspects(
          { operationName: code },
          () => entry.run!(db as unknown as DmlDb, params),
        ),
      { operationName: code, idempotent: isSafeToRetryEntry(entry) },
    )) as T;
  } catch (err) {
    if (err instanceof SchemaComponentError) throw err;
    const cause = err instanceof Error ? err.message : String(err);
    throw createSchemaError(
      SchemaErrorCode.EXECUTION_FAILED,
      `code ${code}: ${cause}`,
    );
  }
}

/**
 * Execute a build-form entry: the thunk assembles the whole Drizzle
 * SQL object from the parameters and it runs through db.all (mode
 * "all", read shapes) or db.run (mode "run", write shapes).
 */
export async function executeDmlSql<T = unknown, TDb extends DrizzleD1Database<any> = DmlDb>(
  catalogue: DmlCatalogue,
  db: TDb,
  code: string,
  params: DmlParams = {},
): Promise<T> {
  const entry = catalogue.get(code);
  revalidate(code, entry);
  if (entry.form !== "build" || typeof entry.build !== "function") {
    throw createSchemaError(
      SchemaErrorCode.INVALID_ENTRY,
      `code ${code}: form "${entry.form}" cannot execute through executeDmlSql (build entries only)`,
    );
  }
  const query = entry.build(params);
  const openDb = db as unknown as DmlDb;
  try {
    return (await withD1Retry(
      () =>
        withAspects({ operationName: code }, async () => {
          if (entry.mode === "all") return openDb.all(query);
          return openDb.run(query);
        }),
      { operationName: code, idempotent: isSafeToRetryEntry(entry) },
    )) as T;
  } catch (err) {
    if (err instanceof SchemaComponentError) throw err;
    const cause = err instanceof Error ? err.message : String(err);
    throw createSchemaError(
      SchemaErrorCode.EXECUTION_FAILED,
      `code ${code}: ${cause}`,
    );
  }
}

/**
 * Resolve a fragment-form entry to its Drizzle SQL fragment. The
 * fragment itself executes inside the caller's builder call.
 */
export function dmlFragment(
  catalogue: DmlCatalogue,
  code: string,
  params: DmlParams = {},
): SQL {
  const entry = catalogue.get(code);
  revalidate(code, entry);
  if (entry.form !== "fragment" || typeof entry.fragment !== "function") {
    throw createSchemaError(
      SchemaErrorCode.INVALID_ENTRY,
      `code ${code}: form "${entry.form}" cannot resolve through dmlFragment (fragment entries only)`,
    );
  }
  return entry.fragment(params);
}
