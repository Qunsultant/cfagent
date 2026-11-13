/**
 * #4282 P0 — schema-equality harness.
 *
 * The harness executes a catalogue against a clean instance and diffs
 * the resulting schema against an expected schema. The clean instance
 * is the InMemorySchemaInstance: it captures executed DDL at the
 * statement seam and parses it into a schema model (tables → columns,
 * indexes, constraints) — the same executed-DDL-capture idiom the #782
 * drift pin uses (tests/schema_single_source.test.ts), because this
 * repo's test harness has no real SQLite (node:sqlite is flag-gated
 * on CI's Node 22).
 *
 * The parser covers the DDL dialect the repo actually uses: CREATE
 * TABLE (with inline and table-level constraints), CREATE [UNIQUE]
 * INDEX, ALTER TABLE ADD COLUMN, DROP TABLE / DROP INDEX. Seed DML
 * (INSERT/UPDATE/DELETE) is a no-op for the model — seeds do not
 * change schema. A statement the parser cannot apply (an unresolvable
 * table name, e.g. an unresolved ${TABLE} template) throws instead of
 * silently dropping the statement.
 */
import { executeCatalogue, type SqlExecutor } from "./executor";
import type { SchemaCatalogue } from "./catalogue";
import { createSchemaError, SchemaErrorCode } from "./schemaErrors";

export interface SchemaColumn {
  name: string;
  type: string;
  pk: number;
}

export interface SchemaConstraint {
  kind: "primaryKey" | "unique" | "check" | "foreignKey";
  columns: string[];
}

export interface SchemaTable {
  columns: SchemaColumn[];
  constraints: Record<string, SchemaConstraint>;
}

export interface SchemaIndex {
  table: string;
  columns: string[];
  unique: boolean;
}

export interface SchemaModel {
  tables: Record<string, SchemaTable>;
  indexes: Record<string, SchemaIndex>;
}

export function emptySchemaModel(): SchemaModel {
  return { tables: {}, indexes: {} };
}

export interface SchemaInstance {
  exec(sql: string): void | Promise<void>;
  introspect(): SchemaModel | Promise<SchemaModel>;
}

/* ------------------------------------------------------------------ */
/* Statement splitting + DDL parsing                                   */
/* ------------------------------------------------------------------ */

/** Split on `;` at paren depth 0 and outside quotes/backticks. */
export function splitStatements(sql: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === ";" && depth === 0) {
      if (current.trim() !== "") parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

/** Split a comma list at paren depth 0, outside quotes/backticks. */
function splitTopLevel(list: string): string[] {
  const parts: string[] = [];
  let current = "";
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < list.length; i++) {
    const ch = list[i];
    if (quote) {
      current += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

function unquote(name: string): string {
  return name.replace(/^["`]/, "").replace(/["`]$/, "");
}

function columnList(raw: string): string[] {
  return splitTopLevel(raw)
    .map((item) => unquote(item.trim()))
    .filter((item) => item !== "");
}

const CREATE_TABLE_HEAD =
  /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w]+)["`]?\s*\(/i;
const CREATE_INDEX_HEAD =
  /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["`]?([\w]+)["`]?\s+ON\s+["`]?([\w]+)["`]?\s*\(([^)]*)\)/i;
const ALTER_ADD_COLUMN =
  /ALTER\s+TABLE\s+["`]?([\w]+)["`]?\s+ADD\s+COLUMN\s+["`]?([\w]+)["`]?\s*(.*)$/is;
const DROP_TABLE = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?["`]?([\w]+)["`]?/i;
const DROP_INDEX = /DROP\s+INDEX\s+(?:IF\s+EXISTS\s+)?["`]?([\w]+)["`]?/i;

/** The content between the first `(` after `start` and its matching `)`. */
function balancedParenContent(sql: string, start: number): string | null {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      continue;
    }
    if (ch === "(") depth += 1;
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(start + 1, i);
    }
  }
  return null;
}

function parseCreateTable(sql: string, model: SchemaModel): void {
  const head = sql.match(CREATE_TABLE_HEAD);
  if (!head) {
    throw createSchemaError(
      SchemaErrorCode.INVALID_ENTRY,
      `cannot parse CREATE TABLE statement (unresolved table name): ${sql.slice(0, 80)}`,
    );
  }
  const table = head[1];
  const openParen = sql.indexOf("(", head.index ?? 0);
  const body = balancedParenContent(sql, openParen);
  if (body === null) {
    throw createSchemaError(
      SchemaErrorCode.INVALID_ENTRY,
      `cannot parse CREATE TABLE statement (unbalanced parentheses): ${sql.slice(0, 80)}`,
    );
  }
  const columns: SchemaColumn[] = [];
  const constraints: Record<string, SchemaConstraint> = {};
  for (const item of splitTopLevel(body)) {
    const upper = item.toUpperCase();
    if (/^PRIMARY\s+KEY\b/.test(upper)) {
      const cols = item.match(/\(([^)]*)\)/);
      constraints.primary_key = {
        kind: "primaryKey",
        columns: cols ? columnList(cols[1]) : [],
      };
      continue;
    }
    if (/^UNIQUE\b/.test(upper)) {
      const cols = item.match(/\(([^)]*)\)/);
      const columnsList = cols ? columnList(cols[1]) : [];
      constraints[`unique:${columnsList.join(",")}`] = {
        kind: "unique",
        columns: columnsList,
      };
      continue;
    }
    if (/^CHECK\b/.test(upper)) {
      constraints.check = { kind: "check", columns: [] };
      continue;
    }
    if (/^FOREIGN\s+KEY\b/.test(upper)) {
      const cols = item.match(/\(([^)]*)\)/);
      const columnsList = cols ? columnList(cols[1]) : [];
      constraints[`fk:${columnsList.join(",")}`] = {
        kind: "foreignKey",
        columns: columnsList,
      };
      continue;
    }
    const constraintMatch = item.match(
      /^CONSTRAINT\s+["`]?([\w]+)["`]?\s+(.*)$/i,
    );
    if (constraintMatch) {
      const [, name, rest] = constraintMatch;
      const restUpper = rest.toUpperCase();
      const cols = rest.match(/\(([^)]*)\)/);
      const columnsList = cols ? columnList(cols[1]) : [];
      const kind: SchemaConstraint["kind"] = /^PRIMARY\s+KEY\b/.test(restUpper)
        ? "primaryKey"
        : /^UNIQUE\b/.test(restUpper)
          ? "unique"
          : /^CHECK\b/.test(restUpper)
            ? "check"
            : "foreignKey";
      constraints[name] = { kind, columns: columnsList };
      continue;
    }
    // Column definition: name, type, then constraints.
    const tokens = item.split(/\s+/);
    const name = unquote(tokens[0]);
    const type = (tokens[1] ?? "").toUpperCase();
    const pk = /\bPRIMARY\s+KEY\b/i.test(item) ? 1 : 0;
    columns.push({ name, type, pk });
    if (/\bUNIQUE\b/i.test(item)) {
      constraints[`unique:${name}`] = { kind: "unique", columns: [name] };
    }
  }
  model.tables[table] = { columns, constraints };
}

function parseCreateIndex(sql: string, model: SchemaModel): void {
  const match = sql.match(CREATE_INDEX_HEAD);
  if (!match) {
    throw createSchemaError(
      SchemaErrorCode.INVALID_ENTRY,
      `cannot parse CREATE INDEX statement: ${sql.slice(0, 80)}`,
    );
  }
  const [, unique, name, table, cols] = match;
  model.indexes[name] = {
    table,
    columns: columnList(cols),
    unique: Boolean(unique),
  };
}

function parseAlterTable(sql: string, model: SchemaModel): void {
  const match = sql.match(ALTER_ADD_COLUMN);
  if (!match) {
    // ALTER TABLE forms the harness does not model (e.g. RENAME) are
    // ignored: they do not change the table/column/index model.
    return;
  }
  const [, table, column, rest] = match;
  const existing = model.tables[table];
  if (!existing) return;
  const type = (rest.trim().split(/\s+/, 1)[0] ?? "").toUpperCase();
  const pk = /\bPRIMARY\s+KEY\b/i.test(rest) ? 1 : 0;
  if (!existing.columns.some((c) => c.name === column)) {
    existing.columns.push({ name: column, type, pk });
  }
}

/** Apply one DDL/DML statement to the model. Seed DML is a no-op. */
export function parseSchemaStatement(sql: string, model: SchemaModel): void {
  const trimmed = sql.trim();
  if (trimmed === "") return;
  const upper = trimmed.toUpperCase();
  if (upper.startsWith("CREATE TABLE")) {
    parseCreateTable(trimmed, model);
    return;
  }
  if (
    upper.startsWith("CREATE INDEX") ||
    upper.startsWith("CREATE UNIQUE INDEX")
  ) {
    parseCreateIndex(trimmed, model);
    return;
  }
  if (upper.startsWith("ALTER TABLE")) {
    parseAlterTable(trimmed, model);
    return;
  }
  if (upper.startsWith("DROP TABLE")) {
    const match = trimmed.match(DROP_TABLE);
    if (match) {
      delete model.tables[match[1]];
      for (const [name, index] of Object.entries(model.indexes)) {
        if (index.table === match[1]) delete model.indexes[name];
      }
    }
    return;
  }
  if (upper.startsWith("DROP INDEX")) {
    const match = trimmed.match(DROP_INDEX);
    if (match) delete model.indexes[match[1]];
    return;
  }
  // INSERT / UPDATE / DELETE / REPLACE and anything else: no schema effect.
}

/** In-memory clean instance: captures executed DDL, parses it into the model. */
export class InMemorySchemaInstance implements SchemaInstance {
  private readonly model: SchemaModel = emptySchemaModel();

  exec(sql: string): void {
    for (const statement of splitStatements(sql)) {
      parseSchemaStatement(statement, this.model);
    }
  }

  introspect(): SchemaModel {
    return this.model;
  }
}

/* ------------------------------------------------------------------ */
/* Diff                                                                */
/* ------------------------------------------------------------------ */

export interface ChangedColumn {
  table: string;
  column: string;
  actualType: string;
  expectedType: string;
  actualPk: number;
  expectedPk: number;
}

export interface ChangedIndex {
  name: string;
  actual: SchemaIndex;
  expected: SchemaIndex;
}

export interface SchemaDiff {
  missingTables: string[];
  extraTables: string[];
  missingColumns: { table: string; column: string }[];
  extraColumns: { table: string; column: string }[];
  changedColumns: ChangedColumn[];
  missingIndexes: string[];
  extraIndexes: string[];
  changedIndexes: ChangedIndex[];
  missingConstraints: { table: string; constraint: string }[];
  extraConstraints: { table: string; constraint: string }[];
}

export function emptyDiff(): SchemaDiff {
  return {
    missingTables: [],
    extraTables: [],
    missingColumns: [],
    extraColumns: [],
    changedColumns: [],
    missingIndexes: [],
    extraIndexes: [],
    changedIndexes: [],
    missingConstraints: [],
    extraConstraints: [],
  };
}

export function diffSchema(
  actual: SchemaModel,
  expected: SchemaModel,
): SchemaDiff {
  const diff = emptyDiff();
  const actualTables = Object.keys(actual.tables).sort();
  const expectedTables = Object.keys(expected.tables).sort();
  diff.missingTables = expectedTables.filter((t) => !actual.tables[t]);
  diff.extraTables = actualTables.filter((t) => !expected.tables[t]);

  for (const table of expectedTables) {
    if (!actual.tables[table]) continue;
    const actualCols = new Map(
      actual.tables[table].columns.map((c) => [c.name, c]),
    );
    const expectedCols = new Map(
      expected.tables[table].columns.map((c) => [c.name, c]),
    );
    for (const [name, col] of expectedCols) {
      const found = actualCols.get(name);
      if (!found) {
        diff.missingColumns.push({ table, column: name });
      } else if (found.type !== col.type || found.pk !== col.pk) {
        diff.changedColumns.push({
          table,
          column: name,
          actualType: found.type,
          expectedType: col.type,
          actualPk: found.pk,
          expectedPk: col.pk,
        });
      }
    }
    for (const [name] of actualCols) {
      if (!expectedCols.has(name)) {
        diff.extraColumns.push({ table, column: name });
      }
    }
    const actualConstraints = actual.tables[table].constraints;
    const expectedConstraints = expected.tables[table].constraints;
    for (const name of Object.keys(expectedConstraints).sort()) {
      if (!actualConstraints[name]) {
        diff.missingConstraints.push({ table, constraint: name });
      }
    }
    for (const name of Object.keys(actualConstraints).sort()) {
      if (!expectedConstraints[name]) {
        diff.extraConstraints.push({ table, constraint: name });
      }
    }
  }

  const actualIndexes = Object.keys(actual.indexes).sort();
  const expectedIndexes = Object.keys(expected.indexes).sort();
  diff.missingIndexes = expectedIndexes.filter((n) => !actual.indexes[n]);
  diff.extraIndexes = actualIndexes.filter((n) => !expected.indexes[n]);
  for (const name of expectedIndexes) {
    if (!actual.indexes[name]) continue;
    const a = actual.indexes[name];
    const e = expected.indexes[name];
    if (
      a.table !== e.table ||
      a.unique !== e.unique ||
      a.columns.join(",") !== e.columns.join(",")
    ) {
      diff.changedIndexes.push({ name, actual: a, expected: e });
    }
  }

  // Deterministic order for the report and the tests.
  diff.missingColumns.sort((x, y) =>
    x.table.localeCompare(y.table) || x.column.localeCompare(y.column),
  );
  diff.extraColumns.sort((x, y) =>
    x.table.localeCompare(y.table) || x.column.localeCompare(y.column),
  );
  diff.changedColumns.sort((x, y) =>
    x.table.localeCompare(y.table) || x.column.localeCompare(y.column),
  );
  diff.missingConstraints.sort((x, y) =>
    x.table.localeCompare(y.table) || x.constraint.localeCompare(y.constraint),
  );
  diff.extraConstraints.sort((x, y) =>
    x.table.localeCompare(y.table) || x.constraint.localeCompare(y.constraint),
  );
  return diff;
}

export function isEmptyDiff(diff: SchemaDiff): boolean {
  return (
    diff.missingTables.length === 0 &&
    diff.extraTables.length === 0 &&
    diff.missingColumns.length === 0 &&
    diff.extraColumns.length === 0 &&
    diff.changedColumns.length === 0 &&
    diff.missingIndexes.length === 0 &&
    diff.extraIndexes.length === 0 &&
    diff.changedIndexes.length === 0 &&
    diff.missingConstraints.length === 0 &&
    diff.extraConstraints.length === 0
  );
}

function listSection<T>(
  label: string,
  items: T[],
  format: (item: T) => string = (item) => String(item),
): string {
  if (items.length === 0) return `${label} (0)`;
  return `${label} (${items.length}): ${items.map(format).join(", ")}`;
}

/** Human-readable diff report — the artefact P4's equality pin asserts on. */
export function formatDiffReport(diff: SchemaDiff): string {
  if (isEmptyDiff(diff)) {
    return "schema diff: no differences — the catalogue-built schema equals the expected schema";
  }
  const lines = [
    listSection("missing tables", diff.missingTables),
    listSection("extra tables", diff.extraTables),
    listSection(
      "missing columns",
      diff.missingColumns.map((c) => `${c.table}.${c.column}`),
    ),
    listSection(
      "extra columns",
      diff.extraColumns.map((c) => `${c.table}.${c.column}`),
    ),
    listSection(
      "changed columns",
      diff.changedColumns,
      (c) =>
        `${c.table}.${c.column}: ${c.actualType}/pk${c.actualPk} -> ${c.expectedType}/pk${c.expectedPk}`,
    ),
    listSection("missing indexes", diff.missingIndexes),
    listSection("extra indexes", diff.extraIndexes),
    listSection(
      "changed indexes",
      diff.changedIndexes,
      (c) => `${c.name} on ${c.actual.table}`,
    ),
    listSection(
      "missing constraints",
      diff.missingConstraints,
      (c) => `${c.table}.${c.constraint}`,
    ),
    listSection(
      "extra constraints",
      diff.extraConstraints,
      (c) => `${c.table}.${c.constraint}`,
    ),
  ];
  return `schema diff:\n  ${lines.join("\n  ")}`;
}

export interface EqualityCheckResult {
  diff: SchemaDiff;
  report: string;
  actual: SchemaModel;
}

/**
 * Execute a catalogue against a fresh clean instance and diff the
 * resulting schema against the expected schema. An execution failure
 * propagates honestly (the check throws) — a failed build is not a
 * diff, it is a failed check.
 */
export async function runEqualityCheck(
  catalogue: SchemaCatalogue,
  expected: SchemaModel,
  executor?: SqlExecutor,
): Promise<EqualityCheckResult> {
  const instance = new InMemorySchemaInstance();
  const sqlExecutor: SqlExecutor =
    executor ?? { exec: (sql: string) => instance.exec(sql) };
  await executeCatalogue(catalogue, sqlExecutor);
  const actual = await instance.introspect();
  const diff = diffSchema(actual, expected);
  return { diff, report: formatDiffReport(diff), actual };
}
