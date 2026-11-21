/** @vitest-environment jsdom */
/**
 * Issue #5878 — bulk pause / resume / run-now on the Schedules home.
 *
 * Pins the toolbar: Pause all / Resume all / Run all now over the
 * whole list, plus the same three verbs over the kind the filter
 * currently shows; every bulk action confirms (naming the scope and
 * its count) before it runs, posts one `{ scope }` call, and shows
 * the per-row summary — counts plus each refused row with its
 * reason — without stopping on a refusal.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SchedulesPanel } from "../src/client/SchedulesPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const optionsItem = {
  id: "opt-1",
  type: "interval",
  callback: "autonomousOptionsAnalysis",
  intervalSeconds: 3600,
  payload: { symbols: ["AAPL"], userLogin: "trader1", environment: "TEST" },
};

const screenItem = {
  id: "screen-1",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 14 * * 1-5",
  payload: { universe: "SP500", userLogin: "trader1", environment: "TEST" },
};

let container: HTMLDivElement;
let root: Root | null = null;
let recorded: Array<{ url: string; method: string; body: any }> = [];

function bulkSummary(verb: string, scope: string) {
  return {
    success: true,
    verb,
    scope,
    total: 2,
    applied: 1,
    already: 0,
    refused: 1,
    results: [
      { id: "opt-1", kind: "options", outcome: verb === "pause" ? "paused" : verb === "resume" ? "resumed" : "triggered" },
      {
        id: "token-renewal",
        kind: "system",
        outcome: "refused",
        reason: `Schedule 'token-renewal' is a derived record with no alarm to ${verb}.`,
      },
    ],
  };
}

function installFetch(schedules: any[]) {
  recorded = [];
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    recorded.push({ url, method, body });
    if (url === "/api/schedules" && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ count: schedules.length, schedules }) };
    }
    const bulk = url.match(/^\/api\/schedules\/(pause|resume|trigger)$/);
    if (bulk && method === "POST") {
      return { ok: true, status: 200, json: async () => bulkSummary(bulk[1], body?.scope) };
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
    ([...scope.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes(text)) as HTMLButtonElement | undefined) ?? null
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
  await waitForText("Options Market Screen");
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

describe("bulk schedule toolbar (#5878)", () => {
  it("renders Pause all / Resume all / Run all now over the whole list", async () => {
    await renderPanel([optionsItem, screenItem]);
    for (const label of ["Pause all", "Resume all", "Run all now"]) {
      expect(buttonOrNull(document, label)).toBeTruthy();
    }
    // No kind-scoped buttons while the filter is All.
    expect(buttonOrNull(document, "Pause Options")).toBeNull();
  });

  it("confirms before pausing all, posts one scoped call, and shows the per-row summary", async () => {
    await renderPanel([optionsItem, screenItem]);
    await click(buttonIn(document, "Pause all"));
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("Pause all schedules?");
    expect(dialog.textContent).toContain("2 schedules");
    // Nothing posted yet — the confirm gates the call.
    expect(recorded.filter((r) => r.url === "/api/schedules/pause")).toHaveLength(0);
    await click(buttonIn(dialog, "Pause all"));
    await waitForText("Paused 1 schedule");
    const pauseCalls = recorded.filter((r) => r.url === "/api/schedules/pause" && r.method === "POST");
    expect(pauseCalls).toHaveLength(1);
    expect(pauseCalls[0].body).toEqual({ scope: "all" });
    // The summary names the refused row and its reason.
    expect(document.body.textContent).toContain("1 refused");
    expect(document.body.textContent).toContain("token-renewal");
    expect(document.body.textContent).toContain("derived record");
  });

  it("offers the same three verbs over the filtered kind, scoped to it", async () => {
    await renderPanel([optionsItem, screenItem]);
    await click(buttonIn(document, "Options (1)"));
    await flush(40);
    expect(buttonOrNull(document, "Pause Options")).toBeTruthy();
    expect(buttonOrNull(document, "Resume Options")).toBeTruthy();
    expect(buttonOrNull(document, "Run Options now")).toBeTruthy();
    await click(buttonIn(document, "Pause Options"));
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    expect(dialog.textContent).toContain("Pause Options schedules?");
    expect(dialog.textContent).toContain("1 schedule");
    await click(buttonIn(dialog, "Pause Options"));
    await waitForText("Paused 1 schedule");
    const pauseCalls = recorded.filter((r) => r.url === "/api/schedules/pause" && r.method === "POST");
    expect(pauseCalls).toHaveLength(1);
    expect(pauseCalls[0].body).toEqual({ scope: "options" });
  });

  it("runs all now over the whole list through the trigger route", async () => {
    await renderPanel([optionsItem, screenItem]);
    await click(buttonIn(document, "Run all now"));
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    expect(dialog.textContent).toContain("Run all schedules now?");
    await click(buttonIn(dialog, "Run all now"));
    await waitForText("Triggered 1 schedule");
    const triggerCalls = recorded.filter((r) => r.url === "/api/schedules/trigger" && r.method === "POST");
    expect(triggerCalls).toHaveLength(1);
    expect(triggerCalls[0].body).toEqual({ scope: "all" });
  });
});
