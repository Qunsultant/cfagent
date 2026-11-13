/**
 * #4282 P0 — statement codes.
 *
 * The code is the statement's identity: it is the withAspects
 * operationName on every execution (so the code is what the structured
 * log carries), and it is the registry key (so an unknown code is
 * rejected fail-closed). The format is a contract, not a tunable:
 * <kind>.<plane>.<table>.<action>, all lowercase word characters.
 */
import type { SchemaPlane, StatementKind } from "./catalogueTypes";

/** The one code format. Kept as a module constant: it is a format contract, not a runtime knob. */
export const SCHEMA_STATEMENT_CODE_PATTERN =
  /^(schema|seed)\.(d1|do|orm|index|route)\.[a-z0-9_]+\.[a-z0-9_]+$/;

export function isValidStatementCode(code: string): boolean {
  return SCHEMA_STATEMENT_CODE_PATTERN.test(code);
}

export function statementCodeKind(code: string): StatementKind | null {
  const match = code.match(/^(schema|seed)\./);
  return match ? (match[1] as StatementKind) : null;
}

export function statementCodePlane(code: string): SchemaPlane | null {
  const match = code.match(/^(?:schema|seed)\.(d1|do|orm|index|route)\./);
  return match ? (match[1] as SchemaPlane) : null;
}

export function statementCodeTable(code: string): string | null {
  const match = code.match(
    /^(?:schema|seed)\.(?:d1|do|orm|index|route)\.([a-z0-9_]+)\./,
  );
  return match ? match[1] : null;
}

export function buildStatementCode(
  kind: StatementKind,
  plane: SchemaPlane,
  table: string,
  action: string,
): string {
  return `${kind}.${plane}.${table}.${action}`;
}
