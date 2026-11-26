import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { jobRunRecorderFromStore } from "../src/services/jobPipelineEngine";
import { runDeterministicResearchViaDoor } from "../src/agents/orchestrator/meshResearchDoor.deprecated";
import { RunResearchJobCommand } from "../src/mcps/openaimp/researchJobCommands";
import {
  dispatchResearchEngineRun,
  executeResearchStageControl,
} from "../src/workflows/researchScreenEngine";

describe("Issue #5286 — Door + MCP research dispatch/control on durable stores", () => {
  it("persists door-dispatched research:<runId> on shared stores so stage control observes completed state instead of idle", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const runRecorder = jobRunRecorderFromStore(runStore);

    const doorRes = await runDeterministicResearchViaDoor({
      actingLogin: "alice",
      trigger: "manual",
      runId: "door-durable-1",
      stores,
      runRecorder,
    });

    expect(doorRes.skipped).toBe(false);
    expect(doorRes.storageMode).toBe("durable");
    expect(doorRes.ephemeralFallback).toBe(false);

    const statusRes = await executeResearchStageControl({
      runId: "door-durable-1",
      stageId: "analyze",
      op: "status",
      userLogin: "alice",
      stores,
      runRecorder,
    });

    expect(statusRes.storageMode).toBe("durable");
    expect(statusRes.ephemeralFallback).toBe(false);
    expect(statusRes.jobState).toBe("completed");
    expect(statusRes.stage?.kind).toBe("analyze");
  });

  it("surfaces a named ephemeralFallback state when no durable store is reachable", async () => {
    const res = await dispatchResearchEngineRun({
      runId: "ephemeral-1",
      userLogin: "alice",
      trigger: "manual",
      execute: async () => ({ ok: true }),
    });
    expect(res.storageMode).toBe("in-memory");
    expect(res.ephemeralFallback).toBe(true);
    expect(res.ephemeralReason).toBe("no_durable_store_reachable");

    const cmd = new RunResearchJobCommand();
    const mcpRes = (await cmd.execute(
      { trigger: "manual", runId: "mcp-ephemeral-1" },
      { actingLogin: () => "alice", audit: () => {}, env: {} } as any,
    )) as Record<string, unknown>;
    expect(mcpRes.engineJobId).toBe("research:mcp-ephemeral-1");
  });
});
