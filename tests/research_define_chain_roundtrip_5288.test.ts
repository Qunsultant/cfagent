import { describe, expect, it, vi } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";

const sharedStores = createInMemoryJobPipelineStores();
const sharedRunStore = new InMemoryJobRunRecordStore();

vi.mock("../src/data/createJobPipelinePorts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/createJobPipelinePorts")>();
  return {
    ...actual,
    createJobPipelineStoresFromSql: vi.fn(() => sharedStores),
  };
});

vi.mock("../src/data/doSqliteJobRunRecordAdapter", () => ({
  SqlJobRunRecordStore: vi.fn(function () {
    return sharedRunStore;
  }),
}));

import {
  DefinePipelineChainCommand,
  RunResearchJobCommand,
} from "../src/mcps/openaimp/researchJobCommands";

describe("Issue #5288 — Wire define_pipeline_chain onto shared durable stores & addressable execution", () => {
  it("defines a chain addressable by run_research_job across invocations via shared durable stores", async () => {
    const ctx = {
      actingLogin: () => "alice",
      audit: () => {},
      env: {},
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
