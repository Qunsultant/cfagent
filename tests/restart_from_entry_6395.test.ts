// @vitest-environment node
/**
 * Issue #6395 — restart a live run from ONE named journal entry.
 *
 * The platform journals every engine step under the name the engine gave it
 * (`stepExecutionId`: `step:<runBody>:<nodePath>:<stepIndex>:<shardKey>:<itemIndex>`),
 * and #6552 already exposes a rewind to a *stage's first step* through the
 * platform's own `restart({ fromStep })`. The checkpoint was still the only
 * resume point for an arbitrary entry: after a fix, the operator could re-run
 * the job or resume from the last completed stage — nothing else.
 *
 * This suite pins the general operation:
 *  - 6395-P01 a live run rewinds to the named entry, and the restart is
 *    recorded as its own event naming that entry;
 *  - 6395-P02 only a live run is addressable (the platform rewinds a live
 *    instance);
 *  - 6395-P03 an entry belonging to another run refuses by name;
 *  - 6395-P04 an entry whose stage the run never recorded refuses by name;
 *  - 6395-P05 a host with no restart channel, or a run with no stamped
 *    instance, refuses by name;
 *  - 6395-P06 the run's own definition version executes (#5278's rule,
 *    reused): a missing stamp or an unresolvable version refuses by name and
 *    the rewind never happens;
 *  - 6395-P07 a refused rewind publishes nothing — no event claims a restart
 *    that did not happen.
 */
import { describe, expect, it } from "vitest";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import {
  createJobPipelineControl,
  jobRunRecorderFromStore,
  type JobPipelineRestartRun,
} from "../src/services/jobPipelineEngine";
import { createBuiltinStepRegistry } from "../src/services/jobPipelineSteps";
import { stepExecutionId } from "../src/services/executionTreeIds";
import type { MessageEnvelope, MessagePublisher } from "../src/messaging/messagingPorts";

const JOB_ID = "restartable";
const RUN = "run-live";
const INSTANCE = "wf-instance-1";
const ENTRY = stepExecutionId(RUN, "", 0, null, null);

function recordingPublisher(): MessagePublisher & { envelopes: MessageEnvelope[] } {
  const envelopes: MessageEnvelope[] = [];
  return {
    envelopes,
    publish: async (envelope: MessageEnvelope) => {
      envelopes.push(envelope);
      return { deliveredTo: ["job-pipeline-events"], failedTo: [] };
    },
  };
}

interface Harness {
  control: ReturnType<typeof createJobPipelineControl>;
  stores: ReturnType<typeof createInMemoryJobPipelineStores>;
  publisher: ReturnType<typeof recordingPublisher>;
  restarts: Array<Parameters<JobPipelineRestartRun>[0]>;
}

/**
 * One live run: the job is defined (version 1), a real run has recorded its
 * stage checkpoint, and the instance is then left in the state a live run has
 * — running, with the run id, the stamped instance id and the version stamp.
 */
async function liveRun(opts: {
  restart?: JobPipelineRestartRun;
  stampVersion?: number | null;
  stampInstance?: string | null;
  runId?: string;
} = {}): Promise<Harness> {
  const stores = createInMemoryJobPipelineStores();
  const publisher = recordingPublisher();
  const restarts: Array<Parameters<JobPipelineRestartRun>[0]> = [];
  let runs = 0;
  const control = createJobPipelineControl({
    stores,
    runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
    publisher,
    steps: createBuiltinStepRegistry(),
    now: () => new Date("2026-11-26T12:00:00.000Z"),
    newRunId: () => `run-${++runs}`,
    ...(opts.restart
      ? { restartRun: opts.restart }
      : {
          restartRun: async (request) => {
            restarts.push(request);
          },
        }),
  });
  await control.defineJob({
    jobId: JOB_ID,
    root: {
      kind: "dummy",
      steps: [{ step: "record" }],
      executionMode: { delivery: "sync" },
    },
  });
  const base = await stores.instances.getInstance(JOB_ID);
  const runId = opts.runId ?? RUN;
  await stores.instances.saveInstance({
    ...base!,
    state: "running",
    currentRunId: runId,
    runStartedAt: "2026-11-26T11:00:00.000Z",
    runTrigger: "manual",
    runKind: "original",
    runDefinitionVersion:
      opts.stampVersion === undefined ? 1 : (opts.stampVersion as number),
    runWorkflowInstanceId:
      opts.stampInstance === undefined ? INSTANCE : opts.stampInstance,
    stageCheckpoint: {
      runId: RUN,
      units: [
        {
          stage: "job:" as never,
          unitId: RUN,
          status: "failed" as never,
          attempt: 1,
          updatedAt: "2026-11-26T11:30:00.000Z",
        },
      ],
      trigger: "manual",
      kind: "original",
    },
  });
  return { control, stores, publisher, restarts };
}

function lastError(control: Harness["control"]): Promise<string> {
  return control
    .getJob(JOB_ID)
    .then((view) => view.instance?.lastError ?? "");
}

describe("6395-P01 a live run rewinds to the named entry", () => {
  it("passes the entry to the platform restart and records the restart", async () => {
    const h = await liveRun();

    const result = await h.control.restartFromJournalEntry(JOB_ID, RUN, ENTRY);

    expect(result).toEqual({ jobId: JOB_ID, runId: RUN, state: "running" });
    expect(h.restarts).toEqual([
      {
        jobId: JOB_ID,
        runId: RUN,
        workflowInstanceId: INSTANCE,
        fromStep: ENTRY,
      },
    ]);
    // The restart is its own recorded event, naming the entry it rewound to.
    const events = h.publisher.envelopes.map(
      (e) => e.data as { action?: string; detail?: string; runId?: string },
    );
    const restart = events.find((e) => e.action === "restart");
    expect(restart).toBeDefined();
    expect(restart?.detail).toBe(ENTRY);
    expect(restart?.runId).toBe(RUN);
  });
});

describe("6395-P02 only a live run is addressable", () => {
  it("refuses a paused run by name", async () => {
    const h = await liveRun();
    const instance = await h.stores.instances.getInstance(JOB_ID);
    await h.stores.instances.saveInstance({ ...instance!, state: "paused" });

    await expect(
      h.control.restartFromJournalEntry(JOB_ID, RUN, ENTRY),
    ).rejects.toMatchObject({ code: "job_not_running" });
    expect(h.restarts).toEqual([]);
  });
});

describe("6395-P03 an entry from another run refuses", () => {
  it("names the entry and the run it belongs to", async () => {
    const h = await liveRun();
    const foreign = stepExecutionId("run-someone-else", "", 0, null, null);

    await expect(
      h.control.restartFromJournalEntry(JOB_ID, RUN, foreign),
    ).rejects.toMatchObject({ code: "journal_entry_not_addressed" });
    expect(h.restarts).toEqual([]);
  });
});

describe("6395-P04 an entry whose stage the run never recorded refuses", () => {
  it("refuses rather than rewinding an unknown stage", async () => {
    const h = await liveRun();
    const unknown = stepExecutionId(RUN, "never-ran", 0, null, null);

    await expect(
      h.control.restartFromJournalEntry(JOB_ID, RUN, unknown),
    ).rejects.toMatchObject({ code: "journal_entry_not_addressed" });
    expect(h.restarts).toEqual([]);
  });
});

describe("6395-P05 the rewind channel must exist", () => {
  it("refuses when the host exposes no restart channel", async () => {
    const h = await liveRun();
    const instance = await h.stores.instances.getInstance(JOB_ID);
    let runs = 100;
    const bare = createJobPipelineControl({
      stores: h.stores,
      runRecorder: jobRunRecorderFromStore(new InMemoryJobRunRecordStore()),
      publisher: null,
      steps: createBuiltinStepRegistry(),
      now: () => new Date("2026-11-26T12:00:00.000Z"),
      newRunId: () => `run-${++runs}`,
    });
    await bare.getJob(JOB_ID); // the instance exists; only the seam is missing
    await expect(
      bare.restartFromJournalEntry(JOB_ID, RUN, ENTRY),
    ).rejects.toMatchObject({ code: "stage_port_unavailable" });
    expect(instance?.state).toBe("running");
  });

  it("refuses when the run carries no stamped instance id", async () => {
    const h = await liveRun({ stampInstance: null });

    await expect(
      h.control.restartFromJournalEntry(JOB_ID, RUN, ENTRY),
    ).rejects.toMatchObject({ code: "stage_port_unavailable" });
    expect(h.restarts).toEqual([]);
  });
});

describe("6395-P06 the run's own definition version executes (#5278)", () => {
  it("refuses a run that predates the version stamp", async () => {
    const h = await liveRun({ stampVersion: null });

    await expect(
      h.control.restartFromJournalEntry(JOB_ID, RUN, ENTRY),
    ).rejects.toMatchObject({ code: "resume_pre_retention_run" });
    expect(h.restarts).toEqual([]);
  });

  it("refuses a version that is no longer resolvable", async () => {
    const h = await liveRun({ stampVersion: 99 });

    await expect(
      h.control.restartFromJournalEntry(JOB_ID, RUN, ENTRY),
    ).rejects.toMatchObject({ code: "resume_definition_version_unresolved" });
    expect(h.restarts).toEqual([]);
  });
});

describe("6395-P07 a refused rewind publishes nothing", () => {
  it("no event claims a restart that did not happen", async () => {
    const h = await liveRun({ stampVersion: 99 });

    await expect(
      h.control.restartFromJournalEntry(JOB_ID, RUN, ENTRY),
    ).rejects.toBeDefined();

    const actions = h.publisher.envelopes.map(
      (e) => (e.data as { action?: string }).action,
    );
    expect(actions).not.toContain("restart");
  });
});
