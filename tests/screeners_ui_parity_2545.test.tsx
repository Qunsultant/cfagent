/** @vitest-environment jsdom */
/**
 * Issue #2545 — Screeners UI parity with the two production schedules.
 *
 * Pins:
 *  1. The manual stock-screen request schema carries the scheduled
 *     run's delivery envelope (pushToSlack / slackChannel / emailTo /
 *     webhookUrl — the schedule payload's own deliveryFields) plus
 *     the PDF report flag, split OUT of the engine filter exactly
 *     like emailTo rides today (#1941). Absent fields stay absent:
 *     a legacy body parses to the legacy shape.
 *  2. The follow-up bridge's outcome projection
 *     (screenerOutcomeFromRunResult) carries the per-task channel
 *     overrides + channel allowlist into the SAME delivery planner
 *     the scheduled path feeds, and generatePdf:false drops the
 *     report artifacts from the delivery projection only.
 *  3. The Stocks panel builds its run body through
 *     buildStockRunRequestBody: delivery fields ride the request,
 *     slackChannel only when Slack push is on, blanks omitted.
 *  4. The Options Research one-shot form defaults to the scheduled
 *     "Options Market Screen" parameter set (NASDAQ100 / 100 /
 *     bullish / balanced), builds through the schedule builders
 *     (buildOptionsRunNowPayload), passes the shared server-side
 *     schedule validation (buildSchedulePayload), and submits to
 *     the schedule's own trigger route.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { parseStockScreenRequest, buildSchedulePayload } from "../src/trading";
import {
  screenerOutcomeFromRunResult,
  plannedDeliveryChannels,
  type ScreenerFollowupConfig,
} from "../src/services/screenerFollowups";
import { buildStockRunRequestBody } from "../src/client/ScreenersHub";
import {
  buildOptionsRunNowPayload,
  validateScheduleCriteriaClient,
} from "../src/client/scheduledOptionsManager/payloadBuilders";
import type { ScheduleFormState } from "../src/client/scheduledOptionsManager/types";
import {
  blankDiscoveryRequestDraft,
  blankNoViewConstraintsDraft,
} from "../src/client/ScheduledOptionsManager";
import { ScheduledOptionsRunForm } from "../src/client/options/ScheduledOptionsRunForm";
import { manualScreenDeliveryEnrichment } from "../src/agents/routes/etradeBrokerScreen";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(join(here, "..", rel), "utf8").replace(/\r\n/g, "\n");

/* ------------------------------------------------------------------ */
/* 1. Stock screen request: the delivery envelope                      */
/* ------------------------------------------------------------------ */

describe("parseStockScreenRequest delivery envelope (#2545)", () => {
  it("splits the schedule delivery fields + PDF flag out of the engine filter", () => {
    const parsed = parseStockScreenRequest({
      universe: "NASDAQ100",
      limit: 25,
      pushToSlack: true,
      slackChannel: "#trading-desk",
      emailTo: "trader@firm.com",
      webhookUrl: "https://api.firm.com/webhooks/screener",
      generatePdf: false,
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.pushToSlack).toBe(true);
    expect(parsed.value.slackChannel).toBe("#trading-desk");
    expect(parsed.value.emailTo).toBe("trader@firm.com");
    expect(parsed.value.webhookUrl).toBe("https://api.firm.com/webhooks/screener");
    expect(parsed.value.generatePdf).toBe(false);
    // The engine filter carries screening criteria only.
    expect(parsed.value.filters).toEqual({ limit: 25 });
  });

  it("a legacy body without delivery fields parses to the legacy shape", () => {
    const parsed = parseStockScreenRequest({ universe: "TECH", limit: 10 });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.pushToSlack).toBeUndefined();
    expect(parsed.value.slackChannel).toBeUndefined();
    expect(parsed.value.webhookUrl).toBeUndefined();
    expect(parsed.value.generatePdf).toBeUndefined();
    expect(parsed.value.emailTo).toBeUndefined();
  });
});

/* ------------------------------------------------------------------ */
/* 2. Bridge outcome: delivery carriage                                */
/* ------------------------------------------------------------------ */

const allConfigured: ScreenerFollowupConfig = {
  enabled: true,
  reportEnabled: true,
  channels: {
    slack: { configured: true },
    email: { configured: true },
    webhook: { configured: true },
  },
  emailAllowlist: [],
  emailAllowlistExplicit: false,
};

describe("screenerOutcomeFromRunResult delivery carriage (#2545)", () => {
  it("carries slackChannel / webhookUrl / deliveryChannels from the enriched run result", () => {
    const outcome = screenerOutcomeFromRunResult("stock", {
      success: true,
      universe: "NASDAQ100",
      pdfKey: "k1",
      emailTo: "trader@firm.com",
      slackChannel: "#trading-desk",
      webhookUrl: "https://api.firm.com/webhooks/screener",
      deliveryChannels: ["slack", "email"],
    });
    expect(outcome.slackChannel).toBe("#trading-desk");
    expect(outcome.webhookUrl).toBe("https://api.firm.com/webhooks/screener");
    expect(outcome.deliveryChannels).toEqual(["slack", "email"]);
    // The planner honors the run's own allowlist over env config.
    expect(plannedDeliveryChannels(outcome, allConfigured)).toEqual(["slack", "email"]);
  });

  it("generatePdf:false drops report artifacts from the delivery projection only", () => {
    const outcome = screenerOutcomeFromRunResult("stock", {
      success: true,
      universe: "NASDAQ100",
      pdfKey: "k1",
      pdfStatus: "generated",
      xlsxKey: "x1",
      xlsxStatus: "generated",
      csvKey: "c1",
      csvStatus: "generated",
      generatePdf: false,
    });
    expect(outcome.pdfKeys).toEqual([]);
    expect(outcome.pdfStatus).toBe("skipped");
    expect(outcome.xlsxKey).toBeUndefined();
    expect(outcome.csvKey).toBeUndefined();
    expect(outcome.reportUrl).toBeUndefined();
  });

  it("without generatePdf the artifacts ride as before", () => {
    const outcome = screenerOutcomeFromRunResult("stock", {
      success: true,
      universe: "NASDAQ100",
      pdfKey: "k1",
      pdfStatus: "generated",
    });
    expect(outcome.pdfKeys).toEqual(["k1"]);
    expect(outcome.pdfStatus).toBe("generated");
  });
});

/* ------------------------------------------------------------------ */
/* 2b. Route enrichment: the selection stamped onto the run result     */
/* ------------------------------------------------------------------ */

describe("manualScreenDeliveryEnrichment (#2545)", () => {
  it("stamps overrides + the explicit-selection allowlist onto the run result", () => {
    expect(
      manualScreenDeliveryEnrichment({
        emailTo: " trader@firm.com ",
        pushToSlack: true,
        slackChannel: "#trading-desk",
        webhookUrl: "https://api.firm.com/webhooks/screener",
        generatePdf: false,
      }),
    ).toEqual({
      emailTo: "trader@firm.com",
      slackChannel: "#trading-desk",
      webhookUrl: "https://api.firm.com/webhooks/screener",
      generatePdf: false,
      deliveryChannels: ["slack", "email", "webhook"],
    });
  });

  it("pushToSlack:false yields an allowlist without slack and drops the channel", () => {
    expect(
      manualScreenDeliveryEnrichment({ pushToSlack: false, slackChannel: "#trading-desk" }),
    ).toEqual({ deliveryChannels: [] });
  });

  it("no selection (or an email-only legacy caller) stamps no allowlist", () => {
    expect(manualScreenDeliveryEnrichment(undefined)).toEqual({});
    expect(manualScreenDeliveryEnrichment({ emailTo: "trader@firm.com" })).toEqual({
      emailTo: "trader@firm.com",
    });
  });
});

/* ------------------------------------------------------------------ */
/* 3. Stocks panel request body                                        */
/* ------------------------------------------------------------------ */

describe("buildStockRunRequestBody (#2545)", () => {
  it("rides the delivery envelope on the run request, blanks omitted", () => {
    const body = buildStockRunRequestBody(
      { universe: "NASDAQ100", limit: 100 },
      {
        pushToSlack: true,
        slackChannel: "#trading-desk",
        emailTo: "  trader@firm.com ",
        webhookUrl: "",
        generatePdf: true,
      },
    );
    expect(body).toEqual({
      universe: "NASDAQ100",
      limit: 100,
      pushToSlack: true,
      slackChannel: "#trading-desk",
      emailTo: "trader@firm.com",
      generatePdf: true,
    });
  });

  it("slackChannel is omitted when Slack push is off, even with a channel typed", () => {
    const body = buildStockRunRequestBody(
      { universe: "TECH" },
      { pushToSlack: false, slackChannel: "#trading-desk", emailTo: "", webhookUrl: "", generatePdf: false },
    );
    expect(body).toEqual({ universe: "TECH", pushToSlack: false, generatePdf: false });
  });
});

/* ------------------------------------------------------------------ */
/* 4. Options one-shot form: the scheduled parameter set               */
/* ------------------------------------------------------------------ */

/** The one-shot form's default state — the production "Options
 *  Market Screen" job's parameters (NASDAQ100 / 100 / bullish /
 *  balanced, Slack push on). */
export function scheduledOptionsFormState(environment = "PROD"): ScheduleFormState {
  return {
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
    cronExpression: "",
    delaySeconds: 0,
    scheduledDate: "",
    thesis: "bullish",
    riskProfile: "balanced",
    pushToSlack: true,
    slackChannel: "",
    emailTo: "",
    webhookUrl: "",
    discoveryRequests: [blankDiscoveryRequestDraft()],
    discoveryInputModel: "saved-request",
    derivedSource: "symbols",
    derivedSymbolsText: "",
    derivedWatchlistName: "",
    derivedProfileId: "",
    noViewDraft: blankNoViewConstraintsDraft(),
    environment,
  };
}

describe("options one-shot payload (#2545)", () => {
  it("the default form state builds the scheduled job's parameter set", () => {
    const payload = buildOptionsRunNowPayload(scheduledOptionsFormState());
    // The wire shape (undefined keys drop in JSON; the builder's
    // slackChannel rides as "" when push is on and no channel is
    // named — the hero Run Now's exact body for the same state).
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      universe: "NASDAQ100",
      maxItems: 100,
      thesis: "bullish",
      riskProfile: "balanced",
      pushToSlack: true,
      slackChannel: "",
      environment: "PROD",
    });
    // Client-side mirror of the route's validation passes...
    expect(validateScheduleCriteriaClient("autonomousOptionsAnalysis", payload)).toBeNull();
    // ...and the trigger route's own shared builder accepts it.
    const { environment: _env, ...criteria } = payload;
    const built = buildSchedulePayload("autonomousOptionsAnalysis", criteria, {
      userLogin: "alice",
      environment: "PROD",
      trigger: "manual",
    }, { applyCreationDefaults: false });
    expect(built.ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* 5. Options one-shot form: render + submit                           */
/* ------------------------------------------------------------------ */

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ScheduledOptionsRunForm (#2545)", () => {
  let container: HTMLDivElement;
  let root: Root;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    fetchMock = vi.fn(async () => jsonResponse({ success: true, data: { withTrades: 3 } }));
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders the full scheduled parameter set and submits it to the schedule's trigger route", async () => {
    await act(async () => {
      root.render(<ScheduledOptionsRunForm activeEnv="PROD" userLogin="alice" />);
    });
    const text = container.textContent ?? "";
    // The scheduled job's parameter set, as form fields.
    expect(text).toContain("Target Universe");
    expect(text).toContain("Max items");
    expect(text).toContain("Market Thesis / Outlook");
    expect(text).toContain("Risk Profile");
    // Defaults are the production job's values.
    const universe = container.querySelector<HTMLSelectElement>("#scheduled-options-run-universe");
    expect(universe?.value).toBe("NASDAQ100");
    const maxItems = container.querySelector<HTMLInputElement>("#scheduled-options-run-max-items");
    expect(maxItems?.value).toBe("100");

    const form = container.querySelector("form");
    expect(form).not.toBeNull();
    await act(async () => {
      form!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    const triggerCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/api/schedules/trigger-options-analysis"),
    );
    expect(triggerCall).toBeDefined();
    const body = JSON.parse(String(triggerCall![1]?.body ?? "{}"));
    expect(body).toMatchObject({
      universe: "NASDAQ100",
      maxItems: 100,
      thesis: "bullish",
      riskProfile: "balanced",
      environment: "PROD",
    });
    expect(container.textContent).toContain("actionable setups");
  });
});

/* ------------------------------------------------------------------ */
/* 6. Source pins: both panels host the parity surfaces                */
/* ------------------------------------------------------------------ */

describe("panel wiring pins (#2545)", () => {
  it("the Stocks panel form carries the delivery fields and builds through the shared helper", () => {
    const hub = read("src/client/ScreenersHub.tsx");
    expect(hub).toContain("buildStockRunRequestBody");
    expect(hub).toContain("Email recipients");
    expect(hub).toContain("Webhook URL");
    expect(hub).toContain("PDF report");
  });

  it("Options Research hosts the one-shot scheduled-parameter form in its schedules mode", () => {
    const panel = read("src/client/options/OptionsResearchPanel.tsx");
    expect(panel).toContain("ScheduledOptionsRunForm");
  });

  it("the Schedules Trigger path is untouched: trigger routes still build via buildSchedulePayload", () => {
    const routes = read("src/agents/routes/schedules.ts");
    expect(routes).toContain('buildSchedulePayload("autonomousMarketScreen"');
    expect(routes).toContain('buildSchedulePayload("autonomousOptionsAnalysis"');
  });
});
