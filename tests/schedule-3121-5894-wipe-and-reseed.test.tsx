/** @vitest-environment jsdom */
/**
 * Issue #5894 — wipe-and-reseed to the needed set (reset to defaults).
 *
 * The Schedules home gains one "Reset to defaults" action: the #5893
 * one-click empty, then re-seed to the needed set — seedable built-in
 * goals (from the server, owner-removed goals subtracted, never
 * re-added) + the Track 1 recreation plan — with a preview of what
 * will exist after the reset, confirm, and a verified result. Derived
 * rows re-derive, declared tasks re-arm on the next Think reconcile,
 * sweep/watchdog arms re-arm via the ensure-guards; every other user
 * row goes and stays gone, and the preview says so by id.
 *
 * The needed set is defined in one place (`resetNeededSet`): the
 * seedable list comes from GET /api/schedule/builtin-goals (the
 * server's config read, never a client copy), the Track 1 labels from
 * `track1RecreatePlan()`, the comeback classes from #5893's
 * `emptyListComeback` — and every planted job must resolve in the one
 * job catalogue (#5880), or the preview refuses. No second defaults
 * list. The action is platform-admin gated with the same overview
 * probe the empty action uses.
 *
 * Harness follows tests/schedule-3121-5893-one-click-empty.test.tsx:
 * the real SchedulesPanel driven against a stubbed global fetch.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SchedulesPanel, resetNeededSet } from "../src/client/SchedulesPanel";
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

const manualGoalItem = {
  id: "my-manual-goal",
  type: "cron",
  callback: "runScheduledGoal",
  cron: "0 10 * * *",
  kind: "goal",
  payload: { userLogin: "trader1", environment: "TEST" },
};

const VALID_OVERVIEW = {
  tenantId: "tenant-1",
  callerInternalUserId: "user-1",
  memberships: [],
  genesis: { platformGenesisOccurred: true },
  recentAuditEvents: [],
};

/** Seedable built-in goals, as GET /api/schedule/builtin-goals serves them. */
const SEEDABLE_GOALS = [
  {
    id: "goal-1",
    name: "Goal one",
    cron: "0 9 * * *",
    operation: "qa.run_sweep",
    budgetCents: 500,
    enabled: true,
  },
  {
    id: "opportunity-hunt",
    name: "Opportunity hunt",
    cron: "0 7 * * *",
    operation: "search.opportunity_hunt",
    budgetCents: 1000,
    enabled: true,
  },
];

const REMOVED_GOALS = ["daily-social-post"];

/** A Track 1 plan in the shape track1RecreatePlan() returns. */
const TRACK1_PLAN = [
  {
    label: "Stock pre-market",
    requestBody: {
      callback: "autonomousMarketScreen",
      scheduleType: "cron",
      payload: {},
      cron: "30 12 * * 1-5",
    },
  },
  {
    label: "Stock intra-day",
    requestBody: {
      callback: "autonomousMarketScreen",
      scheduleType: "cron",
      payload: {},
      cron: "30 16 * * 1-5",
    },
  },
  {
    label: "Options NASDAQ100",
    requestBody: {
      callback: "autonomousOptionsAnalysis",
      scheduleType: "interval",
      payload: {},
      intervalSeconds: 3600,
    },
  },
  {
    label: "Options SP100",
    requestBody: {
      callback: "autonomousOptionsAnalysis",
      scheduleType: "interval",
      payload: {},
      intervalSeconds: 3600,
    },
  },
];

let container: HTMLDivElement;
let root: Root | null = null;
let recorded: Array<{ url: string; method: string; body: any }> = [];
let live: any[] = [];
let overviewMode: "allowed" | "denied" | "error" = "allowed";
let failClearConfirm = false;
let failCreateCallback: string | null = null;
let createCount = 0;

function installFetch(schedules: any[]) {
  recorded = [];
  live = [...schedules];
  failClearConfirm = false;
  failCreateCallback = null;
  createCount = 0;
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
      if (url === "/api/schedule/builtin-goals" && method === "GET") {
        return Response.json({
          ok: true,
          goals: SEEDABLE_GOALS,
          removedBuiltinGoalIds: REMOVED_GOALS,
        });
      }
      if (url === "/api/schedule/goals" && method === "POST") {
        const id = body?.id;
        if (live.some((s) => s.id === id)) {
          return new Response(JSON.stringify({ error: `Goal ${id} already exists` }), {
            status: 409,
          });
        }
        live.push({
          id,
          type: "cron",
          callback: "runScheduledGoal",
          cron: body?.cron,
          kind: "goal",
          source: { kind: "seeded", job: id, origin: "built-in goals config" },
          payload: { userLogin: "trader1", environment: "TEST" },
        });
        return Response.json({ ok: true, goal: body });
      }
      if (url === "/api/schedules/create" && method === "POST") {
        createCount += 1;
        if (failCreateCallback && body?.callback === failCreateCallback) {
          return Response.json({ success: false, error: "create boom" });
        }
        const id = `created-${body?.callback}-${createCount}`;
        live.push({
          id,
          type: body?.scheduleType ?? "cron",
          callback: body?.callback,
          cron: body?.cron,
          intervalSeconds: body?.intervalSeconds,
          payload: body?.payload ?? {},
        });
        return Response.json({ success: true, schedule: { id } });
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

async function waitFor(fn: () => boolean, what: string, timeoutMs = 8000) {
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

describe("5894 the needed set is defined in one place", () => {
  it("classifies seeded goals, removed goals, Track 1, comeback, and gone-for-good", () => {
    const needed = resetNeededSet(
      [screenItem, pausedItem, derivedItem, declaredItem, goalItem, manualGoalItem] as any,
      SEEDABLE_GOALS,
      REMOVED_GOALS,
      TRACK1_PLAN as any,
    );
    expect(needed.seededGoals).toEqual(["goal-1", "opportunity-hunt"]);
    expect(needed.removedGoals).toEqual(["daily-social-post"]);
    expect(needed.track1).toEqual([
      "Stock pre-market",
      "Stock intra-day",
      "Options NASDAQ100",
      "Options SP100",
    ]);
    expect(needed.derived).toEqual(["token-renewal"]);
    expect(needed.declaredTasks).toEqual(["declared-1"]);
    // screen-1 and screen-paused go; the manual goal is not seedable,
    // so it goes too — only the server's seedable list comes back.
    expect(needed.goneForGood).toEqual(["screen-1", "screen-paused", "my-manual-goal"]);
  });

  it("a current goal in the seedable list is re-planted, not gone; one outside it is gone", () => {
    const needed = resetNeededSet([goalItem, manualGoalItem] as any, SEEDABLE_GOALS, [], TRACK1_PLAN as any);
    expect(needed.goneForGood).toEqual(["my-manual-goal"]);
    expect(needed.seededGoals).toContain("goal-1");
  });

  it("a seedable goal whose operation is outside the one catalogue refuses", () => {
    expect(() =>
      resetNeededSet([] as any, [{ id: "nope", operation: "no.such_operation" }], [], TRACK1_PLAN as any),
    ).toThrow(/outside the one catalogue/);
  });

  it("a Track 1 item whose callback is outside the one catalogue refuses", () => {
    expect(() =>
      resetNeededSet(
        [] as any,
        SEEDABLE_GOALS,
        [],
        [{ label: "Bogus", requestBody: { callback: "noSuchCallback", scheduleType: "cron", payload: {} } }] as any,
      ),
    ).toThrow(/outside the one catalogue/);
  });

  it("an empty list has no comeback and nothing gone for good", () => {
    const needed = resetNeededSet([] as any, [], [], TRACK1_PLAN as any);
    expect(needed).toEqual({
      seededGoals: [],
      removedGoals: [],
      track1: ["Stock pre-market", "Stock intra-day", "Options NASDAQ100", "Options SP100"],
      derived: [],
      declaredTasks: [],
      goneForGood: [],
    });
  });
});

describe("5894 the gate: platform admins see the reset, others see it said", () => {
  it("a non-admin sees no Reset button and a plain note instead", async () => {
    overviewMode = "denied";
    await renderPanel([screenItem, derivedItem]);
    await waitForText("platform-admin");
    expect(buttonNamed("Reset to defaults")).toBeNull();
    expect(recorded.filter((r) => r.url === "/api/schedules/cancel-all")).toHaveLength(0);
    expect(recorded.filter((r) => r.url === "/api/maintenance/clear-table")).toHaveLength(0);
    expect(recorded.filter((r) => r.url === "/api/schedule/builtin-goals")).toHaveLength(0);
    expect(recorded.filter((r) => r.url === "/api/schedules/create")).toHaveLength(0);
  });

  it("a platform admin sees the Reset to defaults button", async () => {
    await renderPanel([screenItem, derivedItem]);
    await waitForText("Reset to defaults");
    expect(buttonNamed("Reset to defaults")).not.toBeNull();
  });
});

describe("5894 preview → confirm → verify", () => {
  it("preview names what will exist after the reset, what comes back, and what stays gone", async () => {
    await renderPanel([screenItem, pausedItem, derivedItem, declaredItem, goalItem, manualGoalItem]);
    await waitForText("Reset to defaults");
    await click(buttonNamed("Reset to defaults"));
    await waitFor(() => document.querySelector(".sched-confirm-modal") !== null, "reset modal");
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    await waitFor(() => dialog.textContent?.includes("will be cancelled") ?? false, "preview copy");
    expect(dialog.textContent).toContain("5 alarm(s) will be cancelled");
    expect(dialog.textContent).toContain("1 paused record(s) will be deleted");
    // Planted: both seedable goals (one is not in the list today) + Track 1.
    expect(dialog.textContent).toContain("goal-1");
    expect(dialog.textContent).toContain("opportunity-hunt");
    expect(dialog.textContent).toContain("Stock pre-market");
    expect(dialog.textContent).toContain("Options SP100");
    // Comeback on its own.
    expect(dialog.textContent).toContain("token-renewal");
    expect(dialog.textContent).toContain("declared-1");
    // Gone for good, by id — including the manual goal.
    expect(dialog.textContent).toContain("screen-1");
    expect(dialog.textContent).toContain("my-manual-goal");
    // Owner-removed goals stay removed, named.
    expect(dialog.textContent).toContain("daily-social-post");
    expect(dialog.textContent).toContain("Own instance only");
    expect(dialog.textContent).toContain("KV is never touched");
    // Preview cancels nothing and creates nothing.
    expect(recorded.filter((r) => r.body?.confirm === true)).toHaveLength(0);
    expect(recorded.filter((r) => r.url === "/api/schedules/create")).toHaveLength(0);
    expect(recorded.filter((r) => r.url === "/api/schedule/goals")).toHaveLength(0);
    expect(recorded.filter((r) => r.url === "/api/schedule/builtin-goals")).toHaveLength(1);
  });

  it("confirm wipes, re-seeds, re-creates Track 1, and verifies by re-fetch", async () => {
    await renderPanel([screenItem, pausedItem, derivedItem, declaredItem, goalItem, manualGoalItem]);
    await waitForText("Reset to defaults");
    await click(buttonNamed("Reset to defaults"));
    await waitFor(() => document.querySelector(".sched-confirm-modal") !== null, "reset modal");
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    await waitFor(() => dialog.textContent?.includes("will be cancelled") ?? false, "preview copy");
    await click(buttonIn(dialog, "Reset to defaults"));
    await waitFor(
      () => recorded.some((r) => r.url === "/api/schedules/cancel-all" && r.body?.confirm === true),
      "cancel-all confirm",
    );
    await waitFor(
      () => recorded.some((r) => r.url === "/api/maintenance/clear-table" && r.body?.confirm === true),
      "clear-table confirm",
    );
    // The notice title is the button label, so wait for the
    // notice-specific reseed line instead of the title.
    await waitForText("Re-seeded");
    expect(document.body.textContent).toContain("Cancelled 4 alarm(s)");
    expect(document.body.textContent).toContain("deleted 1 paused record(s)");
    // Both seedable goals planted (goal-1 re-planted, opportunity-hunt new).
    expect(recorded.filter((r) => r.url === "/api/schedule/goals" && r.method === "POST")).toHaveLength(2);
    expect(recorded.filter((r) => r.url === "/api/schedules/create" && r.method === "POST")).toHaveLength(4);
    expect(document.body.textContent).toContain("Re-seeded 2 built-in goal(s)");
    expect(document.body.textContent).toContain("Re-created 4 of 4 Track 1 screen(s)");
    expect(document.body.textContent).toContain("token-renewal");
    expect(document.body.textContent).toContain("opportunity-hunt");
    // Declared tasks re-arm on the next Think reconcile, not now —
    // named as pending, not reported as missing.
    expect(document.body.textContent).toContain("declared-1");
    // The wiped rows are gone from the re-fetched list.
    expect(document.body.textContent).not.toContain("screen-1");
    expect(document.body.textContent).not.toContain("screen-paused");
    expect(document.body.textContent).not.toContain("my-manual-goal");
  });

  it("a failed clear step still re-seeds and reports the partial wipe honestly", async () => {
    await renderPanel([screenItem, pausedItem, derivedItem]);
    await waitForText("Reset to defaults");
    failClearConfirm = true;
    await click(buttonNamed("Reset to defaults"));
    await waitFor(() => document.querySelector(".sched-confirm-modal") !== null, "reset modal");
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    await waitFor(() => dialog.textContent?.includes("will be cancelled") ?? false, "preview copy");
    await click(buttonIn(dialog, "Reset to defaults"));
    await waitForText("Reset incomplete");
    expect(document.body.textContent).toContain("clear failed");
    expect(document.body.textContent).toContain("screen-paused");
    // The reseed still ran after the partial wipe.
    expect(recorded.filter((r) => r.url === "/api/schedule/goals" && r.method === "POST")).toHaveLength(2);
    expect(recorded.filter((r) => r.url === "/api/schedules/create" && r.method === "POST")).toHaveLength(4);
  });

  it("a failed Track 1 create is named instead of claimed", async () => {
    await renderPanel([screenItem, derivedItem]);
    await waitForText("Reset to defaults");
    failCreateCallback = "autonomousOptionsAnalysis";
    await click(buttonNamed("Reset to defaults"));
    await waitFor(() => document.querySelector(".sched-confirm-modal") !== null, "reset modal");
    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    await waitFor(() => dialog.textContent?.includes("will be cancelled") ?? false, "preview copy");
    await click(buttonIn(dialog, "Reset to defaults"));
    await waitForText("Reset incomplete");
    expect(document.body.textContent).toContain("Re-created 2 of 4 Track 1 screen(s)");
    expect(document.body.textContent).toContain("Options NASDAQ100");
    expect(document.body.textContent).toContain("create boom");
  });
});
