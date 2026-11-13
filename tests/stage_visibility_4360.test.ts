// @vitest-environment node
/**
 * Issue #4360 ([Stage visibility] started event + stage-store persistence).
 *
 * Pins:
 *  - 4360-P01 the stage contract gains a `started` action; a start event
 *    carries `startedAt`, a terminal event carries `endedAt`.
 *  - 4360-P02 the engine publishes `started` the moment a unit starts, and
 *    every terminal publish carries the same stamps the checkpoint holds
 *    (persist → checkpoint → publish, order unchanged).
 *  - 4360-P03 the consumer persists every `job.stage.*` envelope into the
 *    stage store, deduplicated so a re-delivered publication is ignored.
 *  - 4360-P04 a store failure is a `retry`, never a silent ack-and-drop.
 *  - 4360-P05 the DO-SQLite store keeps one row per publication and lists a
 *    run's events in recorded order.
 *  - 4360-P06 a started event with no terminal event is visible in the store
 *    (in-flight visibility), and a failed unit records its error.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { JobStepRegistry } from "../src/services/jobPipelineSteps";
import {
  jobStageActionEvent,
  type JobStageActionInput,
} from "../src/services/jobPipelineEvents";
import type { MessageEnvelope, MessagePublisher, PublishReport } from "../src/messaging/messagingPorts";
import {
  createJobPipelineEventsHandler,
  type JobPipelineEventsHandlerDeps,
} from "../src/messaging/jobPipelineEventsConsumer";
import { stageEventFromEnvelope } from "../src/services/jobStageEvents";
import { createInMemoryJobStageEventStore } from "../src/data/inMemoryJobStageEventAdapter";
import { createDoSqliteJobStageEventStore } from "../src/data/doSqliteJobStageEventAdapter";
import type { SqlStorage } from "../src/orm";

const T0 = Date.parse("2026-11-13T12:00:00.000Z");

function tickingClock(startMs: number) {
  let current = startMs;
  return () => {
    const at = new Date(current);
    current += 1000;
    return at;
  };
}

function noopRegistry(): JobStepRegistry {
  const registry = new JobStepRegistry();
  registry.register("noop", async (ctx) => ({ output: ctx.input }));
  return registry;
}

const SIX_STAGES = ["feed", "enrich", "analyze", "store", "serve", "deliver"] as const;

function sixStageConfig(jobId: string) {
  let node: Record<string, unknown> | undefined;
  for (let i = SIX_STAGES.length - 1; i >= 0; i -= 1) {
    const next: Record<string, unknown> = {
      kind: SIX_STAGES[i],
      steps: [{ step: "noop" }],
      processing: { shards: ["shard-1"] },
      ...(node ? { children: [node] } : {}),
    };
    node = next;
  }
  return { jobId, name: `Screen ${jobId}`, root: node };
}

function recordingPublisher(): MessagePublisher & { envelopes: MessageEnvelope[] } {
  const envelopes: MessageEnvelope[] = [];
  return {
    envelopes,
    publish: async (envelope: MessageEnvelope): Promise<PublishReport> => {
      envelopes.push(envelope);
      return { deliveredTo: ["job-pipeline-events"], failedTo: [] };
    },
  };
}

async function runSixStageJob(jobId = "screen-4360") {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const publisher = recordingPublisher();
  const control = new JobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher,
    steps: noopRegistry(),
    now: tickingClock(T0),
  });
  await control.defineJob(sixStageConfig(jobId));
  const dispatch = await control.runJob(jobId, { trigger: "manual" });
  const outcome = dispatch.completion ? await dispatch.completion : null;
  const instance = await stores.instances.getInstance(jobId);
  return { stores, runStore, publisher, control, outcome, instance };
}

function stageEvent(input: Partial<JobStageActionInput> = {}): MessageEnvelope {
  return jobStageActionEvent({
    jobId: "screen-4360",
    runId: "run-1",
    stageId: "job:root",
    action: "started",
    at: new Date(T0).toISOString(),
    ...input,
  });
}

function handlerDeps(over: Partial<JobPipelineEventsHandlerDeps> = {}): JobPipelineEventsHandlerDeps {
  return {
    routeCompletion: async () => {},
    ...over,
  };
}

describe("4360-P01 the contract carries start and end stamps", () => {
  it("publishes job.stage.started with startedAt", () => {
    const envelope = stageEvent({ action: "started", startedAt: "2026-11-13T12:00:01.000Z" });
    expect(envelope.type).toBe("job.stage.started");
    const data = envelope.data as Record<string, unknown>;
    expect(data.startedAt).toBe("2026-11-13T12:00:01.000Z");
    expect(data.endedAt).toBeUndefined();
    expect(data.idempotencyKey).toBe("run-1::jobs::job:root");
  });

  it("publishes a terminal action with endedAt", () => {
    const envelope = stageEvent({
      action: "completed",
      startedAt: "2026-11-13T12:00:01.000Z",
      endedAt: "2026-11-13T12:00:03.000Z",
    });
    const data = envelope.data as Record<string, unknown>;
    expect(envelope.type).toBe("job.stage.completed");
    expect(data.endedAt).toBe("2026-11-13T12:00:03.000Z");
    expect(data.startedAt).toBe("2026-11-13T12:00:01.000Z");
  });
});

describe("4360-P02 the engine publishes the start the moment it happens", () => {
  it("emits one started and one completed per stage, in that order", async () => {
    const h = await runSixStageJob();
    expect(h.outcome?.state).toBe("completed");
    const stageTypes = h.publisher.envelopes
      .map((e) => e.type)
      .filter((t) => t.startsWith("job.stage."));
    expect(stageTypes.filter((t) => t === "job.stage.started")).toHaveLength(6);
    expect(stageTypes.filter((t) => t === "job.stage.completed")).toHaveLength(6);
    // Per stage, its start precedes its completion.
    const byStage = new Map<string, string[]>();
    for (const envelope of h.publisher.envelopes) {
      if (!envelope.type.startsWith("job.stage.")) continue;
      const data = envelope.data as Record<string, unknown>;
      const key = String(data.stageId);
      byStage.set(key, [...(byStage.get(key) ?? []), envelope.type]);
    }
    for (const types of byStage.values()) {
      expect(types.indexOf("job.stage.started")).toBeLessThan(
        types.indexOf("job.stage.completed"),
      );
    }
  });

  it("carries the checkpoint's own stamps on the events", async () => {
    const h = await runSixStageJob();
    const units = h.instance?.stageCheckpoint?.units ?? [];
    const completed = h.publisher.envelopes.filter((e) => e.type === "job.stage.completed");
    expect(completed).toHaveLength(6);
    for (const envelope of completed) {
      const data = envelope.data as Record<string, unknown>;
      const unit = units.find(
        (u) => u.stage === data.stageId && u.unitId === data.unitId,
      );
      expect(unit).toBeTruthy();
      expect(data.startedAt).toBe(unit!.startedAt);
      expect(data.endedAt).toBe(unit!.endedAt);
    }
  });
});

describe("4360-P03 the consumer persists every stage event, once", () => {
  it("records a start and a terminal event, and ignores a re-delivery", async () => {
    const store = createInMemoryJobStageEventStore();
    const handler = createJobPipelineEventsHandler(handlerDeps({ recordStageEvent: store.record }));
    const started = stageEvent({ action: "started", startedAt: "2026-11-13T12:00:01.000Z" });
    const completed = stageEvent({
      action: "completed",
      at: "2026-11-13T12:00:03.000Z",
      startedAt: "2026-11-13T12:00:01.000Z",
      endedAt: "2026-11-13T12:00:03.000Z",
    });
    expect(await handler(started)).toBe("processed");
    expect(await handler(completed)).toBe("processed");
    expect(await handler(completed)).toBe("processed");
    const rows = await store.listByRun("run-1");
    expect(rows.map((r) => r.action)).toEqual(["started", "completed"]);
  });

  it("does not touch non-stage envelopes", async () => {
    const store = createInMemoryJobStageEventStore();
    const handler = createJobPipelineEventsHandler(handlerDeps({ recordStageEvent: store.record }));
    const outcome = await handler({
      ...stageEvent(),
      type: "job.completed",
      data: { jobId: "screen-4360", runId: "run-1", state: "completed" },
    });
    expect(outcome).toBe("processed");
    expect(await store.listByRun("run-1")).toEqual([]);
  });
});

describe("4360-P04 a store failure retries", () => {
  it("returns retry rather than dropping the event", async () => {
    const handler = createJobPipelineEventsHandler(
      handlerDeps({
        recordStageEvent: async () => {
          throw new Error("stage store unavailable");
        },
      }),
    );
    expect(await handler(stageEvent())).toBe("retry");
  });
});

describe("4360-P05 the DO-SQLite store keeps one row per publication", () => {
  function sqlDouble(): SqlStorage {
    const sqlite = new DatabaseSync(":memory:");
    return {
      exec: (query: string, ...params: unknown[]) => {
        const stmt = sqlite.prepare(query);
        if (/^\s*(SELECT|PRAGMA)/i.test(query)) return stmt.all(...(params as never[])) as never;
        stmt.run(...(params as never[]));
        return [] as never;
      },
    } as unknown as SqlStorage;
  }

  it("dedups on the claim key + action + instant and lists in order", async () => {
    const store = createDoSqliteJobStageEventStore(sqlDouble());
    const started = stageEventFromEnvelope(
      stageEvent({ action: "started", startedAt: "2026-11-13T12:00:01.000Z" }),
    )!;
    const completed = stageEventFromEnvelope(
      stageEvent({
        action: "completed",
        at: "2026-11-13T12:00:03.000Z",
        startedAt: "2026-11-13T12:00:01.000Z",
        endedAt: "2026-11-13T12:00:03.000Z",
      }),
    )!;
    expect(await store.record(started)).toBe(true);
    expect(await store.record(started)).toBe(false);
    expect(await store.record(completed)).toBe(true);
    const rows = await store.listByRun("run-1");
    expect(rows.map((r) => r.action)).toEqual(["started", "completed"]);
    expect(rows[0].startedAt).toBe("2026-11-13T12:00:01.000Z");
    expect(rows[1].endedAt).toBe("2026-11-13T12:00:03.000Z");
  });
});

describe("4360-P07 the host exposes the persistence seam", () => {
  it("the agent records and lists stage events; the door carries both", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const agent = readFileSync(join(here, "..", "src/agents/scheduled-agent.ts"), "utf8");
    expect(agent).toContain("async recordStageEvent(");
    expect(agent).toContain("async listStageEvents(");
    const door = readFileSync(join(here, "..", "src/agents/orchestrator/meshDoors.ts"), "utf8");
    expect(door).toContain("recordStageEvent(event: JobStageEventRecord)");
    expect(door).toContain("listStageEvents(runId: string)");
  });
});

describe("4360-P06 in-flight and failure visibility", () => {
  it("leaves a started row without a terminal row while running", async () => {
    const store = createInMemoryJobStageEventStore();
    await store.record(
      stageEventFromEnvelope(
        stageEvent({ action: "started", startedAt: "2026-11-13T12:00:01.000Z" }),
      )!,
    );
    const rows = await store.listByRun("run-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].endedAt).toBeNull();
  });

  it("records a failed unit's error and end stamp", async () => {
    const store = createInMemoryJobStageEventStore();
    await store.record(
      stageEventFromEnvelope(
        stageEvent({
          action: "failed",
          at: "2026-11-13T12:00:05.000Z",
          startedAt: "2026-11-13T12:00:01.000Z",
          endedAt: "2026-11-13T12:00:05.000Z",
          detail: "FEED_JOB_NOT_CONFIGURED",
        }),
      )!,
    );
    const [row] = await store.listByRun("run-1");
    expect(row.action).toBe("failed");
    expect(row.endedAt).toBe("2026-11-13T12:00:05.000Z");
    expect(row.detail).toContain("FEED_JOB_NOT_CONFIGURED");
  });
});
