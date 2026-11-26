// @vitest-environment node
/**
 * Issue #6400 (owner decision 2026-11-26: **a new op**) — replay ONE stage
 * of a PAST run.
 *
 * `replayRun` reproduces a whole past run; `rerunStage` re-executes a stage
 * of the CURRENT run. Neither can replay one stage of a run that has already
 * settled. This pins the third op:
 *
 *  - 6400-P01 the stage re-executes as a NEW run, on the past run's recorded
 *    definition version, from that stage's RECORDED input;
 *  - 6400-P02 only the named stage runs — the stages after it are explicitly
 *    NOT re-executed (the issue requires that rule be stated, never silent);
 *  - 6400-P03 an unknown past run refuses by name;
 *  - 6400-P04 a past run with no recorded version refuses by name rather than
 *    replaying today's definition;
 *  - 6400-P05 a stage the past definition never had refuses by name;
 *  - 6400-P06 a composite (a node that OWNS downstream stages) refuses by
 *    name, listing the stages that can be replayed — "one stage" has one
 *    meaning, and the whole-run operation is `replayRun`;
 *  - 6400-P07 the original run and its artifacts are untouched.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { handleJobStatusRoutes } from "../src/agents/routes/jobStatus";

const JOB_ID = "replay-stage-job";

interface Call {
  step: string;
  input: unknown;
}

function makeControl() {
  const stores = createInMemoryJobPipelineStores();
  const runStore = new InMemoryJobRunRecordStore();
  const calls: Call[] = [];
  const steps = createBuiltinStepRegistry();
  const step = (name: string, output: unknown) =>
    steps.register(name, async (ctx) => {
      calls.push({ step: name, input: ctx.input ?? null });
      return { output };
    });
  step("noop", { from: "noop" });
  step("feed", { quotes: [{ symbol: "AAPL" }] });
  step("enrich", { quotes: [{ symbol: "AAPL" }], bySymbol: { AAPL: { score: 1 } } });
  step("analyze", { ideas: [{ symbol: "AAPL" }] });
  let runs = 0;
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(runStore),
    publisher: null,
    steps,
    now: () => new Date("2026-11-26T12:00:00.000Z"),
    newRunId: () => `run-${++runs}`,
  });
  return { control, stores, runStore, calls };
}

/**
 * The research chain's own shape (#6400's first consumer): a root whose own
 * work is nothing, and five-ish sibling stages chained after it. Here:
 * root → 0 feed → 1 enrich → 2 analyze.
 */
async function defineChained(control: ReturnType<typeof makeControl>["control"]) {
  await control.defineJob({
    jobId: JOB_ID,
    root: {
      kind: "noop",
      steps: [{ step: "noop" }],
      children: [
        { kind: "feed", steps: [{ step: "feed" }] },
        { kind: "enrich", steps: [{ step: "enrich" }] },
        { kind: "analyze", steps: [{ step: "analyze" }] },
      ],
      executionMode: { delivery: "sync" },
    },
  });
}

/** Run the job once and hand back the settled run's id. */
async function pastRun(h: ReturnType<typeof makeControl>) {
  const dispatch = await h.control.runJob(JOB_ID, { trigger: "manual" });
  const settled = dispatch.completion ? await dispatch.completion : dispatch;
  return settled.runId;
}

const ENRICH = "1";
const ANALYZE = "2";

describe("6400-P01 a past stage re-executes as a new run on its recorded version", () => {
  it("mints a new run, from the past run's hand-off, on the past version", async () => {
    const h = makeControl();
    await defineChained(h.control);
    const pastRunId = await pastRun(h);
    h.calls.length = 0;

    const replayed = await h.control.replayStage(JOB_ID, pastRunId, ENRICH);

    expect(replayed.state).toBe("completed");
    expect(replayed.runId).not.toBe(pastRunId); // ...as its OWN run
    expect(h.calls.map((c) => c.step)).toEqual(["enrich"]);
    // The recorded input is what the PAST run handed this stage: the feed
    // stage's output, not the root's and not today's re-fetch.
    expect(h.calls[0]?.input).toEqual({ quotes: [{ symbol: "AAPL" }] });
    const record = h.runStore.listByJob(JOB_ID, 5).find((r) => r.workflowId === replayed.runId);
    expect(record?.kind).toBe("replay");
    expect(record?.originRunId).toBe(pastRunId);
    expect(record?.definitionVersion).toBe(1);
    // The origin link names the stage too (the field the runs view reads).
    expect(record?.descriptor).toContain("replay of job:1");
    expect(record?.descriptor).toContain(pastRunId);
  });
});

describe("6400-P02 downstream stages are explicitly not re-executed", () => {
  it("runs only the named stage", async () => {
    const h = makeControl();
    await defineChained(h.control);
    const pastRunId = await pastRun(h);
    h.calls.length = 0;

    await h.control.replayStage(JOB_ID, pastRunId, ENRICH);

    // `analyze` is downstream of the replayed stage; the rule is "not run".
    expect(h.calls.map((c) => c.step)).toEqual(["enrich"]);
  });
});

describe("6400-P03 an unknown past run refuses", () => {
  it("refuses job_run_not_found", async () => {
    const h = makeControl();
    await defineChained(h.control);
    await pastRun(h);

    await expect(
      h.control.replayStage(JOB_ID, "run-does-not-exist", ENRICH),
    ).rejects.toMatchObject({ code: "job_run_not_found" });
  });
});

describe("6400-P04 the recorded version is the only one replayed", () => {
  it("refuses a run that predates the version stamp", async () => {
    const h = makeControl();
    await defineChained(h.control);
    await pastRun(h);
    // A retained record from before the #5887 stamp: replayed under today's
    // definition would be a false continuation, so it must refuse.
    await h.runStore.record({
      system: "job-pipeline",
      jobId: JOB_ID,
      operation: "noop",
      started: "2026-11-01T00:00:00.000Z",
      finished: "2026-11-01T00:01:00.000Z",
      outcome: "success",
      triggeredBy: "manual",
      workflowId: "run-legacy",
    } as never);

    await expect(
      h.control.replayStage(JOB_ID, "run-legacy", ENRICH),
    ).rejects.toMatchObject({ code: "replay_pre_retention_run" });
  });
});

describe("6400-P05 a stage the past definition never had refuses", () => {
  it("names the missing node", async () => {
    const h = makeControl();
    await defineChained(h.control);
    const pastRunId = await pastRun(h);

    await expect(
      h.control.replayStage(JOB_ID, pastRunId, "ghost/stage"),
    ).rejects.toMatchObject({ code: "job_config_invalid" });
  });
});

describe("6400-P06 a composite is not 'one stage'", () => {
  it("refuses the chain root and names the stages that can be replayed", async () => {
    const h = makeControl();
    await defineChained(h.control);
    const pastRunId = await pastRun(h);
    h.calls.length = 0;

    const refused = await h.control
      .replayStage(JOB_ID, pastRunId, "")
      .catch((error: { code?: string; message?: string }) => error);

    expect(refused).toMatchObject({ code: "replay_stage_composite" });
    const message = String((refused as { message?: string }).message);
    // The refusal is actionable: each replayable stage is named with its kind.
    expect(message).toContain("job:0 (feed)");
    expect(message).toContain("job:1 (enrich)");
    expect(message).toContain("job:2 (analyze)");
    // And nothing ran on the way to refusing.
    expect(h.calls).toEqual([]);
  });
});

describe("6400-P07 the original run is untouched", () => {
  it("leaves the past run's record and artifacts as they were", async () => {
    const h = makeControl();
    await defineChained(h.control);
    const pastRunId = await pastRun(h);
    const before = h.runStore.listByJob(JOB_ID, 5);
    const handoffBefore = await h.stores.artifacts.getArtifact(
      pastRunId,
      "0/stage-output",
    );

    const replayed = await h.control.replayStage(JOB_ID, pastRunId, ANALYZE);

    // The analyze replay consumed the ENRICH hand-off of the past run.
    expect(h.calls.at(-1)?.input).toEqual({
      quotes: [{ symbol: "AAPL" }],
      bySymbol: { AAPL: { score: 1 } },
    });
    // The past run kept its own row and its own artifacts; the replay is a
    // second row, never a rewrite of the first.
    const after = h.runStore.listByJob(JOB_ID, 5);
    expect(after.length).toBe(before.length + 1);
    const pastRecord = after.find((r) => r.workflowId === pastRunId);
    expect(pastRecord?.kind).toBe("original");
    expect(pastRecord?.outcome).toBe("success");
    expect(
      await h.stores.artifacts.getArtifact(pastRunId, "0/stage-output"),
    ).toEqual(handoffBefore);
    expect(
      await h.stores.artifacts.getArtifact(replayed.runId, "0/stage-output"),
    ).toBeNull();
  });
});

describe("6400-P08 the replay route carries the stage selector", () => {
  const call = (
    path: string,
    search: string,
    ctx: Parameters<typeof handleJobStatusRoutes>[3],
  ) =>
    handleJobStatusRoutes(
      new Request(`https://example.test${path}${search}`, { method: "POST" }),
      new URL(`https://example.test${path}${search}`),
      path,
      ctx,
    );

  it("passes ?stage through to the one replay seam", async () => {
    const seen: Array<string | undefined> = [];
    const res = await call(
      "/api/jobs/replay-stage-job/runs/run-1/replay",
      "?stage=job%3A1",
      {
        readJobStatus: async () => null,
        replayJobRun: async (jobId, runId, stage) => {
          seen.push(stage);
          return {
            jobId,
            replayedRunId: runId,
            runId: "run-9",
            state: "completed",
            stage,
          };
        },
      },
    );
    expect(res?.status).toBe(200);
    expect(seen).toEqual(["job:1"]);
  });

  it("answers 409 for a composite refusal", async () => {
    const res = await call(
      "/api/jobs/replay-stage-job/runs/run-1/replay",
      "?stage=job%3Aroot",
      {
        readJobStatus: async () => null,
        replayJobRun: async () => {
          throw new Error(
            'Stage "job:root" of job "replay-stage-job" is not one stage: it owns downstream stages job:0 (feed).',
          );
        },
      },
    );
    expect(res?.status).toBe(409);
  });
});
