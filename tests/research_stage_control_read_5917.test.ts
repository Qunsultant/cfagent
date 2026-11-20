// @vitest-environment node
/**
 * Issue #5917 — the stage list a page needs before it can offer stage control.
 *
 * Pins:
 *  - 5917-P01 six stages, in pipeline order, every one "pending" for a run
 *    that never started — the read never invents a status;
 *  - 5917-P02 the read is keyed by the run id and names the engine job
 *    (`research:<runId>`), so the page can address the same run the engine has;
 *  - 5917-P03 an idle instance reads idle (no fabricated "running").
 */
import { describe, it, expect } from "vitest";
import { readResearchStages } from "../src/workflows/researchScreenEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";

const stores = () => createInMemoryJobPipelineStores();

describe("5917-P01 six stages, pending, for a run that never started", () => {
  it("returns the pipeline order and no invented status", async () => {
    const read = await readResearchStages({
      runId: "r-never-ran",
      userLogin: "trader@example.com",
      stores: stores(),
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    });

    expect(read.stages.map((s) => s.stageId)).toEqual([
      "feed",
      "enrich",
      "analyze",
      "generate",
      "deliver",
      "evaluate",
    ]);
    for (const stage of read.stages) {
      expect(stage.status).toBe("pending");
      expect(stage.startedAt).toBeNull();
      expect(stage.endedAt).toBeNull();
    }
  });
});

describe("5917-P02 the read is keyed by the run id", () => {
  it("names the engine job the page must address", async () => {
    const read = await readResearchStages({
      runId: "abc123",
      userLogin: "trader@example.com",
      stores: stores(),
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    });

    expect(read.engineJobId).toBe("research:abc123");
  });
});

describe("5917-P03 an idle instance reads idle", () => {
  it("does not fabricate a running state", async () => {
    const read = await readResearchStages({
      runId: "idle-run",
      userLogin: "trader@example.com",
      stores: stores(),
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    });

    expect(read.jobState).toBe("idle");
    expect(read.engineRunId).toBeNull();
  });
});
