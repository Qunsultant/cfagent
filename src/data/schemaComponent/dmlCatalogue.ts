/**
 * #4282 P6a (#4384) — DML catalogue registry + entry validation.
 *
 * The D1 family's DML lives in exactly one place: this registry, filled
 * by dmlEntries.ts. A DML entry is NOT a SQL string — it is a thunk:
 * a Drizzle builder call ("builder" form), a Drizzle SQL fragment the
 * builder cannot express ("fragment" form), or a whole-SQL assembly for
 * the dynamically-shaped marketplace queries ("build" form). The
 * registry is the statement-code authority for DML exactly as
 * catalogue.ts is for DDL: one code identifies exactly one entry, an
 * unknown code is rejected fail-closed, and an invalid entry is
 * rejected at registration — never at execution. Registered entries
 * are frozen, so a registered entry cannot be mutated in place.
 *
 * What this registry does NOT hold, by design:
 * - Inline Drizzle builder calls (the ADR 0032 standard idiom) — a
 *   builder call needs no catalogue entry; the pin only forbids
 *   hand-written SQL text outside the catalogue.
 * - ProviderConfig's batch-leg writes — the statements never execute
 *   individually; the unit carries the code
 *   "dataProviders.applyConfigWrites" and the SQL text is
 *   builder-generated via .toSQL(), never hand-written.
 * - DDL — the schema catalogue owns it; kind "dml" is rejected there.
 */
import type { SQL } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  isValidStatementCode,
  statementCodeKind,
  statementCodePlane,
  statementCodeTable,
} from "./statementCodes";
import {
  createSchemaError,
  SchemaErrorCode,
} from "./schemaErrors";
import { DML_CATALOGUE_ENTRIES } from "./dmlEntries";

/** The Drizzle D1 handle a DML entry runs against (schema-open, like the marketplace's MarketplaceDb). */
export type DmlDb = DrizzleD1Database<Record<string, never>>;

/** The operation an entry performs — the verb half of its code's action. */
export type DmlOperation = "insert" | "upsert" | "update" | "delete" | "read";

/** Parameters a thunk takes — validated by the thunk itself. */
export type DmlParams = Record<string, unknown>;

/**
 * "builder" = the thunk runs the operation via Drizzle (a whole
 * statement, possibly a db.batch of several). "fragment" = the thunk
 * returns a Drizzle SQL fragment the builder cannot express (an
 * atomic counter increment, an excluded.* reference, a CAST bucket);
 * the fragment executes as part of the caller's builder call.
 * "build" = the thunk assembles a whole Drizzle SQL object for a
 * dynamically-shaped query (the marketplace repository).
 */
export type DmlEntryForm = "builder" | "fragment" | "build";

export interface DmlCatalogueEntry {
  /** Canonical code: dml.d1.<table>.<action>, e.g. dml.d1.mas_feed_datasets.upsert. */
  code: string;
  /** Target table. */
  table: string;
  operation: DmlOperation;
  form: DmlEntryForm;
  /** Builder form: run the operation via Drizzle. */
  run?: (db: DmlDb, params: DmlParams) => Promise<unknown>;
  /** Fragment form: return the SQL fragment. */
  fragment?: (params: DmlParams) => SQL;
  /** Build form: assemble the whole SQL object. */
  build?: (params: DmlParams) => SQL;
  /** Build form only: "all" returns rows (db.all), "run" returns the run result (db.run). */
  mode?: "all" | "run";
}

export type DmlCatalogueValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

const WORD = /^[a-z0-9_]+$/;
const OPERATIONS: ReadonlySet<string> = new Set([
  "insert",
  "upsert",
  "update",
  "delete",
  "read",
]);

/**
 * Validate one DML entry against the catalogue format. Every failure
 * names the field and the rule — the message is the reviewable reason
 * the entry was rejected.
 */
export function validateDmlEntry(
  entry: unknown,
): DmlCatalogueValidationResult {
  if (!entry || typeof entry !== "object") {
    return { valid: false, reason: "entry must be an object" };
  }
  const candidate = entry as Partial<DmlCatalogueEntry>;

  if (typeof candidate.code !== "string" || !isValidStatementCode(candidate.code)) {
    return {
      valid: false,
      reason: `code "${String(candidate.code)}" must match <kind>.<plane>.<table>.<action>`,
    };
  }
  if (statementCodeKind(candidate.code) !== "dml") {
    return {
      valid: false,
      reason: `code kind "${statementCodeKind(candidate.code)}" must be "dml"`,
    };
  }
  if (statementCodePlane(candidate.code) !== "d1") {
    return {
      valid: false,
      reason: `code plane "${statementCodePlane(candidate.code)}" must be "d1"`,
    };
  }
  if (statementCodeTable(candidate.code) !== candidate.table) {
    return {
      valid: false,
      reason: `code table "${statementCodeTable(candidate.code)}" does not match entry table "${String(candidate.table)}"`,
    };
  }
  if (typeof candidate.table !== "string" || !WORD.test(candidate.table)) {
    return {
      valid: false,
      reason: `table "${String(candidate.table)}" must be a lowercase word`,
    };
  }
  if (typeof candidate.operation !== "string" || !OPERATIONS.has(candidate.operation)) {
    return {
      valid: false,
      reason: `operation "${String(candidate.operation)}" must be one of insert/upsert/update/delete/read`,
    };
  }
  // The form must carry exactly its thunk — a builder entry with a
  // fragment thunk (or vice versa) is a wiring error, rejected here.
  if (candidate.form === "builder") {
    if (typeof candidate.run !== "function") {
      return { valid: false, reason: "builder entry must carry a run thunk" };
    }
    if (candidate.fragment !== undefined || candidate.build !== undefined) {
      return {
        valid: false,
        reason: "builder entry must not carry a fragment or build thunk",
      };
    }
  } else if (candidate.form === "fragment") {
    if (typeof candidate.fragment !== "function") {
      return { valid: false, reason: "fragment entry must carry a fragment thunk" };
    }
    if (candidate.run !== undefined || candidate.build !== undefined) {
      return {
        valid: false,
        reason: "fragment entry must not carry a run or build thunk",
      };
    }
  } else if (candidate.form === "build") {
    if (typeof candidate.build !== "function") {
      return { valid: false, reason: "build entry must carry a build thunk" };
    }
    if (candidate.run !== undefined || candidate.fragment !== undefined) {
      return {
        valid: false,
        reason: "build entry must not carry a run or fragment thunk",
      };
    }
    if (candidate.mode !== "all" && candidate.mode !== "run") {
      return {
        valid: false,
        reason: 'build entry must declare mode "all" or "run"',
      };
    }
  } else {
    return {
      valid: false,
      reason: `form "${String(candidate.form)}" must be "builder", "fragment" or "build"`,
    };
  }
  return { valid: true };
}

export interface DmlCatalogue {
  register(entry: DmlCatalogueEntry): void;
  get(code: string): DmlCatalogueEntry;
  has(code: string): boolean;
  entries(): DmlCatalogueEntry[];
  findByTable(table: string): DmlCatalogueEntry[];
  byOperation(operation: DmlOperation): DmlCatalogueEntry[];
  size(): number;
}

/** An empty DML catalogue — the pin tests build from this; production uses DML_CATALOGUE. */
export function createDmlCatalogue(): DmlCatalogue {
  const byCode = new Map<string, DmlCatalogueEntry>();
  const ordered: DmlCatalogueEntry[] = [];

  return {
    register(entry: DmlCatalogueEntry): void {
      const validation = validateDmlEntry(entry);
      if (!validation.valid) {
        throw createSchemaError(
          SchemaErrorCode.INVALID_ENTRY,
          `code ${entry.code}: ${validation.reason}`,
        );
      }
      if (byCode.has(entry.code)) {
        throw createSchemaError(
          SchemaErrorCode.DUPLICATE_CODE,
          `code ${entry.code} is already registered`,
        );
      }
      // Freeze on registration: a registered entry cannot be
      // mutated in place (the tamper guard; the executor also
      // re-validates on every execution).
      Object.freeze(entry);
      byCode.set(entry.code, entry);
      ordered.push(entry);
    },

    get(code: string): DmlCatalogueEntry {
      const entry = byCode.get(code);
      if (!entry) {
        throw createSchemaError(
          SchemaErrorCode.UNKNOWN_CODE,
          `code ${code} is not registered in the DML catalogue`,
        );
      }
      return entry;
    },

    has(code: string): boolean {
      return byCode.has(code);
    },

    entries(): DmlCatalogueEntry[] {
      return [...ordered];
    },

    findByTable(table: string): DmlCatalogueEntry[] {
      return ordered.filter((entry) => entry.table === table);
    },

    byOperation(operation: DmlOperation): DmlCatalogueEntry[] {
      return ordered.filter((entry) => entry.operation === operation);
    },

    size(): number {
      return ordered.length;
    },
  };
}

/** Build a catalogue holding every DML entry. */
export function buildDmlCatalogue(): DmlCatalogue {
  const catalogue = createDmlCatalogue();
  for (const entry of DML_CATALOGUE_ENTRIES) {
    catalogue.register(entry);
  }
  return catalogue;
}

/** The production DML catalogue — every migrated D1 operation, registered once. */
export const DML_CATALOGUE: DmlCatalogue = buildDmlCatalogue();
