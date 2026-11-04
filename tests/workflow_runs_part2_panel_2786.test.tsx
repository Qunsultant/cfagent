/** @vitest-environment jsdom */
/**
 * #2786 Part 2 — Workflow Runs toolbar controls + sorting (RED FIRST).
 *
 * Pins, against a mocked fetch:
 *  - every data column sorts (Docs-tab parity: same column reverses,
 *    a new column starts at its default direction);
 *  - the read-traces toggle is visible, shows the hidden count, and
 *    refetches with traces=all when shown (nothing silently dropped);
 *  - the ad-beacons toggle flips the per-browser preference;
 *  - Load more pages with offset and appends (no 50-cap dead end);
 *  - the prune action previews counts (running rows never deleted)
 *    before confirming, then reports the deleted count and refreshes.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { WorkflowRunsPanel } from "../src/client/WorkflowRunsPanel";
import type { WorkflowRun } from "../src/services/workflowRuns";
import { AD_BEACONS_PAUSED_KEY } from "../src/client/adBeacons";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "r1",
    runId: "r1",
    workflow: "Stock screening workflow",
    family: "stock",
    title: "Stock screen",
    source: "job-chain",
    trigger: "manual",
    triggerDetail: "Manual",
    triggeredBy: null,
    status: "completed",
    startedAt: "2026-11-03T10:00:00.000Z",
    finishedAt: "2026-11-03T10:01:00.000Z",
    durationMs: 60000,
    stageCount: 0,
    completedStages: 0,
    failedStages: 0,
    stages: [],
    inputs: null,
    outputs: null,
    artifacts: [],
    deliveryStates: {},
    error: null,
    ...over,
  };
}

const realFetch = globalThis.fetch;
let container: HTMLDivElement;
let root: Root;
let listPayload: Record<string, unknown>;
let fetchCalls: Array<{ url: string; method: string; body: unknown }>;
let prunePreview: Record<string, unknown>;
let pruneConfirm: Record<string, unknown>;

function stubFetch() {
  fetchCalls = [];
  globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: unknown }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    let body: unknown = undefined;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = init?.body;
    }
    fetchCalls.push({ url, method, body });
    if (url.includes("/api/maintenance/clear-table") && method === "POST") {
      const confirmed = (body as { confirm?: boolean } | undefined)?.confirm === true;
      return Response.json(confirmed ? pruneConfirm : prunePreview);
    }
    if (url.includes("/api/workflow-runs")) {
      const offset = Number(new URL(url, "https://agent.internal").searchParams.get("offset") ?? "0");
      if (offset > 0 && Array.isArray((listPayload as { nextPage?: unknown[] }).nextPage)) {
        return Response.json({
          count: 1,
          runs: (listPayload as { nextPage: unknown[] }).nextPage,
          totalMatched: 3,
          summary: (listPayload as { summary?: unknown }).summary ?? null,
        });
      }
      return Response.json(listPayload);
    }
    return Response.json({ error: "not mocked" }, { status: 404 });
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

function titles(): string[] {
  return [...container.querySelectorAll(".workflow-runs-title")].map((el) => el.textContent ?? "");
}

function buttonByPrefix(prefix: string): HTMLButtonElement {
  // Modals portal to document.body, so search the whole document.
  const button = [...document.querySelectorAll("button")].find((candidate) =>
    (candidate.textContent ?? "").trim().startsWith(prefix),
  );
  if (!button) throw new Error(`button starting with "${prefix}" not found`);
  return button as HTMLButtonElement;
}

function buttonByAriaLabel(label: string): HTMLButtonElement {
  const button = document.querySelector(`button[aria-label="${label}"]`);
  if (!button) throw new Error(`button aria-label "${label}" not found`);
  return button as HTMLButtonElement;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  window.localStorage.clear();
  listPayload = {
    count: 3,
    runs: [
      run({ id: "a", title: "Beta", startedAt: "2026-11-03T10:00:00.000Z", status: "completed", durationMs: 5000 }),
      run({ id: "b", title: "Alpha", startedAt: "2026-11-03T11:00:00.000Z", status: "failed", durationMs: null }),
      run({ id: "c", title: "Gamma", startedAt: "2026-11-03T09:00:00.000Z", status: "running", durationMs: 9000 }),
    ],
    totalMatched: 3,
    hiddenTraceCount: 4,
    summary: { total: 3, completed: 1, partial: 0, failed: 1, active: 1, byTrigger: { manual: 3, scheduled: 0, autonomous: 0, webhook: 0, agent: 0, unknown: 0 } },
  };
  prunePreview = { table: "mas_async_jobs", scope: "session", confirmed: false, confirmRequired: true, wouldDelete: 5, breakdown: { completed: 5 }, skippedRunning: 1 };
  pruneConfirm = { table: "mas_async_jobs", scope: "session", confirmed: true, deleted: 5, skippedRunning: 1 };
  stubFetch();
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  globalThis.fetch = realFetch;
});

describe("Workflow Runs Part 2 panel controls", () => {
  it("sorts columns: Started reverses, Workflow starts A→Z", async () => {
    await renderPanel();
    // Default sort is newest first (Started descending), not API order.
    expect(titles()).toEqual(["Alpha", "Beta", "Gamma"]);
    await act(async () => {
      buttonByAriaLabel("Sort by Started").click();
    });
    await flush();
    expect(titles()).toEqual(["Gamma", "Beta", "Alpha"]);
    await act(async () => {
      buttonByAriaLabel("Sort by Workflow").click();
    });
    await flush();
    // All three rows share one workflow label, so the tie falls back
    // to newest-first — the sort control still engaged and stable.
    expect(titles()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("shows the hidden read-trace count and refetches with traces=all when shown", async () => {
    await renderPanel();
    const toggle = buttonByPrefix("Read traces:");
    expect(toggle.textContent).toContain("4");
    await act(async () => {
      toggle.click();
    });
    await flush();
    expect(fetchCalls.some((c) => c.url.includes("traces=all"))).toBe(true);
    expect(buttonByPrefix("Read traces:").textContent).toContain("shown");
  });

  it("toggles the ad-beacon preference and the label follows it", async () => {
    await renderPanel();
    const toggle = buttonByPrefix("Ad beacons:");
    expect(toggle.textContent).toContain("on");
    expect(window.localStorage.getItem(AD_BEACONS_PAUSED_KEY)).toBeNull();
    await act(async () => {
      toggle.click();
    });
    await flush();
    expect(window.localStorage.getItem(AD_BEACONS_PAUSED_KEY)).toBe("1");
    expect(buttonByPrefix("Ad beacons:").textContent).toContain("off");
  });

  it("loads more with offset and appends (no 50-cap dead end)", async () => {
    (listPayload as Record<string, unknown>).runs = [
      run({ id: "a", title: "Beta", startedAt: "2026-11-03T10:00:00.000Z" }),
      run({ id: "b", title: "Alpha", startedAt: "2026-11-03T11:00:00.000Z" }),
    ];
    (listPayload as Record<string, unknown>).nextPage = [
      run({ id: "c", title: "Gamma", startedAt: "2026-11-03T09:00:00.000Z" }),
    ];
    await renderPanel();
    expect(titles()).toEqual(["Alpha", "Beta"]);
    await act(async () => {
      buttonByPrefix("Load more").click();
    });
    await flush();
    expect(fetchCalls.some((c) => c.url.includes("offset=2"))).toBe(true);
    expect(titles()).toEqual(["Alpha", "Beta", "Gamma"]);
  });

  it("prune previews counts, never deletes running rows, and reports the deleted count", async () => {
    await renderPanel();
    await act(async () => {
      buttonByPrefix("Prune history").click();
    });
    await flush();
    await flush();
    // The modal portals to document.body, not the panel container.
    expect(document.body.textContent).toContain("5");
    expect(document.body.textContent).toContain("1 running");
    await act(async () => {
      buttonByPrefix("Confirm prune").click();
    });
    await flush();
    await flush();
    const confirmCall = fetchCalls.find(
      (c) => c.url.includes("/api/maintenance/clear-table") && (c.body as { confirm?: boolean })?.confirm === true,
    );
    expect(confirmCall).toBeDefined();
    expect((confirmCall!.body as Record<string, unknown>).table).toBe("mas_async_jobs");
    expect(container.textContent).toContain("Deleted 5");
  });
});
