/** @vitest-environment jsdom */
/**
 * Issue #2810 — panel failure surfacing: an errored saga
 * instance renders as a TERMINAL failure state showing the
 * reason, and polling STOPS on it (same stop discipline as
 * the #2777 terminal states — never poll a terminal state
 * forever). Previously the panel showed only the benign
 * fallback row ("payment starting") and kept polling a dead
 * run as if it were alive.
 *
 * Component tests use the repo idiom (createRoot + act +
 * stubbed global fetch, no testing library). Fake timers
 * drive the 30-second poll interval.
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

describe("SagaStartSection errored terminal state (#2810)", () => {
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
    setInput(inputs[0], "AAPL");
    setInput(inputs[1], "10");
    setInput(inputs[2], "alice@example.com");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();
  };

  it("errored instance with a reason renders the failure and stops polling", async () => {
    statusResponses = [
      {
        status: 200,
        body: {
          sagaId: "saga-test-1",
          jobs: [
            {
              stage: "payment",
              status: "submitted",
              detail: "Saga submitted; payment leg starting.",
            },
          ],
          instanceStatus: "errored",
          instanceError:
            "Stored price for family goal is not approved (status: proposed): refusing to charge (fail-closed).",
        },
      },
    ];
    await startSaga();
    expect(statusCalls).toBe(1);
    // Terminal failure state: the reason is visible, the run
    // is no longer "following", and the instance reads errored.
    // Batch A renders the failure as <Notice tone="danger"> (S-U2
    // #3051) — danger renders role="alert", so the alert semantics
    // are preserved; no .options-error div remains.
    const alert = container.querySelector(".ui-notice.tone-danger");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("not approved");
    expect(alert!.textContent).toContain("fail-closed");
    expect(container.textContent).toContain("Instance: errored");
    expect(container.textContent).not.toMatch(/Following this run/);
    // Two more poll intervals fire: no further status calls.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(statusCalls).toBe(1);
  });

  it("errored instance without a reason still stops polling with a fallback message", async () => {
    statusResponses = [
      {
        status: 200,
        body: {
          sagaId: "saga-test-1",
          jobs: [
            {
              stage: "payment",
              status: "submitted",
              detail: "Saga submitted; payment leg starting.",
            },
          ],
          instanceStatus: "errored",
        },
      },
    ];
    await startSaga();
    expect(statusCalls).toBe(1);
    // The failure renders as <Notice tone="danger"> (S-U2 #3051) —
    // danger renders role="alert", so the alert semantics are
    // preserved; no .options-error div remains.
    const alert = container.querySelector(".ui-notice.tone-danger");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("instance errored");
    expect(container.textContent).not.toMatch(/Following this run/);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60000);
    });
    expect(statusCalls).toBe(1);
  });
});
