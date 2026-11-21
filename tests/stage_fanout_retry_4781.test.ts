// @vitest-environment node
/**
 * Issue #4781 S2 — externalize fan-out cap + retry-bucket +
 * processing.* as job-definition fields.
 *
 * Three per-stage values resolved from code, never from the job
 * definition — all in one choke point, `stageForNode`:
 *
 * - C3: fan-out cap 4 shards (`DEFAULT_MAX_PARALLEL_SHARDS`) —
 *   `stageForNode` never set `maxParallel`.
 * - C4: retry-bucket assignment per stage kind + default bucket
 *   `"report"` — `stageForNode` set it only for the five chain
 *   kinds; job stages fell back to `"report"`.
 * - B8: `processing.checkpointEverySteps` (default 1) — the
 *   definition field existed and was validated, but the define
 *   view never exposed it.
 *
 * This slice wires them (Decision 1): node fields `maxParallel?`,
 * `retryBucket?` on `JobNodeConfig`, beside S1's `timeoutMs`;
 * `stageForNode` reads them with today's constants as fallback;
 * the define view gains three per-stage fields (posted as
 * `stageMaxParallel` / `stageRetryBuckets` / `stageProcessing`,
 * applied onto the matching nodes). The runner contract already
 * honored per-stage declarations — S2 is wiring only.
 *
 * Validation is load-bearing (Decision 3): an unknown bucket today
 * flows to `policy.retry[unknown]` = `undefined`, and
 * `budget.maxAttempts` throws a TypeError mid-run — so the bucket
 * is refused by name at define time (400) and at resolve time,
 * and `stageForNode` refuses an invalid value that somehow reaches
 * the engine, never silently the default.
 *
 * Defaults are unchanged: 4 shards / table-or-"report" / 1.
 */
import { describe, expect, it } from "vitest";
import {
  JOB_STAGE_DEFAULT_RETRY_BUCKET,
  STAGE_RETRY_BUCKET,
  assertStageRunnerPlan,
  resolveStageRetryBudget,
  stageMaxParallel,
  stageRetryBucket,
  type StageRunnerPlan,
  type StageRunnerStage,
} from "../src/workflows/stageRunnerPorts";
import { fanoutCapExceeded, planRun, planStageFanout } from "../src/workflows/stageRunnerPlan";
import { DEFAULT_MAX_PARALLEL_SHARDS } from "../src/workflows/workflowPorts";
import {
  DEFAULT_PIPELINE_POLICY,
  RETRY_BUCKET_NAMES,
  isRetryBucketName,
} from "../src/services/pipelinePolicy";
import { resolveJobDefinition } from "../src/services/jobPipelineConfig";
import { bindStageOverrides } from "../src/services/jobDefinitionParamBinders";
import { buildJobConfigFromSpec } from "../src/services/jobDefinitionSpecBuilder";
import { handleJobDefinitionsRoutes } from "../src/agents/routes/jobDefinitions";
import type { JobDefinitionSpec } from "../src/config/jobDefinitionCatalog";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessageEnvelope, MessagingPorts } from "../src/messaging/messagingPorts";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry, type JobStepContext } from "../src/services/jobPipelineSteps";

const T0 = Date.parse("2026-11-06T12:00:00.000Z");

function runnerStage(overrides: Partial<StageRunnerStage> = {}): StageRunnerStage {
  return {
    stage: "feed",
    execution: "parallel",
    timeoutMs: 600_000,
    ...overrides,
  };
}

function runnerPlan(stages: StageRunnerStage[], unitIds: string[]): StageRunnerPlan {
  return planRun({
    runId: "run-1",
    invocation: "sync",
    stages,
    units: unitIds.map((unitId) => ({ unitId })),
  });
}

describe("retry-bucket names (#4781 S2, Decision 1)", () => {
  it("the bucket names are exactly the pipelinePolicy retry keys", () => {
    expect(RETRY_BUCKET_NAMES).toEqual(["acquisition", "delivery", "report"]);
    expect(RETRY_BUCKET_NAMES).toEqual(Object.keys(DEFAULT_PIPELINE_POLICY.retry));
  });

  it("isRetryBucketName accepts only the three policy keys", () => {
    for (const name of ["acquisition", "delivery", "report"]) {
      expect(isRetryBucketName(name)).toBe(true);
    }
    for (const raw of ["nosuch", "", "ACQUISITION", 3, null, undefined, {}]) {
      expect(isRetryBucketName(raw)).toBe(false);
    }
  });
});

describe("fan-out and bucket defaults (#4781 S2, Decision 2)", () => {
  it("a parallel stage without a cap runs under the 4-shard default", () => {
    expect(stageMaxParallel(runnerStage({}))).toBe(DEFAULT_MAX_PARALLEL_SHARDS);
    expect(stageMaxParallel(runnerStage({}))).toBe(4);
  });

  it("a node cap wins over the default", () => {
    expect(stageMaxParallel(runnerStage({ maxParallel: 2 }))).toBe(2);
  });

  it("a sequential stage ignores the cap", () => {
    expect(stageMaxParallel(runnerStage({ execution: "sequential", maxParallel: 2 }))).toBe(1);
  });

  it("a stage's own bucket wins over the table", () => {
    expect(stageRetryBucket(runnerStage({ retryBucket: "delivery" }))).toBe("delivery");
    expect(stageRetryBucket(runnerStage({ stage: "job:root", retryBucket: "acquisition" }))).toBe(
      "acquisition",
    );
  });

  it("absent, the table applies for chain stages and \"report\" for job stages", () => {
    expect(STAGE_RETRY_BUCKET.feed).toBe("acquisition");
    expect(stageRetryBucket(runnerStage({}))).toBe("acquisition");
    expect(JOB_STAGE_DEFAULT_RETRY_BUCKET).toBe("report");
    expect(stageRetryBucket(runnerStage({ stage: "job:root" }))).toBe("report");
  });

  it("the budget resolves from the policy table, never a call-site constant", () => {
    expect(
      resolveStageRetryBudget(DEFAULT_PIPELINE_POLICY, runnerStage({ retryBucket: "delivery" })),
    ).toEqual(DEFAULT_PIPELINE_POLICY.retry.delivery);
    expect(
      resolveStageRetryBudget(DEFAULT_PIPELINE_POLICY, runnerStage({ retryBucket: "report" }))
        .maxAttempts,
    ).toBe(2);
    expect(
      resolveStageRetryBudget(DEFAULT_PIPELINE_POLICY, runnerStage({ retryBucket: "acquisition" }))
        .maxAttempts,
    ).toBe(3);
  });

  it("planStageFanout caps at the stage's cap and names the deferred tail", () => {
    const plan = runnerPlan([runnerStage({ maxParallel: 2 })], ["a", "b", "c", "d", "e"]);
    const fanout = planStageFanout(plan.stages[0]!, plan.units);
    expect(fanout.maxParallel).toBe(2);
    expect(fanout.started.map((u) => u.unitId)).toEqual(["a", "b"]);
    expect(fanout.deferred.map((u) => u.unitId)).toEqual(["c", "d", "e"]);
    const reason = fanoutCapExceeded(fanout);
    expect(reason).toContain("3 unit(s) deferred");
    expect(reason).toContain("at maxParallel 2");
  });

  it("planStageFanout without a cap uses the 4-shard default", () => {
    const plan = runnerPlan([runnerStage({})], ["a", "b", "c", "d", "e"]);
    const fanout = planStageFanout(plan.stages[0]!, plan.units);
    expect(fanout.maxParallel).toBe(4);
    expect(fanout.deferred.map((u) => u.unitId)).toEqual(["e"]);
  });
});

describe("resolve-time maxParallel / retryBucket (#4781 S2, Decision 3)", () => {
  it("an invalid maxParallel is refused by name at resolve time", () => {
    for (const raw of [0, -1, 1.5, "2", Number.NaN]) {
      expect(() =>
        resolveJobDefinition({
          jobId: "bad-cap",
          root: { kind: "feed", maxParallel: raw, steps: [{ step: "track" }] },
        }),
      ).toThrow(/maxParallel/);
    }
  });

  it("an unknown bucket is refused by name at resolve time, naming the valid set", () => {
    for (const raw of ["nosuch", "", 3, null]) {
      expect(() =>
        resolveJobDefinition({
          jobId: "bad-bucket",
          root: { kind: "feed", retryBucket: raw, steps: [{ step: "track" }] },
        }),
      ).toThrow(/retryBucket/);
      expect(() =>
        resolveJobDefinition({
          jobId: "bad-bucket",
          root: { kind: "feed", retryBucket: raw, steps: [{ step: "track" }] },
        }),
      ).toThrow(/acquisition, delivery, report/);
    }
  });

  it("valid values are preserved through resolution, on children too", () => {
    const resolved = resolveJobDefinition({
      jobId: "good-fields",
      root: {
        kind: "feed",
        maxParallel: 2,
        retryBucket: "delivery",
        processing: { checkpointEverySteps: 3 },
        steps: [{ step: "track" }],
        children: [
          {
            kind: "analyze",
            maxParallel: 3,
            retryBucket: "acquisition",
            steps: [{ step: "track" }],
          },
        ],
      },
    });
    expect(resolved.root.maxParallel).toBe(2);
    expect(resolved.root.retryBucket).toBe("delivery");
    expect(resolved.root.processing?.checkpointEverySteps).toBe(3);
    expect(resolved.root.children?.[0]?.maxParallel).toBe(3);
    expect(resolved.root.children?.[0]?.retryBucket).toBe("acquisition");
  });

  it("an unset definition carries no new fields", () => {
    const resolved = resolveJobDefinition({
      jobId: "plain",
      root: { kind: "feed", steps: [{ step: "track" }] },
    });
    expect(resolved.root.maxParallel).toBeUndefined();
    expect(resolved.root.retryBucket).toBeUndefined();
    expect(resolved.root.processing).toBeUndefined();
  });
});

const TEST_SPEC: JobDefinitionSpec = {
  id: "test-def",
  name: "Test",
  version: 1,
  stages: [
    { kind: "feed", step: "track" },
    { kind: "analyze", step: "track" },
  ],
};

describe("define-time overrides (#4781 S2, Decision 4)", () => {
  it("valid stage values bind and land on the matching nodes", () => {
    const perStage = bindStageOverrides(TEST_SPEC, {
      stageMaxParallel: { feed: 2 },
      stageRetryBuckets: { feed: "delivery", analyze: "acquisition" },
      stageProcessing: { feed: { checkpointEverySteps: 3 } },
    });
    expect(perStage.maxParallel).toEqual({ feed: 2 });
    expect(perStage.retryBuckets).toEqual({ feed: "delivery", analyze: "acquisition" });
    expect(perStage.processing).toEqual({ feed: { checkpointEverySteps: 3 } });
    const raw = buildJobConfigFromSpec(TEST_SPEC, "test-job", {}, perStage);
    const root = raw.root as Record<string, unknown>;
    expect(root.maxParallel).toBe(2);
    expect(root.retryBucket).toBe("delivery");
    expect(root.processing).toEqual({ checkpointEverySteps: 3 });
    const child = (root.children as Array<Record<string, unknown>>)[0]!;
    expect(child.maxParallel).toBeUndefined();
    expect(child.retryBucket).toBe("acquisition");
    expect(child.processing).toBeUndefined();
  });

  it("an invalid cap is refused by name at define time", () => {
    for (const raw of [0, -1, 1.5, "2"]) {
      expect(() =>
        bindStageOverrides(TEST_SPEC, { stageMaxParallel: { feed: raw as never } }),
      ).toThrow(/feed/);
      expect(() =>
        bindStageOverrides(TEST_SPEC, { stageMaxParallel: { feed: raw as never } }),
      ).toThrow(/maxParallel/);
    }
  });

  it("an unknown bucket is refused by name at define time", () => {
    expect(() =>
      bindStageOverrides(TEST_SPEC, { stageRetryBuckets: { feed: "nosuch" as never } }),
    ).toThrow(/feed/);
    expect(() =>
      bindStageOverrides(TEST_SPEC, { stageRetryBuckets: { feed: "nosuch" as never } }),
    ).toThrow(/retryBucket/);
  });

  it("an invalid checkpoint interval is refused by name at define time", () => {
    for (const raw of [0, -1, 1.5, "3"]) {
      expect(() =>
        bindStageOverrides(TEST_SPEC, {
          stageProcessing: { feed: { checkpointEverySteps: raw as never } },
        }),
      ).toThrow(/feed/);
      expect(() =>
        bindStageOverrides(TEST_SPEC, {
          stageProcessing: { feed: { checkpointEverySteps: raw as never } },
        }),
      ).toThrow(/checkpointEverySteps/);
    }
  });

  it("an unknown stage is refused by name", () => {
    expect(() =>
      bindStageOverrides(TEST_SPEC, { stageMaxParallel: { nosuch: 2 } }),
    ).toThrow(/has no stage "nosuch"/);
    expect(() =>
      bindStageOverrides(TEST_SPEC, { stageRetryBuckets: { nosuch: "report" } }),
    ).toThrow(/has no stage "nosuch"/);
    expect(() =>
      bindStageOverrides(TEST_SPEC, { stageProcessing: { nosuch: { checkpointEverySteps: 2 } } }),
    ).toThrow(/has no stage "nosuch"/);
  });

  it("absent stage values change nothing", () => {
    const perStage = bindStageOverrides(TEST_SPEC, {});
    expect(perStage.maxParallel).toBeUndefined();
    expect(perStage.retryBuckets).toBeUndefined();
    expect(perStage.processing).toBeUndefined();
    const raw = buildJobConfigFromSpec(TEST_SPEC, "test-job", {}, perStage);
    const root = raw.root as Record<string, unknown>;
    expect(root.maxParallel).toBeUndefined();
    expect(root.retryBucket).toBeUndefined();
    expect(root.processing).toBeUndefined();
  });
});

describe("define route (#4781 S2, Decision 4)", () => {
  async function define(
    body: Record<string, unknown>,
    seen: Array<Record<string, unknown> | undefined>,
  ): Promise<Response> {
    const request = new Request("http://localhost/api/job-definitions/screener/define", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jobId: "test-job", ...body }),
    });
    const result = await handleJobDefinitionsRoutes(
      request,
      new URL(request.url),
      "/api/job-definitions/screener/define",
      {
        defineJobFromSpec: async (_specId, jobId, _params, overrides) => {
          seen.push({
            stageMaxParallel: overrides.stageMaxParallel,
            stageRetryBuckets: overrides.stageRetryBuckets,
            stageProcessing: overrides.stageProcessing,
          });
          return { jobId, name: "Test", version: 1, stages: 6 };
        },
      },
    );
    expect(result).not.toBeNull();
    return result!;
  }

  it("valid stage values reach the define call", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const response = await define(
      {
        stageMaxParallel: { feed: 2 },
        stageRetryBuckets: { feed: "delivery" },
        stageProcessing: { feed: { checkpointEverySteps: 3 } },
      },
      seen,
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        stageMaxParallel: { feed: 2 },
        stageRetryBuckets: { feed: "delivery" },
        stageProcessing: { feed: { checkpointEverySteps: 3 } },
      },
    ]);
  });

  it("numeric-string values are parsed", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const response = await define(
      {
        stageMaxParallel: { feed: "2" },
        stageProcessing: { feed: { checkpointEverySteps: "3" } },
      },
      seen,
    );
    expect(response.status).toBe(200);
    expect(seen).toEqual([
      {
        stageMaxParallel: { feed: 2 },
        stageRetryBuckets: undefined,
        stageProcessing: { feed: { checkpointEverySteps: 3 } },
      },
    ]);
  });

  it("an invalid cap refuses with 400, naming the stage", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const response = await define({ stageMaxParallel: { feed: 0 } }, seen);
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('Stage "feed"');
    expect(body.error).toContain("must be a positive integer");
  });

  it("an unknown bucket refuses with 400, naming the bucket", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const response = await define({ stageRetryBuckets: { feed: "nosuch" } }, seen);
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('Stage "feed"');
    expect(body.error).toContain("nosuch");
  });

  it("an invalid checkpoint interval refuses with 400", async () => {
    const seen: Array<Record<string, unknown> | undefined> = [];
    const response = await define(
      { stageProcessing: { feed: { checkpointEverySteps: 0 } } },
      seen,
    );
    expect(response.status).toBe(400);
    expect(seen).toEqual([]);
    const body = (await response.json()) as { error?: string };
    expect(body.error).toContain('Stage "feed"');
    expect(body.error).toContain("checkpointEverySteps");
  });

  it("the catalogue list carries the retry-bucket names for the define view", async () => {
    const request = new Request("http://localhost/api/job-definitions", {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    const result = await handleJobDefinitionsRoutes(
      request,
      new URL(request.url),
      "/api/job-definitions",
      {},
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    const body = (await result!.json()) as { retryBuckets?: string[] };
    expect(body.retryBuckets).toEqual(["acquisition", "delivery", "report"]);
  });
});

/* ------------------------------------------------------------------ */
/* Engine harness (mirrors tests/job_pipeline_3534.test.ts)             */
/* ------------------------------------------------------------------ */

function makeHarness(overrides?: Partial<JobPipelineDeps>) {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const messaging = new InMemoryMessagingAdapter();
  const ports: MessagingPorts = {
    producer: messaging,
    consumer: messaging,
    publisher: messaging,
    subscriber: messaging,
  };
  const events: MessageEnvelope[] = [];
  for (const state of [
    "queued",
    "running",
    "paused",
    "checkpointed",
    "completed",
    "failed",
    "cancelled",
  ]) {
    messaging.subscribe("collector", `job.${state}`, (envelope) => {
      events.push(envelope);
      return "processed";
    });
  }
  const stepLog: Array<{ kind: string; step: string; itemIndex: number | null }> = [];
  const steps = createBuiltinStepRegistry();
  steps.register("track", async (ctx: JobStepContext) => {
    stepLog.push({ kind: ctx.kind, step: "track", itemIndex: ctx.itemIndex });
    return { output: { tracked: true } };
  });
  let flakyFailures = 0;
  let flakyCalls = 0;
  steps.register("flaky", async (_ctx: JobStepContext) => {
    flakyCalls++;
    if (flakyCalls <= flakyFailures) throw new Error("flaky boom");
    return { output: { flaked: true } };
  });
  const sleepCalls: number[] = [];
  let runCounter = 0;
  const deps: JobPipelineDeps = {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: ports.publisher,
    steps,
    now: () => new Date(T0),
    newRunId: () => `run-${++runCounter}`,
    // The unit deadline (600s) never fires inside a test — the unit
    // settles first. Backoff sleeps (hundreds of ms) resolve at once:
    // the test measures attempts, not wall-clock backoff.
    sleep: (ms: number) => {
      sleepCalls.push(ms);
      return ms >= 60_000 ? new Promise<void>(() => {}) : Promise.resolve();
    },
    ...overrides,
  };
  return {
    control: createJobPipelineControl(deps),
    runStore,
    events,
    stepLog,
    sleepCalls,
    setFlakyFailures: (n: number) => {
      flakyFailures = n;
      flakyCalls = 0;
    },
    flakyCalls: () => flakyCalls,
  };
}

const SHARDS = ["a", "b", "c", "d", "e"];

describe("engine: node maxParallel flows to the stage (#4781 S2)", () => {
  it("a node cap bounds the fan-out round and names the deferred tail", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "capped",
      root: {
        kind: "dummy",
        steps: [{ step: "track" }],
        processing: { shards: SHARDS },
        executionMode: { delivery: "sync", concurrency: "parallel", shape: "sharded" },
        maxParallel: 2,
      },
    });
    const dispatch = await h.control.runJob("capped");
    expect(dispatch.state).toBe("completed");
    const descriptor = h.runStore.latestByJob("capped")?.descriptor ?? "";
    expect(descriptor).toContain("at maxParallel 2");
    expect(descriptor).toContain("3 unit(s) deferred");
  });

  it("absent, the 4-shard default bounds the fan-out round", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "default-cap",
      root: {
        kind: "dummy",
        steps: [{ step: "track" }],
        processing: { shards: SHARDS },
        executionMode: { delivery: "sync", concurrency: "parallel", shape: "sharded" },
      },
    });
    const dispatch = await h.control.runJob("default-cap");
    expect(dispatch.state).toBe("completed");
    const descriptor = h.runStore.latestByJob("default-cap")?.descriptor ?? "";
    expect(descriptor).toContain("at maxParallel 4");
    expect(descriptor).toContain("1 unit(s) deferred");
  });

  it("a sequential stage ignores the node cap", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "sequential-cap",
      root: {
        kind: "dummy",
        steps: [{ step: "track" }],
        processing: { shards: SHARDS },
        executionMode: { delivery: "sync", concurrency: "sequential", shape: "sharded" },
        maxParallel: 2,
      },
    });
    const dispatch = await h.control.runJob("sequential-cap");
    expect(dispatch.state).toBe("completed");
    const descriptor = h.runStore.latestByJob("sequential-cap")?.descriptor ?? "";
    expect(descriptor).toContain("at maxParallel 1");
    expect(descriptor).not.toContain("at maxParallel 2");
  });
});

describe("engine: node retryBucket flows to the stage (#4781 S2)", () => {
  it("a job stage retries under the \"report\" budget by default", async () => {
    const h = makeHarness();
    h.setFlakyFailures(2);
    await h.control.defineJob({
      jobId: "report-default",
      root: {
        kind: "dummy",
        steps: [{ step: "flaky" }],
        executionMode: { delivery: "sync" },
      },
    });
    const dispatch = await h.control.runJob("report-default");
    expect(dispatch.state).toBe("failed");
    expect(h.flakyCalls()).toBe(2);
  });

  it("a node bucket overrides the job-stage default", async () => {
    const h = makeHarness();
    h.setFlakyFailures(2);
    await h.control.defineJob({
      jobId: "acquisition-override",
      root: {
        kind: "dummy",
        steps: [{ step: "flaky" }],
        executionMode: { delivery: "sync" },
        retryBucket: "acquisition",
      },
    });
    const dispatch = await h.control.runJob("acquisition-override");
    expect(dispatch.state).toBe("completed");
    expect(h.flakyCalls()).toBe(3);
  });

  it("a chain kind retries under its table bucket by default", async () => {
    const h = makeHarness();
    h.setFlakyFailures(2);
    await h.control.defineJob({
      jobId: "feed-default",
      root: {
        kind: "feed",
        steps: [{ step: "flaky" }],
        executionMode: { delivery: "sync" },
      },
    });
    const dispatch = await h.control.runJob("feed-default");
    expect(dispatch.state).toBe("completed");
    expect(h.flakyCalls()).toBe(3);
  });

  it("a node bucket overrides the chain-kind table", async () => {
    const h = makeHarness();
    h.setFlakyFailures(2);
    await h.control.defineJob({
      jobId: "report-override",
      root: {
        kind: "feed",
        steps: [{ step: "flaky" }],
        executionMode: { delivery: "sync" },
        retryBucket: "report",
      },
    });
    const dispatch = await h.control.runJob("report-override");
    expect(dispatch.state).toBe("failed");
    expect(h.flakyCalls()).toBe(2);
  });
});

describe("engine: checkpoint interval drives the run (#4781 S2, B8)", () => {
  const CHECKPOINT_SPEC: JobDefinitionSpec = {
    id: "checkpoint-def",
    name: "Checkpoint",
    version: 1,
    // Sync delivery: the test observes the terminal state, so the
    // defined job must settle on runJob instead of queueing.
    stages: [{ kind: "feed", step: "track", executionMode: { delivery: "sync" } }],
  };

  it("a checkpoint interval set through the define round-trip lands on the node", async () => {
    const perStage = bindStageOverrides(CHECKPOINT_SPEC, {
      stageProcessing: { feed: { checkpointEverySteps: 3 } },
    });
    const raw = buildJobConfigFromSpec(CHECKPOINT_SPEC, "checkpoint-job", {}, perStage);
    const resolved = resolveJobDefinition(raw);
    expect(resolved.root.processing?.checkpointEverySteps).toBe(3);
    const h = makeHarness();
    await h.control.defineJob(raw);
    const dispatch = await h.control.runJob("checkpoint-job");
    expect(dispatch.state).toBe("completed");
    // One step, interval 3: no step boundary is a multiple of 3.
    expect(h.events.filter((e) => e.type === "job.checkpointed").length).toBe(0);
  });

  it("absent, the interval is 1 and every step checkpoints", async () => {
    const perStage = bindStageOverrides(CHECKPOINT_SPEC, {});
    const raw = buildJobConfigFromSpec(CHECKPOINT_SPEC, "checkpoint-default", {}, perStage);
    const resolved = resolveJobDefinition(raw);
    expect(resolved.root.processing?.checkpointEverySteps).toBeUndefined();
    expect(resolved.config.processing.checkpointEverySteps).toBe(1);
    const h = makeHarness();
    await h.control.defineJob(raw);
    const dispatch = await h.control.runJob("checkpoint-default");
    expect(dispatch.state).toBe("completed");
    expect(h.events.filter((e) => e.type === "job.checkpointed").length).toBe(1);
  });

  it("the interval drives ctx.currentGranularity at run time", async () => {
    const countFor = async (granularity: number | undefined) => {
      const h = makeHarness();
      await h.control.defineJob({
        jobId: "granular",
        root: {
          kind: "dummy",
          steps: [{ step: "track" }, { step: "track" }, { step: "track" }],
          ...(granularity !== undefined
            ? { processing: { checkpointEverySteps: granularity } }
            : {}),
          executionMode: { delivery: "sync" },
        },
      });
      await h.control.runJob("granular");
      return h.events.filter((e) => e.type === "job.checkpointed").length;
    };
    expect(await countFor(3)).toBe(1);
    expect(await countFor(undefined)).toBe(3);
  });
});

describe("engine: an unset definition behaves exactly as today (#4781 S2, area g)", () => {
  it("the stage runs under the 4-shard default with the table bucket", async () => {
    const h = makeHarness();
    await h.control.defineJob({
      jobId: "plain",
      root: {
        kind: "dummy",
        steps: [{ step: "track" }],
        processing: { shards: SHARDS },
        executionMode: { delivery: "sync", concurrency: "parallel", shape: "sharded" },
      },
    });
    const dispatch = await h.control.runJob("plain");
    expect(dispatch.state).toBe("completed");
    const descriptor = h.runStore.latestByJob("plain")?.descriptor ?? "";
    expect(descriptor).toContain("at maxParallel 4");
    expect(descriptor).toContain("1 unit(s) deferred");
    expect(h.sleepCalls).toContain(600_000);
  });
});
