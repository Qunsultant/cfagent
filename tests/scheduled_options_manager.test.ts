/** @vitest-environment jsdom */
/**
 * Issue #110: ScheduledOptionsManager completeness & safety.
 *
 * The manager is the UI for the Agents scheduling API. The #106 audit
 * found it partial and, in places, misleading:
 *  - no UI control called the screen / renewal / IV trigger routes;
 *  - every card's "Trigger Now" ran options analysis, whatever the
 *    card's own job was;
 *  - the baseline system schedules (token renewal, market screen, IV
 *    collection) rendered as generic cards with analysis-default
 *    payload labels, and Edit/Cancel acted on them unguarded — an edit
 *    could silently replace the IV cron with an analysis schedule;
 *  - the create form hard-coded the analysis callback and offered
 *    only cron + interval, though the API supports delayed and
 *    one-shot (date) modes too, and IV collection was not creatable;
 *  - nothing called GET /api/schedules/:id.
 *
 * Harness follows tests/scanner_panel.test.ts: the REAL apiFetch is
 * driven against a stubbed global fetch (the #71 lesson — mock the
 * transport contract, not just payloads), including one test through
 * the worker's 202 async-job stub → poll → completed flow. The
 * component renders with react-dom/client in jsdom.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  ScheduledOptionsManager,
  SYSTEM_JOBS,
  triggerRouteFor,
  buildNoViewPayload,
  blankNoViewConstraintsDraft,
  noViewDraftFromConstraintSets,
  formatNoViewConstraints,
  buildProfileDerivedPayload,
  parseDerivedSymbols,
  profileDerivationBlockReason,
} from "../src/client/ScheduledOptionsManager";
import { etToUtcCron } from "../src/client/options/cronTime";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

// Fixtures -----------------------------------------------------------------

const NEXT_RUN_S = Math.floor(Date.UTC(2026, 9, 19, 14, 30, 0) / 1000);

const screenSystem = {
  id: "sys-market-screen",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 14 * * 1-5",
  payload: { userLogin: "trader1", environment: "TEST", universe: "LEV_ETF", maxItems: 29, sector: "Technology", trigger: "scheduled" },
  time: NEXT_RUN_S,
};

const userAnalysis = {
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

const ALL_SCHEDULES = [screenSystem, userAnalysis];

interface StubState {
  schedules: any[];
  cancelledIds: Set<string>;
  listViaJob: boolean;
}

interface RecordedCall {
  url: string;
  method: string;
  body: any;
}

function installFetch(state: StubState) {
  const calls: RecordedCall[] = [];
  const visibleSchedules = () => state.schedules.filter((s) => !state.cancelledIds.has(s?.id));
  const mock = vi.fn(async (input: any, init: any = {}) => {
    const url = String(input);
    const method = String(init.method || "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });

    if (url.includes("/api/jobs/")) {
      return Response.json({
        jobId: "job-list",
        capability: "http.request",
        status: "completed",
        statusUrl: "/api/jobs/job-list",
        responseStatus: 200,
        result: {
          body: JSON.stringify({ count: visibleSchedules().length, schedules: visibleSchedules() }),
          headers: { "content-type": "application/json" },
        },
      });
    }
    if (url.startsWith("/api/audit")) {
      return Response.json({ events: [] });
    }
    if (url === "/api/schedules" && method === "GET") {
      if (state.listViaJob) {
        return Response.json(
          { jobId: "job-list", status: "queued", statusUrl: "/api/jobs/job-list" },
          { status: 202 }
        );
      }
      return Response.json({ count: visibleSchedules().length, schedules: visibleSchedules() });
    }
    if (url === "/api/schedules/cancel" && method === "POST") {
      state.cancelledIds.add(body?.id);
      return Response.json({ scheduleId: body?.id, cancelled: true });
    }
    if (url === "/api/schedules/create" && method === "POST") {
      // Mirror the real create route's discovery validation (#126): an
      // unknown strategy id is rejected at arm time with a 400 naming
      // the offending saved request.
      const badRequest = (body?.payload?.requests || []).find((r: any) =>
        (r?.allowedStrategies || []).some((s: string) => s === "not_a_strategy")
      );
      if (body?.callback === "autonomousStrategyDiscovery" && badRequest) {
        return Response.json(
          {
            success: false,
            error: `Saved discovery request 1 (${badRequest.symbol}) is invalid: Invalid strategy request. Supply a thesis, target, date, risk cap, reward/risk minimum, and allowed strategies.`,
          },
          { status: 400 }
        );
      }
      // Mirror the route's arm-time rejection for the profile-derived
      // model (#533): one fixture profile id is rejected server-side
      // so the form's 400 surfacing is exercised for this model too.
      if (
        body?.callback === "autonomousStrategyDiscovery" &&
        body?.payload?.inputModel === "profile-derived" &&
        body?.payload?.profileId === "prof-reject"
      ) {
        return Response.json(
          {
            success: false,
            error: "Profile-derived discovery schedules require exactly one symbol source: payload.symbols or payload.watchlistName.",
          },
          { status: 400 }
        );
      }
      // Mirror the route's arm-time validation for the no-view model
      // (#534): a constraint set for the fixture symbol REJECT is
      // rejected server-side so the form's 400 surfacing is exercised
      // for this model too.
      if (
        body?.callback === "autonomousStrategyDiscovery" &&
        body?.payload?.inputModel === "no-view" &&
        (body?.payload?.constraintSets || []).some((s: any) => s?.symbol === "REJECT")
      ) {
        return Response.json(
          {
            success: false,
            error: "No-view constraint set 1 (REJECT) is invalid: Invalid no-view strategy request. Supply a symbol, risk cap, reward/risk minimum, and constraints only — no thesis, target price, target date, or IV direction.",
          },
          { status: 400 }
        );
      }
      return Response.json({ success: true, schedule: { id: "sched-new-1", ...body } });
    }
    if (url.includes("/api/etrade/options/profiles") && method === "GET") {
      return Response.json({ count: PROFILE_FIXTURES.length, profiles: PROFILE_FIXTURES });
    }
    if (url === "/api/schedules/trigger-discovery" && method === "POST") {
      const reqs = Array.isArray(body?.requests) ? body.requests : [];
      return Response.json({
        success: true,
        taskType: "strategy_discovery",
        data: {
          runId: "run-disc-1",
          status: "completed",
          requestCount: reqs.length,
          completedCount: reqs.length,
          failedCount: 0,
          symbols: reqs.map((r: any) => r?.symbol),
          failures: [],
        },
        timestamp: "2026-10-19T14:30:00.000Z",
      });
    }
    if (url === "/api/schedules/trigger-options-analysis" && method === "POST") {
      return Response.json({
        success: true,
        taskType: "options_analysis",
        data: {
          totalScanned: 4,
          withTrades: 2,
          symbols: ["NVDA", "AAPL"],
          summary: "stub analysis complete",
          notifications: { slack: true },
        },
      });
    }
    if (url === "/api/schedules/trigger-screen" && method === "POST") {
      return Response.json({ success: true, message: "Autonomous market screen triggered" });
    }
    if (url === "/api/schedules/trigger-renew" && method === "POST") {
      return Response.json({ success: true, message: "E*TRADE token renewal triggered" });
    }
    if (url === "/api/schedules/trigger-iv-collection" && method === "POST") {
      return Response.json({
        success: true,
        taskType: "options.iv_collection",
        data: {
          date: "2026-10-16",
          outcomes: [],
          recorded: 3,
          alreadyRecorded: 40,
          failed: 0,
          trackedCount: 43,
        },
      });
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

function freshState(overrides: Partial<StubState> = {}): StubState {
  return {
    schedules: [...ALL_SCHEDULES],
    cancelledIds: new Set<string>(),
    listViaJob: false,
    ...overrides,
  };
}

function callsTo(calls: RecordedCall[], urlPart: string, method?: string) {
  return calls.filter(
    (c) => c.url.includes(urlPart) && (method === undefined || c.method === method)
  );
}

// DOM helpers ----------------------------------------------------------------

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

async function waitForNoText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (!container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for "${text}" to disappear.`);
}

async function renderManager() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      React.createElement(ScheduledOptionsManager, { activeEnv: "TEST", userLogin: "trader1" })
    );
  });
  await flush(60);
}

function setValue(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
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

function cardByTitle(titlePart: string): HTMLElement {
  const card = [...container.querySelectorAll(".schedule-item-card")].find((c) =>
    c.textContent?.includes(titlePart)
  );
  if (!card) throw new Error(`schedule row "${titlePart}" not found`);
  return card as HTMLElement;
}

/** #2329: details render in the one dialog, portaled to document.body. */
function detailDialog(): HTMLElement {
  const dialog = document.querySelector(".sched-detail-modal") as HTMLElement | null;
  if (!dialog) throw new Error("details dialog did not open");
  return dialog;
}

/** waitForText reads the render container; a portaled dialog needs its own wait. */
async function waitForDialogText(text: string, timeoutMs = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const dialog = document.querySelector(".sched-detail-modal");
    if (dialog?.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`Timed out waiting for dialog text "${text}".`);
}

function selectByOptionText(scope: ParentNode, optionText: string): HTMLSelectElement {
  const sel = [...scope.querySelectorAll("select")].find((s) =>
    [...s.options].some((o) => o.textContent?.includes(optionText))
  );
  if (!sel) throw new Error(`select with option "${optionText}" not found`);
  return sel as HTMLSelectElement;
}

function optionValueByText(sel: HTMLSelectElement, optionText: string): string {
  const opt = [...sel.options].find((o) => o.textContent?.includes(optionText));
  if (!opt) throw new Error(`option "${optionText}" not found`);
  return opt.value;
}

async function submitForm(form: HTMLFormElement) {
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush(60);
}

async function openCreateModal() {
  await click(buttonByText(container, "New Schedule"));
  // Modal portals to document.body, outside the render container.
  const modal = document.querySelector(".sched-modal-card");
  if (!modal) throw new Error("create modal did not open");
  return modal as HTMLElement;
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

// Only account-owned stock and options screens are surfaced.
describe("ScheduledOptionsManager — stock/options schedules", () => {
  it("renders identical account and run metadata for both screen types", async () => {
    installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");
    const stockCard = cardByTitle("Stock Market Screen");
    const optionsCard = cardByTitle("Options Market Screen");
    // #2329: every row states the same owner/environment line...
    for (const row of [stockCard, optionsCard]) {
      expect(row.textContent).toContain("trader1");
      expect(row.textContent).toContain("TEST");
    }
    expect(stockCard.textContent).toContain("LEV_ETF");
    expect(stockCard.textContent).toContain("Technology");
    expect(optionsCard.textContent).toContain("NVDA, AAPL");

    // ...and the one Details dialog names the same fields for both kinds.
    await click(buttonByText(stockCard, "Details"));
    const stockDialog = detailDialog();
    await waitForDialogText("Raw payload");
    for (const field of ["Schedule ID", "Job", "Callback", "Owner", "Environment", "Trigger", "Universe", "Max items"]) {
      expect(stockDialog.textContent).toContain(field);
    }
    expect(stockDialog.textContent).toContain('"userLogin": "trader1"');
    expect(stockDialog.textContent).toContain("scheduled");
    await click(buttonByText(stockDialog, "Close"));

    await click(buttonByText(optionsCard, "Details"));
    const optionsDialog = detailDialog();
    await waitForDialogText("NASDAQ100");
    expect(optionsDialog.textContent).toContain("NASDAQ100");
    // Deliberate registry growth (#126 PR-G): saved-view strategy
    // discovery joined the two screen jobs as a first-class system job.
    expect(Object.keys(SYSTEM_JOBS).sort()).toEqual(
      ["autonomousMarketScreen", "autonomousOptionsAnalysis", "autonomousStrategyDiscovery"].sort()
    );
    expect(container.textContent).not.toContain("Token Renewal");
    expect(container.textContent).not.toContain("IV History Collection");
  });

  it("keeps edit and cancel controls on account-owned screening jobs", async () => {
    installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");
    for (const title of ["Stock Market Screen", "Options Market Screen"]) {
      const card = cardByTitle(title);
      expect([...card.querySelectorAll("button")].some((b) => b.textContent?.includes("Edit"))).toBe(true);
      expect([...card.querySelectorAll("button")].some((b) => b.textContent?.includes("Cancel"))).toBe(true);
    }
  });

  it("ignores legacy and malformed schedule rows", async () => {
    installFetch(freshState({ schedules: [screenSystem, userAnalysis, null, { id: 42 }, { callback: "autoRenewETradeTokens" }, { callback: "collectIvHistory" }] as any }));
    await renderManager();
    await waitForText("Stock Market Screen");
    expect(container.textContent).toContain("Options Market Screen");
    expect(container.textContent).not.toContain("Token Renewal");
    expect(container.textContent).toContain("2 Active");
  });
});

// Per-card triggers -----------------------------------------------------------

describe("ScheduledOptionsManager — per-card triggers", () => {
  it("maps every triggerable callback to its own route and no further", () => {
    expect(triggerRouteFor("autonomousOptionsAnalysis")).toBe("/api/schedules/trigger-options-analysis");
    expect(triggerRouteFor("autonomousMarketScreen")).toBe("/api/schedules/trigger-screen");
    expect(triggerRouteFor("autoRenewETradeTokens")).toBeUndefined();
    expect(triggerRouteFor("collectIvHistory")).toBeUndefined();
    expect(triggerRouteFor("sendScheduledReminder")).toBeUndefined();
    expect(triggerRouteFor("expireStaleOrderDraft")).toBeUndefined();
    expect(triggerRouteFor("executeAsyncJob")).toBeUndefined();
  });

  it("Trigger Now on the screen card calls trigger-screen with the card's payload", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    await click(buttonByText(cardByTitle("Stock Market Screen"), "Trigger Now"));

    const screenCalls = callsTo(calls, "/api/schedules/trigger-screen", "POST");
    expect(screenCalls).toHaveLength(1);
    expect(screenCalls[0].body).toMatchObject({ sector: "Technology", universe: "LEV_ETF", maxItems: 29 });
    expect(callsTo(calls, "/api/schedules/trigger-options-analysis", "POST")).toHaveLength(0);
  });

  it("Trigger Now on a user analysis card still runs options analysis with that card's payload", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Options Market Screen");

    await click(buttonByText(cardByTitle("Options Market Screen"), "Trigger Now"));

    const analysisCalls = callsTo(calls, "/api/schedules/trigger-options-analysis", "POST");
    expect(analysisCalls).toHaveLength(1);
    expect(analysisCalls[0].body.symbols).toEqual(["NVDA", "AAPL"]);
    await waitForText("Found 2 actionable setups");
  });

  it("shows no Trigger or Edit control on callbacks without a trigger route", async () => {
    installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");
    expect(container.textContent).not.toContain("sendScheduledReminder");
    expect(triggerRouteFor("sendScheduledReminder")).toBeUndefined();
  });
});

// Create form -----------------------------------------------------------------

describe("ScheduledOptionsManager — create form", () => {
  it("creates a stock screen schedule with the selected universe, maxItems, and scheduled trigger", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    const jobSelect = selectByOptionText(modal, "Autonomous Market Screen (Stocks)");
    setValue(jobSelect, optionValueByText(jobSelect, "Autonomous Market Screen (Stocks)"));
    const universe = selectByOptionText(modal, "Leveraged ETFs");
    setValue(universe, optionValueByText(universe, "Leveraged ETFs"));
    const maxItems = modal.querySelector('input[type="number"]') as HTMLInputElement;
    setValue(maxItems, "29");

    await submitForm(modal.querySelector("form")!);

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.callback).toBe("autonomousMarketScreen");
    expect(createCalls[0].body.payload).toMatchObject({ universe: "LEV_ETF", maxItems: 29, trigger: "scheduled", sector: "Technology" });
    expect(createCalls[0].body.scheduleType).toBe("interval");
    expect(createCalls[0].body.payload.userLogin).toBeUndefined(); // trusted identity is stamped server-side
  });

  it("posts a delayed create body with delayInSeconds and no cron/interval fields", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Options Market Screen");

    const modal = await openCreateModal();
    const cadence = selectByOptionText(modal, "Delayed (Once, After a Delay)");
    setValue(cadence, optionValueByText(cadence, "Delayed (Once, After a Delay)"));
    await flush(40);

    const delayInput = [...modal.querySelectorAll('input[type="number"]')].at(-1) as HTMLInputElement;
    expect(delayInput).not.toBeNull();
    setValue(delayInput, "7200");
    await flush(20);

    await submitForm(modal.querySelector("form")!);

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.callback).toBe("autonomousOptionsAnalysis");
    expect(createCalls[0].body.scheduleType).toBe("delayed");
    expect(createCalls[0].body.delayInSeconds).toBe(7200);
    expect(createCalls[0].body).not.toHaveProperty("cron");
    expect(createCalls[0].body).not.toHaveProperty("intervalSeconds");
  });

  it("posts a one-shot create body with an ISO date", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Options Market Screen");

    const modal = await openCreateModal();
    const cadence = selectByOptionText(modal, "One-Shot (Specific Date & Time)");
    setValue(cadence, optionValueByText(cadence, "One-Shot (Specific Date & Time)"));
    await flush(40);

    const dateInput = modal.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    expect(dateInput).not.toBeNull();
    setValue(dateInput, "2026-10-20T09:30");
    await flush(20);

    await submitForm(modal.querySelector("form")!);

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.scheduleType).toBe("scheduled");
    expect(createCalls[0].body.date).toBe(new Date("2026-10-20T09:30").toISOString());
    expect(createCalls[0].body).not.toHaveProperty("cron");
    expect(createCalls[0].body).not.toHaveProperty("intervalSeconds");
    expect(createCalls[0].body).not.toHaveProperty("delayInSeconds");
  });

  it("keeps the #107 cron presets: ET intents converted to UTC at pick time, with the DST disclosure", async () => {
    installFetch(freshState());
    await renderManager();
    await waitForText("Options Market Screen");

    const modal = await openCreateModal();
    const cadence = selectByOptionText(modal, "Cron Expression (Specific Time/Days)");
    setValue(cadence, optionValueByText(cadence, "Cron Expression (Specific Time/Days)"));
    await flush(40);

    await click(buttonByText(modal, "Market Open (9:30 AM ET M-F)"));
    const cronInput = modal.querySelector('input[placeholder*="30 9"]') as HTMLInputElement;
    expect(cronInput).not.toBeNull();
    expect(cronInput.value).toBe(etToUtcCron({ hour: 9, minute: 30, daysOfWeek: "1-5" }));
    expect(modal.textContent).toContain("converted to UTC when picked");
  });
});

// Detail view -----------------------------------------------------------------

describe("ScheduledOptionsManager — detail view", () => {
  it("fetches GET /api/schedules/:id on demand and renders type, next run, cron and payload", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const screenCard = cardByTitle("Stock Market Screen");
    // No by-id fetch happens until the user asks for details.
    expect(callsTo(calls, "/api/schedules/sys-market-screen", "GET")).toHaveLength(0);

    await click(buttonByText(screenCard, "Details"));
    const dialog = detailDialog();
    await waitForDialogText("Raw payload");

    const detailCalls = callsTo(calls, "/api/schedules/sys-market-screen", "GET");
    expect(detailCalls).toHaveLength(1);
    expect(dialog.textContent).toContain(new Date(NEXT_RUN_S * 1000).toLocaleString());
    expect(dialog.textContent).toContain("0 14 * * 1-5");
    expect(dialog.textContent).toContain("autonomousMarketScreen");
    expect(dialog.textContent).toContain('"userLogin"');
    expect(dialog.textContent).toContain("sys-market-screen");

    // Closing the dialog keeps the single fetch: no re-read, no guess.
    await click(buttonByText(dialog, "Close"));
    expect(document.querySelector(".sched-detail-modal")).toBeNull();
    expect(callsTo(calls, "/api/schedules/sys-market-screen", "GET")).toHaveLength(1);
  });
});

// Transport contract ----------------------------------------------------------

describe("ScheduledOptionsManager — transport (issue #71 contract)", () => {
  it("renders the schedule list delivered through the worker's 202 async-job stub", async () => {
    installFetch(freshState({ listViaJob: true }));
    await renderManager();
    await waitForText("Stock Market Screen");
    expect(container.textContent).toContain("Options Market Screen");
    expect(container.textContent).toContain("2 Active");
  });
});

// Strategy discovery schedules (issue #126, PR-G) --------------------------

const discoveryRequestNvda = {
  symbol: "NVDA",
  thesis: "bullish",
  targetPrice: 200,
  targetDate: "2027-12-18",
  expectedIvDirection: "unchanged",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  allowedStrategies: ["long_call", "long_put"],
  dataMode: "live",
  optimizationBias: 50,
  maxDte: 45,
};

const discoveryRequestMsft = {
  symbol: "MSFT",
  thesis: "bearish",
  targetPrice: 380,
  targetDate: "2027-12-18",
  expectedIvDirection: "rise",
  maxPlannedLoss: 250,
  minRewardRisk: 2,
  allowedStrategies: ["long_put"],
  dataMode: "live",
};

const userDiscovery = {
  id: "user-discovery-1",
  type: "interval",
  callback: "autonomousStrategyDiscovery",
  intervalSeconds: 14400,
  payload: {
    userLogin: "trader1",
    environment: "TEST",
    requests: [discoveryRequestNvda, discoveryRequestMsft],
    maxItems: 0, // the create route's inert account-scoped stamp; the service ignores it
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

describe("ScheduledOptionsManager — strategy discovery schedules (#126 PR-G)", () => {
  const withDiscovery = () => freshState({ schedules: [...ALL_SCHEDULES, userDiscovery] });

  it("registers discovery in the system-job registry and trigger map", () => {
    expect(SYSTEM_JOBS.autonomousStrategyDiscovery.label).toBe("Strategy Discovery");
    expect(SYSTEM_JOBS.autonomousStrategyDiscovery.triggerRoute).toBe("/api/schedules/trigger-discovery");
    expect(triggerRouteFor("autonomousStrategyDiscovery")).toBe("/api/schedules/trigger-discovery");
  });

  it("renders a discovery schedule with its saved views, cadence, and working controls", async () => {
    installFetch(withDiscovery());
    await renderManager();
    await waitForText("Strategy Discovery");
    expect(container.textContent).toContain("3 Active");
    const card = cardByTitle("Strategy Discovery");
    expect(card.textContent).toContain("Every 240 min");
    expect(card.textContent).toContain("2 saved views");
    expect(card.textContent).toContain("NVDA, MSFT");
    for (const label of ["Trigger Now", "Edit", "Cancel", "Details"]) {
      expect([...card.querySelectorAll("button")].some((b) => b.textContent?.includes(label))).toBe(true);
    }
    // #2329: each saved view is a row in the one Details dialog.
    await click(buttonByText(card, "Details"));
    const dialog = detailDialog();
    await waitForDialogText("Saved views");
    expect(dialog.textContent).toContain("bullish");
    expect(dialog.textContent).toContain("$200");
    expect(dialog.textContent).toContain("2027-12-18");
    expect(dialog.textContent).toContain("MSFT");
  });

  it("Trigger Now on a discovery card posts the card's saved requests to trigger-discovery only", async () => {
    const calls = installFetch(withDiscovery());
    await renderManager();
    await waitForText("Strategy Discovery");

    await click(buttonByText(cardByTitle("Strategy Discovery"), "Trigger Now"));

    const discCalls = callsTo(calls, "/api/schedules/trigger-discovery", "POST");
    expect(discCalls).toHaveLength(1);
    expect(discCalls[0].body.requests).toHaveLength(2);
    expect(discCalls[0].body.requests[0].symbol).toBe("NVDA");
    expect(callsTo(calls, "/api/schedules/trigger-options-analysis", "POST")).toHaveLength(0);
    expect(callsTo(calls, "/api/schedules/trigger-screen", "POST")).toHaveLength(0);
    await waitForText("2 of 2 saved views produced results");
  });

  it("cancels a discovery schedule through the shared cancel route", async () => {
    const calls = installFetch(withDiscovery());
    await renderManager();
    await waitForText("Strategy Discovery");

    await click(buttonByText(cardByTitle("Strategy Discovery"), "Cancel"));

    // #2283 stream 1: Cancel opens a Modal instead of a native confirm().
    // #2329: that dialog is the shared one and names what is cancelled.
    const modal = document.querySelector(".sched-confirm-modal") as HTMLElement;
    expect(modal.textContent).toContain("user-discovery-1");
    await click(buttonByText(modal, "Cancel schedule"));

    const cancelCalls = callsTo(calls, "/api/schedules/cancel", "POST");
    expect(cancelCalls).toHaveLength(1);
    expect(cancelCalls[0].body.id).toBe("user-discovery-1");
    await waitForText("Schedule user-discovery-1 cancelled");
  });

  it("creates a discovery schedule with the exact saved-request payload shape", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    const jobSelect = selectByOptionText(modal, "Saved-View Strategy Discovery");
    setValue(jobSelect, optionValueByText(jobSelect, "Saved-View Strategy Discovery"));
    await flush(40);

    const field = (label: string) =>
      modal.querySelector(`[aria-label="${label}"]`) as HTMLInputElement | HTMLSelectElement;
    setValue(field("View 1 symbol") as HTMLInputElement, "NVDA");
    setValue(field("View 1 target price") as HTMLInputElement, "200");
    setValue(field("View 1 target date") as HTMLInputElement, "2027-12-18");
    setValue(field("View 1 max planned loss") as HTMLInputElement, "500");
    setValue(field("View 1 minimum reward risk") as HTMLInputElement, "1");

    await click(buttonByText(modal, "Add another saved view"));
    setValue(field("View 2 symbol") as HTMLInputElement, "MSFT");
    setValue(field("View 2 thesis") as HTMLSelectElement, "bearish");
    setValue(field("View 2 target price") as HTMLInputElement, "380");
    setValue(field("View 2 target date") as HTMLInputElement, "2027-12-18");
    setValue(field("View 2 max planned loss") as HTMLInputElement, "250");
    setValue(field("View 2 minimum reward risk") as HTMLInputElement, "2");
    setValue(field("View 2 allowed strategies") as HTMLInputElement, "long_put, bull_put_spread");

    await submitForm(modal.querySelector("form")!);

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    const body = createCalls[0].body;
    expect(body.callback).toBe("autonomousStrategyDiscovery");
    expect(body.scheduleType).toBe("interval");
    expect(body.intervalSeconds).toBe(3600);
    expect(body.payload.environment).toBe("TEST");
    expect(body.payload.trigger).toBe("scheduled");
    expect(body.payload).not.toHaveProperty("universe");
    expect(body.payload).not.toHaveProperty("symbols");
    expect(body.payload).not.toHaveProperty("maxItems");
    expect(body.payload.requests).toHaveLength(2);
    expect(body.payload.requests[0]).toEqual({
      symbol: "NVDA",
      thesis: "bullish",
      targetPrice: 200,
      targetDate: "2027-12-18",
      expectedIvDirection: "unchanged",
      maxPlannedLoss: 500,
      minRewardRisk: 1,
      allowedStrategies: ["all"],
      dataMode: "live",
    });
    expect(body.payload.requests[1]).toMatchObject({
      symbol: "MSFT",
      thesis: "bearish",
      targetPrice: 380,
      allowedStrategies: ["long_put", "bull_put_spread"],
    });
    await waitForText("Schedule created paused");
  });

  it("blocks a discovery create with an incomplete view and posts nothing", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    const jobSelect = selectByOptionText(modal, "Saved-View Strategy Discovery");
    setValue(jobSelect, optionValueByText(jobSelect, "Saved-View Strategy Discovery"));
    await flush(40);

    await submitForm(modal.querySelector("form")!);

    expect(callsTo(calls, "/api/schedules/create", "POST")).toHaveLength(0);
    await waitForText("a symbol is required");
  });

  it("surfaces the create route's 400 when the server rejects a saved view", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    const jobSelect = selectByOptionText(modal, "Saved-View Strategy Discovery");
    setValue(jobSelect, optionValueByText(jobSelect, "Saved-View Strategy Discovery"));
    await flush(40);

    const field = (label: string) =>
      modal.querySelector(`[aria-label="${label}"]`) as HTMLInputElement;
    setValue(field("View 1 symbol"), "NVDA");
    setValue(field("View 1 target price"), "200");
    setValue(field("View 1 target date"), "2027-12-18");
    setValue(field("View 1 max planned loss"), "500");
    setValue(field("View 1 minimum reward risk"), "1");
    setValue(field("View 1 allowed strategies"), "not_a_strategy");

    await submitForm(modal.querySelector("form")!);

    expect(callsTo(calls, "/api/schedules/create", "POST")).toHaveLength(1);
    await waitForText("Saved discovery request 1 (NVDA) is invalid");
    // The modal stays open so the user can fix the view.
    expect(document.querySelector(".sched-modal-card")).not.toBeNull();
  });

  it("edits a discovery schedule: the editor round-trips its saved views through cancel + create", async () => {
    const calls = installFetch(withDiscovery());
    await renderManager();
    await waitForText("Strategy Discovery");

    await click(buttonByText(cardByTitle("Strategy Discovery"), "Edit"));
    const modal = document.querySelector(".sched-modal-card") as HTMLElement;
    expect(modal).not.toBeNull();
    const symbolInput = modal.querySelector('[aria-label="View 1 symbol"]') as HTMLInputElement;
    expect(symbolInput.value).toBe("NVDA");
    const biasInput = modal.querySelector('[aria-label="View 1 optimization bias"]') as HTMLInputElement;
    expect(biasInput.value).toBe("50");

    await submitForm(modal.querySelector("form")!);

    const cancelCalls = callsTo(calls, "/api/schedules/cancel", "POST");
    expect(cancelCalls.map((c) => c.body.id)).toContain("user-discovery-1");
    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.callback).toBe("autonomousStrategyDiscovery");
    expect(createCalls[0].body.payload.requests[0]).toEqual(discoveryRequestNvda);
    expect(createCalls[0].body.payload.requests[1]).toEqual(discoveryRequestMsft);
    await waitForText("Schedule updated successfully");
  });
});

// Profile-derived discovery schedules (issue #533, PR-533B) -----------

const profileIncome = {
  id: "prof-1",
  userLogin: "trader1",
  name: "Income",
  version: 3,
  thesis: "bullish",
  maxPlannedLoss: 500,
  minRewardRisk: 1,
  allowedStrategies: ["long_call", "long_put"],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
};

const PROFILE_FIXTURES = [
  profileIncome,
  {
    id: "prof-2",
    userLogin: "trader1",
    name: "No Thesis",
    version: 1,
    maxPlannedLoss: 500,
    minRewardRisk: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    id: "prof-3",
    userLogin: "trader1",
    name: "No Caps",
    version: 2,
    thesis: "bearish",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
  {
    id: "prof-reject",
    userLogin: "trader1",
    name: "Server Rejects",
    version: 1,
    thesis: "bullish",
    maxPlannedLoss: 100,
    minRewardRisk: 1,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
  },
];

const userDiscoveryDerived = {
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

const userDiscoveryNoView = {
  id: "user-discovery-noview",
  type: "interval",
  callback: "autonomousStrategyDiscovery",
  intervalSeconds: 3600,
  payload: {
    userLogin: "trader1",
    environment: "TEST",
    inputModel: "no-view",
    constraintSets: [
      { symbol: "NVDA", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, minDte: 7, maxDte: 45, riskProfile: "balanced" },
      { symbol: "MSFT", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, minDte: 7, maxDte: 45, riskProfile: "balanced" },
    ],
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

// The same model armed with per-symbol constraints (possible via
// the API): hydration must surface the divergence, not flatten it.
const userDiscoveryNoViewDivergent = {
  id: "user-discovery-noview-divergent",
  type: "interval",
  callback: "autonomousStrategyDiscovery",
  intervalSeconds: 3600,
  payload: {
    userLogin: "trader1",
    environment: "TEST",
    inputModel: "no-view",
    constraintSets: [
      { symbol: "NVDA", maxPlannedLoss: 500, minRewardRisk: 1, riskProfile: "balanced" },
      { symbol: "MSFT", maxPlannedLoss: 250, minRewardRisk: 2, riskProfile: "conservative" },
    ],
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};

function setFieldValue(
  el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement,
  value: string
) {
  const proto =
    el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

async function openDerivedEditor(modal: HTMLElement) {
  const jobSelect = selectByOptionText(modal, "Saved-View Strategy Discovery");
  setValue(jobSelect, optionValueByText(jobSelect, "Saved-View Strategy Discovery"));
  await flush(40);
  const modelSelect = selectByOptionText(modal, "Symbol set + profile (derived targets)");
  setValue(modelSelect, optionValueByText(modelSelect, "Symbol set + profile (derived targets)"));
  await flush(40);
}

async function openNoViewEditor(modal: HTMLElement) {
  const jobSelect = selectByOptionText(modal, "Saved-View Strategy Discovery");
  setValue(jobSelect, optionValueByText(jobSelect, "Saved-View Strategy Discovery"));
  await flush(40);
  const modelSelect = selectByOptionText(modal, "No-view (constraints only)");
  setValue(modelSelect, optionValueByText(modelSelect, "No-view (constraints only)"));
  await flush(40);
}

describe("profile-derived payload builder (#533)", () => {
  it("parses symbols from comma/newline text, uppercased, blanks dropped", () => {
    expect(parseDerivedSymbols("NVDA, msft\nAAPL,,  spy ")).toEqual(["NVDA", "MSFT", "AAPL", "SPY"]);
    expect(parseDerivedSymbols("")).toEqual([]);
  });

  it("emits exactly one symbol source: symbols XOR watchlistName, never both", () => {
    const bySymbols = buildProfileDerivedPayload({
      source: "symbols",
      symbolsText: "NVDA, MSFT",
      watchlistName: "My List",
      profileId: "prof-1",
    });
    expect(bySymbols).toEqual({
      payload: { inputModel: "profile-derived", symbols: ["NVDA", "MSFT"], profileId: "prof-1" },
    });
    const byWatchlist = buildProfileDerivedPayload({
      source: "watchlist",
      symbolsText: "NVDA",
      watchlistName: " My List ",
      profileId: "prof-1",
    });
    expect(byWatchlist).toEqual({
      payload: { inputModel: "profile-derived", watchlistName: "My List", profileId: "prof-1" },
    });
  });

  it("rejects a missing profile, an empty source, an over-cap set, and a bad ticker", () => {
    expect(
      buildProfileDerivedPayload({ source: "symbols", symbolsText: "NVDA", watchlistName: "", profileId: "" })
    ).toEqual({ error: "Choose a Strategy Profile to derive targets under." });
    expect(
      buildProfileDerivedPayload({ source: "symbols", symbolsText: " , ", watchlistName: "", profileId: "p" })
    ).toEqual({ error: "Enter at least one symbol to derive targets for." });
    expect(
      buildProfileDerivedPayload({ source: "watchlist", symbolsText: "", watchlistName: "  ", profileId: "p" })
    ).toEqual({ error: "Enter the name of a watchlist to derive targets for." });
    const tooMany = Array.from({ length: 26 }, (_, i) => `S${i}`).join(",");
    expect(
      buildProfileDerivedPayload({ source: "symbols", symbolsText: tooMany, watchlistName: "", profileId: "p" })
    ).toEqual({ error: "Profile-derived discovery schedules are capped at 25 symbols per schedule." });
    expect(
      buildProfileDerivedPayload({ source: "symbols", symbolsText: "NVDA, BAD!", watchlistName: "", profileId: "p" })
    ).toEqual({ error: '"BAD!" is not a valid ticker symbol.' });
  });

  it("names why a profile cannot derive: no thesis (D1), missing risk caps (D3)", () => {
    expect(profileDerivationBlockReason({ thesis: "bullish", maxPlannedLoss: 500, minRewardRisk: 1 })).toBeNull();
    expect(profileDerivationBlockReason({ maxPlannedLoss: 500, minRewardRisk: 1 })).toBe(
      "no thesis — cannot derive direction"
    );
    expect(profileDerivationBlockReason({ thesis: "bearish" })).toBe(
      "missing max planned loss or min reward/risk — cannot derive targets"
    );
    expect(profileDerivationBlockReason({ thesis: "bearish", maxPlannedLoss: 500 })).toBe(
      "missing max planned loss or min reward/risk — cannot derive targets"
    );
  });
});

describe("ScheduledOptionsManager — profile-derived discovery (#533)", () => {
  const withDerived = () => freshState({ schedules: [...ALL_SCHEDULES, userDiscovery, userDiscoveryDerived] });

  it("labels a profile-derived schedule's card with its model, symbols, and resolved profile", async () => {
    installFetch(withDerived());
    await renderManager();
    await waitForText("Strategy Discovery · Profile-derived");
    await waitForText("Income (v3)");
    const card = cardByTitle("Strategy Discovery · Profile-derived");
    expect(card.textContent).toContain("Profile-derived");
    expect(card.textContent).toContain("NVDA, MSFT");
    // The profile id resolves to the loaded profile's name + version.
    expect(card.textContent).toContain("Income (v3)");
    expect(card.textContent).not.toContain("saved views");
    // The canonical model row lives in the one Details dialog.
    await click(buttonByText(card, "Details"));
    const dialog = detailDialog();
    expect(dialog.textContent).toContain("Input model");
    expect(dialog.textContent).toContain("Profile-derived");
    // The saved-view card next to it keeps its own labelling.
    const savedCard = cardByTitle("Strategy Discovery");
    expect(savedCard.textContent).toContain("saved views");
  });

  it("creates a profile-derived schedule from explicit symbols with the exact payload shape", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    await openDerivedEditor(modal);

    const symbolsArea = modal.querySelector('[aria-label="Derived symbols"]') as HTMLTextAreaElement;
    expect(symbolsArea).not.toBeNull();
    setFieldValue(symbolsArea, "NVDA, msft\nAAPL");
    const profileSelect = selectByOptionText(modal, "Income");
    setValue(profileSelect, "prof-1");

    await submitForm(modal.querySelector("form")!);

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    const body = createCalls[0].body;
    expect(body.callback).toBe("autonomousStrategyDiscovery");
    expect(body.payload).toEqual({
      inputModel: "profile-derived",
      symbols: ["NVDA", "MSFT", "AAPL"],
      profileId: "prof-1",
      slackChannel: "#options-alerts",
      environment: "TEST",
      trigger: "scheduled",
    });
    expect(body.payload).not.toHaveProperty("requests");
    expect(body.payload).not.toHaveProperty("watchlistName");
    await waitForText("Schedule created paused");
  });

  it("creates a profile-derived schedule from a watchlist name — symbols key absent", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    await openDerivedEditor(modal);

    const sourceSelect = selectByOptionText(modal, "Watchlist name");
    setValue(sourceSelect, optionValueByText(sourceSelect, "Watchlist name"));
    await flush(40);
    const watchlistInput = modal.querySelector('[aria-label="Derived watchlist name"]') as HTMLInputElement;
    expect(watchlistInput).not.toBeNull();
    setFieldValue(watchlistInput, "My List");
    const profileSelect = selectByOptionText(modal, "Income");
    setValue(profileSelect, "prof-1");

    await submitForm(modal.querySelector("form")!);

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.payload).toEqual({
      inputModel: "profile-derived",
      watchlistName: "My List",
      profileId: "prof-1",
      slackChannel: "#options-alerts",
      environment: "TEST",
      trigger: "scheduled",
    });
    expect(createCalls[0].body.payload).not.toHaveProperty("symbols");
    expect(createCalls[0].body.payload).not.toHaveProperty("requests");
  });

  it("disables profiles that cannot derive, with the reason in the option text", async () => {
    installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    await openDerivedEditor(modal);

    const profileSelect = selectByOptionText(modal, "Income");
    const byValue = (v: string) => [...profileSelect.options].find((o) => o.value === v)!;
    expect(byValue("prof-1").disabled).toBe(false);
    expect(byValue("prof-2").disabled).toBe(true);
    expect(byValue("prof-2").textContent).toContain("no thesis — cannot derive direction");
    expect(byValue("prof-3").disabled).toBe(true);
    expect(byValue("prof-3").textContent).toContain("missing max planned loss or min reward/risk");
  });

  it("blocks a derived create with no profile chosen and posts nothing", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    await openDerivedEditor(modal);
    const symbolsArea = modal.querySelector('[aria-label="Derived symbols"]') as HTMLTextAreaElement;
    setFieldValue(symbolsArea, "NVDA");

    await submitForm(modal.querySelector("form")!);

    expect(callsTo(calls, "/api/schedules/create", "POST")).toHaveLength(0);
    await waitForText("Choose a Strategy Profile to derive targets under.");
  });

  it("surfaces the create route's 400 for a profile-derived create, modal stays open", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    await openDerivedEditor(modal);
    const symbolsArea = modal.querySelector('[aria-label="Derived symbols"]') as HTMLTextAreaElement;
    setFieldValue(symbolsArea, "NVDA");
    const profileSelect = selectByOptionText(modal, "Server Rejects");
    setValue(profileSelect, "prof-reject");

    await submitForm(modal.querySelector("form")!);

    expect(callsTo(calls, "/api/schedules/create", "POST")).toHaveLength(1);
    await waitForText("require exactly one symbol source");
    expect(document.querySelector(".sched-modal-card")).not.toBeNull();
  });

  it("edits a profile-derived schedule: the form hydrates from its payload and round-trips it", async () => {
    const calls = installFetch(withDerived());
    await renderManager();
    await waitForText("Strategy Discovery · Profile-derived");

    await click(buttonByText(cardByTitle("Strategy Discovery · Profile-derived"), "Edit"));
    const modal = document.querySelector(".sched-modal-card") as HTMLElement;
    expect(modal).not.toBeNull();
    const modelSelect = selectByOptionText(modal, "Symbol set + profile (derived targets)");
    expect(modelSelect.value).toBe("profile-derived");
    const symbolsArea = modal.querySelector('[aria-label="Derived symbols"]') as HTMLTextAreaElement;
    expect(symbolsArea.value).toBe("NVDA, MSFT");
    const profileSelect = selectByOptionText(modal, "Income");
    expect(profileSelect.value).toBe("prof-1");

    await submitForm(modal.querySelector("form")!);

    const cancelCalls = callsTo(calls, "/api/schedules/cancel", "POST");
    expect(cancelCalls.map((c) => c.body.id)).toContain("user-discovery-derived");
    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.payload).toEqual({
      inputModel: "profile-derived",
      symbols: ["NVDA", "MSFT"],
      profileId: "prof-1",
      environment: "TEST",
      trigger: "scheduled",
    });
    // Issue #2438 (conflicting-state rule): the stored discovery
    // payload carries NO channel, so the edit save must not invent
    // one — the pre-#2438 round-trip passed only because the form's
    // create defaults (Slack on, "#options-alerts") leaked into edits.
    expect(createCalls[0].body.payload).not.toHaveProperty("slackChannel");
    await waitForText("Schedule updated successfully");
  });

  it("shows the profile id and the derived-at-run-time note in a derived schedule's details", async () => {
    const calls = installFetch(withDerived());
    await renderManager();
    await waitForText("Strategy Discovery · Profile-derived");

    const card = cardByTitle("Strategy Discovery · Profile-derived");
    await click(buttonByText(card, "Details"));
    await waitForDialogText("Targets derived at run time");

    expect(callsTo(calls, "/api/schedules/user-discovery-derived", "GET")).toHaveLength(1);
    const dialog = detailDialog();
    expect(dialog.textContent).toContain("Profile");
    expect(dialog.textContent).toContain("Income (v3)");
    expect(dialog.textContent).toContain('"profileId": "prof-1"');
  });
});

describe("no-view payload builder (#534)", () => {
  const draft = (patch: Partial<ReturnType<typeof blankNoViewConstraintsDraft>> = {}) => ({
    ...blankNoViewConstraintsDraft(),
    symbolsText: "NVDA, msft\nAAPL",
    maxPlannedLoss: "500",
    minRewardRisk: "1",
    ...patch,
  });

  it("builds one constraint set per symbol, all sharing the edited constraints", () => {
    expect(buildNoViewPayload(draft({ minDte: "7", maxDte: "45" }))).toEqual({
      payload: {
        inputModel: "no-view",
        constraintSets: [
          { symbol: "NVDA", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, riskProfile: "balanced", minDte: 7, maxDte: 45 },
          { symbol: "MSFT", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, riskProfile: "balanced", minDte: 7, maxDte: 45 },
          { symbol: "AAPL", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, riskProfile: "balanced", minDte: 7, maxDte: 45 },
        ],
      },
    });
  });

  it("emits no view fields — no thesis, target, date, or IV direction exists to send", () => {
    const built = buildNoViewPayload(draft());
    if (!("payload" in built)) throw new Error("expected a payload");
    for (const set of built.payload.constraintSets) {
      expect(Object.keys(set).sort()).toEqual(
        ["maxPlannedLoss", "minProbabilityOfProfit", "minRewardRisk", "riskProfile", "symbol"].sort()
      );
    }
    expect(built.payload).not.toHaveProperty("requests");
    expect(built.payload).not.toHaveProperty("symbols");
    expect(built.payload).not.toHaveProperty("profileId");
  });

  it("applies the mode's default POP floor when the field is blank, and omits blank DTE bounds", () => {
    const built = buildNoViewPayload(draft({ minProbabilityOfProfit: "" }));
    if (!("payload" in built)) throw new Error("expected a payload");
    expect(built.payload.constraintSets[0].minProbabilityOfProfit).toBe(0.35);
    expect(built.payload.constraintSets[0]).not.toHaveProperty("minDte");
    expect(built.payload.constraintSets[0]).not.toHaveProperty("maxDte");
  });

  it("rejects an empty set, an over-cap set, a bad ticker, and bad numbers", () => {
    expect(buildNoViewPayload(draft({ symbolsText: " , " }))).toEqual({
      error: "Enter at least one symbol for the no-view constraint sets.",
    });
    const tooMany = Array.from({ length: 26 }, (_, i) => `S${i}`).join(",");
    expect(buildNoViewPayload(draft({ symbolsText: tooMany }))).toEqual({
      error: "No-view discovery schedules are capped at 25 symbols per schedule.",
    });
    expect(buildNoViewPayload(draft({ symbolsText: "NVDA, BAD!" }))).toEqual({
      error: '"BAD!" is not a valid ticker symbol.',
    });
    expect(buildNoViewPayload(draft({ maxPlannedLoss: "" }))).toEqual({
      error: "Max planned loss must be a positive number.",
    });
    expect(buildNoViewPayload(draft({ maxPlannedLoss: "-5" }))).toEqual({
      error: "Max planned loss must be a positive number.",
    });
    expect(buildNoViewPayload(draft({ minRewardRisk: "-1" }))).toEqual({
      error: "Minimum reward/risk must be zero or more.",
    });
    expect(buildNoViewPayload(draft({ minProbabilityOfProfit: "0" }))).toEqual({
      error: "Minimum probability of profit must be more than 0 and at most 1 (e.g. 0.35).",
    });
    expect(buildNoViewPayload(draft({ minProbabilityOfProfit: "1.5" }))).toEqual({
      error: "Minimum probability of profit must be more than 0 and at most 1 (e.g. 0.35).",
    });
    expect(buildNoViewPayload(draft({ minDte: "0" }))).toEqual({
      error: "Min DTE must be a whole number of at least 1.",
    });
    expect(buildNoViewPayload(draft({ minDte: "45", maxDte: "7" }))).toEqual({
      error: "Max DTE must be at least the min DTE.",
    });
  });

  it("hydrates shared sets back into one draft; divergent sets report shared = false", () => {
    const sets = userDiscoveryNoView.payload.constraintSets;
    const { draft: hydrated, shared } = noViewDraftFromConstraintSets(sets);
    expect(shared).toBe(true);
    expect(hydrated.symbolsText).toBe("NVDA, MSFT");
    expect(hydrated.maxPlannedLoss).toBe("500");
    expect(hydrated.minRewardRisk).toBe("1");
    expect(hydrated.minProbabilityOfProfit).toBe("0.35");
    expect(hydrated.minDte).toBe("7");
    expect(hydrated.maxDte).toBe("45");
    expect(hydrated.riskProfile).toBe("balanced");
    // A hydrated draft re-builds the identical payload (round-trip).
    expect(buildNoViewPayload(hydrated)).toEqual({
      payload: { inputModel: "no-view", constraintSets: sets },
    });

    const divergent = noViewDraftFromConstraintSets(userDiscoveryNoViewDivergent.payload.constraintSets);
    expect(divergent.shared).toBe(false);
    // The draft takes the first set's constraints — visibly, not silently.
    expect(divergent.draft.maxPlannedLoss).toBe("500");
    expect(divergent.draft.symbolsText).toBe("NVDA, MSFT");

    const empty = noViewDraftFromConstraintSets([]);
    expect(empty.shared).toBe(true);
    expect(empty.draft.symbolsText).toBe("");
  });

  it("summarizes a stored constraint set for cards", () => {
    expect(formatNoViewConstraints(userDiscoveryNoView.payload.constraintSets[0])).toBe(
      "max loss $500 · min R/R 1× · POP ≥ 35% · DTE 7–45 · balanced"
    );
    expect(formatNoViewConstraints({ symbol: "AAPL", maxPlannedLoss: 250, minRewardRisk: 2 })).toBe(
      "max loss $250 · min R/R 2× · POP ≥ 35%"
    );
    expect(formatNoViewConstraints(null)).toBe("—");
  });
});

describe("ScheduledOptionsManager — no-view discovery (#534)", () => {
  const withNoView = () => freshState({ schedules: [...ALL_SCHEDULES, userDiscovery, userDiscoveryNoView] });

  it("labels a no-view schedule's card with its model, symbols, and constraints", async () => {
    installFetch(withNoView());
    await renderManager();
    await waitForText("Strategy Discovery · No-view");
    const card = cardByTitle("Strategy Discovery · No-view");
    expect(card.textContent).toContain("No-view");
    expect(card.textContent).toContain("NVDA, MSFT");
    expect(card.textContent).not.toContain("saved views");
    await click(buttonByText(card, "Details"));
    const dialog = detailDialog();
    expect(dialog.textContent).toContain("max loss $500");
    expect(dialog.textContent).toContain("no thesis, no target");
    // The saved-view card next to it keeps its own labelling.
    const savedCard = cardByTitle("Strategy Discovery");
    expect(savedCard.textContent).toContain("saved views");
  });

  it("creates a no-view schedule with the exact constraintSets payload shape", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    await openNoViewEditor(modal);

    // The mode's copy states the absence of a view explicitly, and
    // the editor has no thesis/target fields at all.
    expect(modal.textContent).toContain("targets are never set in this mode");
    expect(modal.querySelector('[aria-label="No-view symbols"]')).not.toBeNull();
    expect(modal.textContent).not.toContain("Target Price");

    setFieldValue(modal.querySelector('[aria-label="No-view symbols"]') as HTMLTextAreaElement, "NVDA, msft");
    setFieldValue(modal.querySelector('[aria-label="No-view max planned loss"]') as HTMLInputElement, "500");
    setFieldValue(modal.querySelector('[aria-label="No-view min reward risk"]') as HTMLInputElement, "1");
    setFieldValue(modal.querySelector('[aria-label="No-view min DTE"]') as HTMLInputElement, "7");
    setFieldValue(modal.querySelector('[aria-label="No-view max DTE"]') as HTMLInputElement, "45");

    await submitForm(modal.querySelector("form")!);

    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    const body = createCalls[0].body;
    expect(body.callback).toBe("autonomousStrategyDiscovery");
    expect(body.payload).toEqual({
      inputModel: "no-view",
      constraintSets: [
        { symbol: "NVDA", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, riskProfile: "balanced", minDte: 7, maxDte: 45 },
        { symbol: "MSFT", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, riskProfile: "balanced", minDte: 7, maxDte: 45 },
      ],
      slackChannel: "#options-alerts",
      environment: "TEST",
      trigger: "scheduled",
    });
    expect(body.payload).not.toHaveProperty("requests");
    expect(body.payload).not.toHaveProperty("profileId");
    await waitForText("Schedule created paused");
  });

  it("blocks a no-view create with no symbols and posts nothing", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    await openNoViewEditor(modal);
    setFieldValue(modal.querySelector('[aria-label="No-view max planned loss"]') as HTMLInputElement, "500");
    setFieldValue(modal.querySelector('[aria-label="No-view min reward risk"]') as HTMLInputElement, "1");

    await submitForm(modal.querySelector("form")!);

    expect(callsTo(calls, "/api/schedules/create", "POST")).toHaveLength(0);
    await waitForText("Enter at least one symbol for the no-view constraint sets.");
  });

  it("surfaces the create route's 400 for a no-view create, modal stays open", async () => {
    const calls = installFetch(freshState());
    await renderManager();
    await waitForText("Stock Market Screen");

    const modal = await openCreateModal();
    await openNoViewEditor(modal);
    setFieldValue(modal.querySelector('[aria-label="No-view symbols"]') as HTMLTextAreaElement, "REJECT");
    setFieldValue(modal.querySelector('[aria-label="No-view max planned loss"]') as HTMLInputElement, "500");
    setFieldValue(modal.querySelector('[aria-label="No-view min reward risk"]') as HTMLInputElement, "1");

    await submitForm(modal.querySelector("form")!);

    expect(callsTo(calls, "/api/schedules/create", "POST")).toHaveLength(1);
    await waitForText("constraints only — no thesis, target price, target date, or IV direction");
    expect(document.querySelector(".sched-modal-card")).not.toBeNull();
  });

  it("edits a no-view schedule: the form hydrates from its constraint sets and round-trips them", async () => {
    const calls = installFetch(withNoView());
    await renderManager();
    await waitForText("Strategy Discovery · No-view");

    await click(buttonByText(cardByTitle("Strategy Discovery · No-view"), "Edit"));
    const modal = document.querySelector(".sched-modal-card") as HTMLElement;
    expect(modal).not.toBeNull();
    const modelSelect = selectByOptionText(modal, "No-view (constraints only)");
    expect(modelSelect.value).toBe("no-view");
    const symbolsArea = modal.querySelector('[aria-label="No-view symbols"]') as HTMLTextAreaElement;
    expect(symbolsArea.value).toBe("NVDA, MSFT");
    expect((modal.querySelector('[aria-label="No-view max planned loss"]') as HTMLInputElement).value).toBe("500");
    expect((modal.querySelector('[aria-label="No-view min DTE"]') as HTMLInputElement).value).toBe("7");
    expect((modal.querySelector('[aria-label="No-view max DTE"]') as HTMLInputElement).value).toBe("45");

    await submitForm(modal.querySelector("form")!);

    const cancelCalls = callsTo(calls, "/api/schedules/cancel", "POST");
    expect(cancelCalls.map((c) => c.body.id)).toContain("user-discovery-noview");
    const createCalls = callsTo(calls, "/api/schedules/create", "POST");
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].body.payload).toEqual({
      inputModel: "no-view",
      constraintSets: userDiscoveryNoView.payload.constraintSets,
      environment: "TEST",
      trigger: "scheduled",
    });
    // Issue #2438 (conflicting-state rule): see the profile-derived
    // edit test — no stored channel, no invented channel on save.
    expect(createCalls[0].body.payload).not.toHaveProperty("slackChannel");
    await waitForText("Schedule updated successfully");
  });

  it("surfaces per-symbol divergence when editing a schedule armed with differing sets", async () => {
    installFetch(freshState({ schedules: [...ALL_SCHEDULES, userDiscoveryNoViewDivergent] }));
    await renderManager();
    await waitForText("Strategy Discovery · No-view");

    await click(buttonByText(cardByTitle("Strategy Discovery · No-view"), "Edit"));
    const modal = document.querySelector(".sched-modal-card") as HTMLElement;
    expect(modal).not.toBeNull();
    expect(modal.textContent).toContain("different constraints per symbol");
    expect(modal.textContent).toContain("saving re-arms every symbol with the values above");
    // The editor shows the first set's constraints.
    expect((modal.querySelector('[aria-label="No-view max planned loss"]') as HTMLInputElement).value).toBe("500");
  });

  it("shows the no-view model and its no-view note in a no-view schedule's details", async () => {
    const calls = installFetch(withNoView());
    await renderManager();
    await waitForText("Strategy Discovery · No-view");

    const card = cardByTitle("Strategy Discovery · No-view");
    await click(buttonByText(card, "Details"));
    await waitForDialogText("No view is stored on this schedule");

    expect(callsTo(calls, "/api/schedules/user-discovery-noview", "GET")).toHaveLength(1);
    const dialog = detailDialog();
    expect(dialog.textContent).toContain("Input model");
    expect(dialog.textContent).toContain("Constraint sets");
    expect(dialog.textContent).toContain("no-view-v1 score model");
  });
});
