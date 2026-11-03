/** @vitest-environment jsdom */
/**
 * Issue #2419 — GoalScreenPanel staged-run tracking loop.
 * Issue #2376 slice 1 — the loop rides the shared polling contract
 * (startPolling): the bounded shape (2s cadence, 10-minute absolute
 * deadline, stops on terminal state) is expressed through the
 * poller's stop handle + deadline checks, and hidden-pause comes
 * from the scheduler (event-driven: the harness dispatches
 * visibilitychange like a real browser). Harness follows
 * tests/goal_screen_panel_persist_2129.test.tsx.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  GoalScreenPanel,
  GOAL_TRACKING_KEY,
  persistGoalTracking,
} from "../src/client/GoalScreenPanel";
import {
  resetAutoRefreshCacheForTests,
  setAutoRefresh,
} from "../src/client/autoRefresh";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const STATUS_URL = "/api/jobs/history?chainId=job-1";

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value: state, configurable: true });
  // A real browser dispatches visibilitychange on every change; the
  // shared scheduler resumes from the event, not from a state poll.
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("GoalScreenPanel tracking loop (#2419)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let statusCalls: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    setVisibility("visible");
    statusCalls = [];
    sessionStorage.clear();
    // Issue #2481: the tracking loop is gated by the global
    // auto-refresh switch; this #2419 pin covers ON behaviour.
    resetAutoRefreshCacheForTests();
    setAutoRefresh(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        const url = String(input);
        if (url.includes("/api/jobs/history")) {
          statusCalls.push(url);
          // Running, never terminal: the loop keeps polling.
          return {
            ok: true,
            status: 200,
            json: async () => ({
              chainId: "job-1",
              jobs: [{ stage: "analysis", status: "running", detail: "", updatedAtMs: 1000 }],
            }),
          };
        }
        return { ok: false, status: 500, json: async () => ({}) };
      }),
    );
    Element.prototype.scrollIntoView = vi.fn() as any;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    vi.unstubAllGlobals();
    sessionStorage.clear();
    resetAutoRefreshCacheForTests();
    setVisibility("visible");
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("skips status fetches while hidden and resumes on visible", async () => {
    persistGoalTracking({ jobId: "job-1", statusUrl: STATUS_URL, startedAtMs: Date.now() });
    expect(sessionStorage.getItem(GOAL_TRACKING_KEY)).not.toBeNull();
    await act(async () => {
      root.render(<GoalScreenPanel activeEnv="PROD" userLogin="alice" />);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(statusCalls.length).toBe(1);
    setVisibility("hidden");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(statusCalls.length).toBe(1);
    setVisibility("visible");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    // Shared-contract resume: the first fetch lands immediately on
    // return, then the 2s cadence resumes.
    expect(statusCalls.length).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(statusCalls.length).toBe(3);
  });
});
