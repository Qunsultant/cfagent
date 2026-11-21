/** @vitest-environment jsdom */
/**
 * Issue #5893 — one-click empty the schedules list (safe wipe: own
 * instance, confirmation, audit).
 *
 * The Schedules home gains one "Empty the list" action, reusing the
 * wipe machinery already built: POST /api/schedules/cancel-all and
 * POST /api/maintenance/clear-table (preview + confirm each), and
 * the AdminQueueWipePanel preview → confirm → verify flow. Own
 * instance only — KV is never touched, nothing platform-wide.
 *
 * The preview names what will go (alarms + paused records) and what
 * will come back on its own (derived rows re-derive from code,
 * declared tasks re-arm on the next Think reconcile, built-in goals
 * re-seed when the store is empty except goals the owner removed).
 * The action is platform-admin gated with the same overview probe
 * the queue view uses; a non-admin sees that said, not a button.
 *
 * Harness follows tests/schedule-3121-5891-delete-must-delete.test.tsx:
 * the real SchedulesPanel driven against a stubbed global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SchedulesPanel, emptyListComeback } from "../src/client/SchedulesPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const screenItem = {
  id: "screen-1",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 14 * * 1-5",
  payload: { universe: "SP500", userLogin: "trader1", environment: "TEST" },
};

const pausedItem = {
  id: "screen-paused",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 15 * * 1-5",
  paused: true,
  payload: { universe: "SP500", userLogin: "trader1", environment: "TEST" },
};

const derivedItem = {
  id: "token-renewal",
  type: "cron",
  callback: "autoRenewETradeTokens",
  cron: "0 3 * * *",
  kind: "internal",
  source: { kind: "derived", job: "token-renewal", origin: "code" },
  payload: { userLogin: "trader1", environment: "TEST" },
};

const declaredItem = {
  id: "declared-1",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 16 * * 1-5",
  source: { kind: "declared-task", job: "stock-copilot", origin: "OrchestratorAgent" },
  payload: { userLogin: "trader1", environment: "TEST" },
};

const goalItem = {
  id: "goal-1",
  type: "cron",
  callback: "runScheduledGoal",
  cron: "0 9 * * *",
  kind: "goal",
  source: { kind: "seeded", job: "goal-1", origin: "built-in goals config" },
  payload: { userLogin: "trader1", environment: "TEST" },
};

const VALID_OVERVIEW = {
  tenantId: "tenant-1",
  callerInternalUserId: "user-1",
  memberships: [],
  genesis: { platformGenesisOccurred: true },
  recentAuditEvents: [],
};

let container: HTMLDivElement;
let root: Root | null = null;
let recorded: Array<{ url: string; method: string; body: any }> = [];
let live: any[] = [];
let overviewMode: "allowed" | "denied" | "error" = "allowed";
let failClearConfirm = false;

function installFetch(schedules: any[]) {
  recorded = [];
  live = [...schedules];
  failClearConfirm = false;
  vi.stubGlobal(
    "fetch",
    async (input: any, init: any = {}) => {
      const url = String(input);
      const method = String(init.method || "GET").toUpperCase();
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      recorded.push({ url, method, body });
      if (url === "/api/iaaa/overview" && method === "GET") {
        if (overviewMode === "denied") {
          return new Response(JSON.stringify({ error: "Forbidden" }), { status: 403 });
        }
        if (overviewMode === "error") {
          return new Response(JSON.stringify({ error: "boom" }), { status: 500 });
        }
        return Response.json(VALID_OVERVIEW);
      }
      if (url === "/api/schedules" && method === "GET") {
        return Response.json({ count: live.length, schedules: live });
      }
      if (url === "/api/schedules/cancel-all" && method === "POST") {
        const alarms = live.filter((s) => !s.paused);
        if (body?.confirm !== true) {
          return Response.json({
            cancelled: 0,
            confirmRequired: true,
            wouldCancel: alarms.map((s) => ({ id: s.id, callback: s.callback })),
            wouldCancelCount: alarms.length,
            pausedPreserved: live.filter((s) => s.paused).length,
          });
        }
        // Cancel the alarms; derived rows re-derive on the next list,
        // so they stay listed. Declared tasks re-arm on the next Think
        // reconcile, so they are gone from this re-fetch.
        const cancelled = alarms.filter((s) => s.id !== "token-renewal");
        live = live.filter((s) => s.paused || s.id === "token-renewal");
        return Response.json({
          cancelled: cancelled.length,
          cancelledIds: cancelled.map((s) => s.id),
          failed: [],
          pausedPreserved: live.filter((s) => s.paused).length,
        });
      }
      if (url === "/api/maintenance/clear-table" && method === "POST") {
        const paused = live.filter((s) => s.paused);
        if (body?.confirm !== true) {
          return Response.json({
            table: "unified_schedules",
            scope: "instance",
            confirmed: false,
            confirmRequired: true,
            wouldDelete: paused.length,
          });
        }
        if (failClearConfirm) {
          return new Response(JSON.stringify({ error: "clear failed" }), { status: 500 });
        }
        live = live.filter((s) => !s.paused);
        return Response.json({ table: "unified_schedules", scope: "instance", confirmed: true, deleted: paused.length });
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
  throw new Error(`timeout waiting for ${what}; body: ${document.body.textContent?.slice(0, 900)}`);
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

function buttonNamed(text: string): HTMLButtonElement | null {
  return (
    ([...document.querySelectorAll("button")].find((b) => (b.textContent ?? "").trim() === text) as HTMLButtonElement | undefined) ??
    null
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
  await waitForText("Stock Market Screen");
}

beforeEach(() => {
  document.body.innerHTML = "";
  overviewMode = "allowed";
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = null;
  vi.unstubAllGlobals();
});

describe("5893 the comeback preview names what returns on its own", () => {
  it("classifies derived rows, declared tasks, and seeded goals — and nothing else", () => {
    const comeback = emptyListComeback([
      screenItem,
      pausedItem,
      derivedItem,
      declaredItem,
      goalItem,
    ] as any);
    expect(comeback.derived).toEqual(["token-renewal"]);
    expect(comeback.declaredTasks).toEqual(["declared-1"]);
    expect(comeback.seededGoals).toEqual(["goal-1"]);
  });

  it("a derived row is recognised by its source kind even under a new id", () => {
    const comeback = emptyListComeback([
      { ...derivedItem, id: "derived-other", source: { kind: "derived", job: "derived-other", origin: "code" } },
    ] as any);
    expect(comeback.derived).toEqual(["derived-other"]);
  });

  it("an empty list has no comeback", () => {
    expect(emptyListComeback([])).toEqual({ derived: [], declaredTasks: [], seededGoals: [] });
  });
});

describe("5893 the gate: platform admins see the action, others see it said", () => {
  it("a non-admin sees no Empty button and a plain note instead", async () => {
    overviewMode = "denied";
    await renderPanel([screenItem, derivedItem]);
    await waitForText("platform-admin");
    expect(buttonNamed("Empty the list")).toBeNull();
    expect(recorded.filter((r) => r.url === "/api/schedules/cancel-all")).toHaveLength(0);
    expect(recorded.filter((r) => r.url === "/api/maintenance/clear-table")).toHaveLength(0);
  });

  it("a platform admin sees the Empty the list button", async () => {
    await renderPanel([screenItem, derivedItem]);
    await waitForText("Empty the list");
    expect(buttonNamed("Empty the list")).not.toBeNull();
  });
});

describe("5893 preview → confirm → verify", () => {
  it("preview names what will go and what will come back, and never mentions KV as wiped", async () => {
    await renderPanel([screenItem, pausedItem, derivedItem, declaredItem, goalItem]);
    await waitForText("Empty the list");
    await click(buttonNamed("Empty the list"));
    await waitFor(() => document.querySelector(".sched-confirm-modal") !== null, "empty modal");
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    await waitFor(() => dialog.textContent?.includes("will be cancelled") ?? false, "preview copy");
    expect(dialog.textContent).toContain("4 alarm(s) will be cancelled");
    expect(dialog.textContent).toContain("1 paused record(s) will be deleted");
    expect(dialog.textContent).toContain("token-renewal");
    expect(dialog.textContent).toContain("declared-1");
    expect(dialog.textContent).toContain("goal-1");
    expect(dialog.textContent).toContain("Own instance only");
    expect(dialog.textContent).toContain("KV is never touched");
    expect(recorded.filter((r) => r.url === "/api/schedules/cancel-all" && r.body?.confirm !== true)).toHaveLength(1);
    expect(recorded.filter((r) => r.url === "/api/maintenance/clear-table" && r.body?.confirm !== true)).toHaveLength(1);
    // Preview cancels nothing.
    expect(recorded.filter((r) => r.body?.confirm === true)).toHaveLength(0);
  });

  it("confirm cancels the alarms, clears the paused records, and verifies by re-fetch", async () => {
    await renderPanel([screenItem, pausedItem, derivedItem, declaredItem, goalItem]);
    await waitForText("Empty the list");
    await click(buttonNamed("Empty the list"));
    await waitFor(() => document.querySelector(".sched-confirm-modal") !== null, "empty modal");
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    await waitFor(() => dialog.textContent?.includes("will be cancelled") ?? false, "preview copy");
    await click(buttonIn(dialog, "Empty the list"));
    await waitFor(
      () => recorded.some((r) => r.url === "/api/schedules/cancel-all" && r.body?.confirm === true),
      "cancel-all confirm",
    );
    await waitFor(
      () => recorded.some((r) => r.url === "/api/maintenance/clear-table" && r.body?.confirm === true),
      "clear-table confirm",
    );
    await waitForText("Emptied the list");
    expect(document.body.textContent).toContain("Cancelled 3 alarm(s)");
    expect(document.body.textContent).toContain("deleted 1 paused record(s)");
    expect(document.body.textContent).toContain("token-renewal");
    // The wiped rows are gone from the re-fetched list.
    expect(document.body.textContent).not.toContain("screen-1");
    expect(document.body.textContent).not.toContain("screen-paused");
    expect(document.body.textContent).not.toContain("declared-1");
    expect(document.body.textContent).not.toContain("goal-1");
  });

  it("a failed clear step reports the partial wipe honestly instead of claiming empty", async () => {
    await renderPanel([screenItem, pausedItem, derivedItem]);
    await waitForText("Empty the list");
    failClearConfirm = true;
    await click(buttonNamed("Empty the list"));
    await waitFor(() => document.querySelector(".sched-confirm-modal") !== null, "empty modal");
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    await waitFor(() => dialog.textContent?.includes("will be cancelled") ?? false, "preview copy");
    await click(buttonIn(dialog, "Empty the list"));
    await waitForText("not fully emptied");
    expect(document.body.textContent).toContain("Cancelled 1 alarm(s)");
    expect(document.body.textContent).toContain("clear failed");
    expect(document.body.textContent).toContain("screen-paused");
  });
});
