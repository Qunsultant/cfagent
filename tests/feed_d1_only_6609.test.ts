// @vitest-environment node
/**
 * Issue #6609 — the ScheduledAgent feed path is D1-only.
 *
 * Pins:
 *  - the host control defines pipeline jobs in D1 without touching DO
 *    SQLite or DO blob storage;
 *  - feed deps build their capture provider from the D1 capture port +
 *    R2 blob seam and read shard config from D1 definitions;
 *  - ScheduledAgent stage events are D1-authoritative;
 *  - an unbound AGENT_DB refuses by name instead of falling back to DO.
 */
import { describe, expect, it } from "vitest";
import {
  createScheduledAgentPipelineControl,
  createScheduledAgentStageEventStore,
  ensureScheduledAgentPipelineJobs,
  feedStepDepsForScheduledAgent,
  type ScheduledTasksPipelineContext,
} from "../src/agents/scheduledTasksPipeline";
import { createJobPipelineStoresFromD1 } from "../src/data/createJobPipelinePorts";
import { createD1JobStageEventStore } from "../src/data/d1JobStageEventAdapter";
import type { Env } from "../src/types";
import { MockD1Database } from "./mock-d1";

function makeFakeBucket() {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>();
  return {
    async put(key: string, value: Uint8Array | string, options?: Record<string, unknown>) {
      objects.set(key, {
        bytes: typeof value === "string" ? new TextEncoder().encode(value) : value,
        customMetadata: options?.customMetadata as Record<string, string> | undefined,
      });
    },
    async get(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        async arrayBuffer() {
          return obj.bytes.buffer.slice(
            obj.bytes.byteOffset,
            obj.bytes.byteOffset + obj.bytes.byteLength,
          ) as ArrayBuffer;
        },
        async text() {
          return new TextDecoder().decode(obj.bytes);
        },
        httpMetadata: {},
        customMetadata: obj.customMetadata ?? {},
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list() {
      return { objects: [...objects.keys()].map((key) => ({ key })), truncated: false };
    },
  };
}

function makeContext(env: Partial<Env>): ScheduledTasksPipelineContext {
  const storage: Record<string, unknown> = {
    get: async () => {
      throw new Error("DO storage get accessed on the feed path");
    },
    put: async () => {
      throw new Error("DO storage put accessed on the feed path");
    },
  };
  Object.defineProperty(storage, "sql", {
    get() {
      throw new Error("DO sql accessed on the feed path");
    },
  });
  return {
    env: env as Env,
    agentCtx: { storage } as unknown as ScheduledTasksPipelineContext["agentCtx"],
  };
}

describe("#6609 ScheduledAgent feed path D1-only", () => {
  it("defines jobs in D1 and builds feed deps without DO sql or DO blob storage", async () => {
    const d1 = new MockD1Database();
    const ctx = makeContext({
      AGENT_DB: d1 as unknown as Env["AGENT_DB"],
      REPORTS_BUCKET: makeFakeBucket() as unknown as Env["REPORTS_BUCKET"],
    });

    const control = createScheduledAgentPipelineControl(ctx);
    await ensureScheduledAgentPipelineJobs(ctx, control);

    const stores = createJobPipelineStoresFromD1(d1 as never);
    const definition = await stores.definitions.getDefinition("yahoo-nasdaq100-quotes");
    expect(definition).toBeTruthy();

    const feedDeps = feedStepDepsForScheduledAgent(ctx);
    const def = feedDeps.registry.get("yahoo-nasdaq100-quotes")!;
    expect(feedDeps.providerFor(def)).toBeTruthy();
    expect(await feedDeps.shardsFor?.("yahoo-nasdaq100-quotes")).toEqual(
      definition!.config.processing.shards,
    );
  });

  it("records ScheduledAgent stage events in D1", async () => {
    const d1 = new MockD1Database();
    const ctx = makeContext({ AGENT_DB: d1 as unknown as Env["AGENT_DB"] });
    const store = createScheduledAgentStageEventStore(ctx);
    await store.record({
      eventKey: "r-6609:job:0:terminal",
      claimKey: "r-6609::job:0",
      runId: "r-6609",
      jobId: "yahoo-nasdaq100-quotes",
      stageId: "feed",
      unitId: null,
      action: "terminal",
      at: "2026-11-27T00:00:05.000Z",
      startedAt: "2026-11-27T00:00:00.000Z",
      endedAt: "2026-11-27T00:00:05.000Z",
      detail: null,
      stageStatus: "completed",
      durationMs: 5000,
      unitCount: 1,
      failedUnitCount: 0,
      resultRef: "feed/r-6609",
      definitionVersion: 1,
    });

    const rows = await createD1JobStageEventStore(d1 as never).listByRun("r-6609");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ jobId: "yahoo-nasdaq100-quotes", stageId: "feed" });
  });

  it("refuses by name when AGENT_DB is unbound", () => {
    const ctx = makeContext({});
    let thrown: unknown;
    try {
      createScheduledAgentPipelineControl(ctx);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as { code?: string })?.code).toBe("job_stores_unavailable");
    const feedDeps = feedStepDepsForScheduledAgent(ctx);
    expect(feedDeps.universeStore).toBeNull();
    expect(feedDeps.indexRefresh).toBeNull();
  });
});
