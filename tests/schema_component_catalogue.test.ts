/**
 * #4282 P0 — catalogue format + registry + statement codes.
 *
 * The catalogue is the component's contract: every entry carries code,
 * plane, table, constraint/index, statement text, seed-vs-schema kind,
 * and a parameterized form where the statement is template-assembled.
 * Storage form (decided in this phase, per the P0 body): in-repo
 * TS modules — the catalogue is code, so the Gitleaks and typecheck
 * gates apply to it exactly as they do to every other module. A data
 * file the component loads at runtime would dodge both gates.
 *
 * The registry starts EMPTY at P0: zero statements are migrated in
 * this phase. P1–P3 fill it, one family at a time, and the grep pin
 * (tests/schema_component_grep_pin.test.ts) is what proves the fill.
 */
import { describe, expect, it } from "vitest";
import {
  createCatalogue,
  validateCatalogueEntry,
} from "../src/data/schemaComponent/catalogue";
import {
  buildStatementCode,
  isValidStatementCode,
  SCHEMA_STATEMENT_CODE_PATTERN,
  statementCodeKind,
  statementCodePlane,
} from "../src/data/schemaComponent/statementCodes";
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

describe("statement codes (#4282 P0)", () => {
  it("code pattern accepts kind.plane.table.action and rejects anything else", () => {
    expect(
      SCHEMA_STATEMENT_CODE_PATTERN.test(
        "schema.do.schema_probe_widgets.create_table",
      ),
    ).toBe(true);
    expect(
      SCHEMA_STATEMENT_CODE_PATTERN.test(
        "seed.d1.schema_probe_rules.insert_default",
      ),
    ).toBe(true);
    for (const bad of [
      "not-a-code",
      "schema.do.missing-action",
      "schema.unknown.schema_probe_widgets.create_table",
      "schema.do.schema_probe_widgets.create-table",
      "SCHEMA.DO.schema_probe_widgets.create_table",
      "schema.do.schema_probe_widgets.create_table.extra",
      "",
    ]) {
      expect(isValidStatementCode(bad)).toBe(false);
    }
  });

  it("buildStatementCode composes the canonical code from its parts", () => {
    expect(
      buildStatementCode(
        "schema",
        "do",
        "schema_probe_widgets",
        "create_table",
      ),
    ).toBe("schema.do.schema_probe_widgets.create_table");
    expect(
      buildStatementCode("seed", "d1", "schema_probe_rules", "insert_default"),
    ).toBe("seed.d1.schema_probe_rules.insert_default");
  });

  it("kind and plane decode from the code, null for a malformed code", () => {
    expect(statementCodeKind(TABLE_ENTRY.code)).toBe("schema");
    expect(statementCodePlane(TABLE_ENTRY.code)).toBe("do");
    expect(statementCodeKind(SEED_ENTRY.code)).toBe("seed");
    expect(statementCodePlane(SEED_ENTRY.code)).toBe("d1");
    expect(statementCodeKind("not-a-code")).toBeNull();
    expect(statementCodePlane("not-a-code")).toBeNull();
  });
});

describe("catalogue entry validation (#4282 P0)", () => {
  it("accepts a literal table entry, an index entry, a parameterized entry, and a seed entry", () => {
    for (const entry of [
      TABLE_ENTRY,
      INDEX_ENTRY,
      PARAMETERIZED_ENTRY,
      SEED_ENTRY,
    ]) {
      expect(validateCatalogueEntry(entry)).toEqual({ valid: true });
    }
  });

  it("rejects a malformed code", () => {
    const result = validateCatalogueEntry({ ...TABLE_ENTRY, code: "nope" });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/code/);
  });

  it("rejects kind/code, plane/code, and table/code mismatches", () => {
    expect(
      validateCatalogueEntry({ ...TABLE_ENTRY, kind: "seed" }).valid,
    ).toBe(false);
    expect(
      validateCatalogueEntry({ ...TABLE_ENTRY, plane: "d1" }).valid,
    ).toBe(false);
    expect(
      validateCatalogueEntry({
        ...TABLE_ENTRY,
        table: "schema_probe_other",
      }).valid,
    ).toBe(false);
  });

  it("rejects a literal statement that does not name its table", () => {
    const result = validateCatalogueEntry({
      ...TABLE_ENTRY,
      statement:
        "CREATE TABLE IF NOT EXISTS some_other_table (id TEXT PRIMARY KEY)",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/table/);
  });

  it("rejects a literal statement carrying a template placeholder (miscategorized form)", () => {
    const result = validateCatalogueEntry({
      ...TABLE_ENTRY,
      statement:
        "CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY)",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/parameterized/);
  });

  it("rejects a parameterized entry with an undeclared placeholder", () => {
    const result = validateCatalogueEntry({
      ...PARAMETERIZED_ENTRY,
      parameters: ["OTHER"],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/TABLE/);
  });

  it("rejects a parameterized entry with a declared-but-unused parameter", () => {
    const result = validateCatalogueEntry({
      ...PARAMETERIZED_ENTRY,
      parameters: ["TABLE", "UNUSED"],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/UNUSED/);
  });

  it("rejects a parameterized entry with no parameters declared", () => {
    const result = validateCatalogueEntry({
      ...PARAMETERIZED_ENTRY,
      parameters: [],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a schema-kind entry carrying DML and a seed-kind entry carrying DDL", () => {
    expect(
      validateCatalogueEntry({
        ...TABLE_ENTRY,
        statement:
          "INSERT INTO schema_probe_widgets (id) VALUES ('x')",
      }).valid,
    ).toBe(false);
    expect(
      validateCatalogueEntry({
        ...SEED_ENTRY,
        statement:
          "CREATE TABLE IF NOT EXISTS schema_probe_rules (id TEXT PRIMARY KEY)",
      }).valid,
    ).toBe(false);
  });

  it("rejects an index entry whose statement does not name the index", () => {
    const result = validateCatalogueEntry({
      ...INDEX_ENTRY,
      statement:
        "CREATE INDEX IF NOT EXISTS other_idx ON schema_probe_widgets (label)",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toMatch(/index/);
  });

  it("rejects an empty statement and a non-object entry", () => {
    expect(
      validateCatalogueEntry({ ...TABLE_ENTRY, statement: "  " }).valid,
    ).toBe(false);
    expect(validateCatalogueEntry(null).valid).toBe(false);
    expect(validateCatalogueEntry("schema.do.x.create_table").valid).toBe(
      false,
    );
  });
});

describe("catalogue registry (#4282 P0)", () => {
  it("starts empty at P0 — zero statements migrated in this phase", () => {
    const catalogue = createCatalogue();
    expect(catalogue.size()).toBe(0);
    expect(catalogue.entries()).toEqual([]);
  });

  it("registers and retrieves entries in registration order", () => {
    const catalogue = createCatalogue();
    catalogue.register(TABLE_ENTRY);
    catalogue.register(SEED_ENTRY);
    expect(catalogue.size()).toBe(2);
    expect(catalogue.get(TABLE_ENTRY.code)).toEqual(TABLE_ENTRY);
    expect(catalogue.entries()).toEqual([TABLE_ENTRY, SEED_ENTRY]);
    expect(catalogue.has(TABLE_ENTRY.code)).toBe(true);
    expect(catalogue.has("schema.do.nope.create_table")).toBe(false);
  });

  it("rejects a duplicate code (fail-closed: one code, one statement)", () => {
    const catalogue = createCatalogue();
    catalogue.register(TABLE_ENTRY);
    expect(() => catalogue.register(TABLE_ENTRY)).toThrowError(
      SchemaComponentError,
    );
    try {
      catalogue.register(TABLE_ENTRY);
    } catch (err) {
      expect((err as SchemaComponentError).code).toBe(
        SchemaErrorCode.DUPLICATE_CODE,
      );
    }
  });

  it("rejects an invalid entry at registration with the validation reason", () => {
    const catalogue = createCatalogue();
    expect(() =>
      catalogue.register({ ...TABLE_ENTRY, code: "nope" }),
    ).toThrowError(SchemaComponentError);
    try {
      catalogue.register({ ...TABLE_ENTRY, code: "nope" });
    } catch (err) {
      expect((err as SchemaComponentError).code).toBe(
        SchemaErrorCode.INVALID_ENTRY,
      );
      expect((err as SchemaComponentError).message).toMatch(/code/);
    }
    expect(catalogue.size()).toBe(0);
  });

  it("unknown-code lookup throws SCHEMA_UNKNOWN_CODE (fail-closed)", () => {
    const catalogue = createCatalogue();
    expect(() => catalogue.get("schema.do.nope.create_table")).toThrowError(
      SchemaComponentError,
    );
    try {
      catalogue.get("schema.do.nope.create_table");
    } catch (err) {
      expect((err as SchemaComponentError).code).toBe(
        SchemaErrorCode.UNKNOWN_CODE,
      );
    }
  });

  it("finds entries by table and by kind", () => {
    const catalogue = createCatalogue();
    catalogue.register(TABLE_ENTRY);
    catalogue.register(INDEX_ENTRY);
    catalogue.register(SEED_ENTRY);
    expect(catalogue.findByTable("schema_probe_widgets")).toEqual([
      TABLE_ENTRY,
      INDEX_ENTRY,
    ]);
    expect(catalogue.findByTable("schema_probe_rules")).toEqual([SEED_ENTRY]);
    expect(catalogue.byKind("schema")).toEqual([TABLE_ENTRY, INDEX_ENTRY]);
    expect(catalogue.byKind("seed")).toEqual([SEED_ENTRY]);
  });
});
