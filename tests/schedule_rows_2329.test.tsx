/** @vitest-environment jsdom */
/**
 * Issue #2329 — Schedules as one row per schedule.
 *
 * Pins the redesign the owner asked for on the Schedules tab:
 *
 *  1. MODEL: one canonical detail model supplies both the row's scope
 *     summary and the Details dialog. Every kind (options analysis,
 *     market screen, saved-view discovery, profile-derived discovery,
 *     no-view discovery) uses the same label vocabulary and order —
 *     a kind's fields are a subsequence of the canonical order, never
 *     a new vocabulary.
 *  2. ROW: each schedule is exactly one <tr class="schedule-item-card">
 *     carrying the job name, the FULL id (never sliced), cadence, a
 *     one-line scope summary, and every action in one actions cell:
 *     Details, Edit, Trigger Now, Pause/Resume, Cancel. No second
 *     cadence editor exists on the row.
 *  3. DIALOGS: Details opens the one dialog (canonical sections +
 *     server run definition + raw payload); Edit opens the one form
 *     with the stored cadence prefilled; Cancel confirms in a dialog
 *     that names the schedule; a failed detail read shows the error
 *     and a retry inside the dialog.
 *  4. ONE CREATE: the page renders exactly one create action.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ScheduledOptionsManager } from "../src/client/ScheduledOptionsManager";
import { SchedulesPanel } from "../src/client/SchedulesPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  buildScheduleDetail,
  scheduleScope,
  scheduleTitle,
  SCHEDULE_SCOPE_LABEL_ORDER,
} from "../src/client/scheduledOptionsManager/scheduleDetail";
import type { ScheduledTaskItem } from "../src/client/scheduledOptionsManager/types";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const NEXT_RUN_S = Math.floor(Date.UTC(2026, 9, 19, 14, 30, 0) / 1000);

const optionsItem: ScheduledTaskItem = {
  id: "user-analysis-very-long-identifier-0123456789",
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

const screenItem: ScheduledTaskItem = {
  id: "sys-market-screen",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 14 * * 1-5",
  payload: { userLogin: "trader1", environment: "TEST", universe: "LEV_ETF", maxItems: 29, sector: "Technology", trigger: "scheduled" },
  time: NEXT_RUN_S,
};

const savedViewsItem: ScheduledTaskItem = {
  id: "user-discovery-saved",
  type: "interval",
  callback: "autonomousStrategyDiscovery",
  intervalSeconds: 14400,
  payload: {
    userLogin: "trader1",
    environment: "TEST",
    requests: [
      { symbol: "NVDA", thesis: "bullish", targetPrice: 200, targetDate: "2027-12-18" },
      { symbol: "MSFT", thesis: "bearish", targetPrice: 380, targetDate: "2027-12-18" },
    ],
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

const derivedItem: ScheduledTaskItem = {
  id: "user-discovery-derived",
  type: "interval",
  callback: "autonomousStrategyDiscovery",
  intervalSeconds: 3600,
  payload: {
    userLogin: "trader1",
    environment: "TEST",
    inputModel: "profile-derived",
    symbols: ["NVDA", "MSFT"],
    profileId: "prof-1",
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

const noViewItem: ScheduledTaskItem = {
  id: "user-discovery-noview",
  type: "interval",
  callback: "autonomousStrategyDiscovery",
  intervalSeconds: 3600,
  payload: {
    userLogin: "trader1",
    environment: "TEST",
    inputModel: "no-view",
    constraintSets: [
      { symbol: "NVDA", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, riskProfile: "balanced" },
    ],
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

const PROFILES = [
  {
    id: "prof-1",
    name: "Income",
    version: 3,
    thesis: "bullish",
    riskProfile: "balanced",
    allowedStrategies: ["long_call"],
    minProbabilityOfProfit: 0.35,
    minRewardRisk: 1,
    maxPlannedLoss: 500,
    targetDteMin: 7,
    targetDteMax: 45,
    notes: "",
  },
] as any[];

const ctx = { profiles: PROFILES, activeEnv: "TEST", userLogin: "trader1" };

/* ------------------------------------------------------------------ */
/* 1. The canonical model                                              */
/* ------------------------------------------------------------------ */

describe("#2329 canonical schedule detail model", () => {
  it("gives every kind the same scope vocabulary, as a subsequence of the canonical order", () => {
    const kinds = [optionsItem, screenItem, savedViewsItem, derivedItem, noViewItem];
    for (const item of kinds) {
      const model = buildScheduleDetail(item, ctx);
      const scope = model.sections.find((s) => s.id === "scope");
      expect(scope).toBeTruthy();
      const labels = (scope?.fields ?? []).map((f) => f.label);
      let cursor = -1;
      for (const label of labels) {
        const at = SCHEDULE_SCOPE_LABEL_ORDER.indexOf(label);
        // A label outside the canonical vocabulary is the defect this
        // pin exists for: one fact, one label, everywhere.
        expect(at, `unknown scope label "${label}" on ${item.id}`).toBeGreaterThan(-1);
        expect(at, `scope labels out of canonical order on ${item.id}`).toBeGreaterThan(cursor);
        cursor = at;
      }
    }
  });

  it("labels the same facts identically across options, stock, and discovery kinds", () => {
    const labelsOf = (item: ScheduledTaskItem) =>
      buildScheduleDetail(item, ctx)
        .sections.flatMap((s) => s.fields.map((f) => f.label));
    const optionLabels = labelsOf(optionsItem);
    const stockLabels = labelsOf(screenItem);
    for (const shared of ["Schedule ID", "Job", "Callback", "Cadence", "Status", "Next run", "Owner", "Environment", "Input model", "Slack"]) {
      expect(optionLabels).toContain(shared);
      expect(stockLabels).toContain(shared);
    }
  });

  it("names each kind's input model once", () => {
    expect(buildScheduleDetail(optionsItem, ctx).sections.find((s) => s.id === "scope")?.fields.find((f) => f.label === "Input model")?.value).toBe("Options analysis");
    expect(buildScheduleDetail(screenItem, ctx).sections.find((s) => s.id === "scope")?.fields.find((f) => f.label === "Input model")?.value).toBe("Stock screen");
    expect(buildScheduleDetail(savedViewsItem, ctx).sections.find((s) => s.id === "scope")?.fields.find((f) => f.label === "Input model")?.value).toBe("Saved views");
    expect(buildScheduleDetail(derivedItem, ctx).sections.find((s) => s.id === "scope")?.fields.find((f) => f.label === "Input model")?.value).toBe("Profile-derived");
    expect(buildScheduleDetail(noViewItem, ctx).sections.find((s) => s.id === "scope")?.fields.find((f) => f.label === "Input model")?.value).toBe("No-view");
  });

  it("keeps one-line row scope summaries per kind", () => {
    expect(scheduleScope(optionsItem, PROFILES)).toBe("NVDA, AAPL · max 100");
    // Issue #3655 S4b: a stock schedule with no preset armed states
    // "Custom thresholds" in its row scope, so the list shows which
    // criteria/preset the schedule uses.
    expect(scheduleScope(screenItem, PROFILES)).toBe("LEV_ETF · Technology · Custom thresholds");
    expect(scheduleScope(savedViewsItem, PROFILES)).toBe("2 saved views · NVDA, MSFT");
    expect(scheduleScope(derivedItem, PROFILES)).toBe("Income (v3) · NVDA, MSFT");
    expect(scheduleScope(noViewItem, PROFILES)).toBe("No-view · NVDA");
  });

  it("names each kind's job without inventing one", () => {
    expect(scheduleTitle(optionsItem, PROFILES)).toBe("Options Market Screen");
    expect(scheduleTitle(screenItem, PROFILES)).toBe("Stock Market Screen");
    expect(scheduleTitle(savedViewsItem, PROFILES)).toBe("Strategy Discovery");
    expect(scheduleTitle(derivedItem, PROFILES)).toBe("Strategy Discovery · Profile-derived");
    expect(scheduleTitle(noViewItem, PROFILES)).toBe("Strategy Discovery · No-view");
  });

  it("states each discovery model's limits in one note, and no view where none exists", () => {
    expect(buildScheduleDetail(noViewItem, ctx).note).toContain("no thesis, no target");
    expect(buildScheduleDetail(derivedItem, ctx).note).toContain("Targets derived at run time");
    expect(buildScheduleDetail(savedViewsItem, ctx).note).toContain("Re-runs saved discovery views");
  });

  it("renders delivery channels as the stored values, never as a claim", () => {
    const delivery = buildScheduleDetail(optionsItem, ctx).sections.find((s) => s.id === "delivery");
    const byLabel = Object.fromEntries((delivery?.fields ?? []).map((f) => [f.label, f.value]));
    expect(byLabel.Slack).toBe("#options-alerts");
    expect(byLabel.Email).toBe("Not configured");
    expect(byLabel.Webhook).toBe("Not configured");
  });

  it("lists saved views and constraint sets with one row per symbol", () => {
    const saved = buildScheduleDetail(savedViewsItem, ctx).sections.find((s) => s.id === "views");
    expect(saved?.fields.map((f) => f.label)).toEqual(["NVDA", "MSFT"]);
    expect(saved?.fields[0].value).toContain("$200");

    const noView = buildScheduleDetail(noViewItem, ctx).sections.find((s) => s.id === "constraints");
    expect(noView?.fields.map((f) => f.label)).toEqual(["NVDA"]);
    expect(noView?.fields[0].value).toContain("max loss $500");
  });
});

/* ------------------------------------------------------------------ */
/* Harness                                                            */
/* ------------------------------------------------------------------ */

let container: HTMLDivElement;
let root: Root | null = null;
let recorded: Array<{ url: string; method: string; body: any }> = [];
let detailStatus = 200;

function installFetch(schedules: any[]) {
  recorded = [];
  detailStatus = 200;
  vi.stubGlobal("fetch", async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    recorded.push({ url, method, body });
    if (url === "/api/schedules" && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ count: schedules.length, schedules }) };
    }
    if (url.startsWith("/api/audit")) return { ok: true, status: 200, json: async () => ({ events: [] }) };
    if (url === "/api/options/latest") return { ok: true, status: 200, json: async () => ({ runs: [] }) };
    if (url.includes("/api/etrade/options/profiles")) {
      return { ok: true, status: 200, json: async () => ({ count: PROFILES.length, profiles: PROFILES }) };
    }
    const byId = url.match(/^\/api\/schedules\/([^/?]+)$/);
    if (byId && method === "GET") {
      if (detailStatus !== 200) {
        return { ok: false, status: detailStatus, json: async () => ({ error: "detail read failed" }) };
      }
      const found = schedules.find((s) => s.id === decodeURIComponent(byId[1]));
      return { ok: true, status: 200, json: async () => found };
    }
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
  vi.stubGlobal("confirm", () => {
    throw new Error("native confirm() is banned in client code (#2283)");
  });
  vi.stubGlobal("alert", () => {
    throw new Error("native alert() is banned in client code (#2283)");
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

function rowFor(id: string): HTMLElement {
  const row = [...container.querySelectorAll("tr.schedule-item-card")].find((r) =>
    (r.textContent ?? "").includes(id)
  );
  if (!row) throw new Error(`row for ${id} not found`);
  return row as HTMLElement;
}

async function renderPanel(schedules: any[]) {
  installFetch(schedules);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ToastProvider>
        <SchedulesPanel activeEnv="TEST" userLogin="trader1" />
      </ToastProvider>
    );
  });
  await flush(60);
}

async function renderManager(schedules = [optionsItem, screenItem, savedViewsItem, derivedItem, noViewItem]) {
  installFetch(schedules);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<ScheduledOptionsManager activeEnv="TEST" userLogin="trader1" />);
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

/* ------------------------------------------------------------------ */
/* 2. One row per schedule                                            */
/* ------------------------------------------------------------------ */

describe("#2329 the schedule table", () => {
  it("renders one row per schedule with the full id and every action in one cell", async () => {
    await renderManager();
    const rows = [...container.querySelectorAll("tr.schedule-item-card")];
    expect(rows).toHaveLength(5);

    const row = rowFor(optionsItem.id);
    // The full id, not the 16-character snippet the card truncated.
    expect(row.textContent).toContain(optionsItem.id);
    expect(row.textContent).not.toContain(`${optionsItem.id.slice(0, 16)}…`);
    // The names the old cards carried.
    expect(row.textContent).toContain("Options Market Screen");
    expect(row.textContent).toContain("Every 60 min");
    expect(row.textContent).toContain("NVDA, AAPL");
    // One actions cell, all five controls, no second cadence editor.
    const actions = row.querySelector(".schedule-row-actions");
    expect(actions).toBeTruthy();
    for (const label of ["Details", "Edit", "Trigger Now", "Pause", "Cancel"]) {
      expect(buttonIn(actions as HTMLElement, label)).toBeTruthy();
    }
    expect(row.textContent).not.toContain("Edit frequency");
    expect(row.querySelectorAll("button")).toHaveLength(5);
  });

  it("shows one compact row per discovery model, not per-card payload blocks", async () => {
    await renderManager();
    expect(rowFor(savedViewsItem.id).textContent).toContain("Saved views");
    expect(rowFor(savedViewsItem.id).textContent).toContain("2 saved views");
    expect(rowFor(derivedItem.id).textContent).toContain("Profile-derived");
    expect(rowFor(derivedItem.id).textContent).toContain("Income (v3)");
    expect(rowFor(noViewItem.id).textContent).toContain("No-view");
    expect(rowFor(noViewItem.id).textContent).toContain("NVDA");
  });

  it("shows Paused and a Resume action for a paused schedule", async () => {
    await renderManager([{ ...optionsItem, paused: true }]);
    const row = rowFor(optionsItem.id);
    expect(row.textContent).toContain("Paused");
    expect(buttonIn(row, "Resume")).toBeTruthy();
  });
});

/* ------------------------------------------------------------------ */
/* 3. The dialogs                                                     */
/* ------------------------------------------------------------------ */

describe("#2329 the schedule dialogs", () => {
  it("opens one Details dialog with canonical sections, the run definition, and the raw payload", async () => {
    await renderManager();
    await click(buttonIn(rowFor(noViewItem.id), "Details"));
    await waitForText("Raw payload");

    const dialog = document.querySelector(".sched-detail-modal") as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.getAttribute("role")).toBe("dialog");
    const text = dialog.textContent ?? "";
    for (const label of ["Schedule ID", "Job", "Callback", "Cadence", "Status", "Next run", "Owner", "Environment", "Input model", "Delivery", "Slack", "Email", "Webhook"]) {
      expect(text).toContain(label);
    }
    expect(text).toContain(noViewItem.id);
    expect(text).toContain("No-view");
    expect(text).toContain("max loss $500");
    expect(text).toContain("no thesis, no target");
    expect(text).toContain('"inputModel": "no-view"');

    const gets = recorded.filter((c) => c.method === "GET" && c.url === `/api/schedules/${noViewItem.id}`);
    expect(gets).toHaveLength(1);

    // One close control: the dialog's own header close button.
    await click(buttonIn(dialog, "Close"));
    expect(document.querySelector(".sched-detail-modal")).toBeNull();
  });

  it("opens the one Edit form with the stored cadence prefilled", async () => {
    await renderManager();
    await click(buttonIn(rowFor(optionsItem.id), "Edit"));
    await waitForText("Update Screening Schedule");

    const modal = document.querySelector(".sched-modal-card") as HTMLElement;
    expect(modal).toBeTruthy();
    const cadenceType = modal.querySelector("#sched-cadence-type") as HTMLSelectElement;
    expect(cadenceType.value).toBe("interval");
    const interval = modal.querySelector("#sched-interval-seconds") as HTMLInputElement;
    expect(interval.value).toBe("3600");
  });

  it("confirms Cancel in a dialog that names the schedule, then posts the cancel route", async () => {
    await renderManager([optionsItem]);
    await click(buttonIn(rowFor(optionsItem.id), "Cancel"));
    await waitForText("Cancel this schedule?");

    const dialog = document.querySelector(".sched-confirm-modal") as HTMLElement;
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain(optionsItem.id);
    expect(dialog.textContent).toContain("Options Market Screen");
    expect(dialog.textContent).toContain("cannot be undone");

    await click(buttonIn(dialog, "Cancel schedule"));
    const cancels = recorded.filter((c) => c.method === "POST" && c.url === "/api/schedules/cancel");
    expect(cancels).toHaveLength(1);
    expect(cancels[0].body.id).toBe(optionsItem.id);
  });

  it("shows a failed detail read inside the dialog with a retry, never as a success", async () => {
    await renderManager([optionsItem]);
    detailStatus = 500;
    await click(buttonIn(rowFor(optionsItem.id), "Details"));
    await waitForText("detail read failed");

    const dialog = document.querySelector(".sched-detail-modal") as HTMLElement;
    expect(dialog.textContent).toContain("detail read failed");
    expect(buttonIn(dialog, "Retry")).toBeTruthy();

    detailStatus = 200;
    await click(buttonIn(dialog, "Retry"));
    await waitForText("Raw payload");
    expect(document.querySelector(".sched-detail-modal")?.textContent).not.toContain("detail read failed");
  });
});

/* ------------------------------------------------------------------ */
/* 4. One create action on the page                                   */
/* ------------------------------------------------------------------ */

describe("#2329 one create entry point", () => {
  it("renders exactly one create action in the panel", async () => {
    await renderPanel([optionsItem, screenItem]);
    await waitForText("Options Market Screen");

    const creates = [...document.querySelectorAll("button")].filter((b) =>
      /new schedule/i.test(b.textContent ?? "")
    );
    expect(creates).toHaveLength(1);
  });

  // Issue #5895: the page gains a second, bulk create entry point —
  // Quick create (one action creates schedules for each job with
  // defaults). The rule is now exactly one single-create action AND
  // exactly one bulk-create action, not one create action total.
  it("renders exactly one bulk-create action beside the single create", async () => {
    await renderPanel([optionsItem, screenItem]);
    await waitForText("Options Market Screen");

    const bulkCreates = [...document.querySelectorAll("button")].filter((b) =>
      /quick create/i.test(b.textContent ?? "")
    );
    expect(bulkCreates).toHaveLength(1);
  });

  it("describes a generic system schedule without dressing it as a screening kind", async () => {
    await renderPanel([
      {
        id: "system-iv-job",
        type: "interval",
        callback: "collectIvHistory",
        intervalSeconds: 3600,
        payload: { universe: "SP500", userLogin: "trader1", environment: "TEST" },
      },
    ]);
    await waitForText("Scheduled IV collection");
    const row = rowFor("system-iv-job");
    expect(row.textContent).toContain("System");
    expect(row.textContent).not.toContain("Discovery");
    expect(row.textContent).toContain("Universe: SP500");

    await click(buttonIn(row, "Details"));
    await waitForText("Raw payload");
    const dialog = document.querySelector(".sched-detail-modal") as HTMLElement;
    expect(dialog.textContent).toContain("System job");
    expect(dialog.textContent).toContain('"universe": "SP500"');
    expect(dialog.textContent).not.toContain("Discovery");
  });
});
