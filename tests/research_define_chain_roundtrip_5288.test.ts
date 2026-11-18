import { describe, expect, it, vi } from "vitest";
import {
  DefinePipelineChainCommand,
  RunResearchJobCommand,
} from "../src/mcps/openaimp/researchJobCommands";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import * as researchScreenEngine from "../src/workflows/researchScreenEngine";

describe("Issue #5288 — Wire define_pipeline_chain onto shared durable stores & addressable execution", () => {
  it("defines a chain addressable by run_research_job across invocations via shared stores", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runRecorder = jobRunRecorderFromStore(new InMemoryJobRunRecordStore());
    const spy = vi
      .spyOn(researchScreenEngine, "resolveResearchEngineAdapters")
      .mockReturnValue({
        storageMode: "durable",
        ephemeralFallback: false,
        stores,
        runRecorder,
      });

    try {
      const ctx = {
        actingLogin: () => "alice",
        audit: () => {},
        env: {},
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
        jobState: "completed",
      });
    } finally {
      spy.mockRestore();
    }
  });
});
