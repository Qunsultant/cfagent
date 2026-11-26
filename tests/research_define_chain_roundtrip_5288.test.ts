import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";

/** Minimal D1Database stand-in over node:sqlite (the #6101 suite's double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    return {
      bind(...params: unknown[]) {
        return {
          async run() {
            const info = db.prepare(sql).run(...(params as any[]));
            return {
              success: true,
              meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
              results: [],
            };
          },
          async all() {
            return { results: db.prepare(sql).all(...(params as any[])) };
          },
          async first() {
            return db.prepare(sql).get(...(params as any[])) ?? null;
          },
          async raw() {
            return db
              .prepare(sql)
              .all(...(params as any[]))
              .map((row: any) => Object.values(row));
          },
        };
      },
    };
  }
}

const sharedStores = createInMemoryJobPipelineStores();
vi.mock("../src/data/createJobPipelinePorts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/createJobPipelinePorts")>();
  return {
    ...actual,
    createJobPipelineStoresFromSql: vi.fn(() => sharedStores),
  };
});

import {
  DefinePipelineChainCommand,
  RunResearchJobCommand,
} from "../src/mcps/openaimp/researchJobCommands";

describe("Issue #5288 — Wire define_pipeline_chain onto shared durable stores & addressable execution", () => {
  it("defines a chain addressable by run_research_job across invocations via shared durable stores", async () => {
    // Issue #6101 — the research engine's run recorder is D1-only
    // and fail-closed: without a bound AGENT_DB the run cannot be
    // recorded and the run fails by name. The harness binds a mock
    // D1, as production always does.
    const d1 = new MockD1Database() as unknown as D1Database;
    const ctx = {
      actingLogin: () => "alice",
      audit: () => {},
      env: { AGENT_DB: d1 },
      orm: {},
    } as any;

    const defineCmd = new DefinePipelineChainCommand();
    const defined = await defineCmd.execute(
      {
        jobId: "custom-roundtrip-1",
        stages: ["feed", "analyze", "evaluate"],
      },
      ctx,
    );

    expect(defined).toMatchObject({
      ok: true,
      jobId: "custom-roundtrip-1",
      engineJobId: "research:custom-roundtrip-1",
      runId: "custom-roundtrip-1",
      storageMode: "durable",
      ephemeralFallback: false,
    });

    const runCmd = new RunResearchJobCommand();
    const stageRun = await runCmd.execute(
      {
        runId: "custom-roundtrip-1",
        stageId: "analyze",
        op: "run",
      },
      ctx,
    );

    expect(stageRun).toMatchObject({
      ok: true,
      engineJobId: "research:custom-roundtrip-1",
      stageId: "analyze",
      op: "run",
      storageMode: "durable",
      ephemeralFallback: false,
      jobState: "completed",
    });
  });
});
