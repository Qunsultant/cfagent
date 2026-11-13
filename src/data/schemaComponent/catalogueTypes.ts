/**
 * #4282 P0 — catalogue entry types.
 *
 * The catalogue is the component's contract: every statement the
 * component can execute is an entry carrying its code, plane, table,
 * constraint/index, statement text, seed-vs-schema kind, and a
 * parameterized form where the statement is template-assembled.
 *
 * Storage form (decided in this phase, per the P0 body): in-repo
 * TS modules. The catalogue is code, so the Gitleaks and typecheck
 * gates apply to it exactly as they do to every other module — a data
 * file the component loads at runtime would dodge both gates.
 *
 * Planes follow the survey (§2): D1 is builder-dominant, DO is
 * raw-SQL-dominant, ORM is method-level, index schemas are their own
 * family, and route-held statements are the "route" plane.
 */
export type SchemaPlane = "d1" | "do" | "orm" | "index" | "route";

/** "schema" = DDL (tables, indexes, constraints); "seed" = DML seed data. */
export type StatementKind = "schema" | "seed";

/**
 * "literal" = the statement text is the statement, verbatim.
 * "parameterized" = the statement is a template: `${NAME}` placeholders
 * are substituted from the caller's parameters at execution time.
 * The mas_reports `${TABLE}` form (survey §1.4.2) is the reason this
 * form exists — a static catalogue cannot hold it verbatim.
 */
export type StatementForm = "literal" | "parameterized";

export interface CatalogueEntry {
  /** Canonical code: <kind>.<plane>.<table>.<action>, e.g. schema.do.mas_reports.create_table. */
  code: string;
  plane: SchemaPlane;
  /** Target table. For an index entry, the indexed table. */
  table: string;
  /** Constraint name, when the statement defines one (PK / UNIQUE / CHECK / FK). */
  constraint?: string;
  /** Index name, when the statement creates one. */
  index?: string;
  /** Statement text — verbatim when literal, a ${NAME} template when parameterized. */
  statement: string;
  kind: StatementKind;
  form: StatementForm;
  /** Declared parameter names; required when form is "parameterized". */
  parameters?: string[];
}

export interface Catalogue {
  version: number;
  entries: CatalogueEntry[];
}
