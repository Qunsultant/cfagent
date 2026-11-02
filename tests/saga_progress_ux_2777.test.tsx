/** @vitest-environment jsdom */
/**
 * Issue #2777 + #2780 — saga progress UX: no raw API URLs on the
 * panel, polling treats 404 as "not yet", and the receipt links to
 * the Workflow Runs view filtered to the saga id (the link ships
 * with the #2780 extension, now that the run resolves there).
 *
 * Component tests use the repo idiom (createRoot + act + stubbed
 * global fetch, no testing library). Fake timers drive the
 * 30-second poll interval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SagaStartSection, sagaWorkflowRunsLink } from "../src/client/GoalScreenPanel";
import { WorkflowRunsPanel } from "../src/client/WorkflowRunsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const flush = async () => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
};

function setInput(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}


describe("sagaWorkflowRunsLink (#2777)", () => {
  it("builds a Workflow Runs deep link by saga id, never an API URL", () => {
    const href = sagaWorkflowRunsLink("saga-test-1");
    expect(href).toContain("tab=workflow-runs");
    expect(href).toContain("run=saga-test-1");
    expect(href).not.toContain("/api/");
  });
});

describe("SagaStartSection receipt + polling (#2777)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let statusResponses: Array<{ status: number; body: unknown }>;
  let statusCalls: number;

  beforeEach(() => {
    vi.useFakeTimers();
    statusResponses = [];
    statusCalls = 0;
    sessionStorage.clear();
    window.history.pushState({}, "", "/");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        if (url.endsWith("/payments/agentic/commercial/pricing") && method === "GET") {
          return {
            ok: true,
            status: 200,
            json: async () => ({ monetizationEnabled: true, prices: {} }),
          };
        }
        if (url.endsWith("/api/saga/start") && method === "POST") {
          return {
            ok: true,
            status: 202,
            json: async () => ({
              sagaId: "saga-test-1",
              runRequestId: "saga-test-1",
              workflowId: "saga-workflow-1",
              statusUrl: "/api/saga/saga-test-1/status",
              disclosure: "If this screen had failed, a replacement-run credit would apply.",
            }),
          };
        }
        if (url.includes("/api/saga/") && url.endsWith("/status") && method === "GET") {
          statusCalls += 1;
          const next = statusResponses.shift() ?? {
            status: 200,
            body: { sagaId: "saga-test-1", jobs: [] },
          };
          return {
            ok: next.status < 300,
            status: next.status,
            json: async () => next.body,
          };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    sessionStorage.clear();
    window.history.pushState({}, "", "/");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const sagaForm = () => {
    const button = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("Start paid saga"),
    )!;
    return button.closest("form") as HTMLFormElement;
  };

  const startSaga = async () => {
    await act(async () => {
      root.render(<SagaStartSection userLogin="alice" />);
    });
    await flush();
    const form = sagaForm();
    const inputs = [...form.querySelectorAll("input")];
    // Input order: symbol, quantity, email.
    setInput(inputs[0], "AAPL");
    setInput(inputs[1], "10");
    setInput(inputs[2], "alice@example.com");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
  };

  it("receipt renders no URL at all", async () => {
    statusResponses = [
      {
        status: 200,
        body: {
          sagaId: "saga-test-1",
          jobs: [{ stage: "payment", status: "submitted", detail: "payment started" }],
        },
      },
    ];
    await startSaga();
    expect(container.textContent).toContain("Saga started");
    expect(container.textContent).toContain("Run request: saga-test-1");
    expect(container.textContent).toContain("replacement-run credit would apply");
    // Extension (#2780): the receipt links to the Workflow Runs
    // view filtered to this saga id — never a raw API URL.
    const link = [...container.querySelectorAll("a")].find((a) =>
      (a.getAttribute("href") ?? "").includes("tab=workflow-runs"),
    );
    expect(link).toBeTruthy();
    expect(link!.getAttribute("href")).toContain("run=saga-test-1");
    expect(link!.textContent).toMatch(/Workflow Runs/);
    expect(container.textContent).not.toContain("/api/saga/");
  });

  it("a 404 while polling keeps polling with the waiting state, then shows stages when they land", async () => {
    statusResponses = [
      { status: 404, body: { error: "saga not found" } },
      {
        status: 200,
        body: {
          sagaId: "saga-test-1",
          jobs: [{ stage: "payment", status: "submitted", detail: "payment started" }],
        },
      },
    ];
    await startSaga();
    // First poll hit the pre-audit window: no error phase, still
    // following, waiting for the first stage row.
    expect(container.querySelector(".options-error")).toBeNull();
    expect(container.textContent).toContain("Waiting for the first stage row");
    expect(container.textContent).toMatch(/Following this run/);
    expect(statusCalls).toBe(1);
    // The 30-second interval fires the next poll, which lands stages.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30000);
    });
    expect(statusCalls).toBe(2);
    expect(container.textContent).toContain("payment");
    expect(container.textContent).toContain("payment started");
    expect(container.querySelector(".options-error")).toBeNull();
  });

  it("resume renders no URL, not the stored status URL", async () => {
    sessionStorage.setItem(
      "saga:tracking",
      JSON.stringify({
        sagaId: "saga-resumed-1",
        statusUrl: "/api/saga/saga-resumed-1/status",
      }),
    );
    statusResponses = [
      {
        status: 200,
        body: {
          sagaId: "saga-resumed-1",
          jobs: [{ stage: "payment", status: "submitted", detail: "payment started" }],
        },
      },
    ];
    await act(async () => {
      root.render(<SagaStartSection userLogin="alice" />);
    });
    await flush();
    expect(container.textContent).toContain("Saga started (resumed)");
    const link = [...container.querySelectorAll("a")].find((a) =>
      (a.getAttribute("href") ?? "").includes("tab=workflow-runs"),
    );
    expect(link).toBeTruthy();
    expect(link!.getAttribute("href")).toContain("run=saga-resumed-1");
    expect(container.textContent).not.toContain("/api/saga/");
  });
});

describe("WorkflowRunsPanel deep link (#2777)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    window.history.pushState({}, "", "/?tab=workflow-runs&run=saga-test-1");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.startsWith("/api/workflow-runs")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              count: 2,
              runs: [
                {
                  id: "saga-test-1",
                  runId: "saga-test-1",
                  workflow: "saga",
                  family: "saga",
                  title: "Saga saga-test-1",
                  source: "job-chain",
                  trigger: "manual",
                  triggerDetail: "Manual",
                  triggeredBy: "alice",
                  status: "running",
                  startedAt: "2026-11-02T00:00:00.000Z",
                  finishedAt: null,
                  durationMs: null,
                  stageCount: 1,
                  completedStages: 0,
                  failedStages: 0,
                  stages: [],
                  inputs: null,
                  outputs: null,
                  artifacts: [],
                  deliveryStates: {},
                  error: null,
                },
                {
                  id: "other-1",
                  runId: "other-1",
                  workflow: "screener",
                  family: "screener",
                  title: "Screen other-1",
                  source: "job-chain",
                  trigger: "manual",
                  triggerDetail: "Manual",
                  triggeredBy: "alice",
                  status: "completed",
                  startedAt: "2026-11-01T00:00:00.000Z",
                  finishedAt: "2026-11-01T00:01:00.000Z",
                  durationMs: 60000,
                  stageCount: 1,
                  completedStages: 1,
                  failedStages: 0,
                  stages: [],
                  inputs: null,
                  outputs: null,
                  artifacts: [],
                  deliveryStates: {},
                  error: null,
                },
              ],
              summary: {
                total: 2,
                completed: 1,
                partial: 0,
                failed: 0,
                active: 1,
                byTrigger: { manual: 2, scheduled: 0, autonomous: 0, webhook: 0, agent: 0, unknown: 0 },
              },
              generatedAt: "2026-11-02T00:00:00.000Z",
            }),
          };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      }),
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    window.history.pushState({}, "", "/");
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("prefills the search from the run query param and filters to that run", async () => {
    await act(async () => {
      root.render(<WorkflowRunsPanel />);
    });
    await flush();
    const search = container.querySelector(
      'input[aria-label="Search workflow runs"]',
    ) as HTMLInputElement | null;
    expect(search).toBeTruthy();
    expect(search!.value).toBe("saga-test-1");
    expect(container.textContent).toContain("saga-test-1");
    expect(container.textContent).not.toContain("other-1");
  });
});
