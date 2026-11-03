/**
 * Issue #2989 — the Cloudflare workflow run-id as a correlation id on
 * job records, via the ONE seam (workflowInstanceSeam).
 *
 * RED FIRST: ShardJobRow has no workflowRunId yet,
 * projectLegOutcomes drops the field, and recordSagaProjectionRow
 * takes no workflowRunId.
 *
 * The correlation field IS the Cloudflare workflow id: binding
 * create() returns only instance.id and status() returns only
 * status/output/error, so the id used at start (derived or
 * fallback) is the id get()/status() address the instance by.
 * No second field is invented.
 */
import { describe, expect, it } from "vitest";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { agentShardJobs } from "../src/data/drizzleSchema";
import { InMemoryShardJobAdapter } from "../src/data/inMemoryShardJobAdapter";
import { projectLegOutcomes } from "../src/data/shardJobProjection";
import { recordSagaProjectionRow } from "../src/agents/routes/sagaStatus";

describe("shard job row carries the workflow run id (#2989)", () => {
  it("in-memory round-trip preserves workflowRunId", async () => {
    const store = new InMemoryShardJobAdapter();
    await store.recordJob({
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
    const row = await store.latestJob("t1", "chain-1", "shard:a");
    expect(row?.workflowRunId).toBe("screen-fallbackhex");
  });

  it("drizzle schema carries workflow_run_id", () => {
    const rawColumns = getTableConfig(agentShardJobs as never).columns as never;
    const schemaColumns = Array.isArray(rawColumns)
      ? (rawColumns as Array<{ name: string }>).map((c) => c.name)
      : Object.keys(rawColumns).map((s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`));
    expect(schemaColumns).toContain("workflow_run_id");
  });

  it("projectLegOutcomes passes workflowRunId onto the row", async () => {
    const store = new InMemoryShardJobAdapter();
    await projectLegOutcomes({
      store,
      tenantId: "t1",
      workspaceId: "t1",
      chainId: "chain-1",
      legs: [
        {
          stepId: "shard:a",
          capabilityId: "screener",
          stage: "analysis",
          status: "completed",
          detail: "Shard a completed.",
          result: { shardJobIds: ["shard:a"], result: { shardId: "a", status: "completed" } },
          workflowRunId: "screen-childhex",
        },
      ],
      nowMs: 5000,
      writer: "test",
      provenanceSourceDo: "ScreenerWorkflow",
    });
    const row = await store.latestJob("t1", "chain-1", "shard:a");
    expect(row?.workflowRunId).toBe("screen-childhex");
  });

  it("a same-status leg carrying a missing run id fills it at version+1 (not a replay skip)", async () => {
    const store = new InMemoryShardJobAdapter();
    const leg = (workflowRunId?: string) => ({
      stepId: "shard:a",
      capabilityId: "screener",
      stage: "analysis",
      status: "completed" as const,
      detail: "Shard a completed.",
      result: { shardJobIds: ["shard:a"], result: { shardId: "a", status: "completed" } },
      ...(workflowRunId ? { workflowRunId } : {}),
    });
    const project = (legs: ReturnType<typeof leg>[]) =>
      projectLegOutcomes({
        store,
        tenantId: "t1",
        workspaceId: "t1",
        chainId: "chain-1",
        legs,
        nowMs: 5000,
        writer: "test",
        provenanceSourceDo: "ScreenerWorkflow",
      });
    await project([leg()]);
    const v1 = await store.latestJob("t1", "chain-1", "shard:a");
    expect(v1?.version).toBe(1);
    expect(v1?.workflowRunId).toBeUndefined();
    // The parent's deliver leg re-projects the same status but now
    // knows the child instance id: the row gains it at version+1.
    await project([leg("screen-childhex")]);
    const v2 = await store.latestJob("t1", "chain-1", "shard:a");
    expect(v2?.version).toBe(2);
    expect(v2?.workflowRunId).toBe("screen-childhex");
    // A further identical replay is a no-op again.
    await project([leg("screen-childhex")]);
    const v3 = await store.latestJob("t1", "chain-1", "shard:a");
    expect(v3?.version).toBe(2);
  });

  it("saga entry projection row carries the seam-started workflow id", async () => {
    const store = new InMemoryShardJobAdapter();
    await recordSagaProjectionRow(store, {
      sagaId: "saga-1",
      runRequestId: "req-1",
      tenantId: "t1",
      statusUrl: "/api/saga/saga-1/status",
      workflowRunId: "saga-saga-1",
    });
    const row = await store.latestJob("t1", "saga-1", "saga");
    expect(row?.workflowRunId).toBe("saga-saga-1");
  });
});
