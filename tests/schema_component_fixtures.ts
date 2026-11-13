/**
 * Shared catalogue fixtures for the #4282 P0 schema-component tests.
 *
 * Clearly synthetic names — no real table, no secret-shaped value.
 * This is a helper, not a suite (no `.test.` in the name), so vitest
 * does not collect it as a test file.
 */
import type { CatalogueEntry } from "../src/data/schemaComponent/catalogue";

export const TABLE_ENTRY: CatalogueEntry = {
  code: "schema.do.schema_probe_widgets.create_table",
  plane: "do",
  table: "schema_probe_widgets",
  statement:
    "CREATE TABLE IF NOT EXISTS schema_probe_widgets (id TEXT PRIMARY KEY, label TEXT NOT NULL, created_at TEXT NOT NULL)",
  kind: "schema",
  form: "literal",
};

export const INDEX_ENTRY: CatalogueEntry = {
  code: "schema.do.schema_probe_widgets.create_index_label",
  plane: "do",
  table: "schema_probe_widgets",
  index: "schema_probe_widgets_label_idx",
  statement:
    "CREATE INDEX IF NOT EXISTS schema_probe_widgets_label_idx ON schema_probe_widgets (label)",
  kind: "schema",
  form: "literal",
};

export const PARAMETERIZED_ENTRY: CatalogueEntry = {
  code: "schema.do.schema_probe_reports.create_table",
  plane: "do",
  table: "schema_probe_reports",
  statement:
    "CREATE TABLE IF NOT EXISTS ${TABLE} (id TEXT PRIMARY KEY, title TEXT NOT NULL)",
  kind: "schema",
  form: "parameterized",
  parameters: ["TABLE"],
};

export const SEED_ENTRY: CatalogueEntry = {
  code: "seed.d1.schema_probe_rules.insert_default",
  plane: "d1",
  table: "schema_probe_rules",
  statement:
    "INSERT OR IGNORE INTO schema_probe_rules (id, label) VALUES ('probe-default', 'Probe default rule')",
  kind: "seed",
  form: "literal",
};
