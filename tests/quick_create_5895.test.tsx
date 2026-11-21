/** @vitest-environment jsdom */
/**
 * Issue #5895 — quick-create modal on the Schedules home.
 *
 * Harness follows tests/scheduled_options_manager.test.ts: the REAL
 * apiFetch driven against a stubbed global fetch (mock the transport
 * contract, not just payloads), component rendered with
 * react-dom/client in jsdom.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScheduledOptionsManager } from "../src/client/ScheduledOptionsManager";
import { quickCreateDefaultCron } from "../src/client/scheduledOptionsManager/quickCreate";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NEXT_RUN_S = Math.floor(Date.UTC(2026, 9, 19, 14, 30, 0) / 1000);

const existingAnalysis = {
  id: "user-analysis-1",
  type: "interval",
  callback: "autonomousOptionsAnalysis",
  intervalSeconds: 3600,
  payload: {
    symbols: ["NVDA", "AAPL"],
    thesis: "bullish",
    riskProfile: "balanced",
    userLogin: "trader1",
    environment: "TEST",
    universe: "NASDAQ100",
    maxItems: 100,
    trigger: "scheduled",
    pushToSlack: true,
    slackChannel: "#options-alerts",
  },
  time: NEXT_RUN_S,
};

interface StubState {
  schedules: any[];
  /** Callback the stub refuses, to exercise the per-job failure path. */
  failCallback?: string;
}

interface RecordedCall {
  url: string;
  method: string;
  body: any;
}

function installFetch(state: StubState) {
  const calls: RecordedCall[] = [];
  let created = 0;
  const mock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.startsWith("/api/audit")) {
      return Response.json({ events: [] });
    }
    if (url === "/api/schedules" && method === "GET") {
      return Response.json({ count: state.schedules.length, schedules: state.schedules });
    }
    if (url === "/api/schedules/create" && method === "POST") {
      if (state.failCallback && body?.callback === state.failCallback) {
        return Response.json(
          { success: false, error: "Connect an E*TRADE account first." },
          { status: 400 },
        );
      }
      created += 1;
      const id = `sched-quick-${created}`;
      state.schedules.push({
        id,
        type: body?.scheduleType,
        callback: body?.callback,
        cron: body?.cron,
        intervalSeconds: body?.intervalSeconds,
        payload: body?.payload,
        time: NEXT_RUN_S,
      });
      return Response.json({ success: true, schedule: { id, ...body } });
    }
    if (url.includes("/api/etrade/options/profiles") && method === "GET") {
      return Response.json({ count: 0, profiles: [] });
    }
    const byId = url.match(/^\/api\/schedules\/([^/?]+)$/);
    if (byId && method === "GET") {
      const found = state.schedules.find((s) => s?.id === decodeURIComponent(byId[1]));
      if (!found) return Response.json({ error: "schedule not found" }, { status: 404 });
      return Response.json(found);
    }
    return Response.json({ error: `unstubbed ${method} ${url}` }, { status: 500 });
  });
  vi.stubGlobal("fetch", mock);
  return calls;
}

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function waitForText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}". Panel text: ${container.textContent?.slice(0, 600)}`);
}

async function waitForDialogText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dialog = document.querySelector(".sched-quick-create-modal");
    if (dialog?.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for dialog text "${text}".`);
}

async function renderManager() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ScheduledOptionsManager, { activeEnv: "TEST", userLogin: "trader1" }),
    );
  });
  await flush(60);
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await flush(40);
}

function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}

async function openQuickCreate() {
  await click(buttonByText(container, "Quick create"));
  const modal = document.querySelector(".sched-quick-create-modal");
  if (!modal) throw new Error("quick-create modal did not open");
  return modal as HTMLElement;
}

function checkboxFor(modal: HTMLElement, labelText: string): HTMLInputElement {
  const label = [...modal.querySelectorAll("label")].find((l) =>
    (l.textContent || "").includes(labelText),
  );
  if (!label) throw new Error(`row "${labelText}" not found`);
  const box = label.querySelector('input[type="checkbox"]') as HTMLInputElement | null;
  if (!box) throw new Error(`checkbox for "${labelText}" not found`);
  return box;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  vi.unstubAllGlobals();
});

describe("5895 quick create on the Schedules home", () => {
  it("offers Quick create beside New Schedule (one single-create, one bulk-create)", async () => {
    installFetch({ schedules: [existingAnalysis] });
    await renderManager();
    await waitForText("Options Market Screen");
    const creates = [...container.querySelectorAll("button")].filter((b) =>
      /new schedule/i.test(b.textContent ?? ""),
    );
    expect(creates).toHaveLength(1);
    expect(buttonByText(container, "Quick create")).toBeTruthy();
  });

  it("lists every form job with its defaults; discovery is unticked and blocked", async () => {
    installFetch({ schedules: [existingAnalysis] });
    await renderManager();
    await waitForText("Options Market Screen");
    const modal = await openQuickCreate();
    await waitForDialogText("Autonomous Options Analysis");
    const cron = quickCreateDefaultCron();
    expect(modal.textContent).toContain(`Cron ${cron}`);
    expect(modal.textContent).toContain("Universe NASDAQ100");
    expect(modal.textContent).toContain("Slack #options-alerts");
    expect(checkboxFor(modal, "Autonomous Options Analysis").checked).toBe(true);
    expect(checkboxFor(modal, "Autonomous Market Screen").checked).toBe(true);
    const discovery = checkboxFor(modal, "Saved-View Strategy Discovery");
    expect(discovery.checked).toBe(false);
    expect(discovery.disabled).toBe(true);
    expect(modal.textContent).toMatch(/saved discovery view/i);
  });

  it("creates the ticked jobs in one action and reports each id", async () => {
    const calls = installFetch({ schedules: [existingAnalysis] });
    await renderManager();
    await waitForText("Options Market Screen");
    const modal = await openQuickCreate();
    await waitForDialogText("Autonomous Options Analysis");
    await click(buttonByText(modal, "Create selected"));
    await waitForDialogText("sched-quick-1");
    const creates = calls.filter(
      (c) => c.url === "/api/schedules/create" && c.method === "POST",
    );
    expect(creates).toHaveLength(2);
    expect(creates.map((c) => c.body.callback)).toEqual([
      "autonomousOptionsAnalysis",
      "autonomousMarketScreen",
    ]);
    for (const c of creates) {
      expect(c.body.scheduleType).toBe("cron");
      expect(c.body.cron).toBe(quickCreateDefaultCron());
      expect(c.body).not.toHaveProperty("subDailyOptIn");
      expect(c.body.payload.universe).toBe("NASDAQ100");
    }
    // The list refetches and the created rows render with Edit controls.
    await waitForText("sched-quick-2");
    const createdRow = [...container.querySelectorAll(".schedule-item-card")].find((card) =>
      (card.textContent || "").includes("sched-quick-2"),
    );
    expect(createdRow).toBeTruthy();
    expect(
      [...(createdRow as HTMLElement).querySelectorAll("button")].some((b) =>
        (b.textContent || "").includes("Edit"),
      ),
    ).toBe(true);
  });

  it("unticking a job creates only the rest", async () => {
    const calls = installFetch({ schedules: [existingAnalysis] });
    await renderManager();
    await waitForText("Options Market Screen");
    const modal = await openQuickCreate();
    await waitForDialogText("Autonomous Options Analysis");
    await click(checkboxFor(modal, "Autonomous Market Screen"));
    expect(checkboxFor(modal, "Autonomous Market Screen").checked).toBe(false);
    await click(buttonByText(modal, "Create selected"));
    await waitForDialogText("sched-quick-1");
    const creates = calls.filter(
      (c) => c.url === "/api/schedules/create" && c.method === "POST",
    );
    expect(creates).toHaveLength(1);
    expect(creates[0].body.callback).toBe("autonomousOptionsAnalysis");
  });

  it("reports a failed create per job and still creates the rest", async () => {
    const calls = installFetch({
      schedules: [existingAnalysis],
      failCallback: "autonomousOptionsAnalysis",
    });
    await renderManager();
    await waitForText("Options Market Screen");
    const modal = await openQuickCreate();
    await waitForDialogText("Autonomous Options Analysis");
    await click(buttonByText(modal, "Create selected"));
    await waitForDialogText("Connect an E*TRADE account first.");
    const creates = calls.filter(
      (c) => c.url === "/api/schedules/create" && c.method === "POST",
    );
    expect(creates).toHaveLength(2);
    expect(modal.textContent).toContain("sched-quick-1");
    await waitForText("sched-quick-1");
  });
});
