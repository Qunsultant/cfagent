/** @vitest-environment jsdom */
/**
 * Issue #2777 (split variant) — saga progress UX: no raw API URLs
 * on the panel, and polling treats 404 as "not yet". The receipt
 * renders no URL at all; the Workflow Runs link ships later with
 * the Workflow Runs extension follow-up.
 *
 * Component tests use the repo idiom (createRoot + act + stubbed
 * global fetch, no testing library). Fake timers drive the
 * 30-second poll interval.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SagaStartSection } from "../src/client/GoalScreenPanel";

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
    // Split variant: no link of any kind in the receipt — neither
    // the raw status URL nor the Workflow Runs link (held for the
    // extension follow-up). The stage list is the progress view.
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent).not.toContain("/api/saga/");
    expect(container.textContent).not.toContain("Workflow Runs");
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
    expect(container.querySelectorAll("a")).toHaveLength(0);
    expect(container.textContent).not.toContain("/api/saga/");
    expect(container.textContent).not.toContain("Workflow Runs");
  });
});
