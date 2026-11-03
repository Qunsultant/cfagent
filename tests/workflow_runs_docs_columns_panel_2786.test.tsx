/** @vitest-environment jsdom */
/**
 * Issue #2786 Part 3 (panel): Workflow Runs carries the Docs columns
 * (Source, PDF, XLSX, CSV) and a Reports filter alongside Trigger and
 * Status. The Reports filter is server-side: selecting it refetches
 * with reports=only so report runs past the 50-window still show.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowRunsPanel } from "../src/client/WorkflowRunsPanel";
import type { WorkflowRun } from "../src/services/workflowRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;
let payload: unknown = { count: 0, runs: [] };
let fetchedUrls: string[] = [];

let detailsPayload: unknown = { detail: null };
function stubFetch() {
  fetchedUrls = [];
  globalThis.fetch = vi.fn(async (input: any) => {
    fetchedUrls.push(String(input));
    if (String(input).includes("/runs/details")) return Response.json(detailsPayload);
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
    status: "completed",
    startedAt: "2026-10-27T13:00:00.000Z",
    finishedAt: "2026-10-27T13:01:25.000Z",
    durationMs: 85000,
    stageCount: 0,
    completedStages: 0,
    failedStages: 0,
    stages: [],
    inputs: {},
    outputs: {},
    artifacts: [],
    deliveryStates: {},
    error: null,
    ...over,
  };
}

const docRun = run({
  id: "goal-run-1",
  runId: "goal-run-1",
  workflow: "Goal screening workflow",
  family: "goal",
  title: "Goal report — Technology",
  source: "report",
  documents: {
    reportId: "rep-1",
    family: "goal",
    pdfUrl: "/api/screening/goal-screen/report.pdf?key=g.pdf",
    pdfStatus: "generated",
    pdfError: null,
    xlsxUrl: null,
    xlsxStatus: "failed",
    xlsxError: "workbook blew up",
    csvUrl: null,
    csvStatus: null,
    csvError: null,
  },
});

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

describe("WorkflowRunsPanel Docs columns + Reports filter", () => {
  it("renders Source, PDF, XLSX, and CSV columns from run documents", async () => {
    payload = { count: 1, runs: [docRun] };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("Source");
    expect(text).toContain("Goal");
    const pdfLink = container.querySelector('a[href="/api/screening/goal-screen/report.pdf?key=g.pdf"]');
    expect(pdfLink).not.toBeNull();
    expect(pdfLink!.textContent).toBe("PDF");
    expect(text).toContain("failed");
    const failedBadge = [...container.querySelectorAll("span")].find(
      (el) => el.textContent?.trim() === "failed",
    );
    expect(failedBadge).not.toBeNull();
    expect(failedBadge!.getAttribute("title")).toBe("workbook blew up");
  });

  it("renders — for a run with no documents", async () => {
    payload = { count: 1, runs: [run()] };
    await renderPanel();
    const text = container.textContent ?? "";
    expect(text).toContain("Source");
    expect(text).toContain("Stock");
  });

  it("refetches with reports=only when the Reports filter is selected", async () => {
    payload = { count: 1, runs: [docRun] };
    await renderPanel();
    expect(fetchedUrls[0]).not.toContain("reports=only");
    await act(async () => {
      buttonByText("Reports only").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(fetchedUrls[fetchedUrls.length - 1]).toContain("reports=only");
    await act(async () => {
      buttonByText("All runs").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(fetchedUrls[fetchedUrls.length - 1]).not.toContain("reports=only");
  });

  it("shows the Documents section in the run detail modal", async () => {
    payload = { count: 1, runs: [docRun] };
    await renderPanel();
    await act(async () => {
      buttonByText("Details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("Documents");
    expect(dialog!.querySelector('a[href="/api/screening/goal-screen/report.pdf?key=g.pdf"]')).not.toBeNull();
  });
});

describe("WorkflowRunsPanel docs RunDetail sections (losslessness)", () => {
  const fakeDetail = {
    catalogVersion: "test",
    id: "rep-1",
    runId: "goal-run-1",
    kind: "goal",
    source: "goal_screen",
    title: "Goal report — Technology",
    createdAt: "2026-10-27T13:00:00.000Z",
    status: "completed",
    resultCount: 3,
    request: [{ field: "symbols", value: "AAPL", source: "recorded", store: "mas_reports" }],
    defaultsApplied: [],
    provenance: { executionMode: null, syncAsync: null, interface: null, parallelism: null, parallelCount: null, parallelCap: null, submittedVia: null, deliveredVia: null, trigger: "manual", scheduleId: null, goalId: null, asyncJobId: null, jobType: null, strategyMode: null, workflowId: null, workflowName: null, workflowVersion: null, workflowType: null },
    lineage: { inputHash: "abc", captureIds: ["cap-1"], captures: [{ field: "provider", value: "etrade", source: "recorded", store: "mas_reports" }], engineVersion: "1", catalogueVersion: null, rendererVersions: {}, store: "mas_reports" },
    stages: [{ stage: "feed", status: "completed", durationMs: 1200, inputIds: [], outputIds: ["out-1"], errorCode: null, error: null, evidence: {} }],
    formats: [{ format: "PDF", status: "generated", url: "/api/screening/goal-screen/report.pdf?key=g.pdf", key: "g.pdf", error: null }],
    reasons: [],
    store: "mas_reports",
  };

  it("fetches docs run details by canonical row id and renders the docs sections without removing existing content", async () => {
    detailsPayload = { detail: fakeDetail };
    payload = { count: 1, runs: [docRun] };
    await renderPanel();
    await act(async () => {
      buttonByText("Details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    await flush();
    expect(fetchedUrls.some((u) => u.includes("/api/runs/details") && u.includes("id=rep-1"))).toBe(true);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    const text = dialog!.textContent ?? "";
    expect(text).toContain("Docs run details");
    expect(text).toContain("Request");
    expect(text).toContain("Provenance");
    expect(text).toContain("Lineage");
    expect(text).toContain("Stage trace");
    expect(text).toContain("Why this report has no data");
    expect(text).toContain("Documents");
    expect(text).toContain("Stages");
    expect(text).toContain("Artifacts & delivery");
  });

  it("does not fetch docs details for a run with no canonical row", async () => {
    payload = { count: 1, runs: [run()] };
    await renderPanel();
    await act(async () => {
      buttonByText("Details").dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await flush();
    expect(fetchedUrls.some((u) => u.includes("/runs/details"))).toBe(false);
    const dialog = document.querySelector('[role="dialog"]') as HTMLElement | null;
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).not.toContain("Docs run details");
  });
});
