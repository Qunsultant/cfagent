/** @vitest-environment jsdom */
/**
 * S7 (consolidation, umbrella #958) — one schedule UI over the one
 * schedule store. Pins:
 *
 *  1. PAYLOAD GOLDENS: the single client payload builder
 *     (scheduledOptionsManager/payloadBuilders) reproduces, byte for
 *     byte, the POST bodies the legacy options manager's inline
 *     construction submitted for the same form states. The goldens
 *     were captured from the CONTROL tree by driving the legacy
 *     component (2026-10-22, base 3b8ac741) — see the S7 build
 *     report. JSON.stringify equality: same keys, same order, same
 *     values (undefined-valued keys drop identically).
 *  2. Every golden payload passes the S1 client-side validation;
 *     the validator names bad fields and enforces the route's
 *     maxItems rule with the route's message.
 *  3. ONE BUILDER / ONE SURFACE (source pins): only the screening
 *     section component posts creates, and it builds through the
 *     builders module; SchedulesPanel hosts the section; the options
 *     hub's schedules mode is a redirect; the retired component path
 *     is gone.
 *  4. UNION RENDER: the survivor (SchedulesPanel) shows kind rows
 *     with pause/resume + the one Edit control, generic rows for the
 *     other callbacks, the latest-runs and audit sections, and tab
 *     filtering across both. #2329 replaced the kind cards with rows:
 *     the frequency-only editor became part of the one Edit form.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildOptionsRunNowPayload,
  buildScheduleSubmission,
  validateScheduleCriteriaClient,
} from "../src/client/scheduledOptionsManager/payloadBuilders";
import {
  blankDiscoveryRequestDraft,
  blankNoViewConstraintsDraft,
} from "../src/client/ScheduledOptionsManager";
import type { ScheduleFormState } from "../src/client/scheduledOptionsManager/types";
import { SchedulesPanel } from "../src/client/SchedulesPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(join(here, "..", rel), "utf8").replace(/\r\n/g, "\n");

/* ------------------------------------------------------------------ */
/* Golden fixtures                                                     */
/* ------------------------------------------------------------------ */

/** The legacy create form's state after openCreateModal, as driven
 *  in the control-tree capture (environment TEST). */
const baseForm: ScheduleFormState = {
  jobType: "optionsAnalysis",
  targetSymbols: "",
  maxItems: 100,
  targetUniverse: "NASDAQ100",
  sector: "Technology",
  minPrice: "",
  maxPrice: "",
  minMarketCap: "",
  maxPe: "",
  trendFilter: "",
  scheduleType: "interval",
  intervalSeconds: 3600,
  cronExpression: "30 13 * * 1-5",
  delaySeconds: 1800,
  scheduledDate: "",
  thesis: "bullish",
  riskProfile: "balanced",
  pushToSlack: true,
  slackChannel: "#options-alerts",
  emailTo: "",
  webhookUrl: "",
  discoveryRequests: [blankDiscoveryRequestDraft()],
  discoveryInputModel: "saved-request",
  derivedSource: "symbols",
  derivedSymbolsText: "",
  derivedWatchlistName: "",
  derivedProfileId: "",
  noViewDraft: blankNoViewConstraintsDraft(),
  environment: "TEST",
};

function submission(form: ScheduleFormState): Record<string, any> {
  const built = buildScheduleSubmission(form);
  if ("error" in built) throw new Error(`unexpected builder error: ${built.error}`);
  return built.requestBody;
}

const GOLDENS: Record<string, { form: ScheduleFormState; body: Record<string, any> }> = {
  G1_marketScreen_universe: {
    form: { ...baseForm, jobType: "marketScreen", targetUniverse: "LEV_ETF", maxItems: 29 },
    body: {
      callback: "autonomousMarketScreen",
      scheduleType: "interval",
      payload: { universe: "LEV_ETF", maxItems: 29, sector: "Technology", trigger: "scheduled", pushToSlack: true, slackChannel: "#options-alerts" },
      intervalSeconds: 3600,
    },
  },
  G2_marketScreen_filters: {
    form: { ...baseForm, jobType: "marketScreen", targetUniverse: "SP500", sector: "ALL", minPrice: "5", maxPrice: "500", minMarketCap: "1", maxPe: "50", trendFilter: "bullish_breakout" },
    body: {
      callback: "autonomousMarketScreen",
      scheduleType: "interval",
      payload: {
        universe: "SP500", maxItems: 100, sector: "ALL", trigger: "scheduled", pushToSlack: true, slackChannel: "#options-alerts",
        filters: { minPrice: 5, maxPrice: 500, minMarketCap: 1, maxPeRatio: 50, momentum: "bullish_breakout" },
      },
      intervalSeconds: 3600,
    },
  },
  G3_options_default: {
    form: { ...baseForm },
    body: {
      callback: "autonomousOptionsAnalysis",
      scheduleType: "interval",
      payload: { universe: "NASDAQ100", maxItems: 100, thesis: "bullish", riskProfile: "balanced", pushToSlack: true, slackChannel: "#options-alerts", environment: "TEST", trigger: "scheduled" },
      intervalSeconds: 3600,
    },
  },
  G4_options_symbols: {
    form: { ...baseForm, targetUniverse: "", targetSymbols: "nvda, aapl", maxItems: 10, thesis: "bearish", riskProfile: "aggressive", pushToSlack: false, emailTo: "trader@firm.com", webhookUrl: "https://hooks.example.com/x" },
    body: {
      callback: "autonomousOptionsAnalysis",
      scheduleType: "interval",
      payload: { symbols: ["NVDA", "AAPL"], maxItems: 10, thesis: "bearish", riskProfile: "aggressive", pushToSlack: false, emailTo: "trader@firm.com", webhookUrl: "https://hooks.example.com/x", environment: "TEST", trigger: "scheduled" },
      intervalSeconds: 3600,
    },
  },
  G5_options_cron: {
    form: { ...baseForm, scheduleType: "cron", cronExpression: "30 14 * * 1-5" },
    body: {
      callback: "autonomousOptionsAnalysis",
      scheduleType: "cron",
      payload: { universe: "NASDAQ100", maxItems: 100, thesis: "bullish", riskProfile: "balanced", pushToSlack: true, slackChannel: "#options-alerts", environment: "TEST", trigger: "scheduled" },
      cron: "30 14 * * 1-5",
    },
  },
  G6_options_delayed: {
    form: { ...baseForm, scheduleType: "delayed", delaySeconds: 7200 },
    body: {
      callback: "autonomousOptionsAnalysis",
      scheduleType: "delayed",
      payload: { universe: "NASDAQ100", maxItems: 100, thesis: "bullish", riskProfile: "balanced", pushToSlack: true, slackChannel: "#options-alerts", environment: "TEST", trigger: "scheduled" },
      delayInSeconds: 7200,
    },
  },
  G8_discovery_saved: {
    form: {
      ...baseForm,
      jobType: "strategyDiscovery",
      discoveryRequests: [
        { ...blankDiscoveryRequestDraft(), symbol: "NVDA", targetPrice: "200", targetDate: "2027-12-18", maxPlannedLoss: "500", minRewardRisk: "1" },
        { ...blankDiscoveryRequestDraft(), symbol: "MSFT", thesis: "bearish", targetPrice: "380", targetDate: "2027-12-18", maxPlannedLoss: "250", minRewardRisk: "2", allowedStrategies: "long_put, bull_put_spread" },
      ],
    },
    body: {
      callback: "autonomousStrategyDiscovery",
      scheduleType: "interval",
      payload: {
        requests: [
          { symbol: "NVDA", thesis: "bullish", targetPrice: 200, targetDate: "2027-12-18", expectedIvDirection: "unchanged", maxPlannedLoss: 500, minRewardRisk: 1, allowedStrategies: ["all"], dataMode: "live" },
          { symbol: "MSFT", thesis: "bearish", targetPrice: 380, targetDate: "2027-12-18", expectedIvDirection: "unchanged", maxPlannedLoss: 250, minRewardRisk: 2, allowedStrategies: ["long_put", "bull_put_spread"], dataMode: "live" },
        ],
        slackChannel: "#options-alerts",
        environment: "TEST",
        trigger: "scheduled",
      },
      intervalSeconds: 3600,
    },
  },
  G9_discovery_derived_symbols: {
    form: { ...baseForm, jobType: "strategyDiscovery", discoveryInputModel: "profile-derived", derivedSymbolsText: "NVDA, msft\nAAPL", derivedProfileId: "prof-1" },
    body: {
      callback: "autonomousStrategyDiscovery",
      scheduleType: "interval",
      payload: { inputModel: "profile-derived", symbols: ["NVDA", "MSFT", "AAPL"], profileId: "prof-1", slackChannel: "#options-alerts", environment: "TEST", trigger: "scheduled" },
      intervalSeconds: 3600,
    },
  },
  G10_discovery_derived_watchlist: {
    form: { ...baseForm, jobType: "strategyDiscovery", discoveryInputModel: "profile-derived", derivedSource: "watchlist", derivedWatchlistName: "My List", derivedProfileId: "prof-1" },
    body: {
      callback: "autonomousStrategyDiscovery",
      scheduleType: "interval",
      payload: { inputModel: "profile-derived", watchlistName: "My List", profileId: "prof-1", slackChannel: "#options-alerts", environment: "TEST", trigger: "scheduled" },
      intervalSeconds: 3600,
    },
  },
  G11_discovery_noview: {
    form: {
      ...baseForm,
      jobType: "strategyDiscovery",
      discoveryInputModel: "no-view",
      noViewDraft: { symbolsText: "NVDA, msft", maxPlannedLoss: "500", minRewardRisk: "1", minProbabilityOfProfit: "0.35", minDte: "7", maxDte: "45", riskProfile: "balanced" },
    },
    body: {
      callback: "autonomousStrategyDiscovery",
      scheduleType: "interval",
      payload: {
        inputModel: "no-view",
        constraintSets: [
          { symbol: "NVDA", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, riskProfile: "balanced", minDte: 7, maxDte: 45 },
          { symbol: "MSFT", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, riskProfile: "balanced", minDte: 7, maxDte: 45 },
        ],
        slackChannel: "#options-alerts",
        environment: "TEST",
        trigger: "scheduled",
      },
      intervalSeconds: 3600,
    },
  },
};

describe("S7 payload goldens — the one builder reproduces the legacy bodies byte-for-byte", () => {
  for (const [name, { form, body }] of Object.entries(GOLDENS)) {
    it(name, () => {
      expect(JSON.stringify(submission(form))).toBe(JSON.stringify(body));
    });
  }

  it("G7 one-shot cadence carries the ISO date and no other cadence keys", () => {
    const body = submission({ ...baseForm, scheduleType: "scheduled", scheduledDate: "2026-10-20T09:30" });
    expect(body.date).toBe(new Date("2026-10-20T09:30").toISOString());
    const { date, ...rest } = body;
    expect(JSON.stringify(rest)).toBe(
      JSON.stringify({
        callback: "autonomousOptionsAnalysis",
        scheduleType: "scheduled",
        payload: { universe: "NASDAQ100", maxItems: 100, thesis: "bullish", riskProfile: "balanced", pushToSlack: true, slackChannel: "#options-alerts", environment: "TEST", trigger: "scheduled" },
      })
    );
  });

  it("hero Run Now payloads match the legacy hero bodies (no trigger stamp)", () => {
    expect(JSON.stringify(buildOptionsRunNowPayload(baseForm))).toBe(
      JSON.stringify({ universe: "NASDAQ100", maxItems: 100, thesis: "bullish", riskProfile: "balanced", pushToSlack: true, slackChannel: "#options-alerts", environment: "TEST" })
    );
    expect(
      JSON.stringify(buildOptionsRunNowPayload({ ...baseForm, targetUniverse: "", targetSymbols: "NVDA, AAPL", thesis: "bearish" }))
    ).toBe(
      JSON.stringify({ symbols: ["NVDA", "AAPL"], maxItems: 100, thesis: "bearish", riskProfile: "balanced", pushToSlack: true, slackChannel: "#options-alerts", environment: "TEST" })
    );
  });
});

describe("S7 client-side S1 schema validation", () => {
  it("accepts every golden payload", () => {
    for (const { body } of Object.values(GOLDENS)) {
      expect(validateScheduleCriteriaClient(body.callback, body.payload)).toBeNull();
    }
  });

  it("names an unknown field instead of letting the route 400 it", () => {
    const err = validateScheduleCriteriaClient("autonomousOptionsAnalysis", {
      universe: "NASDAQ100",
      bogus: 1,
    });
    expect(err).toContain("unknown field(s): bogus");
  });

  it("names a mis-typed field", () => {
    const err = validateScheduleCriteriaClient("autonomousMarketScreen", { sector: 42 });
    expect(err).toContain("sector");
  });

  it("enforces the route's maxItems rule with the route's message", () => {
    expect(
      validateScheduleCriteriaClient("autonomousOptionsAnalysis", { universe: "NASDAQ100", maxItems: 10001 })
    ).toBe("maxItems must be a whole number from 0 to 10000.");
  });

  it("a schema-invalid form state never reaches the create route shape", () => {
    // The builder surfaces the validation error in the form's own
    // { error } channel.
    const built = buildScheduleSubmission({ ...baseForm, maxItems: 10001 });
    expect(built).toEqual({ error: "maxItems must be a whole number from 0 to 10000." });
  });
});

/* ------------------------------------------------------------------ */
/* Source pins                                                         */
/* ------------------------------------------------------------------ */

describe("S7 one surface / one builder (source pins)", () => {
  const sectionSrc = read("src/client/ScheduledOptionsManager.tsx");
  const panelSrc = read("src/client/SchedulesPanel.tsx");

  it("the section builds submissions only through the builders module", () => {
    expect(sectionSrc).toContain('from "./scheduledOptionsManager/payloadBuilders"');
    expect(sectionSrc).toContain("buildScheduleSubmission(");
    expect(sectionSrc).toContain("buildOptionsRunNowPayload(");
  });

  it("the host panel posts no schedule creates (the raw-JSON path is gone)", () => {
    expect(panelSrc).not.toContain("/api/schedules/create");
    expect(panelSrc).not.toContain("Payload (JSON)");
  });

  it("within the schedule UI, exactly one file posts creates — the section", () => {
    const roots = ["src/client/SchedulesPanel.tsx", "src/client/ScheduledOptionsManager.tsx"];
    const folder = join(here, "..", "src", "client", "scheduledOptionsManager");
    for (const name of readdirSync(folder)) {
      if (name.endsWith(".ts") || name.endsWith(".tsx")) {
        roots.push(`src/client/scheduledOptionsManager/${name}`);
      }
    }
    const posters = roots.filter((rel) => read(rel).includes('fetch("/api/schedules/create"'));
    expect(posters).toEqual(["src/client/ScheduledOptionsManager.tsx"]);
  });

  it("SchedulesPanel hosts the screening section", () => {
    expect(panelSrc).toContain('import { ScheduledOptionsManager } from "./ScheduledOptionsManager"');
    expect(panelSrc).toContain("<ScheduledOptionsManager");
  });

  it("the options hub schedules mode is gone (U-03 #3121): no pointer, no second surface", () => {
    const orp = read("src/client/options/OptionsResearchPanel.tsx");
    expect(orp).not.toContain("ScheduledOptionsManager");
    // U-03 (#3121): the schedules mode is retired, not a pointer.
    // ?tab=options&view=scheduled-screening redirects to ?tab=schedules;
    // the runs content lives in ResearchRunsPanel at options-runs.
    expect(orp).not.toContain("Schedule Management Lives in the Schedules Tab");
    expect(orp).not.toContain("Open the Schedules tab");
    expect(orp).not.toContain("<AutonomousOptionsRuns />");
    expect(orp).not.toContain("ScheduledOptionsRunForm");
  });

  it("the retired paths are gone", () => {
    expect(existsSync(join(here, "..", "src/client/options/ScheduledOptionsManager.tsx"))).toBe(false);
    expect(existsSync(join(here, "..", "src/client/options/scheduledOptionsManager"))).toBe(false);
    expect(read("src/client/options/index.ts")).not.toContain("ScheduledOptionsManager");
  });
});

/* ------------------------------------------------------------------ */
/* Survivor render pins                                                */
/* ------------------------------------------------------------------ */

const NEXT_RUN_S = Math.floor(Date.UTC(2026, 9, 19, 14, 30, 0) / 1000);

const pausedOptions = {
  id: "user-options-paused",
  type: "interval",
  callback: "autonomousOptionsAnalysis",
  intervalSeconds: 3600,
  paused: true,
  payload: { symbols: ["NVDA"], thesis: "bullish", riskProfile: "balanced", userLogin: "venus", environment: "TEST", trigger: "scheduled" },
  time: NEXT_RUN_S,
};
const screenJob = {
  id: "user-screen-1",
  type: "cron",
  callback: "autonomousMarketScreen",
  cron: "0 14 * * 1-5",
  payload: { universe: "SP500", sector: "Technology", userLogin: "venus", environment: "TEST", trigger: "scheduled" },
  time: NEXT_RUN_S,
};
const discoveryNoView = {
  id: "user-discovery-noview",
  type: "interval",
  callback: "autonomousStrategyDiscovery",
  intervalSeconds: 3600,
  payload: {
    userLogin: "venus",
    environment: "TEST",
    inputModel: "no-view",
    constraintSets: [
      { symbol: "NVDA", maxPlannedLoss: 500, minRewardRisk: 1, minProbabilityOfProfit: 0.35, riskProfile: "balanced" },
    ],
    trigger: "scheduled",
  },
  time: NEXT_RUN_S,
};
const ivJob = {
  id: "sys-iv-1",
  type: "interval",
  callback: "collectIvHistory",
  intervalSeconds: 86400,
  payload: { userLogin: "venus" },
  time: NEXT_RUN_S,
};
const ALL = [pausedOptions, screenJob, discoveryNoView, ivJob];

interface Rec { url: string; method: string; body: any }
let recorded: Rec[] = [];
let container: HTMLDivElement;
let root: Root;
let auditEvents: any[] = [];

function installFetch() {
  recorded = [];
  auditEvents = [];
  vi.stubGlobal("fetch", async (input: any, init?: any) => {
    const url = typeof input === "string" ? input : input.url;
    const method = String(init?.method || "GET").toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    recorded.push({ url, method, body });
    if (url.includes("/api/schedules") && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ count: ALL.length, creatableCallbacks: ["autonomousMarketScreen", "autonomousOptionsAnalysis", "autonomousStrategyDiscovery"], schedules: ALL }) };
    }
    if (url.startsWith("/api/audit")) return { ok: true, status: 200, json: async () => ({ events: auditEvents }) };
    if (url === "/api/options/latest") return { ok: true, status: 200, json: async () => ({ runs: [] }) };
    if (url.includes("/api/etrade/options/profiles")) return { ok: true, status: 200, json: async () => ({ count: 0, profiles: [] }) };
    return { ok: true, status: 200, json: async () => ({ success: true }) };
  });
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("alert", () => {});
}

async function flush(ms = 30) {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
}
async function waitForText(text: string) {
  const start = Date.now();
  while (Date.now() - start < 6000) {
    if (container.textContent?.includes(text)) return;
    await flush(50);
  }
  throw new Error(`timeout waiting "${text}"; panel: ${container.textContent?.slice(0, 500)}`);
}
async function click(el: Element) {
  await act(async () => { (el as HTMLElement).click(); });
  await flush(40);
}
function buttonByText(scope: ParentNode, text: string): HTMLButtonElement {
  const btn = [...scope.querySelectorAll("button")].find((b) => b.textContent?.includes(text));
  if (!btn) throw new Error(`button "${text}" not found`);
  return btn as HTMLButtonElement;
}
function cardByTitle(titlePart: string): HTMLElement {
  const card = [...container.querySelectorAll(".schedule-item-card")].find((c) => c.textContent?.includes(titlePart));
  if (!card) throw new Error(`card "${titlePart}" not found`);
  return card as HTMLElement;
}

beforeEach(() => {
  document.body.innerHTML = "";
  installFetch();
});
afterEach(async () => {
  if (root) await act(async () => { root.unmount(); });
  container?.remove();
  vi.unstubAllGlobals();
});

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ToastProvider><SchedulesPanel activeEnv="TEST" userLogin="venus" /></ToastProvider>);
  });
  await flush(60);
  await waitForText("Strategy Discovery · No-view");
}

describe("S7 survivor — the one schedule UI renders the union", () => {
  it("kind cards, generic cards, latest runs, and audit on one surface", async () => {
    await renderPanel();
    const text = container.textContent || "";
    // Screening kinds as kind cards in the hosted section.
    expect(text).toContain("Strategy Discovery · No-view");
    expect(text).toContain("Stock Market Screen");
    expect(text).toContain("Options Market Screen");
    // The other callbacks as generic cards on the same surface.
    expect(text).toContain("collectIvHistory");
    // Folded-in sections.
    expect(text).toContain("Latest Autonomous Options Runs");
    expect(text).toContain("Execution History & Audit Trail");
  });

  it("shows stock and options executions with run metadata and explicit empty values", async () => {
    auditEvents = [
      {
        id: "stock-run-event",
        type: "screener.run_completed",
        created_at: "2026-10-25T17:00:00.000Z",
        payload: {
          runId: "stock-run-123", screenType: "stock", runType: "manual",
          symbols: ["NVDA", "AAPL"], opportunityCount: 2,
          notifications: { slack: true, email: false, webhook: false },
        },
      },
      {
        id: "options-run-event",
        type: "options.scheduled_analysis_failed",
        created_at: "2026-10-25T17:01:00.000Z",
        payload: { runId: "options-run-456", screenType: "options", runType: "manual", symbols: ["NVDA"], error: "cancelled" },
      },
      {
        id: "schedule-event",
        type: "schedule.cancelled",
        created_at: "2026-10-25T17:02:00.000Z",
        payload: { scheduleId: "schedule-789", callback: "autonomousOptionsAnalysis" },
      },
    ];
    await renderPanel();
    const audit = [...container.querySelectorAll("section")].find((section) => section.textContent?.includes("Execution History & Audit Trail"));
    expect(audit?.textContent).toContain("Run ID");
    expect(audit?.textContent).toContain("Screen Type");
    expect(audit?.textContent).toContain("Run Type");
    expect(audit?.textContent).toContain("stock-run-123");
    expect(audit?.textContent).toContain("options-run-456");
    expect(audit?.textContent).toContain("Stock");
    expect(audit?.textContent).toContain("Options");
    expect(audit?.textContent).toContain("Manual");
    expect(audit?.textContent).toContain("Scheduled");
    const cells = [...(audit?.querySelectorAll("tbody td") ?? [])];
    expect(cells.every((cell) => cell.textContent?.trim())).toBe(true);
  });

  it("a paused screening schedule shows the badge, Resume, and a disabled Trigger", async () => {
    await renderPanel();
    const card = cardByTitle("Options Market Screen");
    expect(card.textContent).toContain("Paused");
    const buttons = [...card.querySelectorAll("button")];
    expect(buttons.some((b) => b.textContent?.includes("Resume"))).toBe(true);
    const trigger = buttons.find((b) => b.textContent?.includes("Trigger Now")) as HTMLButtonElement;
    expect(trigger).toBeTruthy();
    expect(trigger.disabled).toBe(true);
    // #2329: one Edit control replaces the two edit entry points; the
    // inline cadence PUT editor is gone (cadence lives in the form).
    expect(buttons.some((b) => b.textContent?.includes("Edit frequency"))).toBe(false);
    expect(buttons.filter((b) => b.textContent?.trim() === "Edit")).toHaveLength(1);
  });

  it("the one Edit control opens the form with the stored cadence and never PUTs", async () => {
    await renderPanel();
    const card = cardByTitle("Options Market Screen");
    await click(buttonByText(card, "Edit"));
    await flush(60);
    const modal = document.querySelector(".sched-modal-card") as HTMLElement;
    expect(modal).toBeTruthy();
    expect((modal.querySelector("#sched-cadence-type") as HTMLSelectElement).value).toBe("interval");
    expect((modal.querySelector("#sched-interval-seconds") as HTMLInputElement).value).toBe("3600");
    // #2329: the screening surface no longer carries the cadence-only
    // PUT path — the form is the one edit surface.
    expect(recorded.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("Resume on a paused screening card posts the resume route", async () => {
    await renderPanel();
    const card = cardByTitle("Options Market Screen");
    await click(buttonByText(card, "Resume"));
    const posts = recorded.filter((c) => c.method === "POST" && c.url === "/api/schedules/user-options-paused/resume");
    expect(posts).toHaveLength(1);
  });

  it("tabs filter both the section and the generic grid", async () => {
    await renderPanel();
    const tab = (label: string) =>
      [...container.querySelectorAll("button")].find((b) => (b.textContent || "").startsWith(label))!;

    await click(tab("System"));
    expect(container.textContent).not.toContain("Strategy Discovery · No-view");
    expect(container.textContent).toContain("collectIvHistory");

    await click(tab("Options"));
    expect(container.textContent).toContain("Strategy Discovery · No-view");
    expect(container.textContent).not.toContain("Stock Market Screen");

    await click(tab("Stocks"));
    expect(container.textContent).toContain("Stock Market Screen");
    expect(container.textContent).not.toContain("Strategy Discovery · No-view");
  });
});
