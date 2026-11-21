/** @vitest-environment jsdom */
/**
 * Issue #5889 — schedule provenance on the Schedules home.
 *
 * Pins the panel: a Source column on every row (source label + job
 * identity + arming origin), view buttons that filter the list by
 * source (per source kind, plus the Cron timing slice), per-agent and
 * per-workflow views that appear only when rows name them, and the
 * same source in the row detail dialog. The Cron view is a timing
 * slice over the one list — it overlaps Derived by design (caveat
 * (b) of the issue); each row still carries exactly one source, so
 * nothing is double-counted.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SchedulesPanel } from "../src/client/SchedulesPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const derivedItem = {
  id: "token-renewal",
  type: "cron",
  callback: "autoRenewETradeTokens",
  cron: "0 3 * * *",
  payload: {
    provenance: {
      origin: "system",
      createdBy: "system",
      reason: "token-renewal",
      createdAt: "2026-11-21T10:00:00.000Z",
    },
  },
  source: { kind: "derived", job: "token-renewal", origin: "system · token-renewal" },
};

const declaredItem = {
  id: "alarm-declared-1",
  type: "scheduled",
  callback: "_runDeclaredScheduledTask",
  time: Date.parse("2026-11-21T11:00:00.000Z") / 1000,
  payload: {
    taskId: "options-strategy-scan-observe",
    scheduleHash: "1cc4bdea8e8b678cdc2258188071a26f",
    scheduledFor: "2026-11-21T11:00:00.000Z",
  },
  source: {
    kind: "declared-task",
    job: "options-strategy-scan-observe",
    origin: "OrchestratorAgent declaration",
    agent: "OrchestratorAgent",
  },
};

const workflowItem = {
  id: "alarm-1",
  type: "cron",
  callback: "runWorkflowStage",
  cron: "0 21 * * *",
  kind: "workflow-stage",
  jobId: "two-child",
  stageId: "job:0",
  payload: { jobId: "two-child", nodePath: "0", stageId: "job:0" },
  source: {
    kind: "workflow",
    job: "two-child",
    origin: "agent schedules-api",
    agent: "schedules-api",
    workflow: "two-child",
  },
};

const userItem = {
  id: "screen-1",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "5 * * * *",
  payload: {
    universe: "SP500",
    userLogin: "venus",
    provenance: { origin: "user", createdBy: "venus", createdAt: "2026-11-21T10:00:00.000Z" },
  },
  source: { kind: "user-created", job: "autonomousMarketScreen", origin: "user venus" },
};

const legacyItem = {
  id: "legacy-1",
  type: "interval",
  callback: "autonomousOptionsAnalysis",
  intervalSeconds: 3600,
  payload: { symbols: ["AAPL"] },
};

let container: HTMLDivElement;
let root: Root | null = null;

function installFetch(schedules: any[]) {
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    if (url === "/api/schedules" && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ count: schedules.length, schedules }) };
    }
    const detail = url.match(/^\/api\/schedules\/([^/]+)$/);
    if (detail && method === "GET") {
      const found = schedules.find((s) => s.id === decodeURIComponent(detail[1]));
      if (found) return { ok: true, status: 200, json: async () => found };
      return { ok: false, status: 404, json: async () => ({ error: "not found" }) };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
}

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function waitFor(fn: () => boolean, what: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fn()) return;
    await flush(50);
  }
  throw new Error(`timeout waiting for ${what}; body: ${document.body.textContent?.slice(0, 700)}`);
}

async function waitForText(text: string) {
  await waitFor(() => (document.body.textContent ?? "").includes(text), `"${text}"`);
}

async function click(el: Element | null) {
  if (!el) throw new Error("click target missing");
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush(40);
}

function buttonIn(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}

function buttonOrNull(scope: ParentNode, text: string): HTMLButtonElement | null {
  return (
    ([...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) as HTMLButtonElement | undefined) ??
    null
  );
}

/** The visible row ids in the generic table, in render order. */
function visibleRowIds(): string[] {
  return [...document.querySelectorAll("table tbody tr")].map((tr) =>
    (tr.querySelector("code")?.textContent ?? "").trim(),
  );
}

async function renderPanel(schedules: any[]) {
  installFetch(schedules);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ToastProvider>
        <SchedulesPanel activeEnv="TEST" />
      </ToastProvider>,
    );
  });
  await flush(60);
  await waitForText("Schedules");
}

beforeEach(() => {
  document.body.innerHTML = "";
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  vi.unstubAllGlobals();
});

describe("5889 Source column", () => {
  it("every row shows its source label, job identity and arming origin", async () => {
    await renderPanel([derivedItem, declaredItem, workflowItem, userItem]);
    const text = document.body.textContent ?? "";
    expect(text).toContain("Source");
    expect(text).toContain("Derived");
    expect(text).toContain("token-renewal");
    expect(text).toContain("Declared task");
    expect(text).toContain("options-strategy-scan-observe");
    expect(text).toContain("Workflow");
    expect(text).toContain("two-child");
    expect(text).toContain("User-created");
    expect(text).toContain("user venus");
    expect(visibleRowIds()).toEqual([
      "token-renewal",
      "alarm-declared-1",
      "alarm-1",
      "screen-1",
    ]);
  });

  it("a row with no source reads Unknown — never a fabricated source", async () => {
    await renderPanel([legacyItem]);
    expect(document.body.textContent).toContain("Unknown");
    expect(document.body.textContent).toContain("not recorded");
  });
});

describe("5889 source view buttons", () => {
  it("the Source buttons filter the list to one source at a time", async () => {
    await renderPanel([derivedItem, declaredItem, workflowItem, userItem]);
    expect(buttonOrNull(document, "Derived (1)")).toBeTruthy();
    expect(buttonOrNull(document, "Declared task (1)")).toBeTruthy();
    expect(buttonOrNull(document, "Workflow (1)")).toBeTruthy();
    expect(buttonOrNull(document, "User-created (1)")).toBeTruthy();
    await click(buttonIn(document, "Derived (1)"));
    expect(visibleRowIds()).toEqual(["token-renewal"]);
    await click(buttonIn(document, "Declared task (1)"));
    expect(visibleRowIds()).toEqual(["alarm-declared-1"]);
  });

  it("the Cron button is a timing slice: every cron-timed row, whatever its source", async () => {
    await renderPanel([derivedItem, declaredItem, workflowItem, userItem]);
    // Three of the four rows are cron-timed; the declared task is a
    // one-off scheduled alarm, so it drops out of the Cron view.
    await click(buttonIn(document, "Cron (3)"));
    expect(visibleRowIds()).toEqual(["token-renewal", "alarm-1", "screen-1"]);
  });

  it("an empty source view states it instead of showing a bare table", async () => {
    await renderPanel([derivedItem, userItem]);
    await click(buttonIn(document, "Declared task (0)"));
    expect(visibleRowIds()).toEqual([]);
    expect(document.body.textContent).toContain("No Declared task schedules");
  });

  it("the source filter composes with the kind filter", async () => {
    await renderPanel([derivedItem, declaredItem, workflowItem, userItem]);
    await click(buttonIn(document, "System (2)"));
    await click(buttonIn(document, "Derived (1)"));
    expect(visibleRowIds()).toEqual(["token-renewal"]);
  });
});

describe("5889 per-agent and per-workflow views", () => {
  it("the Agent buttons appear only for agents the rows name, and filter to them", async () => {
    await renderPanel([derivedItem, declaredItem, workflowItem, userItem]);
    expect(buttonOrNull(document, "OrchestratorAgent (1)")).toBeTruthy();
    expect(buttonOrNull(document, "schedules-api (1)")).toBeTruthy();
    // No TickerAgent row is loaded, so no TickerAgent button is invented.
    expect(buttonOrNull(document, "TickerAgent")).toBeNull();
    await click(buttonIn(document, "OrchestratorAgent (1)"));
    expect(visibleRowIds()).toEqual(["alarm-declared-1"]);
  });

  it("no Agent group renders when no row names an agent", async () => {
    await renderPanel([derivedItem, userItem]);
    expect(document.body.textContent).not.toContain("Filter schedules by agent");
  });

  it("the Workflow buttons appear only for workflows the rows name, and filter to them", async () => {
    await renderPanel([derivedItem, declaredItem, workflowItem, userItem]);
    expect(buttonOrNull(document, "two-child (1)")).toBeTruthy();
    await click(buttonIn(document, "two-child (1)"));
    expect(visibleRowIds()).toEqual(["alarm-1"]);
  });

  it("no Workflow group renders when no row names a workflow", async () => {
    await renderPanel([derivedItem, userItem]);
    expect(document.body.textContent).not.toContain("Filter schedules by workflow");
  });
});

describe("5889 detail dialog", () => {
  it("the Details dialog shows the row's Source section, same as the column", async () => {
    await renderPanel([derivedItem]);
    await click(buttonIn(document, "Details"));
    await waitForText("Source");
    const dialog = document.querySelector(".sched-detail-modal") as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("Source");
    expect(dialog.textContent).toContain("Derived");
    expect(dialog.textContent).toContain("token-renewal");
    expect(dialog.textContent).toContain("system · token-renewal");
    expect(dialog.textContent).toContain("system");
  });
});
