/** @vitest-environment jsdom */
/**
 * Issue #5891 — Delete must delete (panel half).
 *
 * Owner's rule (2026-11-20): NO new button — Delete either deletes
 * or is disabled with the reason. So a goal / non-managed row's
 * Delete is disabled with the refusal as its title (the Trigger Now
 * disabled+title precedent), and the confirm modal no longer
 * promises removal for rows the path cannot remove: the removal
 * sentence renders only for rows Delete can actually remove. The
 * ticker-push feed renders in its own card with no Delete at all
 * (#6503 step 14). The six system duties are stored rows now
 * (#6503), so a stored system row's Delete is enabled like any
 * deletable row's.
 *
 * Harness follows tests/bulk_schedules_5878.test.tsx: the real
 * SchedulesPanel driven against a stubbed global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SchedulesPanel } from "../src/client/SchedulesPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const screenItem = {
  id: "screen-1",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 14 * * 1-5",
  payload: { universe: "SP500", userLogin: "trader1", environment: "TEST" },
};

const systemItem = {
  id: "token-renewal",
  type: "interval",
  callback: "autoRenewETradeTokens",
  intervalSeconds: 2_592_000,
  kind: "internal",
  payload: { userLogin: "trader1", environment: "TEST" },
};

const goalItem = {
  id: "goal-1",
  type: "cron",
  callback: "runScheduledGoal",
  cron: "0 9 * * *",
  kind: "goal",
  payload: { userLogin: "trader1", environment: "TEST" },
};

const tickerItem = {
  id: "ticker-push",
  type: "interval",
  callback: "pushTicks",
  intervalSeconds: 5,
  kind: "ticker-push",
  armed: true,
  health: "healthy",
  payload: { userLogin: "trader1", environment: "TEST" },
};

let container: HTMLDivElement;
let root: Root | null = null;
let recorded: Array<{ url: string; method: string; body: any }> = [];
let live: any[] = [];

function installFetch(schedules: any[]) {
  recorded = [];
  live = [...schedules];
  vi.stubGlobal(
    "fetch",
    async (input: any, init: any = {}) => {
      const url = String(input);
      const method = String(init.method || "GET").toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      recorded.push({ url, method, body });
      if (url === "/api/schedules" && method === "GET") {
        return Response.json({ count: live.length, schedules: live });
      }
      const del = url.match(/^\/api\/schedules\/([^/]+)$/);
      if (del && method === "DELETE") {
        const id = decodeURIComponent(del[1]);
        if (id !== "ticker-push") {
          live = live.filter((s) => s.id !== id);
        }
        return Response.json({ scheduleId: id, cancelled: true });
      }
      return Response.json({ success: true });
    },
  );
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

/** The Delete button on the table row whose id cell reads `id`. */
function deleteButtonForRow(id: string): HTMLButtonElement | null {
  const rows = [...document.querySelectorAll("tr")];
  const row = rows.find((tr) => (tr.textContent ?? "").includes(id));
  if (!row) throw new Error(`row "${id}" not found`);
  const btn = [...row.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === "Delete");
  if (!btn) throw new Error(`Delete button for row "${id}" not found`);
  return btn as HTMLButtonElement;
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
  await waitForText("Stock Market Screen");
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

describe("5891 Delete is disabled with the reason on rows it cannot remove", () => {
  it("a stored system row's Delete is enabled and deletes on confirm (#6503)", async () => {
    await renderPanel([screenItem, systemItem, goalItem]);
    const btn = deleteButtonForRow("token-renewal");
    expect(btn?.disabled).toBe(false);
    expect(btn?.title).toBe("Delete this schedule");
    await click(btn);
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("is removed from the schedule store");
    await click(buttonIn(dialog, "Delete schedule"));
    await waitFor(() => recorded.some((r) => r.method === "DELETE" && r.url === "/api/schedules/token-renewal"), "DELETE token-renewal");
    await waitForText("Stock Market Screen");
    expect(document.body.textContent).not.toContain("token-renewal");
  });

  it("a goal row's Delete is disabled and names the goals surface", async () => {
    await renderPanel([screenItem, systemItem, goalItem]);
    const btn = deleteButtonForRow("goal-1");
    expect(btn?.disabled).toBe(true);
    expect(btn?.title).toContain("Goal schedules");
    expect(btn?.title).toContain("/api/schedule/goals/");
    await click(btn);
    expect(recorded.filter((r) => r.method === "DELETE")).toHaveLength(0);
  });

  it("a deletable row's Delete stays enabled", async () => {
    await renderPanel([screenItem, systemItem, goalItem]);
    const btn = deleteButtonForRow("screen-1");
    expect(btn?.disabled).toBe(false);
    expect(btn?.title).toBe("Delete this schedule");
  });
});

describe("5891 the confirm modal promises only what the path can do", () => {
  it("a deletable row's confirm promises removal and deletes on confirm", async () => {
    await renderPanel([screenItem, systemItem]);
    await click(deleteButtonForRow("screen-1"));
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain("is removed from the schedule store");
    expect(dialog.textContent).toContain("This cannot be undone.");
    await click(buttonIn(dialog, "Delete schedule"));
    await waitFor(() => recorded.some((r) => r.method === "DELETE" && r.url === "/api/schedules/screen-1"), "DELETE screen-1");
    await waitForText("token-renewal");
    expect(document.body.textContent).not.toContain("screen-1");
  });

  it("ticker-push renders as a feed card, not a schedule row — with its own controls and no Delete", async () => {
    // Issue #6503 step 14 — the ticker push is a feed, not a
    // schedule: it renders in its own card above the table, with
    // Pause / Resume / Trigger / Edit through the feed routes, and
    // no Delete (pausing stops the push; Resume brings it back).
    await renderPanel([screenItem, tickerItem]);
    const card = document.querySelector("#ticker-feed-card") as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.textContent).toContain("Ticker push");
    expect(card.textContent).toContain("Feed");
    expect(card.textContent).toContain("Healthy");
    expect(card.textContent).toContain("Last push");
    // No schedule row for the feed: the table holds only the screen row.
    expect(deleteButtonForRow("screen-1")).toBeTruthy();
    expect(
      [...document.querySelectorAll("tr")].some((tr) => (tr.textContent ?? "").includes("ticker-push")),
    ).toBe(false);
    // Exactly one Delete on the page — the screen row's.
    const deletes = [...document.querySelectorAll("button")].filter(
      (b) => (b.textContent ?? "").trim() === "Delete",
    );
    expect(deletes).toHaveLength(1);
    // The feed's own controls fire through the feed routes.
    await click(buttonIn(card, "Pause"));
    await waitFor(
      () => recorded.some((r) => r.method === "POST" && r.url === "/api/schedules/ticker-push/pause"),
      "POST ticker-push pause",
    );
    await click(buttonIn(card, "Trigger Now"));
    await waitFor(
      () => recorded.some((r) => r.method === "POST" && r.url === "/api/schedules/ticker-push/trigger"),
      "POST ticker-push trigger",
    );
  });
});
