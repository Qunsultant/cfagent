// @vitest-environment node
/**
 * Issue #6393 — the durable sleep half of the wait primitive.
 *
 * #3955 shipped the event half: a `wait.event` step whose wait runs on the
 * host's channel, outside the journal, under a stable name, with a declared
 * timeout outcome. What the engine never had is the OTHER half a durable
 * runtime offers — `step.sleep`, a park with a duration.
 *
 * Without it, a wait expressed as a duration can only HOLD: the isolate stays
 * resident holding the run open, and the wait dies with the isolate. That is
 * the defect this suite pins shut:
 *
 *  - 6393-P01 a `wait.sleep` step parks through the host's sleep seam and
 *    hands a declared outcome `{outcome: "slept", durationMs}` to the next
 *    step — the same contract shape the event wait uses;
 *  - 6393-P02 a parked sleep is not cut short by the stage deadline it was
 *    never declared under;
 *  - 6393-P03 the sleep is never wrapped in the step journal (Rules of
 *    Workflows: a journaled sleep would replay as completed instead of
 *    re-arming);
 *  - 6393-P04 a host with no durable sleep refuses BY NAME — a hold is not a
 *    park, so the engine must never silently degrade to one;
 *  - 6393-P05 an invalid duration refuses by name;
 *  - 6393-P06 a duration past the configured bound refuses, naming the bound,
 *    and the bound is configuration (`pipeline.sleepMaxDurationMs`), not a
 *    hard-coded constant;
 *  - 6393-P07 the platform half: `sleepChannelFromStep` maps the host's
 *    `step.sleep` onto the engine's seam under the engine's own stable name;
 *  - 6393-P08 the flow merges the channel, so the workflow residency can
 *    actually park a run.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import type { JobPipelineStores } from "../src/data/jobPipelinePorts";
import {
  WAIT_SLEEP_STEP,
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobDurableSleepRequest,
  type JobPipelineDeps,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { DEFAULT_PIPELINE_POLICY } from "../src/services/pipelinePolicy";
import { sleepChannelFromStep } from "../src/workflows/workflowEventWait";
import { runJobPipelineWorkflowFlow } from "../src/workflows/jobPipelineWorkflowFlow";

const JOB_ID = "sleeper";

function makeControl(opts: {
  seen?: JobDurableSleepRequest[];
  sleep?: (request: JobDurableSleepRequest) => Promise<void>;
  journal?: { do: <T>(name: string, fn: () => Promise<T>) => Promise<T> };
  settings?: Record<string, string>;
}) {
  const stores = createInMemoryJobPipelineStores();
  let runs = 0;
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher: null,
    steps: createBuiltinStepRegistry(),
    now: () => new Date("2026-11-26T12:00:00.000Z"),
    newRunId: () => `run-${++runs}`,
    ...(opts.sleep ? { sleepFor: opts.sleep } : {}),
    ...(opts.journal ? { journal: opts.journal } : {}),
    ...(opts.settings ? { settings: opts.settings } : {}),
  });
  return { control, stores };
}

async function defineSleepJob(
  control: ReturnType<typeof makeControl>["control"],
  params: Record<string, unknown> = { durationMs: 5_000 },
  node: Record<string, unknown> = {},
): Promise<void> {
  await control.defineJob({
    jobId: JOB_ID,
    root: {
      kind: "dummy",
      steps: [{ step: WAIT_SLEEP_STEP, params }, { step: "record" }],
      executionMode: { delivery: "sync" },
      ...node,
    },
  });
}

describe("6393-P01 a sleep step parks through the host's seam", () => {
  it("records a declared outcome and hands it to the next step", async () => {
    const seen: JobDurableSleepRequest[] = [];
    const h = makeControl({
      sleep: async (request) => {
        seen.push(request);
      },
    });
    await defineSleepJob(h.control);

    const dispatch = await h.control.runJob(JOB_ID);

    expect(dispatch.state).toBe("completed");
    // One park, at the engine's own stable name, with the duration the job
    // declared — unchanged.
    expect(seen).toHaveLength(1);
    expect(seen[0].jobId).toBe(JOB_ID);
    expect(seen[0].runId).toBe(dispatch.runId);
    expect(seen[0].durationMs).toBe(5_000);
    expect(seen[0].stepName).toMatch(/^sleep:/);
    expect(seen[0].stepName).toContain(dispatch.runId);

    // The park is a declared outcome, exactly like the event wait's, and it
    // is the next step's input.
    const slept = await h.stores.artifacts.getArtifact(dispatch.runId, "root/step-0");
    expect(slept).toEqual({ outcome: "slept", durationMs: 5_000 });
    const recorded = (await h.stores.artifacts.getArtifact(
      dispatch.runId,
      "root/step-1",
    )) as { input: unknown };
    expect(recorded.input).toEqual(slept);
  });
});

describe("6393-P02 a parked sleep is not cut short by the stage deadline", () => {
  it("outlives a stage deadline it was never declared under", async () => {
    const h = makeControl({
      sleep: () => new Promise<void>((resolve) => setTimeout(resolve, 60)),
    });
    await defineSleepJob(h.control, { durationMs: 60 }, { timeoutMs: 10 });

    const dispatch = await h.control.runJob(JOB_ID);

    expect(dispatch.state).toBe("completed");
  });
});

describe("6393-P03 the sleep is never journaled", () => {
  it("runs outside step.do, so a replay re-arms instead of replaying as done", async () => {
    const journaled: string[] = [];
    const h = makeControl({
      sleep: async () => undefined,
      journal: {
        do: async (name, fn) => {
          journaled.push(name);
          return fn();
        },
      },
    });
    await defineSleepJob(h.control);

    const dispatch = await h.control.runJob(JOB_ID);

    expect(dispatch.state).toBe("completed");
    // Two steps ran; exactly one is journaled — the ordinary one.
    expect(journaled).toHaveLength(1);
    expect(journaled[0]).not.toContain(WAIT_SLEEP_STEP);
  });
});

describe("6393-P04 a host with no durable sleep refuses by name", () => {
  it("never silently degrades a park into a hold", async () => {
    const h = makeControl({});
    await defineSleepJob(h.control);

    const dispatch = await h.control.runJob(JOB_ID);

    expect(dispatch.state).toBe("failed");
    const failed = (await h.control.getJob(JOB_ID)).instance?.lastError ?? "";
    expect(failed).toContain("no durable sleep");
    expect(failed).toContain("5000");
  });
});

describe("6393-P05 an invalid duration refuses by name", () => {
  it("refuses a missing, zero, negative or non-numeric duration", async () => {
    for (const params of [{}, { durationMs: 0 }, { durationMs: -1 }, { durationMs: "soon" }]) {
      const h = makeControl({ sleep: async () => undefined });
      await defineSleepJob(h.control, params);

      const dispatch = await h.control.runJob(JOB_ID);

      expect(dispatch.state).toBe("failed");
      const failed = (await h.control.getJob(JOB_ID)).instance?.lastError ?? "";
      expect(failed).toContain(WAIT_SLEEP_STEP);
      expect(failed).toContain("durationMs");
    }
  });
});

describe("6393-P06 the bound is configuration, and a longer sleep refuses", () => {
  it("refuses past the default bound, naming it", async () => {
    const h = makeControl({ sleep: async () => undefined });
    await defineSleepJob(h.control, { durationMs: DEFAULT_PIPELINE_POLICY.sleepMaxDurationMs + 1 });

    const dispatch = await h.control.runJob(JOB_ID);

    expect(dispatch.state).toBe("failed");
    const failed = (await h.control.getJob(JOB_ID)).instance?.lastError ?? "";
    expect(failed).toContain(String(DEFAULT_PIPELINE_POLICY.sleepMaxDurationMs));
  });

  it("honours the bound from configuration, not a constant", async () => {
    const bounded = makeControl({
      sleep: async () => undefined,
      settings: { "pipeline.sleepMaxDurationMs": "60000" },
    });
    await defineSleepJob(bounded.control, { durationMs: 120_000 });

    const refused = await bounded.control.runJob(JOB_ID);
    expect(refused.state).toBe("failed");
    const failed = (await bounded.control.getJob(JOB_ID)).instance?.lastError ?? "";
    expect(failed).toContain("60000");
  });
});

describe("6393-P07 the platform half maps step.sleep onto the seam", () => {
  it("calls the host's sleep under the engine's stable name and duration", async () => {
    const calls: Array<{ name: string; durationMs: number }> = [];
    const channel = sleepChannelFromStep({
      sleep: async (name: string, durationMs: number) => {
        calls.push({ name, durationMs });
      },
    });

    await channel.sleepFor!({
      jobId: "job",
      runId: "run-1",
      nodePath: "",
      stepName: "sleep:run-1:root:0",
      durationMs: 1_234,
    });

    expect(calls).toEqual([{ name: "sleep:run-1:root:0", durationMs: 1_234 }]);
  });

  it("provides nothing when the host cannot sleep", () => {
    expect(sleepChannelFromStep({})).toEqual({});
  });
});

describe("6393-P08 the workflow flow merges the channel", () => {
  it("parks the run through the flow's own step object", async () => {
    const stores: JobPipelineStores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    let runs = 0;
    const deps: JobPipelineDeps = {
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: null,
      steps: createBuiltinStepRegistry(),
      now: () => new Date("2026-11-26T12:00:00.000Z"),
      newRunId: () => `flow-run-${++runs}`,
    };
    await createJobPipelineControl(deps).defineJob({
      jobId: JOB_ID,
      root: {
        kind: "dummy",
        steps: [{ step: WAIT_SLEEP_STEP, params: { durationMs: 2_000 } }],
        executionMode: { delivery: "sync" },
      },
    });
    const slept: Array<{ name: string; durationMs: number }> = [];

    const outcome = await runJobPipelineWorkflowFlow(
      deps,
      {
        do: async <T>(_name: string, fn: () => Promise<T>) => fn(),
        sleep: async (name: string, durationMs: number) => {
          slept.push({ name, durationMs });
        },
      },
      { jobId: JOB_ID, trigger: "scheduled" },
    );

    expect(outcome.state).toBe("completed");
    expect(slept).toHaveLength(1);
    expect(slept[0].durationMs).toBe(2_000);
  });
});
