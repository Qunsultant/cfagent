/** @vitest-environment jsdom */
/**
 * Issue #3163 - the catalog's "last run" is a deep link into Workflow Runs,
 * and Workflow Runs honours `?run=<id>` by opening that run's detail.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowRunsPanel } from "../src/client/WorkflowRunsPanel";
import { WorkflowCatalogPanel } from "../src/client/WorkflowCatalogPanel";
import type { WorkflowRun } from "../src/services/workflowRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "chain-42",
    runId: "chain-42",
    workflow: "Stock screening workflow",
    family: "stock",
    title: "Stock screen - NASDAQ100",
    source: "job-chain",
    trigger: "scheduled",
    triggerDetail: "Scheduled",
    triggeredBy: null,
    status: "completed",
    startedAt: "2026-11-04T00:00:00.000Z",
    finishedAt: "2026-11-04T00:01:00.000Z",
    durationMs: 60000,
    stageCount: 1,
    completedStages: 1,
    failedStages: 0,
    stages: [
      {
        key: "job-feed",
        order: 1,
        stage: "feed",
        label: "Feed",
        status: "completed",
        recordedBy: "job",
        startedAt: "2026-11-04T00:00:00.000Z",
        finishedAt: "2026-11-04T00:00:30.000Z",
        durationMs: 30000,
        detail: "universe fetched",
        reason: null,
        error: null,
        capability: "marketdata.feed",
        jobKind: "main",
        channel: null,
        input: null,
        output: null,
      } as never,
    ],
    inputs: {},
    outputs: {},
    artifacts: [],
    deliveryStates: {},
    error: null,
    fanoutCapReason: null,
    resumedSkippedUnits: [],
    ...over,
  };
}

async function render(node: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  globalThis.fetch = vi.fn(async () => Response.json({ count: 1, runs: [run()] })) as never;
  await act(async () => {
    root.render(node);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/?tab=workflow-catalog");
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  globalThis.fetch = realFetch;
  window.history.replaceState({}, "", "/");
});

describe("catalog -> Workflow Runs deep link (#3163)", () => {
  it("the last-run id links to the run's detail", async () => {
    await render(<WorkflowCatalogPanel />);
    const link = [...container.querySelectorAll("a")].find(
      (a) => (a.textContent ?? "").trim() === "chain-42",
    );
    expect(link).toBeDefined();
    expect(link!.getAttribute("href")).toBe("?tab=workflow-runs&run=chain-42");
  });

  it("Workflow Runs opens the run named by ?run=", async () => {
    window.history.replaceState({}, "", "/?tab=workflow-runs&run=chain-42");
    await render(<WorkflowRunsPanel />);
    // the detail dialog renders the run's stage rows
    expect(document.body.textContent).toContain("universe fetched");
  });

  it("an unknown ?run= leaves the ledger closed instead of opening an empty dialog", async () => {
    window.history.replaceState({}, "", "/?tab=workflow-runs&run=does-not-exist");
    await render(<WorkflowRunsPanel />);
    expect(document.body.textContent).not.toContain("universe fetched");
  });
});
