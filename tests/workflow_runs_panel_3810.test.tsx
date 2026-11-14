// @vitest-environment jsdom
/**
 * Issue #3810 — the runs panel distinguishes "none" from
 * "not recorded":
 *  - a run whose trigger is a non-scheduled origin (agent / manual /
 *    webhook) and which carries no schedule shows "Not scheduled",
 *    not "Not recorded";
 *  - a run whose trigger is unknown and which carries no schedule
 *    still shows "Not recorded" (data that should exist is missing);
 *  - a run that produced no documents and no artifacts renders
 *    "None" in the document cells — a tool run's empty cells are
 *    none-produced, not missing data;
 *  - a recorded document failure still renders as a failure badge.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowRunsPanel, RunDetail } from "../src/client/WorkflowRunsPanel";
import type { WorkflowRun } from "../src/services/workflowRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "chain-1",
    runId: "chain-1",
    workflow: "Tool run",
    family: "tool",
    title: "MCP: run_pipeline_chain",
    source: "job-chain",
    trigger: "agent",
    triggerDetail: "Agent — recorded by spr9s",
    triggeredBy: "spr9s",
    status: "running",
    lifecycle: "in-progress",
    startedAt: "2026-11-08T21:14:18.000Z",
    finishedAt: null,
    durationMs: null,
    stageCount: 1,
    completedStages: 0,
    failedStages: 0,
    stages: [
      {
        key: "mcp-1",
        order: 1,
        stage: "run_pipeline_chain",
        label: "MCP: run_pipeline_chain",
        status: "running",
        recordedBy: "job",
        startedAt: "2026-11-08T21:14:18.000Z",
        finishedAt: null,
        durationMs: null,
        detail: "MCP: run_pipeline_chain",
        reason: null,
        error: null,
        capability: "mcp.tool",
        jobKind: "main",
        channel: null,
        input: { toolName: "run_pipeline_chain" },
        output: null,
      },
    ],
    inputs: { toolName: "run_pipeline_chain" },
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
let status = 200;

function stubFetch() {
  globalThis.fetch = vi.fn(async () => {
    if (status !== 200) return Response.json({ error: "boom" }, { status });
    return Response.json(payload);
  });
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

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  status = 200;
  stubFetch();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  globalThis.fetch = realFetch;
});

describe("WorkflowRunsPanel provenance (#3810)", () => {
  it("shows Not scheduled for an agent-triggered run with no schedule", async () => {
    payload = { count: 1, runs: [run({ trigger: "agent", schedule: null })] };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("Agent");
    expect(text).toContain("Not scheduled");
    // The row itself carries no "Not recorded" — the filter
    // dropdowns do list it as an option, so scope the negative
    // assertion to the rendered row.
    const row = container.querySelector("tbody tr");
    expect(row?.textContent ?? "").not.toContain("Not recorded");
  });

  it("shows Not recorded for an unknown-trigger run with no schedule", async () => {
    payload = {
      count: 1,
      runs: [run({ trigger: "unknown", triggerDetail: "Not recorded by the source", schedule: null })],
    };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("Not recorded");
  });

  it("shows the schedule identity for a scheduled run", async () => {
    payload = {
      count: 1,
      runs: [
        run({
          trigger: "scheduled",
          triggerDetail: "Scheduled — recorded on the run's job tree",
          schedule: { mechanism: "agent-scheduler", identity: "goal-7", reason: null, nextFiringAt: null, delaySeconds: null },
        }),
      ],
    };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("goal-7");
  });

  it("renders None in the document cells for a tool run that produced nothing", async () => {
    payload = { count: 1, runs: [run({ documents: null, artifacts: [] })] };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("None");
  });

  it("still renders a recorded document failure as a failure badge", async () => {
    payload = {
      count: 1,
      runs: [
        run({
          family: "stock",
          documents: {
            reportId: "rep-1",
            family: "stock",
            pdfUrl: null,
            pdfStatus: "failed",
            pdfError: "render failed",
            xlsxUrl: null,
            xlsxStatus: null,
            xlsxError: null,
            csvUrl: null,
            csvStatus: null,
            csvError: null,
          },
        }),
      ],
    };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("failed");
  });
});
describe("chain bulk retry affordance (#4416)", () => {
  it("offers Retry failed shards on a failed job-chain run and calls the bulk endpoint", async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    payload = { count: 1, runs: [run({ status: "failed" })] };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, method: init?.method });
      if (url.includes("/api/job-chains/chain-1/retry")) {
        return Response.json({ success: true, retried: ["a", "b"], untouched: 3, failures: [] });
      }
      return Response.json(payload);
    });
    root = createRoot(container);
    await act(async () => {
      root.render(<RunDetail run={run({ status: "failed" })} />);
    });
    await flush();
    const retry = [...container.querySelectorAll("button")].find((button) =>
      (button.textContent ?? "").includes("Retry failed shards"),
    );
    expect(retry).toBeTruthy();
    await act(async () => {
      retry!.click();
    });
    await flush();
    expect(calls.some((call) => call.url.includes("/api/job-chains/chain-1/retry") && call.method === "POST")).toBe(
      true,
    );
    expect(container.textContent ?? "").toContain("Retried 2 failed shards");
  });
});