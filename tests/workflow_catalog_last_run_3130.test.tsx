/** @vitest-environment jsdom */
/**
 * Issue #3130 (#3069 S4) - the catalog joins each workflow to its family's
 * most recent run so a stage shows its last outcome next to its contract.
 * A stage with no row renders "never attempted"; a failed load leaves the
 * contract intact.
 */
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowCatalogPanel } from "../src/client/WorkflowCatalogPanel";
import type { WorkflowRun } from "../src/services/workflowRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "chain-1",
    runId: "chain-1",
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
    stageCount: 2,
    completedStages: 1,
    failedStages: 1,
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
        detail: null,
        reason: null,
        error: null,
        capability: null,
        jobKind: null,
        channel: null,
        input: null,
        output: null,
      } as never,
      {
        key: "job-generate",
        order: 2,
        stage: "generate",
        label: "Generate",
        status: "failed",
        recordedBy: "job",
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        detail: null,
        reason: null,
        error: "boom",
        capability: null,
        jobKind: null,
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

async function renderWith(payload: unknown, ok = true) {
  globalThis.fetch = vi.fn(async () =>
    ok ? Response.json(payload) : Response.json({ error: "boom" }, { status: 500 }),
  ) as never;
  root = createRoot(container);
  await act(async () => {
    root.render(<WorkflowCatalogPanel />);
  });
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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
  globalThis.fetch = realFetch;
});

describe("catalog last-run column (#3130)", () => {
  it("shows the family's latest run and its per-stage status", async () => {
    await renderWith({ runs: [run()] });
    const text = container.textContent ?? "";
    expect(text).toContain("Last run:");
    expect(text).toContain("chain-1");
    expect(text).toContain("completed"); // feed
    expect(text).toContain("failed"); // generate -> analysis
    expect(text).toContain("never attempted"); // stages with no row
  });

  it("says 'no run recorded' when the family has no run", async () => {
    await renderWith({ runs: [] });
    expect(container.textContent).toContain("no run recorded");
  });

  it("keeps the stage contract when the run state cannot be loaded", async () => {
    await renderWith({ error: "boom" }, false);
    const text = container.textContent ?? "";
    expect(text).toContain("Run state unavailable");
    expect(text).toContain("Timing:");
    expect(text).toContain("feed");
  });

  it("maps the run's generate verb onto the catalog's analysis stage", async () => {
    await renderWith({ runs: [run()] });
    // The stock card is the one with a run; its analysis row must carry the
    // failed generate status, not a phantom "never attempted".
    const analysisRows = [...container.querySelectorAll("tr")].filter((tr) =>
      ((tr.querySelector("strong")?.textContent ?? "") === "analysis"),
    );
    expect(analysisRows.length).toBeGreaterThan(0);
    expect(analysisRows.some((tr) => (tr.textContent ?? "").includes("failed"))).toBe(true);
  });
});
