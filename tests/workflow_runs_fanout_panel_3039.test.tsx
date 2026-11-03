/** @vitest-environment jsdom */
/**
 * Issue #3039 â€” the Workflow Runs detail renders what #3028 records:
 * the fan-out cap reason and the units a resume skipped. A run that
 * carries neither renders exactly as before (no empty banner).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowRunsPanel } from "../src/client/WorkflowRunsPanel";
import type { WorkflowRun } from "../src/services/workflowRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "job-3028",
    runId: "job-3028",
    workflow: "Options screening workflow",
    family: "options",
    title: "Options screen â€” TSLA",
    source: "job-chain",
    trigger: "scheduled",
    triggerDetail: "Scheduled â€” recorded on the run's job tree",
    triggeredBy: null,
    status: "completed",
    startedAt: "2026-11-03T00:00:00.000Z",
    finishedAt: "2026-11-03T00:01:00.000Z",
    durationMs: 60000,
    stageCount: 1,
    completedStages: 1,
    failedStages: 0,
    stages: [],
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

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;
let payload: unknown = { count: 0, runs: [] };

function stubFetch() {
  globalThis.fetch = vi.fn(async () => Response.json(payload));
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function renderPanel() {
  root = createRoot(container);
  await act(async () => {
    root.render(<WorkflowRunsPanel />);
  });
  await flush();
}

function buttonByText(text: string): HTMLButtonElement {
  const button = [...container.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
  if (!button) throw new Error(`button "${text}" not found`);
  return button as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  stubFetch();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  globalThis.fetch = realFetch;
});

describe("Workflow Runs detail â€” fan-out cap and resume (#3039)", () => {
  it("shows the cap reason and the deferred units", async () => {
    payload = {
      count: 1,
      runs: [
        run({
          fanoutCapReason:
            "fanout_cap_exceeded: 1 unit(s) deferred on stage analysis at maxParallel 2 (S5) â€” queue the tail as a second round/chain; the universe is never truncated silently.",
        }),
      ],
    };
    await renderPanel();
    await act(async () => {
      buttonByText("Details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Fan-out capped");
    expect(text).toContain("fanout_cap_exceeded");
    expect(text).toContain("S5");
  });

  it("shows the units a resume skipped", async () => {
    payload = {
      count: 1,
      runs: [run({ resumedSkippedUnits: ["S1", "S2", "S4"] })],
    };
    await renderPanel();
    await act(async () => {
      buttonByText("Details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).toContain("Resumed run");
    expect(text).toContain("S1, S2, S4");
  });

  it("renders neither banner when the run carries neither field", async () => {
    payload = { count: 1, runs: [run()] };
    await renderPanel();
    await act(async () => {
      buttonByText("Details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    const text = document.body.textContent ?? "";
    expect(text).not.toContain("Fan-out capped");
    expect(text).not.toContain("Resumed run");
  });
});

