// @vitest-environment node
/**
 * Issue #5865 — the append-only definition history that historical replay
 * (#4467) reads.
 *
 * Pins:
 *  - 5865-P01 saving a definition appends its version; the current pointer
 *    still moves forward, and the history keeps every version;
 *  - 5865-P02 a version is immutable: re-saving the same version does not
 *    fork or rewrite it;
 *  - 5865-P03 an unknown version reads null (never the current definition —
 *    a replay must not silently use today's config);
 *  - 5865-P04 the backfill is idempotent and seeds from the current pointer;
 *  - 5865-P05 the D1 migration 0074 really creates the table.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import type { JobDefinition } from "../src/data/jobPipelinePorts";
import { JOB_PIPELINE_DEFINITION_VERSIONS_BACKFILL } from "../src/data/doSqliteJobPipelineAdapter";
import { d1MigrationSql } from "../src/data/schemaComponent/d1Catalogue";

function definition(version: number, marker: string): JobDefinition {
  return {
    jobId: "yahoo-nasdaq100-technicals",
    name: "NASDAQ100 technicals",
    root: { kind: "stage", stage: "feed", children: [] } as never,
    rawConfig: { marker },
    config: { marker } as never,
    version,
    updatedAt: `2026-11-20T00:00:0${version}.000Z`,
  } as never;
}

describe("5865-P01 versions accumulate while the pointer moves", () => {
  it("keeps v1 in history when v2 becomes current", async () => {
    const stores = createInMemoryJobPipelineStores();
    await stores.definitions.saveDefinition(definition(1, "first"));
    await stores.definitions.saveDefinition(definition(2, "second"));

    const current = await stores.definitions.getDefinition("yahoo-nasdaq100-technicals");
    expect((current as { version: number }).version).toBe(2);

    const v1 = await stores.definitions.getDefinitionVersion(
      "yahoo-nasdaq100-technicals",
      1,
    );
    const v2 = await stores.definitions.getDefinitionVersion(
      "yahoo-nasdaq100-technicals",
      2,
    );
    expect((v1 as { config: { marker: string } }).config.marker).toBe("first");
    expect((v2 as { config: { marker: string } }).config.marker).toBe("second");
  });
});

describe("5865-P02 a version is immutable", () => {
  it("re-saving the same version does not rewrite the recorded definition", async () => {
    const stores = createInMemoryJobPipelineStores();
    await stores.definitions.saveDefinition(definition(1, "original"));
    await stores.definitions.saveDefinition(definition(1, "tampered"));

    const v1 = await stores.definitions.getDefinitionVersion(
      "yahoo-nasdaq100-technicals",
      1,
    );
    expect((v1 as { config: { marker: string } }).config.marker).toBe("original");
  });
});

describe("5865-P03 an unknown version is null, never today's definition", () => {
  it("refuses to answer with the current config", async () => {
    const stores = createInMemoryJobPipelineStores();
    await stores.definitions.saveDefinition(definition(1, "only"));
    const missing = await stores.definitions.getDefinitionVersion(
      "yahoo-nasdaq100-technicals",
      99,
    );
    expect(missing).toBeNull();
  });
});

describe("5865-P04 the backfill is idempotent and seeds from the pointer", () => {
  it("inserts only missing rows, from job_pipeline_definitions", () => {
    expect(JOB_PIPELINE_DEFINITION_VERSIONS_BACKFILL).toContain("INSERT OR IGNORE");
    expect(JOB_PIPELINE_DEFINITION_VERSIONS_BACKFILL).toContain(
      "FROM job_pipeline_definitions",
    );
    expect(JOB_PIPELINE_DEFINITION_VERSIONS_BACKFILL).toContain("job_id || ':' || version");
  });
});

describe("5865-P05 the D1 migration 0074 creates the table", () => {
  it("builds the CREATE TABLE from the catalogue", () => {
    const sql = d1MigrationSql(74);
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS job_pipeline_definition_versions");
    expect(sql).toContain("id TEXT PRIMARY KEY");
    expect(sql).toContain("definition_json TEXT NOT NULL");
  });
});

describe("5865-P06 the D1 residency backfills too, not just the DO one", () => {
  it("migration 0074 carries the idempotent backfill after the CREATE", () => {
    const sql = d1MigrationSql(74);
    expect(sql).toContain("INSERT OR IGNORE INTO job_pipeline_definition_versions");
    expect(sql).toContain("FROM job_pipeline_definitions");
    // The table must exist before the backfill selects from the pointer.
    expect(sql.indexOf("CREATE TABLE IF NOT EXISTS")).toBeLessThan(
      sql.indexOf("INSERT OR IGNORE INTO"),
    );
  });
});
