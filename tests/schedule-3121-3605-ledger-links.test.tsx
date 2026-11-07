/** @vitest-environment jsdom */
/**
 * Issue #3605 — ledger job IDs must be clickable links to the job
 * detail (no manual /api/jobs/<id> typing). Parent program #3121.
 *
 * Coverage:
 * - 3605-P01 Job cell: the id is a visible clickable control; clicking
 *   it opens that job's run history via the existing `run=<id>`
 *   deep link (the ledger's own detail view for a job).
 * - 3605-P02 Async job cell: the id is a visible clickable control;
 *   clicking it fetches `GET /api/jobs/<asyncJobId>` and renders the
 *   job's result in the shared detail view.
 * - 3605-P03 Legacy row: a null async-job id renders as "—" with no
 *   clickable element — never a dead link.
 * - 3605-P04 One job-detail view (#1069): the result viewer is the one
 *   shared component — used by the queue panel and the ledger; the
 *   ledger fetches no job detail itself.
 * - 3605-P05 The shared viewer fetches the job by id and renders its
 *   result JSON. (The job id as a visible label is pinned in P01/P02,
 *   where the ledger shows it on the button and the detail header.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
function read(rel: string): string {
  return readFileSync(join(here, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

import { ScheduleRunLedgerPanel } from "../src/client/ScheduleRunLedgerPanel";
import { AsyncJobResultViewer } from "../src/client/AsyncJobResultViewer";

const LINKED_RUN = {
  system: "orchestrator-schedule",
  jobId: "sched-1",
  operation: "autonomousMarketScreen",
  started: "2026-11-05T10:00:00.000Z",
  finished: "2026-11-05T10:01:00.000Z",
  outcome: "success",
  triggeredBy: "scheduled",
  trigger: "scheduled",
  scheduleId: "sched-1",
  asyncJobId: "job-1",
  workflowId: "wf-1",
  descriptor: "Scanned 400 symbols",
};

const LEGACY_RUN = {
  system: "scheduled-agent-goal",
  jobId: "daily-qa-sweep",
  operation: "qa.sweep",
  started: "2026-11-05T09:30:00.000Z",
  finished: "2026-11-05T09:31:00.000Z",
  outcome: "success",
  triggeredBy: "scheduled",
};

let container: HTMLDivElement;
let root: Root | null = null;

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

async function settle(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  window.history.pushState(null, "", "/?tab=schedules");
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
});

function fetchStub(
  handler: (url: string) => { status: number; body: unknown } | null,
) {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: unknown) => {
      const url = String(input);
      const hit = handler(url);
      if (!hit) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify(hit.body), { status: hit.status });
    },
  );
}

function ledgerStub() {
  fetchStub((url) => {
    if (url.includes("/api/schedules/runs")) return { status: 200, body: { runs: [LINKED_RUN] } };
    if (url.includes("/api/schedule/runs")) return { status: 200, body: { runs: [LEGACY_RUN] } };
    return null;
  });
}

function buttonWithLabel(label: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find(
    (b) => (b.textContent ?? "").trim() === label,
  ) as HTMLButtonElement | undefined;
}

describe("3605-P01 Job cell — clicking the id opens that job's run history (#3605)", () => {
  it("renders the job id as a visible clickable control, not plain text", async () => {
    ledgerStub();
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    const jobButton = buttonWithLabel("sched-1");
    expect(jobButton).toBeDefined();
  });

  it("navigates to the run=<id> deep link for that job", async () => {
    ledgerStub();
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    const jobButton = buttonWithLabel("sched-1");
    expect(jobButton).toBeDefined();
    await act(async () => {
      jobButton!.click();
    });
    await settle();
    expect(window.location.search).toContain("run=sched-1");
  });
});

describe("3605-P02 Async job cell — clicking the id opens the job detail (#3605)", () => {
  it("fetches GET /api/jobs/<id> and renders the job result", async () => {
    fetchStub((url) => {
      if (url.includes("/api/schedules/runs")) return { status: 200, body: { runs: [LINKED_RUN] } };
      if (url.includes("/api/schedule/runs")) return { status: 200, body: { runs: [LEGACY_RUN] } };
      if (url === "/api/jobs/job-1") {
        return { status: 200, body: { jobId: "job-1", status: "completed", result: { matchedCount: 3 } } };
      }
      return null;
    });
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    const asyncButton = buttonWithLabel("job-1");
    expect(asyncButton).toBeDefined();
    await act(async () => {
      asyncButton!.click();
    });
    await settle(6);
    const text = container.textContent ?? "";
    expect(text).toContain("matchedCount");
    expect(text).toContain("job-1");
  });
});

describe("3605-P03 Legacy row — a null async-job id is plain text, never a dead link (#3605)", () => {
  it("renders '—' with no clickable element for the null async-job id", async () => {
    ledgerStub();
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    const dashButtons = Array.from(container.querySelectorAll("button")).filter(
      (b) => (b.textContent ?? "").trim() === "—",
    );
    expect(dashButtons).toHaveLength(0);
    // Exactly one clickable async-job id exists: the linked row's.
    expect(buttonWithLabel("job-1")).toBeDefined();
  });
});

describe("3605-P04 One job-detail view — the shared viewer, used by both panels (#3605)", () => {
  it("the queue panel and the ledger both render the shared AsyncJobResultViewer", () => {
    const queue = read("src/client/AsyncJobsPanel.tsx");
    expect(queue).toContain("AsyncJobResultViewer");
    const ledger = read("src/client/ScheduleRunLedgerPanel.tsx");
    expect(ledger).toContain("AsyncJobResultViewer");
  });

  it("the ledger fetches no job detail itself — the fetch lives in the viewer only", () => {
    const ledger = read("src/client/ScheduleRunLedgerPanel.tsx");
    expect(ledger).not.toContain("fetch(`/api/jobs/");
    expect(ledger).not.toContain('fetch("/api/jobs/');
    const viewer = read("src/client/AsyncJobResultViewer.tsx");
    expect(viewer).toContain("/api/jobs/${jobId}");
  });
});

describe("3605-P05 Shared viewer — fetches the job by id and shows its result (#3605)", () => {
  it("fetches GET /api/jobs/<id> and renders the job result JSON", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    fetchStub((url) => {
      if (url === "/api/jobs/job-9") {
        return { status: 200, body: { jobId: "job-9", status: "completed", result: { matchedCount: 7 } } };
      }
      return null;
    });
    await render(<AsyncJobResultViewer jobId="job-9" variant="standalone" />);
    await settle(6);
    expect(fetchMock).toHaveBeenCalledWith("/api/jobs/job-9");
    const text = container.textContent ?? "";
    expect(text).toContain("matchedCount");
  });

  it("renders nothing when no job is selected", async () => {
    fetchStub(() => null);
    await render(<AsyncJobResultViewer jobId={null} variant="standalone" />);
    await settle();
    expect(container.textContent ?? "").toBe("");
  });
});
