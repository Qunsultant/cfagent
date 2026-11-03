// @vitest-environment node
/**
 * Issue #2989 — migration 0038 adds workflow_run_id to
 * agent_shard_jobs; the D1 adapter round-trips it.
 *
 * RED FIRST: migration 0038 does not exist yet and the D1
 * adapter's recordJob/toRow do not map the column.
 * MockD1Database mirrors tests/data_foundation_slice2.test.ts.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  createD1ShardJobDb,
  D1ShardJobAdapter,
  ensureShardJobSchema,
} from "../src/data/d1ShardJobAdapter";
import {
  applyMigrations,
  MIGRATION_0003_AGENT_SHARD_JOBS,
  MIGRATION_0038_AGENT_SHARD_JOBS_WORKFLOW_RUN_ID,
} from "../src/data/migrationRunner";

/** Minimal D1Database stand-in over node:sqlite (test-only, same as slices 0/1). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as never[]));
            return {
              success: true,
              meta: {
                changes: info.changes,
                last_row_id: info.lastInsertRowid,
              },
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as never[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as never[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as never[]))
              .map((row: unknown) => Object.values(row as Record<string, unknown>));
          },
        };
      },
    };
  }
  async batch(statements: Array<{ run: () => Promise<unknown> }>) {
    const results: unknown[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) {
        results.push(await stmt.run());
      }
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

describe("migration 0038: workflow_run_id on agent_shard_jobs (#2989)", () => {
  it("applies after 0003, adds the column, and D1 round-trips it", async () => {
    const mock = new MockD1Database();
    const db = createD1ShardJobDb(mock as never);
    const applied = await applyMigrations(db, [
      MIGRATION_0003_AGENT_SHARD_JOBS,
      MIGRATION_0038_AGENT_SHARD_JOBS_WORKFLOW_RUN_ID,
    ]);
    expect(applied).toContain(38);
    const cols = mock.sqlite
      .prepare("PRAGMA table_info(agent_shard_jobs)")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain("workflow_run_id");
    // ensureShardJobSchema is idempotent over an already-migrated table.
    await ensureShardJobSchema(db);
    const adapter = new D1ShardJobAdapter(db);
    await adapter.recordJob({
      tenantId: "t1",
      workspaceId: "t1",
      chainId: "chain-1",
      jobKey: "shard:a",
      version: 1,
      status: "completed",
      stage: "analysis",
      capabilityId: "screener",
      detail: "Shard a completed.",
      resultJson: "{}",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      provenanceWriter: "test",
      provenanceSourceDo: "ScreenerWorkflow",
      provenanceSourceVersion: "1",
      workflowRunId: "screen-fallbackhex",
    });
    const row = await adapter.latestJob("t1", "chain-1", "shard:a");
    expect(row?.workflowRunId).toBe("screen-fallbackhex");
  });

  it("rows without a run id read back undefined (nullable column)", async () => {
    const mock = new MockD1Database();
    const db = createD1ShardJobDb(mock as never);
    await applyMigrations(db, [
      MIGRATION_0003_AGENT_SHARD_JOBS,
      MIGRATION_0038_AGENT_SHARD_JOBS_WORKFLOW_RUN_ID,
    ]);
    const adapter = new D1ShardJobAdapter(db);
    await adapter.recordJob({
      tenantId: "t1",
      workspaceId: "t1",
      chainId: "chain-1",
      jobKey: "shard:a",
      version: 1,
      status: "completed",
      stage: "analysis",
      capabilityId: "screener",
      detail: "Shard a completed.",
      resultJson: "{}",
      createdAtMs: 1000,
      updatedAtMs: 1000,
      provenanceWriter: "test",
      provenanceSourceDo: "ScreenerWorkflow",
      provenanceSourceVersion: "1",
    });
    const row = await adapter.latestJob("t1", "chain-1", "shard:a");
    expect(row?.workflowRunId).toBeUndefined();
  });
});
