// @vitest-environment jsdom
/**
 * Issue #4420 â€” the shard detail renders its inner per-symbol engine run.
 *
 * Pins:
 *  - 4420-P08 a shard with inner stages renders them under their own heading,
 *    with the status and timing the checkpoint recorded.
 *  - 4420-P09 a shard whose inner checkpoint is absent says so â€” an unknown
 *    inner run is never rendered as if it had no stages.
 *  - 4420-P10 a run with no inner run renders no inner section at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunDetail } from "../src/client/WorkflowRunsPanel";
import type { WorkflowRun, WorkflowRunStage } from "../src/services/workflowRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function stage(over: Partial<WorkflowRunStage> = {}): WorkflowRunStage {
  return {
    key: "shard-aapl",
    order: 1,
    stage: "feed",
    label: "Feed",
    status: "failed",
    recordedBy: "job",
    startedAt: "2026-11-13T12:00:00.000Z",
    finishedAt: "2026-11-13T12:00:05.000Z",
    durationMs: 5_000,
    detail: "Shard: feed/AAPL",
    reason: null,
    error: "host died",
    capability: "shard.execute",
    jobKind: "main",
    channel: null,
    input: null,
    output: null,
    jobId: "shard-aapl",
    ...over,
  };
}

function innerStage(over: Partial<WorkflowRunStage> = {}): WorkflowRunStage {
  return {
    key: "job:0",
    order: 1,
    stage: "scan",
    label: "Scan",
    status: "completed",
    recordedBy: "engine-checkpoint",
    startedAt: "2026-11-13T12:00:01.000Z",
    finishedAt: "2026-11-13T12:00:02.500Z",
    durationMs: 1_500,
    detail: null,
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
    id: "chain-4420",
    runId: "chain-4420",
    workflow: "Options screen",
    family: "options",
    title: "Scheduled options screen",
    source: "job-chain",
    trigger: "scheduled",
    triggerDetail: "Scheduled â€” recorded on the run's job tree",
    triggeredBy: "analyst",
    status: "failed",
    lifecycle: "failed",
    startedAt: "2026-11-13T12:00:00.000Z",
    finishedAt: "2026-11-13T12:00:05.000Z",
    durationMs: 5_000,
    stageCount: 1,
    completedStages: 0,
    failedStages: 1,
    stages: [stage()],
    artifacts: [],
    documents: null,
    schedule: null,
    stranded: false,
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

describe("inner engine stages in the shard detail (#4420)", () => {
  it("renders the inner run's stages with their recorded status and timing", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RunDetail
          run={run({
            stages: [
              stage({
                innerJobId: "strategy-screen:shard-scan:chain-4420:AAPL",
                innerStages: [innerStage(), innerStage({ key: "job:1", order: 2, stage: "risk", label: "Risk", durationMs: 900 })],
              }),
            ],
          })}
        />,
      );
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Inner engine stages");
    expect(text).toContain("strategy-screen:shard-scan:chain-4420:AAPL");
    expect(text).toContain("Scan");
    expect(text).toContain("Risk");
    expect(text).toContain("completed");
  });

  it("says the inner run is unknown when the checkpoint is absent", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RunDetail
          run={run({
            stages: [
              stage({
                innerJobId: "strategy-screen:shard-scan:chain-4420:AAPL",
                innerStages: [],
              }),
            ],
          })}
        />,
      );
    });
    await flush();
    expect(container.textContent ?? "").toContain(
      "No inner engine checkpoint was recorded for this shard's per-symbol scan",
    );
  });

  it("renders no inner section for a run with no inner run", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<RunDetail run={run()} />);
    });
    await flush();
    expect(container.textContent ?? "").not.toContain("Inner engine stages");
  });
});

