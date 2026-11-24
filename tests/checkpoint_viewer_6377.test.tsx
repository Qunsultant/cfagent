// @vitest-environment jsdom
/**
 * Issue #6377 — one checkpoint viewer: a run's checkpoints, per stage.
 *
 * The checkpoint is the resume truth (`resumeJob` refuses without one), and
 * until now no surface showed its CONTENTS: which units ran, their attempts,
 * the result reference each step returned, and the resume position a stopped
 * unit continues from.
 *
 * What this file pins:
 *  - 6377-P01 the resume position survives the engine projection
 *    (`projectStageViews` keeps each unit's `progress`);
 *  - 6377-P02 the stage projection carries the checkpoint entry per stage
 *    (run id, kind, unit states) from the same read — no second read;
 *  - 6377-P03 the Workflow Runs run detail renders that entry per stage,
 *    collapsed, expandable to its units;
 *  - 6377-P04 a run with no checkpoint says so — a missing checkpoint is a
 *    fact, never an empty panel;
 *  - 6377-P05 a checkpoint whose units are absent invents no unit row.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunDetail } from "../src/client/WorkflowRunsPanel";
import {
  projectStageViews,
  type JobInstanceRecord,
  type JobStageView,
} from "../src/services/jobPipelineEngine";
import { stagesFromEngineViews, type WorkflowRun, type WorkflowRunStage } from "../src/services/workflowRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function instance(over: Partial<JobInstanceRecord> = {}): JobInstanceRecord {
  return {
    jobId: "screener",
    state: "running",
    desiredState: "running",
    currentRunId: "run-6377",
    runStartedAt: "2026-11-24T12:00:00.000Z",
    runTrigger: "manual",
    runKind: null,
    runOriginId: null,
    runDefinitionVersion: null,
    runScheduleId: null,
    runAsyncJobId: null,
    runWorkflowInstanceId: null,
    checkpoint: null,
    stageCheckpoint: {
      runId: "run-6377",
      kind: "original",
      units: [
        {
          stage: "job:feed",
          unitId: "feed",
          status: "completed",
          attempt: 2,
          startedAt: "2026-11-24T12:00:00.000Z",
          endedAt: "2026-11-24T12:00:05.000Z",
          resultRef: "feed@v1",
        },
        {
          // A stopped unit is the resumable one: its progress is the
          // position a resume continues from, and the reason the viewer
          // exists.
          stage: "job:analyze",
          unitId: "analyze",
          status: "stopped",
          attempt: 1,
          startedAt: "2026-11-24T12:00:06.000Z",
          progress: { stepIndex: 3, itemIndex: 17 },
        },
      ],
    },
    stageDesired: null,
    lastError: null,
    updatedAt: "2026-11-24T12:00:07.000Z",
    ...over,
  };
}

function stage(over: Partial<WorkflowRunStage> = {}): WorkflowRunStage {
  return {
    key: "job:feed",
    order: 1,
    stage: "feed",
    label: "Feed",
    status: "completed",
    recordedBy: "engine-checkpoint",
    startedAt: "2026-11-24T12:00:00.000Z",
    finishedAt: "2026-11-24T12:00:05.000Z",
    durationMs: 5_000,
    detail: "feed",
    reason: null,
    error: null,
    capability: null,
    jobKind: null,
    channel: null,
    input: null,
    output: null,
    ...over,
  };
}

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "run-6377",
    family: "screener",
    title: "Screener run",
    status: "completed",
    trigger: "manual",
    triggerDetail: null,
    startedAt: "2026-11-24T12:00:00.000Z",
    finishedAt: "2026-11-24T12:00:07.000Z",
    durationMs: 7_000,
    stages: [stage()],
    artifacts: [],
    deliveryStates: {},
    inputs: null,
    outputs: null,
    error: null,
    ...over,
  } as WorkflowRun;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  root = null;
});

describe("#6377 — the checkpoint entry, one read", () => {
  it("P01: the engine projection keeps each unit's resume position", () => {
    const views = projectStageViews(null, instance());
    const analyze = views.find((view) => view.stageId === "job:analyze");
    expect(analyze).toBeTruthy();
    const unit = analyze?.units.find((u) => u.unitId === "analyze");
    expect(unit?.progress).toEqual({ stepIndex: 3, itemIndex: 17 });
    // The completed unit recorded no resume position: nothing invented.
    const feed = views.find((view) => view.stageId === "job:feed")?.units[0];
    expect(feed?.progress).toBeUndefined();
  });

  it("P02: the stage projection carries the checkpoint entry, from the same view", () => {
    const views = projectStageViews(null, instance());
    const stages = stagesFromEngineViews(views, "screener");
    const feed = stages.find((s) => s.key === "job:feed");
    expect(feed?.checkpoint?.runId).toBe("run-6377");
    expect(feed?.checkpoint?.kind).toBe("original");
    expect(feed?.checkpoint?.units).toEqual([
      {
        unitId: "feed",
        status: "completed",
        attempt: 2,
        startedAt: "2026-11-24T12:00:00.000Z",
        endedAt: "2026-11-24T12:00:05.000Z",
        resultRef: "feed@v1",
      },
    ]);
    const analyze = stages.find((s) => s.key === "job:analyze");
    expect(analyze?.checkpoint?.units[0]?.progress).toEqual({ stepIndex: 3, itemIndex: 17 });
  });

  it("P05: a view with no units and no checkpoint id carries no checkpoint entry", () => {
    const bare: JobStageView = {
      stageId: "job:feed",
      nodePath: "feed",
      kind: "feed",
      startedAt: null,
      endedAt: null,
      durationMs: null,
      resultRef: null,
      units: [],
    };
    expect(stagesFromEngineViews([bare], "screener")[0]?.checkpoint).toBeUndefined();
  });
});

describe("#6377 — the viewer in the Workflow Runs run detail", () => {
  it("P03: renders a per-stage checkpoint with its units, attempts and resume position", async () => {
    const views = projectStageViews(null, instance());
    root = createRoot(container);
    await act(async () => {
      root!.render(<RunDetail run={run({ stages: stagesFromEngineViews(views, "screener") })} />);
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Checkpoint");
    // The checkpoint header names the run it belongs to.
    expect(text).toContain("run-6377");
    // The units, their attempts, the result reference and the resume position.
    expect(text).toContain("feed");
    expect(text).toContain("attempt 2");
    expect(text).toContain("feed@v1");
    expect(text).toContain("step 4");
    expect(text).toContain("item 18");
  });

  it("P04: a run with no checkpoint says so instead of rendering an empty panel", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<RunDetail run={run({ stages: [stage({ recordedBy: "job" })] })} />);
    });
    await flush();
    expect(container.textContent ?? "").toContain("No engine checkpoint was recorded for this run");
  });
});
