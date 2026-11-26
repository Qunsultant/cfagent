// @vitest-environment node
/**
 * Issue #6584 — provenance on the workflow-shard residency.
 *
 * #6557 recorded run provenance for the sync residency only: the firing
 * schedule payload reaches the engine through `ScheduledAgent.runPipelineJob`,
 * and every other dispatch records explicit nulls. The workflow-shard
 * residency dispatches the same jobs through `JobPipelineWorkflow`, and its
 * one scheduled production caller — `startOptionsChainWorkflow` — already
 * resolves all four facts (broker, data provider, mode, mode source) onto
 * `ShardChainContext` (#3655) before dropping them at the payload boundary.
 *
 * This suite pins the second half of the row:
 *  - 6584-P01 the workflow payload's carrier reaches the run record;
 *  - 6584-P02 a payload without one records explicit nulls;
 *  - 6584-P03 a malformed carrier fails closed to nulls, never a half object,
 *    and never fails the run;
 *  - 6584-P04 `chainRunProvenance` reads the chain's facts for a scheduled
 *    firing ONLY — a manual chain start names none (#6557's decision);
 *  - 6584-P05 `startOptionsChainWorkflow` carries the carrier into the
 *    workflow instance it creates (both the injectable seam and the binding);
 *  - 6584-P06 `startPipelineJobWorkflow` threads it through the same seam.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  normalizeRunProvenance,
  type JobPipelineStores,
  type JobRunProvenance,
} from "../src/data/jobPipelinePorts";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";
import { chainRunProvenance } from "../src/services/optionsChainJobDefinition";
import { startOptionsChainWorkflow } from "../src/workflows/optionsWorkflowHost";
import { startPipelineJobWorkflow } from "../src/agents/scheduledTasksPipeline";
import type { ShardChainContext } from "../src/types";
import type { Env } from "../src/types";

const JOB_ID = "workflow-shard-provenance-job";

const PROVENANCE: JobRunProvenance = {
  brokerId: "alpaca",
  dataProviderId: "alpaca",
  mode: "paper",
  modeSource: "selection",
};

/** The single-step job the flow harness dispatches. */
const JOB = {
  jobId: JOB_ID,
  name: "Workflow-shard provenance job",
  root: {
    kind: "track",
    steps: [{ step: "track", params: {} }],
    executionMode: { delivery: "sync" as const },
  },
};

function flowDeps(
  stores: JobPipelineStores,
  runStore: InMemoryJobRunRecordStore,
): JobPipelineDeps {
  const steps = createBuiltinStepRegistry();
  steps.register("track", async () => ({ output: { tracked: true } }));
  let runCounter = 0;
  return {
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps,
    now: () => new Date("2026-11-25T12:00:00.000Z"),
    newRunId: () => `run-${++runCounter}`,
  };
}

/** A journal that executes and records, like a first flow execution. */
const executingStep = {
  do: async <T>(name: string, fn: () => Promise<T>): Promise<T> => fn(),
};

async function defineJob(deps: JobPipelineDeps): Promise<void> {
  await createJobPipelineControl(deps).defineJob(JOB);
}

describe("6584-P01 the workflow payload's carrier reaches the run record", () => {
  it("records all four facts and stamps the instance", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const deps = flowDeps(stores, runStore);
    await defineJob(deps);

    await runJobPipelineWorkflowFlow(deps, executingStep, {
      jobId: JOB_ID,
      trigger: "scheduled",
      provenance: PROVENANCE,
    });

    const record = runStore.listByJob(JOB_ID, 1)[0];
    expect(record.brokerId).toBe("alpaca");
    expect(record.dataProviderId).toBe("alpaca");
    expect(record.mode).toBe("paper");
    expect(record.modeSource).toBe("selection");

    const instance = await stores.instances.getInstance(JOB_ID);
    expect(instance?.runProvenance).toEqual(PROVENANCE);
  });
});

describe("6584-P02 a payload without a carrier records explicit nulls", () => {
  it("never infers a value at the residency", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const deps = flowDeps(stores, runStore);
    await defineJob(deps);

    await runJobPipelineWorkflowFlow(deps, executingStep, {
      jobId: JOB_ID,
      trigger: "scheduled",
    });

    const record = runStore.listByJob(JOB_ID, 1)[0];
    expect(record.brokerId).toBeNull();
    expect(record.dataProviderId).toBeNull();
    expect(record.mode).toBeNull();
    expect(record.modeSource).toBeNull();
  });
});

describe("6584-P03 a malformed carrier fails closed", () => {
  it("records nulls and still completes the run", async () => {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const deps = flowDeps(stores, runStore);
    await defineJob(deps);

    const outcome = await runJobPipelineWorkflowFlow(deps, executingStep, {
      jobId: JOB_ID,
      trigger: "scheduled",
      // A hand-written payload: wrong shapes for every field.
      provenance: { brokerId: 7, mode: "turbo", modeSource: "guess" } as never,
    });

    expect(outcome.state).toBe("completed");
    const record = runStore.listByJob(JOB_ID, 1)[0];
    expect(record.brokerId).toBeNull();
    expect(record.dataProviderId).toBeNull();
    expect(record.mode).toBeNull();
    expect(record.modeSource).toBeNull();
  });

  it("normalizes one rule for both the object payload and the stored carrier", () => {
    expect(normalizeRunProvenance(PROVENANCE)).toEqual(PROVENANCE);
    expect(normalizeRunProvenance(null)).toBeNull();
    expect(normalizeRunProvenance("junk")).toBeNull();
    expect(normalizeRunProvenance({ mode: "paper" })).toEqual({
      brokerId: null,
      dataProviderId: null,
      mode: "paper",
      modeSource: null,
    });
  });
});

const CHAIN = {
  chainId: "chain-1",
  universe: "symbols",
  userLogin: "owner@example.com",
  brokerId: "alpaca",
  dataProviderId: "alpaca",
  mode: "paper",
  modeSource: "selection",
  timestamp: "2026-11-25T12:00:00.000Z",
  channels: [],
  options: { symbols: ["AAPL"], thesis: "t", targetDate: "2026-12-25" },
} as unknown as ShardChainContext;

describe("6584-P04 the chain's facts are the scheduled firing's provenance", () => {
  it("reads all four for a scheduled firing", () => {
    expect(chainRunProvenance(CHAIN, "scheduled")).toEqual(PROVENANCE);
  });

  it("names none for a manual start, per #6557's decision", () => {
    expect(chainRunProvenance(CHAIN, "manual")).toBeNull();
    expect(chainRunProvenance(CHAIN, "retry")).toBeNull();
  });

  it("keeps an unrecorded fact null rather than guessing it", () => {
    const partial = { ...CHAIN, brokerId: undefined } as unknown as ShardChainContext;
    expect(chainRunProvenance(partial, "scheduled")).toEqual({
      brokerId: null,
      dataProviderId: "alpaca",
      mode: "paper",
      modeSource: "selection",
    });
  });

  it("names none when the chain recorded no fact at all", () => {
    const bare = {
      ...CHAIN,
      brokerId: undefined,
      dataProviderId: undefined,
      mode: undefined,
      modeSource: undefined,
    } as unknown as ShardChainContext;
    expect(chainRunProvenance(bare, "scheduled")).toBeNull();
  });
});

/** In-memory stores + recorder a start seam accepts through its opts. */
function startOpts(startWorkflow: (jobId: string, params: unknown) => Promise<{ instanceId: string }>) {
  return {
    stores: createInMemoryJobPipelineStores(),
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    startWorkflow,
  };
}

describe("6584-P05 the chain start carries the carrier into the instance", () => {
  it("passes it to the injectable start seam for a scheduled chain", async () => {
    let captured: unknown;
    const opts = startOpts(async (_jobId, params) => {
      captured = params;
      return { instanceId: "instance-1" };
    });

    await startOptionsChainWorkflow({} as Env, { chain: CHAIN }, opts);

    expect(captured).toEqual({ trigger: "scheduled", provenance: PROVENANCE });
  });

  it("passes no carrier for a manual chain", async () => {
    let captured: Record<string, unknown> | undefined;
    const opts = startOpts(async (_jobId, params) => {
      captured = params as Record<string, unknown>;
      return { instanceId: "instance-2" };
    });

    await startOptionsChainWorkflow({} as Env, { chain: CHAIN, trigger: "manual" }, opts);

    expect(captured).toEqual({ trigger: "manual" });
    expect(captured).not.toHaveProperty("provenance");
  });

  it("carries it on the managed binding's params too", async () => {
    let captured: Record<string, unknown> | undefined;
    const env = {
      JOB_PIPELINE_WORKFLOW: {
        create: async (options: { id: string; params: Record<string, unknown> }) => {
          captured = options.params;
          return { id: options.id };
        },
        get: async () => {
          throw new Error("no instance");
        },
      },
    } as unknown as Env;
    const opts = startOpts(async () => {
      throw new Error("the injectable seam is not used here");
    });
    // The binding path is the real one: drop the injectable seam.
    const { startWorkflow: _unused, ...bindingOpts } = opts;

    await startOptionsChainWorkflow(env, { chain: CHAIN }, bindingOpts);

    expect(captured?.provenance).toEqual(PROVENANCE);
  });
});

describe("6584-P06 the pipeline start seam threads the same carrier", () => {
  it("forwards provenance through the door's start seam", async () => {
    let captured: Record<string, unknown> | undefined;
    const ctx = {
      startWorkflow: async (_jobId: string, params: Record<string, unknown>) => {
        captured = params;
        return { instanceId: "instance-3" };
      },
    } as never;

    await startPipelineJobWorkflow(ctx, "some-job", {
      trigger: "scheduled",
      provenance: PROVENANCE,
    });

    expect(captured).toEqual({ trigger: "scheduled", provenance: PROVENANCE });
  });
});
