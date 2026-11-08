/** @vitest-environment jsdom */
/**
 * Workflow Runs page: the run ledger renders the server's recorded
 * facts — trigger, stages, reasons, inputs/outputs, artifacts — and
 * never fabricates what the stores did not record.
 *
 * Pins:
 *  - one row per run with its trigger, status, duration, and stage count;
 *  - Details opens the run's stage table, the recorded failure reason,
 *    its inputs/outputs, and its artifact links;
 *  - a run whose store recorded no stages says so explicitly;
 *  - trigger/status filters narrow the table to the recorded rows;
 *  - a failed load is stated, not rendered as an empty ledger.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { WorkflowRunsPanel } from "../src/client/WorkflowRunsPanel";
import type { WorkflowRun } from "../src/services/workflowRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "chain-1",
    runId: "chain-1",
    workflow: "Stock screening workflow",
    family: "stock",
    title: "Stock screen — NASDAQ100",
    source: "job-chain",
    trigger: "scheduled",
    triggerDetail: "Scheduled — recorded on the run's job tree",
    triggeredBy: null,
    status: "failed",
    startedAt: "2026-10-27T13:00:00.000Z",
    finishedAt: "2026-10-27T13:01:25.000Z",
    durationMs: 85000,
    stageCount: 2,
    completedStages: 1,
    failedStages: 1,
    stages: [
      {
        key: "job-main",
        order: 1,
        stage: "generate",
        label: "Generate — screen / analysis",
        status: "completed",
        recordedBy: "job",
        startedAt: "2026-10-27T13:00:00.000Z",
        finishedAt: "2026-10-27T13:01:00.000Z",
        durationMs: 60000,
        detail: "Stock screen — NASDAQ100",
        reason: null,
        error: null,
        capability: "http.request",
        jobKind: "main",
        channel: null,
        input: { method: "POST", path: "/etrade/screen" },
        output: { matchedCount: 12 },
      },
      {
        key: "job-deliver",
        order: 2,
        stage: "deliver",
        label: "Deliver — channel dispatch",
        status: "failed",
        recordedBy: "job",
        startedAt: "2026-10-27T13:01:00.000Z",
        finishedAt: "2026-10-27T13:01:25.000Z",
        durationMs: 25000,
        detail: "Deliver by Slack — stock screen",
        reason: "[SLACK_002] channel not configured",
        error: "[SLACK_002] channel not configured",
        capability: "followup.deliver",
        jobKind: "delivery",
        channel: "slack",
        input: { channel: "slack" },
        output: { ok: false },
      },
    ],
    inputs: { method: "POST", trigger: "scheduled" },
    outputs: { outcome: { status: "completed", scanned: 100, matched: 12 } },
    artifacts: [{ kind: "pdf", label: "PDF report", url: "/api/screener/report.pdf?key=report" }],
    deliveryStates: { slack: "failed" },
    error: "[SLACK_002] channel not configured",
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

describe("WorkflowRunsPanel", () => {
  it("owns a scroll container so long run lists and details stay reachable", async () => {
    payload = { count: 0, runs: [] };
    await renderPanel();
    expect(container.querySelector(".workflow-runs-page")).not.toBeNull();
    const css = readFileSync("src/client/workflowRuns.css", "utf8");
    const pageRule = css.match(/\.workflow-runs-page\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(pageRule).toContain("flex: 1 0 auto");
    expect(pageRule).toContain("overflow: auto");
  });

  it("opens the selected run in a dialog and closes it", async () => {
    payload = { count: 1, runs: [run()] };
    await renderPanel();
    const opener = buttonByText("Details");
    expect(opener.getAttribute("aria-haspopup")).toBe("dialog");
    await act(async () => {
      opener.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute("aria-modal")).toBe("true");
    const titleId = dialog!.getAttribute("aria-labelledby");
    expect(document.getElementById(titleId ?? "")?.textContent).toBe("Workflow run detail");
    expect(dialog!.textContent).toContain("Generate — screen / analysis");
    // The detail lives only in the dialog; no stale inline section remains.
    expect(container.querySelector("#workflow-run-detail")).toBeNull();

    const close = document.querySelector('[aria-label="Close dialog"]') as HTMLButtonElement;
    await act(async () => {
      close.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("renders a row per run with trigger, status, and stage progress", async () => {
    payload = { count: 1, runs: [run()] };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("Stock screen — NASDAQ100");
    expect(text).toContain("Scheduled");
    expect(text).toContain("Failed");
    expect(text).toContain("1/2 completed");
    expect(text).toContain("chain-1");
  });

  it("opens the run detail with stages, reasons, inputs, outputs, and artifacts", async () => {
    payload = { count: 1, runs: [run()] };
    await renderPanel();
    await act(async () => {
      buttonByText("Details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const text = document.body.textContent ?? "";
    expect(text).toContain("Workflow run detail");
    expect(text).toContain("Generate — screen / analysis");
    expect(text).toContain("Deliver — channel dispatch");
    expect(text).toContain("[SLACK_002] channel not configured");
    expect(text).toContain("Scheduled — recorded on the run's job tree");
    expect(text).toContain("matchedCount");
    const pdf = [...document.querySelectorAll("a")].find((a) => a.textContent === "PDF report");
    expect(pdf?.getAttribute("href")).toBe("/api/screener/report.pdf?key=report");
    expect(text).toContain("slack: failed");
  });

  it("says a run has no stage records instead of inventing stages", async () => {
    payload = {
      count: 1,
      runs: [
        run({
          id: "discovery-1",
          runId: "discovery-1",
          source: "job-outcome",
          workflow: "Strategy discovery workflow",
          title: "Discovery run — discovery-1",
          status: "completed",
          stageCount: 0,
          completedStages: 0,
          failedStages: 0,
          stages: [],
          error: null,
          artifacts: [],
          deliveryStates: {},
        }),
      ],
    };
    await renderPanel();
    await act(async () => {
      buttonByText("Details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("No stage records exist for this run");
    expect(document.body.textContent).toContain("Stages are never inferred");
  });

  it("filters by status and trigger", async () => {
    payload = {
      count: 2,
      runs: [
        run(),
        run({
          id: "chain-2",
          runId: "chain-2",
          title: "Manual options run",
          trigger: "manual",
          triggerDetail: "Manual — recorded by the operator",
          status: "completed",
          failedStages: 0,
          stages: [],
          stageCount: 0,
          error: null,
          artifacts: [],
          deliveryStates: {},
        }),
      ],
    };
    await renderPanel();
    await act(async () => {
      buttonByText("Failed").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Stock screen — NASDAQ100");
    expect(container.textContent).not.toContain("Manual options run");

    await act(async () => {
      buttonByText("All statuses").dispatchEvent(new MouseEvent("click", { bubbles: true }));
      buttonByText("Manual").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Manual options run");
    expect(container.textContent).not.toContain("Stock screen — NASDAQ100");
  });

  it("states a failed load instead of showing an empty ledger", async () => {
    status = 500;
    await renderPanel();
    expect(container.textContent).toContain("Could not load workflow runs");
  });

  it("renders lifecycle + schedule columns and filters by them (#3021)", async () => {
    payload = {
      count: 2,
      runs: [
        run({
          id: "sched-1",
          runId: "sched-1",
          title: "Scheduled market screen",
          workflow: "Scheduled task",
          source: "schedule",
          status: "queued",
          lifecycle: "scheduled",
          schedule: {
            mechanism: "agent-scheduler",
            identity: "0 3 * * *",
            reason: "Nightly market scan",
            nextFiringAt: "2026-11-05T03:00:00.000Z",
            delaySeconds: null,
          },
          stages: [],
          stageCount: 0,
          completedStages: 0,
          failedStages: 0,
          error: null,
          artifacts: [],
          deliveryStates: {},
        }),
        run({
          id: "chain-2",
          runId: "chain-2",
          title: "Manual options run",
          trigger: "manual",
          triggerDetail: "Manual — recorded by the operator",
          status: "completed",
          lifecycle: "done",
          schedule: { mechanism: "manual", identity: null, reason: null, nextFiringAt: null, delaySeconds: null },
          failedStages: 0,
          stages: [],
          stageCount: 0,
          error: null,
          artifacts: [],
          deliveryStates: {},
        }),
      ],
    };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("Scheduled market screen");
    expect(text).toContain("Agent scheduler");
    expect(text).toContain("0 3 * * *");
    expect(text).toContain("Nightly market scan");
    expect(text).toContain("Done");
    const lifecycleGroup = container.querySelector('[aria-label="Filter runs by lifecycle state"]');
    const scheduledPill = [...(lifecycleGroup?.querySelectorAll("button") ?? [])].find(
      (b) => b.textContent?.trim() === "Scheduled",
    );
    expect(scheduledPill).not.toBeUndefined();
    await act(async () => {
      scheduledPill!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Scheduled market screen");
    expect(container.textContent).not.toContain("Manual options run");
  });

  it("renders a running flagged run as Stuck, not Running (#3784)", async () => {
    payload = {
      count: 1,
      runs: [
        run({
          id: "job-stuck",
          runId: "job-stuck",
          status: "running",
          stuck: true,
          title: "MCP etrade_preview_order",
          startedAt: "2026-11-08T15:29:00.000Z",
          finishedAt: null,
          durationMs: null,
        }),
      ],
    };
    await renderPanel();
    expect(container.textContent).toContain("Stuck");
    expect(container.textContent).not.toContain("Running");
  });

  it("renders an unflagged running run as Running (#3784)", async () => {
    payload = {
      count: 1,
      runs: [
        run({
          id: "job-young",
          runId: "job-young",
          status: "running",
          stuck: false,
          title: "MCP market_data_get_quote",
          startedAt: "2026-11-08T15:29:00.000Z",
          finishedAt: null,
          durationMs: null,
        }),
      ],
    };
    await renderPanel();
    expect(container.textContent).toContain("Running");
    expect(container.textContent).not.toContain("Stuck");
  });

  it("keeps Refresh and Retry reachable on a failed load (#2283 stream 3)", async () => {
    status = 500;
    await renderPanel();
    // The load error used to ride PageShell's error prop, which hides
    // all children — including Refresh. Both controls must stay visible.
    expect(container.textContent).toContain("Could not load workflow runs");
    expect(buttonByText("↻ Refresh")).not.toBeNull();
    expect(buttonByText("Retry")).not.toBeNull();
    // Retry refetches: the server recovers and the ledger renders.
    status = 200;
    payload = { count: 1, runs: [run()] };
    await act(async () => {
      buttonByText("Retry").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).toContain("Stock screen — NASDAQ100");
  });
});
