/**
 * Issue #3121 Slice S3 — the goals view renders through the S1
 * primitives: run history from the one consolidated ledger read
 * (`listAllRuns`, the same read the runs view uses), normalized
 * with the S1 normalizer, and creation provenance on every goal.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ScheduledGoalsPanel } from "../src/client/ScheduledGoalsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OPERATIONS = [
  { operation: "qa.run_sweep", agent: "qa", blurb: "QA sweep." },
  { operation: "search.query", agent: "search", blurb: "Web and data search." },
];

const GOALS = [
  {
    id: "g-1",
    name: "Goal One",
    cron: "0 6 * * *",
    operation: "qa.run_sweep",
    budgetCents: 500,
    enabled: true,
    lastRun: "2026-11-03T06:00:01.000Z",
    provenance: {
      origin: "user",
      createdBy: "octocat-schedule",
      createdAt: "2026-11-01T00:00:00.000Z",
    },
  },
  {
    id: "g-2",
    name: "Legacy goal",
    cron: "0 7 * * *",
    operation: "search.query",
    budgetCents: 100,
    enabled: false,
  },
];

const RUNS = [
  {
    system: "scheduled-agent-goal",
    jobId: "g-1",
    operation: "qa.run_sweep",
    started: "2026-11-03T06:00:01.000Z",
    finished: "2026-11-03T06:00:02.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    trigger: "scheduled",
    scheduleId: "g-1",
    asyncJobId: "job_g-1",
    workflowId: null,
    descriptor: "job:job_g-1",
  },
  // Legacy row: no §4 linkage at all — the normalizer reads it as
  // unknown + nulls, and the view renders those, never drops it.
  {
    system: "scheduled-agent-goal",
    jobId: "g-2",
    operation: "search.query",
    started: "2026-11-02T07:00:01.000Z",
    finished: "2026-11-02T07:00:02.000Z",
    outcome: "skipped",
    triggeredBy: "manual",
    detail: "budget check rejected: over budget",
  },
];

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

function installFetch(runsStatus = 200) {
  (globalThis as any).fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/schedule/goals" && method === "GET") {
      return jsonResponse({ ok: true, goals: GOALS });
    }
    if (path.startsWith("/api/schedule/ticks")) {
      return jsonResponse({ ok: true, ticks: [] });
    }
    if (path === "/api/schedule/operations" && method === "GET") {
      return jsonResponse({ ok: true, operations: OPERATIONS });
    }
    // The one merged read (#3123): the panel reads runs only from
    // GET /api/ledger/runs now.
    if (path.startsWith("/api/ledger/runs")) {
      if (runsStatus !== 200) {
        return jsonResponse({ ok: false, error: "ledger down" }, runsStatus);
      }
      return jsonResponse({ ok: true, runs: RUNS });
    }
    return jsonResponse({ ok: false, error: "not found" }, 404);
  });
}

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ScheduledGoalsPanel />);
  });
  await act(async () => {});
}

beforeEach(() => {
  installFetch();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("S3 goals view — provenance + one ledger read (#3121)", () => {
  it("renders creation provenance, and 'not recorded' for a legacy goal", async () => {
    await renderPanel();
    expect(container.textContent).toContain("provenance user");
    expect(container.textContent).toContain("octocat-schedule");
    expect(container.textContent).toContain("provenance not recorded");
  });

  it("renders recent goal runs from the consolidated ledger with §4 linkage", async () => {
    await renderPanel();
    expect(container.textContent).toContain("Recent goal runs");
    // Linked run: trigger + ids render.
    expect(container.textContent).toContain("job_g-1");
    expect(container.textContent).toContain("trigger scheduled");
    // Legacy run: unknown trigger, null ids as "—", never dropped.
    expect(container.textContent).toContain("trigger unknown");
    expect(container.textContent).toContain("budget check rejected: over budget");
    expect(container.textContent).toContain("g-2");
  });

  it("a ledger-read failure never fails the goals list", async () => {
    installFetch(500);
    await renderPanel();
    // Goals still render; the failure shows in the runs section only.
    expect(container.textContent).toContain("Goal One");
    expect(container.textContent).toContain("Recent goal runs");
    // The runs-section error surfaces in the runs section only (the
    // panel's existing convention renders the read error's message).
    expect(container.textContent).toContain("ledger down");
  });
});
