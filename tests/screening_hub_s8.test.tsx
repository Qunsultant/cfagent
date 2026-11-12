/** @vitest-environment jsdom */
/**
 * S8 (consolidation, umbrella #958) — one screening hub. Pins:
 *
 *  1. SCHEDULE-CAPTURE GOLDEN: the StrategyDiscoveryPanel "schedule
 *     this view" capture (issue #126) now builds its POST
 *     /api/schedules/create body through the S7 payload builders
 *     (buildDiscoveryCaptureSubmission) instead of hand-assembling it.
 *     For identical captured state the built body equals the legacy
 *     hand-assembled body (transcribed verbatim from the control
 *     tree's StrategyDiscoveryPanel) byte for byte — with ONE named
 *     correction: the payload now carries `trigger: "scheduled"`,
 *     the stamp the S7 builder applies to every schedule payload
 *     and the exact value the create route stamps server-side when
 *     it is absent (src/agents/routes/schedules.ts), so the stored
 *     schedule is unchanged.
 *  2. ONE CONSTRUCTION PATH (source pins): exactly two client files
 *     post schedule creates — the one schedule UI's section and the
 *     discovery capture — and both build their bodies through
 *     scheduledOptionsManager/payloadBuilders.
 *  3. HUB INVENTORY COVERAGE (source pins): the one screening hub
 *     (ScreenersHub) hosts the stock screener, the options research
 *     surface (discovery / contracts / custom / NLQ / LLM ideas via
 *     OptionsResearchHost), the Strategy/Symbol Scanner, and the IV
 *     history surface; the options asset class is available, not
 *     PLANNED. The Trading Hub's former screening subtabs
 *     (options / scanner / iv-history) are redirect notices that
 *     deep-link into the hub; its non-screening subtabs are intact.
 *  4. RENDER: the hub renders the folded surfaces under their tabs;
 *     the Trading Hub renders the redirect (with its deep-link
 *     button) for a folded subtab.
 *  5. NAV INTEGRITY: the top-nav ids scanner / screeners / options
 *     still exist and still map to hub subtabs — every entry lands
 *     on a live surface or the hub redirect, none is dead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  buildDiscoveryCaptureSubmission,
  validateScheduleCriteriaClient,
} from "../src/client/scheduledOptionsManager/payloadBuilders";
import { buildStrategyRequest } from "../src/client/options/serverDiscovery";
import { SCREENING_ASSET_CLASSES } from "../src/client/screeningAdapters";
import { ScreenersHub } from "../src/client/ScreenersHub";
import { OptionsHub } from "../src/client/OptionsHub";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string) =>
  readFileSync(join(here, "..", rel), "utf8").replace(/\r\n/g, "\n");

/* ------------------------------------------------------------------ */
/* 1. Schedule-capture golden                                          */
/* ------------------------------------------------------------------ */

/** A captured view, built by the same builder the panel uses. */
const capturedRequest = buildStrategyRequest({
  symbol: "nvda",
  currentPrice: 131.5,
  sentiment: "bullish",
  targetPrice: 150,
  budget: 25000,
  minRewardRisk: 1.5,
  expiration: { date: "2026-11-20", label: "Nov 20", dayLabel: "Fri", dte: 30 },
  bias: 50,
  dataMode: "live",
});

type Cadence = {
  scheduleType: "interval" | "cron" | "delayed" | "scheduled";
  intervalSeconds?: number;
  cron?: string;
  delaySeconds?: number;
  date?: string;
};

/** The legacy hand-assembled body, transcribed verbatim from the
 *  control tree's StrategyDiscoveryPanel.handleCreateDiscoverySchedule
 *  (base 786df559): same keys, same order, same conditionals. */
function legacyCaptureBody(c: Cadence): Record<string, any> | { error: string } {
  const body: Record<string, any> = {
    callback: "autonomousStrategyDiscovery",
    scheduleType: c.scheduleType,
    payload: { requests: [capturedRequest], environment: "PROD" },
  };
  if (c.scheduleType === "interval") {
    body.intervalSeconds = Number(c.intervalSeconds);
  } else if (c.scheduleType === "cron") {
    body.cron = (c.cron ?? "").trim();
  } else if (c.scheduleType === "delayed") {
    body.delayInSeconds = Number(c.delaySeconds);
  } else {
    if (!c.date) return { error: "Pick a date and time for the one-shot run." };
    body.date = new Date(c.date).toISOString();
  }
  return body;
}

function builderCaptureBody(c: Cadence) {
  return buildDiscoveryCaptureSubmission({
    request: capturedRequest,
    environment: "PROD",
    scheduleType: c.scheduleType,
    intervalSeconds: c.intervalSeconds,
    cronExpression: c.cron,
    delaySeconds: c.delaySeconds,
    scheduledDate: c.date,
  });
}

const CADENCES: Cadence[] = [
  { scheduleType: "interval", intervalSeconds: 3600 },
  { scheduleType: "cron", cron: "30 13 * * 1-5" },
  { scheduleType: "delayed", delaySeconds: 1800 },
  { scheduleType: "scheduled", date: "2026-10-26T09:30" },
];

describe("S8 schedule-capture golden (panel capture → S7 builders)", () => {
  it.each(CADENCES)(
    "built body equals the legacy hand-assembled body ($scheduleType), modulo the named trigger correction",
    (cadence) => {
      const built = builderCaptureBody(cadence);
      expect("requestBody" in built).toBe(true);
      if (!("requestBody" in built)) return;
      const legacy = legacyCaptureBody(cadence) as Record<string, any>;
      // The one named correction: the stamp the server applied anyway.
      expect(built.requestBody.payload.trigger).toBe("scheduled");
      const { trigger: _stamp, ...builtPayload } = built.requestBody.payload;
      expect(JSON.stringify({ ...built.requestBody, payload: builtPayload })).toBe(
        JSON.stringify(legacy),
      );
    },
  );

  it("the built payload passes the S1 client-side validation", () => {
    const built = builderCaptureBody(CADENCES[0]);
    if (!("requestBody" in built)) throw new Error("expected a requestBody");
    expect(
      validateScheduleCriteriaClient("autonomousStrategyDiscovery", built.requestBody.payload),
    ).toBeNull();
  });

  it("a one-shot capture without a date fails with the legacy message", () => {
    const built = builderCaptureBody({ scheduleType: "scheduled", date: "" });
    expect(built).toEqual({ error: "Pick a date and time for the one-shot run." });
    expect(legacyCaptureBody({ scheduleType: "scheduled", date: "" })).toEqual({
      error: "Pick a date and time for the one-shot run.",
    });
  });
});

/* ------------------------------------------------------------------ */
/* 2. One construction path for schedule creates                       */
/* ------------------------------------------------------------------ */

describe("S8 one construction path (source pins)", () => {
  it("the discovery panel builds its capture body through the S7 builders", () => {
    const panel = read("src/client/options/StrategyDiscoveryPanel.tsx");
    expect(panel).toContain("buildDiscoveryCaptureSubmission");
    expect(panel).toContain("scheduledOptionsManager/payloadBuilders");
    // The hand-assembled body is gone.
    expect(panel).not.toContain('callback: "autonomousStrategyDiscovery"');
    expect(panel).not.toContain("payload: { requests: [capturedRequest]");
  });

  it("exactly two client files post schedule creates, both via the builders", () => {
    // #3123: the create POST itself lives in the one client module
    // (jobsApi's createSchedule); the two panels post through it or
    // — StrategyDiscoveryPanel, outside the #3123 T2 migration —
    // through the direct fetch the slice did not move. Either way
    // both files build through the S7 payload builders.
    const posters: Array<[string, string, string]> = [
      ["src/client/ScheduledOptionsManager.tsx", "buildScheduleSubmission", "createSchedule("],
      ["src/client/options/StrategyDiscoveryPanel.tsx", "buildDiscoveryCaptureSubmission", 'fetch("/api/schedules/create"'],
    ];
    for (const [rel, builder, transport] of posters) {
      const src = read(rel);
      expect(src).toContain(transport);
      expect(src).toContain(builder);
      expect(src).toContain("scheduledOptionsManager/payloadBuilders");
    }
  });
});

/* ------------------------------------------------------------------ */
/* 3. Hub inventory coverage                                           */
/* ------------------------------------------------------------------ */

describe("S8 hub inventory coverage (source pins)", () => {
  const hub = read("src/client/ScreenersHub.tsx");
  const optionsHub = read("src/client/OptionsHub.tsx");
  const tradingHub = read("src/client/ETradeTradingHub.tsx");

  it("the options asset class is available in the hub — no longer PLANNED", () => {
    expect(SCREENING_ASSET_CLASSES.find((a) => a.id === "options")?.available).toBe(true);
    expect(SCREENING_ASSET_CLASSES.filter((a) => !a.available).map((a) => a.id)).toEqual([
      "forex",
      "futures",
      "commodities",
      "bonds",
    ]);
  });

  it("the options copy hub hosts the options research surface, the scanner, and IV history (#2954)", () => {
    expect(optionsHub).toContain("<OptionsResearchPanel");
    expect(optionsHub).toContain("<ScannerPanel");
    expect(optionsHub).toContain("<IvHistoryPanel");
    // The pre-S8 options redirect notice is gone — options is home here.
    expect(optionsHub).not.toContain("Options Capabilities Moved to Auto Options Research");
    // And the old hub no longer hosts them: they moved to the copy hub.
    expect(hub).not.toContain("<OptionsResearchHost");
    expect(hub).not.toContain("<ScannerPanel");
    expect(hub).not.toContain("<IvHistoryPanel");
  });

  it("the options copy hub threads the trade-preview and prompt handoffs into the folded panels (#2954)", () => {
    expect(optionsHub).toContain("onPreviewTrade={onPreviewTrade}");
    expect(optionsHub).toContain("onSendPrompt={onSendPrompt}");
    // The Trading Hub threads its order-ticket handler into the hub.
    expect(tradingHub).toContain("onPreviewTrade={handleTradeOrder}");
    // The old hub no longer threads prompts: its panels don't take them.
    expect(hub).not.toContain("onSendPrompt={onSendPrompt}");
  });

  // C2 (#1246) supersedes the S8 redirect pins below: the acceptance
  // criteria retire the "Screening Moved" notices — the Trading Hub's
  // screening subtabs now render the hub itself on the equivalent
  // tab, and Reports is hosted BY the hub, not mounted here.
  // Issue #3121 S2: schedules left the hub — it renders from the
  // shell (Chat.tsx TAB_CONTENT → SchedulesHome).
  it("the Trading Hub's screening subtabs render the hub directly, not second surfaces", () => {
    expect(tradingHub).not.toContain("<OptionsResearchPanel");
    expect(tradingHub).not.toContain("<ScannerPanel");
    expect(tradingHub).not.toContain("<IvHistoryPanel");
    expect(tradingHub).not.toContain("ScreeningMovedNotice");
    expect(tradingHub).not.toContain("Screening Moved to the Screeners Hub");
    // Issue #2954: options/scanner/iv-history render the Options copy
    // hub. Issue #2970: reports renders its panel directly now (the
    // hub still hosts it until #2971).
    expect(tradingHub).toContain('renderOptionsHub()');
    expect(tradingHub).toContain('renderOptionsHub("strategy-scanner")');
    expect(tradingHub).toContain('renderOptionsHub("iv-history")');
    expect(tradingHub).toContain("<ReportsPanel");
    expect(tradingHub).not.toContain("<SchedulesPanel");
    const chat = read("src/client/Chat.tsx");
    expect(chat).toContain('import { SchedulesHome } from "./SchedulesHome";');
  });

  it("the Trading Hub's non-screening subtabs are intact", () => {
    for (const subtab of ["autopilot", "order", "portfolio", "ledger", "reports", "omnichannel", "voice"]) {
      expect(tradingHub).toContain(`effectiveSubTab === "${subtab}"`);
    }
    expect(tradingHub).not.toContain('effectiveSubTab === "schedules"');
    expect(tradingHub).toContain("<AutopilotControlCenter");
    // Issue #2970: Reports renders its panel directly now (see the
    // pin above) — the Trading Hub mounts it itself. Issue #3121 S2:
    // Schedules renders from the shell, not the hub.
    expect(tradingHub).toContain("<ReportsPanel");
    expect(tradingHub).not.toContain("<SchedulesPanel");
  });
});

/* ------------------------------------------------------------------ */
/* 4. Render pins                                                      */
/* ------------------------------------------------------------------ */

describe("S8 render pins", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) })),
    );
    // jsdom has no layout engine; the discovery panel scrolls its ATM
    // tick into view on a timer.
    Element.prototype.scrollIntoView = vi.fn() as any;
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    vi.unstubAllGlobals();
  });

  it("the options copy hub renders the options research surface under its strategy-discovery tab (#2954)", async () => {
    await act(async () => {
      root.render(<ToastProvider><OptionsHub activeEnv="PROD" userLogin="tester" initialTab="strategy-discovery" /></ToastProvider>);
    });
    expect(container.textContent).toContain("Strategy Discovery & Payoff Analyzer");
    expect(container.textContent).toContain("AI Strategy Ideas & Exporter");
  });

  it("the options copy hub renders IV history under its iv-history tab (#2954)", async () => {
    await act(async () => {
      root.render(<ToastProvider><OptionsHub activeEnv="PROD" userLogin="tester" initialTab="iv-history" /></ToastProvider>);
    });
    expect(container.textContent).toContain("IV History");
  });

  // C2 (#1246): the folded subtabs render the hub itself — the S8
  // redirect render pins are superseded by these.
  it("the Trading Hub renders the hub itself for the folded options subtab", async () => {
    await act(async () => {
      root.render(<ToastProvider><ETradeTradingHub activeSubTab="options" user={{ login: "tester" }} /></ToastProvider>);
    });
    expect(container.textContent).not.toContain("Screening Moved to the Screeners Hub");
    expect(container.textContent).toContain("Strategy Discovery & Payoff Analyzer");
  });

  it("the Trading Hub renders the hub itself for the folded scanner subtab", async () => {
    await act(async () => {
      root.render(<ToastProvider><ETradeTradingHub activeSubTab="scanner" user={{ login: "tester" }} /></ToastProvider>);
    });
    expect(container.textContent).not.toContain("Screening Moved to the Screeners Hub");
    expect(container.textContent).toContain("Strategy/Symbol Scanner");
  });
});

/* ------------------------------------------------------------------ */
/* 5. Nav integrity                                                    */
/* ------------------------------------------------------------------ */

describe("S8 nav integrity", () => {
  it("the top nav has ONE screening entry; legacy ids still map to hub subtabs", () => {
    // C2 (#1246) supersedes the S8 pin that required separate nav
    // entries for scanner/screeners/options: the nav carries exactly
    // one screening entry now, and the legacy tab ids survive only as
    // deep links in the tab→subtab mapping.
    // S1 (#1804/#1808): nav entries derive from the central route table,
    // now externalized in nav-config.json (issue #2977).
    const data = JSON.parse(read("src/client/nav-config.json")) as {
      routes: { id: string; navEntry?: unknown }[];
    };
    const byId = new Map(data.routes.map((r) => [r.id, r]));
    expect(byId.has("screeners")).toBe(true);
    for (const id of ["scanner", "options", "reports", "schedules"]) {
      expect(byId.has(id)).toBe(true);
      expect(byId.get(id)?.navEntry).toBeUndefined();
    }
    const types = read("src/client/chat/types.ts");
    expect(types).toContain('case "scanner":');
    expect(types).toContain('case "screeners":');
    expect(types).toContain('case "options":');
  });
});
