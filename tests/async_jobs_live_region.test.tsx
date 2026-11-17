/** @vitest-environment jsdom */
/**
 * Async jobs live regions (#1578, A2; WCAG 2.2 AA 4.1.3).
 *
 * Assessment-01 found polling updates in AsyncJobsPanel changing the
 * DOM visually with no live region, so screen readers never heard job
 * state changes. Both render modes now expose the aggregate queue
 * status through a polite live region (role="status"): the embedded
 * pill badge itself, and a dedicated status line in full mode. The
 * region text changes only when the aggregate changes (running count
 * or idle), so per-tick polls that change nothing announce nothing.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AsyncJobsPanel } from "../src/client/AsyncJobsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

type Job = {
  jobId: string;
  capability: string;
  label: string;
  status: "queued" | "running" | "completed" | "failed";
  createdAt: string;
  updatedAt: string;
};

const RUNNING: Job[] = [
  {
    jobId: "job-1",
    capability: "test",
    label: "Test job",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let fetchMock: ReturnType<typeof vi.fn>;

function mockJobs(jobs: Job[]) {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.startsWith("/api/jobs?")) {
      return { ok: true, json: async () => ({ jobs }) } as Response;
    }
    return { ok: false, json: async () => ({ error: "not found" }) } as Response;
  });
}

async function waitForText(text: string, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (document.body.textContent?.includes(text)) return;
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
  }
  throw new Error(`timed out waiting for text: ${text}`);
}

beforeEach(() => {
  fetchMock = vi.fn();
  (globalThis as any).fetch = fetchMock;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("AsyncJobsPanel live regions (#1578, A2)", () => {
  it("embedded mode announces the running count through role=status and updates on refresh", async () => {
    mockJobs(RUNNING);
    act(() => {
      root!.render(<AsyncJobsPanel embedded />);
    });
    await waitForText("1 task running");
    const region = document.querySelector('[role="status"]');
    expect(region, "embedded status region must exist").not.toBeNull();
    expect(region!.textContent).toContain("1 task running");

    mockJobs([]);
    const refresh = document.querySelector('button[title="Refresh background tasks"]') as HTMLButtonElement;
    expect(refresh).not.toBeNull();
    act(() => {
      refresh.click();
    });
    await waitForText("Idle / Queue clear");
    expect(document.querySelector('[role="status"]')!.textContent).toContain("Idle / Queue clear");
  });

  it("full mode exposes a dedicated status line", async () => {
    mockJobs(RUNNING);
    act(() => {
      root!.render(<AsyncJobsPanel />);
    });
    await waitForText("1 task running");
    // Issue #5077: the live-status line no longer carries its bespoke class;
    // the role is the selector (unique in full mode once the spinner is gone).
    const region = document.querySelector("[role='status']");
    expect(region, "full-mode status line must exist").not.toBeNull();
    expect(region!.textContent).toContain("1 task running");
  });
});
