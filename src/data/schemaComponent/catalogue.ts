/**
 * #4282 P0 — catalogue registry + entry validation.
 *
 * The registry is the statement-code authority: one code identifies
 * exactly one statement, an unknown code is rejected fail-closed, and
 * an invalid entry is rejected at registration — never at execution.
 * The registry starts EMPTY at P0; P1–P3 fill it one family at a time.
 */
import type {
  CatalogueEntry,
  StatementKind,
} from "./catalogueTypes";
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

export type CatalogueValidationResult =
  | { valid: true }
  | { valid: false; reason: string };

const WORD = /^[a-z0-9_]+$/;
const PLACEHOLDER = /\$\{([A-Za-z0-9_]+)\}/g;

/** The first verb of a statement, for the kind/verb agreement check. */
function firstVerb(statement: string): string {
  return statement.trim().split(/\s+/, 1)[0]?.toUpperCase() ?? "";
}

const SCHEMA_VERBS = new Set(["CREATE", "ALTER", "DROP"]);
const SEED_VERBS = new Set(["INSERT", "UPDATE", "DELETE", "REPLACE"]);

/**
 * Validate one entry against the catalogue format. Every failure names
 * the field and the rule — the message is the reviewable reason the
 * entry was rejected.
 */
export function validateCatalogueEntry(
  entry: unknown,
): CatalogueValidationResult {
  if (!entry || typeof entry !== "object") {
    return { valid: false, reason: "entry must be an object" };
  }
  const candidate = entry as Partial<CatalogueEntry>;

  if (typeof candidate.code !== "string" || !isValidStatementCode(candidate.code)) {
    return {
      valid: false,
      reason: `code "${String(candidate.code)}" must match <kind>.<plane>.<table>.<action>`,
    };
  }
  if (statementCodeKind(candidate.code) !== candidate.kind) {
    return {
      valid: false,
      reason: `code kind "${statementCodeKind(candidate.code)}" does not match entry kind "${String(candidate.kind)}"`,
    };
  }
  if (statementCodePlane(candidate.code) !== candidate.plane) {
    return {
      valid: false,
      reason: `code plane "${statementCodePlane(candidate.code)}" does not match entry plane "${String(candidate.plane)}"`,
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
  if (typeof candidate.statement !== "string" || candidate.statement.trim() === "") {
    return { valid: false, reason: "statement must be a non-empty string" };
  }
  const statement = candidate.statement;
  if (candidate.kind === "schema" && !SCHEMA_VERBS.has(firstVerb(statement))) {
    return {
      valid: false,
      reason: `schema-kind entry statement must start with a DDL verb (CREATE/ALTER/DROP), got "${firstVerb(statement)}"`,
    };
  }
  if (candidate.kind === "seed" && !SEED_VERBS.has(firstVerb(statement))) {
    return {
      valid: false,
      reason: `seed-kind entry statement must start with a DML verb (INSERT/UPDATE/DELETE/REPLACE), got "${firstVerb(statement)}"`,
    };
  }

  const placeholders = [...statement.matchAll(PLACEHOLDER)].map((m) => m[1]);
  if (candidate.form === "literal") {
    if (placeholders.length > 0) {
      return {
        valid: false,
        reason: `literal statement carries template placeholders (${placeholders.join(", ")}); use form "parameterized"`,
      };
    }
    // A literal statement names its table verbatim.
    if (!new RegExp(`\\b${candidate.table}\\b`, "i").test(statement)) {
      return {
        valid: false,
        reason: `literal statement does not name its table "${candidate.table}"`,
      };
    }
  } else if (candidate.form === "parameterized") {
    if (!Array.isArray(candidate.parameters) || candidate.parameters.length === 0) {
      return {
        valid: false,
        reason: "parameterized entry must declare its parameters",
      };
    }
    const declared = new Set(candidate.parameters);
    for (const name of placeholders) {
      if (!declared.has(name)) {
        return {
          valid: false,
          reason: `parameterized statement uses undeclared placeholder "\${${name}}"`,
        };
      }
    }
    for (const name of candidate.parameters) {
      if (!placeholders.includes(name)) {
        return {
          valid: false,
          reason: `parameterized entry declares unused parameter "${name}"`,
        };
      }
    }
  } else {
    return {
      valid: false,
      reason: `form "${String(candidate.form)}" must be "literal" or "parameterized"`,
    };
  }

  if (
    candidate.index !== undefined &&
    candidate.form === "literal" &&
    !new RegExp(`\\b${candidate.index}\\b`, "i").test(statement)
  ) {
    return {
      valid: false,
      reason: `literal statement does not name its index "${candidate.index}"`,
    };
  }
  if (
    candidate.constraint !== undefined &&
    candidate.form === "literal" &&
    !new RegExp(`\\b${candidate.constraint}\\b`, "i").test(statement)
  ) {
    return {
      valid: false,
      reason: `literal statement does not name its constraint "${candidate.constraint}"`,
    };
  }
  return { valid: true };
}

export interface SchemaCatalogue {
  register(entry: CatalogueEntry): void;
  get(code: string): CatalogueEntry;
  has(code: string): boolean;
  entries(): CatalogueEntry[];
  findByTable(table: string): CatalogueEntry[];
  byKind(kind: StatementKind): CatalogueEntry[];
  size(): number;
}

/** The catalogue starts empty at P0 — zero statements are migrated in this phase. */
export function createCatalogue(): SchemaCatalogue {
  const byCode = new Map<string, CatalogueEntry>();
  const ordered: CatalogueEntry[] = [];

  return {
    register(entry: CatalogueEntry): void {
      const validation = validateCatalogueEntry(entry);
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
      byCode.set(entry.code, entry);
      ordered.push(entry);
    },

    get(code: string): CatalogueEntry {
      const entry = byCode.get(code);
      if (!entry) {
        throw createSchemaError(
          SchemaErrorCode.UNKNOWN_CODE,
          `code ${code} is not registered in the schema catalogue`,
        );
      }
      return entry;
    },

    has(code: string): boolean {
      return byCode.has(code);
    },

    entries(): CatalogueEntry[] {
      return [...ordered];
    },

    findByTable(table: string): CatalogueEntry[] {
      return ordered.filter((entry) => entry.table === table);
    },

    byKind(kind: StatementKind): CatalogueEntry[] {
      return ordered.filter((entry) => entry.kind === kind);
    },

    size(): number {
      return ordered.length;
    },
  };
}
