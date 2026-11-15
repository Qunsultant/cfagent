/**
 * #4282 P6b (#4385) — DO DML catalogue registry + entry validation.
 *
 * The DO family's DML lives in exactly one place: this registry, filled
 * by doDmlEntries.ts. A DO DML entry is one of two kinds (the (b) ruling
 * + Q2 adjustment, user 2026-11-15):
 *  - "repository": a METHOD DESCRIPTOR — operation + table + the
 *    RepositoryPort method to dispatch, with the table's column map.
 *    There is no SQL text in a repository entry at all: the executor
 *    builds the Repository and calls the method. This is the entry
 *    shape for the 42 tranche statements the mini-ORM can express,
 *    and for the P6c (#4386) ORM-core statements.
 *  - "template": a NAMED RAW TEMPLATE — statement text + param names
 *    in binding order + mode ("all" for reads, "run" for writes).
 *    The residual for the 11 tranche statements the Repository cannot
 *    express (visibility disjunctions, NOT IN subquery prunes,
 *    aggregates, DISTINCT). The statement text is byte-identical to
 *    the constant it replaces (the pin test asserts this).
 *
 * #4386 (P6c): a third, parameterized-table form of the repository
 * entry — one entry per Repository operation, registered once with
 * the placeholder table "__table__" and parameterizedTable: true.
 * The executor resolves the runtime table from the caller's code
 * and params at execution (code table == runtime table, enforced
 * there) and logs the full resolved code as the AOP operationName.
 * This is the form the 9 generator templates and the facade's
 * browse/count reads take: the table is a parameter, not a second
 * catalogue per table. A parameterized entry carries no columnMap
 * and no idField (both are table-specific) and is never callable
 * under the placeholder code itself.
 *
 * The registry is the statement-code authority for DO DML exactly as
 * dmlCatalogue.ts is for D1: one code identifies exactly one entry,
 * an unknown code is rejected fail-closed, and an invalid entry is
 * rejected at registration — never at execution. Registered entries
 * are frozen, so a registered entry cannot be mutated in place.
 *
 * Plane "do" is enforced here; P6a's dmlCatalogue.ts enforces plane
 * "d1" and is NOT weakened — the two catalogues are siblings, not
 * one catalogue with a looser rule.
 *
 * What this registry does NOT hold, by design:
 * - DDL — the schema catalogue owns it; kind "dml" is rejected there.
 * - The doSchema* ledger DML and the kv_store funnel — named
 *   exemptions recorded in the mix pin (tests/do_dml_mechanism_mix_4385.test.ts),
 *   not catalogue entries (Q4).
 * - The 16 doSqliteOrmAdapters.ts statements — they went with P6c
 *   (#4386): this registry holds them now (Q5, closed by P6c).
 */
import {
  isValidStatementCode,
  statementCodeAction,
  statementCodeKind,
  statementCodePlane,
  statementCodeTable,
} from "./statementCodes";
import {
  createSchemaError,
  SchemaErrorCode,
} from "./schemaErrors";
import type { DmlOperation } from "./dmlCatalogue";
import { DO_DML_CATALOGUE_ENTRIES } from "./doDmlEntries";

/** Parameters an entry takes — validated by the executor per method. */
export type DoDmlParams = Record<string, unknown>;

/**
 * "repository" = the executor dispatches a RepositoryPort method.
 * "template" = the executor runs the statement text with the params
 * bound in declared order.
 */
export type DoDmlEntryForm = "repository" | "template";

/** The RepositoryPort methods a repository entry may dispatch. */
export type DoDmlRepositoryMethod =
  | "create"
  | "createOrIgnore"
  | "createOrReplace"
  | "update"
  | "updateWhere"
  | "upsert"
  | "delete"
  | "deleteWhere"
  | "findMany"
  | "findById"
  | "findOne"
  | "count";

/** #4386: the placeholder table segment of a parameterized-table entry. */
export const PARAMETERIZED_TABLE = "__table__";

export interface DoDmlCatalogueEntry {
  /** Canonical code: dml.do.<table>.<action>, e.g. dml.do.mas_discovery_runs.prune_age. */
  code: string;
  /** Target table. */
  table: string;
  /**
   * #4386: parameterized-table form — true when this entry is
   * registered once per operation with table "__table__" and the
   * runtime table comes from the caller's code + params (the
   * executor enforces code table == runtime table). A
   * parameterized entry carries no columnMap and no idField.
   */
  parameterizedTable?: boolean;
  operation: DmlOperation;
  form: DoDmlEntryForm;
  /** Repository form: the RepositoryPort method to dispatch. */
  method?: DoDmlRepositoryMethod;
  /** Repository form: prop → column map (identity when empty — tranche rows are snake_case). */
  columnMap?: Record<string, string>;
  /** Repository form: the id field (default "id"). */
  idField?: string;
  /** Template form: the statement text. */
  statement?: string;
  /** Template form: param names in binding order. */
  params?: string[];
  /** Template form: "all" returns rows, "run" returns rowsWritten-or-null. */
  mode?: "all" | "run";
}

export type DoDmlCatalogueValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

const WORD = /^[a-z0-9_]+$/;
/** Template param names are JS-side identifiers (camelCase: userLogin, scopeKey, maxRows). */
const PARAM_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const OPERATIONS: ReadonlySet<string> = new Set([
  "insert",
  "upsert",
  "update",
  "delete",
  "read",
]);
const REPOSITORY_METHODS: ReadonlySet<string> = new Set([
  "create",
  "createOrIgnore",
  "createOrReplace",
  "update",
  "updateWhere",
  "upsert",
  "delete",
  "deleteWhere",
  "findMany",
  "findById",
  "findOne",
  "count",
]);
/** The SQL verb a template statement must start with, per operation. */
const OPERATION_VERBS: Record<string, string> = {
  insert: "INSERT",
  upsert: "INSERT",
  update: "UPDATE",
  delete: "DELETE",
  read: "SELECT",
};

/**
 * Validate one DO DML entry against the catalogue format. Every failure
 * names the field and the rule — the message is the reviewable reason
 * the entry was rejected.
 */
export function validateDoDmlEntry(
  entry: unknown,
): DoDmlCatalogueValidationResult {
  if (!entry || typeof entry !== "object") {
    return { valid: false, reason: "entry must be an object" };
  }
  const candidate = entry as Partial<DoDmlCatalogueEntry>;

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
  if (statementCodePlane(candidate.code) !== "do") {
    return {
      valid: false,
      reason: `code plane "${statementCodePlane(candidate.code)}" must be "do"`,
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
  if (
    candidate.parameterizedTable !== undefined &&
    typeof candidate.parameterizedTable !== "boolean"
  ) {
    return {
      valid: false,
      reason: "parameterizedTable must be a boolean when present",
    };
  }
  if (typeof candidate.operation !== "string" || !OPERATIONS.has(candidate.operation)) {
    return {
      valid: false,
      reason: `operation "${String(candidate.operation)}" must be one of insert/upsert/update/delete/read`,
    };
  }
  // The form must carry exactly its fields — a repository entry with
  // statement text (or a template entry with a method) is a wiring
  // error, rejected here.
  if (candidate.form === "repository") {
    if (typeof candidate.method !== "string" || !REPOSITORY_METHODS.has(candidate.method)) {
      return {
        valid: false,
        reason: `repository entry method "${String(candidate.method)}" must be a RepositoryPort method`,
      };
    }
    // #4386: the parameterized-table form — registered once per
    // operation with the placeholder table; the column map and
    // id field are table-specific, so a parameterized entry
    // carries neither (the executor uses the defaults).
    if (candidate.parameterizedTable === true) {
      if (candidate.table !== PARAMETERIZED_TABLE) {
        return {
          valid: false,
          reason: `parameterized-table entry table must be "${PARAMETERIZED_TABLE}"`,
        };
      }
      if (candidate.columnMap !== undefined || candidate.idField !== undefined) {
        return {
          valid: false,
          reason: "parameterized-table entry must not carry a columnMap or idField",
        };
      }
    }
    if (candidate.columnMap !== undefined) {
      if (
        typeof candidate.columnMap !== "object" ||
        candidate.columnMap === null ||
        Array.isArray(candidate.columnMap) ||
        Object.entries(candidate.columnMap).some(
          // #4386: keys are JS record props (camelCase), values are
          // storage columns (lowercase words) — the P6b rule
          // assumed identity maps; the ORM-core maps translate.
          ([k, v]) => !PARAM_NAME.test(k) || typeof v !== "string" || !WORD.test(v),
        )
      ) {
        return {
          valid: false,
          reason: "repository entry columnMap must map JS-identifier props to lowercase-word columns",
        };
      }
    }
    if (candidate.idField !== undefined && (typeof candidate.idField !== "string" || !WORD.test(candidate.idField))) {
      return {
        valid: false,
        reason: `repository entry idField "${String(candidate.idField)}" must be a lowercase word`,
      };
    }
    if (candidate.statement !== undefined || candidate.params !== undefined || candidate.mode !== undefined) {
      return {
        valid: false,
        reason: "repository entry must not carry a statement, params or mode",
      };
    }
  } else if (candidate.form === "template") {
    if (candidate.parameterizedTable === true) {
      return {
        valid: false,
        reason: "parameterized-table entries must be repository-form",
      };
    }
    if (typeof candidate.statement !== "string" || candidate.statement.trim().length === 0) {
      return { valid: false, reason: "template entry must carry a non-empty statement" };
    }
    const verb = OPERATION_VERBS[candidate.operation];
    if (!new RegExp(`^\\s*${verb}\\b`, "i").test(candidate.statement)) {
      return {
        valid: false,
        reason: `template entry statement must start with ${verb} for operation "${candidate.operation}"`,
      };
    }
    if (
      !Array.isArray(candidate.params) ||
      candidate.params.some((p) => typeof p !== "string" || !PARAM_NAME.test(p))
    ) {
      return {
        valid: false,
        reason: "template entry params must be an array of JS-identifier param names",
      };
    }
    if (candidate.mode !== "all" && candidate.mode !== "run") {
      return {
        valid: false,
        reason: 'template entry must declare mode "all" or "run"',
      };
    }
    if (candidate.method !== undefined || candidate.columnMap !== undefined || candidate.idField !== undefined) {
      return {
        valid: false,
        reason: "template entry must not carry a method, columnMap or idField",
      };
    }
  } else {
    return {
      valid: false,
      reason: `form "${String(candidate.form)}" must be "repository" or "template"`,
    };
  }
  return { valid: true };
}

export interface DoDmlCatalogue {
  register(entry: DoDmlCatalogueEntry): void;
  get(code: string): DoDmlCatalogueEntry;
  has(code: string): boolean;
  entries(): DoDmlCatalogueEntry[];
  findByTable(table: string): DoDmlCatalogueEntry[];
  byOperation(operation: DmlOperation): DoDmlCatalogueEntry[];
  size(): number;
}

/** An empty DO DML catalogue — the pin tests build from this; production uses DO_DML_CATALOGUE. */
export function createDoDmlCatalogue(): DoDmlCatalogue {
  const byCode = new Map<string, DoDmlCatalogueEntry>();
  const ordered: DoDmlCatalogueEntry[] = [];

  /**
   * #4386: resolve a code to its entry — exact first, then the
   * parameterized-table fallback: a registered parameterized
   * entry matches any code with the same kind/plane/action, so
   * one entry serves every table. The executor enforces the
   * execution-time check (code table == runtime table); the
   * placeholder code itself never resolves to a callable entry
   * for a runtime table (see the executor).
   */
  const resolve = (code: string): DoDmlCatalogueEntry | undefined => {
    const exact = byCode.get(code);
    if (exact) return exact;
    const kind = statementCodeKind(code);
    const plane = statementCodePlane(code);
    const action = statementCodeAction(code);
    if (!kind || !plane || !action) return undefined;
    for (const entry of ordered) {
      if (
        entry.parameterizedTable === true &&
        statementCodeKind(entry.code) === kind &&
        statementCodePlane(entry.code) === plane &&
        statementCodeAction(entry.code) === action
      ) {
        return entry;
      }
    }
    return undefined;
  };

  return {
    register(entry: DoDmlCatalogueEntry): void {
      const validation = validateDoDmlEntry(entry);
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

    get(code: string): DoDmlCatalogueEntry {
      const entry = resolve(code);
      if (!entry) {
        throw createSchemaError(
          SchemaErrorCode.UNKNOWN_CODE,
          `code ${code} is not registered in the DO DML catalogue`,
        );
      }
      return entry;
    },

    has(code: string): boolean {
      return resolve(code) !== undefined;
    },

    entries(): DoDmlCatalogueEntry[] {
      return [...ordered];
    },

    findByTable(table: string): DoDmlCatalogueEntry[] {
      return ordered.filter((entry) => entry.table === table);
    },

    byOperation(operation: DmlOperation): DoDmlCatalogueEntry[] {
      return ordered.filter((entry) => entry.operation === operation);
    },

    size(): number {
      return ordered.length;
    },
  };
}

/** Build a catalogue holding every DO DML entry. */
export function buildDoDmlCatalogue(): DoDmlCatalogue {
  const catalogue = createDoDmlCatalogue();
  for (const entry of DO_DML_CATALOGUE_ENTRIES) {
    catalogue.register(entry);
  }
  return catalogue;
}

/** The production DO DML catalogue — every migrated DO operation, registered once. */
export const DO_DML_CATALOGUE: DoDmlCatalogue = buildDoDmlCatalogue();
