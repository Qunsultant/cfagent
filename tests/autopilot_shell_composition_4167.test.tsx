/** @vitest-environment jsdom */
/**
 * Issue #4167 — composition test, not a source-text pin.
 *
 * The #3050 PR2 pin (`tests/ux_autopilot_3050.test.ts`) asserted only
 * that AutopilotControlCenter's FILE contains one PageShell — isolation,
 * not composition — so the nested-shell defect shipped: the trading
 * hub wraps every sub-tab in its own PageShell AND the panels render
 * a second one inside it, giving the live page two h1 titles.
 *
 * This test mounts the composed hub per sub-tab and counts h1s in the
 * rendered DOM. The fix is host-applied context: the hub provides the
 * "tab" chrome mode for its sub-tab branches, so each inner PageShell
 * renders body-only and the page carries exactly one h1 — the hub
 * shell's route crumb.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ETradeTradingHub } from "../src/client/ETradeTradingHub";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

/** Permissive stub: empty shapes keep every panel mounting. */
function stubFetch() {
  return vi.fn(async (input: unknown, init?: any) => {
    const url = String(input);
    const method = (init?.method || "GET").toUpperCase();
    if (url.startsWith("/api/autopilot/jobs")) return jsonResponse({ jobs: [] });
    if (url === "/api/autopilot") {
      return jsonResponse({
        running: false,
        killSwitch: false,
        limits: {
          maxPositionPct: 10.0,
          cashReservePct: 5.0,
          ordersPerDay: 10,
          drawdownAlertPct: 20.0,
          universe: "Default large caps/ETFs",
          riskProfile: "moderate",
        },
        recentVerdicts: [],
      });
    }
    if (url.startsWith("/api/autopilot/")) return jsonResponse({});
    if (url.startsWith("/api/broker/orders")) return jsonResponse({ trades: [], orders: [] });
    if (url.startsWith("/api/audit")) return jsonResponse({ items: [], entries: [] });
    if (url.startsWith("/api/adaptation/candidates")) return jsonResponse({ candidates: [], evaluations: [], verdicts: [], approvals: [] });
    if (url.startsWith("/api/adaptation/weights")) return jsonResponse({ weights: {}, evaluation: null });
    if (url.startsWith("/api/reports")) return jsonResponse({ reports: [] });
    if (url.startsWith("/api/etrade/oauth/status")) return jsonResponse({ connected: false });
    if (method === "POST" || method === "PUT") return jsonResponse({ success: true });
    return jsonResponse({});
  });
}

async function flush(times = 6) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let container: HTMLDivElement;
let root: Root;

async function mountHub(subTab: string) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <ETradeTradingHub activeSubTab={subTab as any} user={{ login: "alice" }} />
      </ToastProvider>,
    );
  });
  await flush();
}

function h1s(): string[] {
  return [...container.querySelectorAll("h1")].map((h) => h.textContent?.trim() ?? "");
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("nextgen_autopilot_running", "false");
  vi.stubGlobal("fetch", stubFetch());
  Element.prototype.scrollIntoView = vi.fn() as any;
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

/** Sub-tabs whose panel renders its own PageShell, plus the expected hub h1 (route crumb). */
const SHELL_TABS: Array<[string, string]> = [
  ["autopilot", "Autopilot"],
  ["portfolio", "Portfolio"],
  ["reports", "Reports"],
  ["ledger", "Ledger"],
  ["goal-screen", "Goal Screen"],
  ["review", "Proposal Review"],
  ["track-record", "Track Record"],
  ["omnichannel", "Email & Slack"],
  ["voice", "Voice Desk"],
];

describe("trading hub shell composition (#4167)", () => {
  it("the autopilot page carries exactly one h1 — the hub shell, not the panel's", async () => {
    await mountHub("autopilot");
    expect(h1s()).toEqual(["Autopilot"]);
    // The panel still renders — only its chrome collapsed. The ribbon
    // is now a KpiRibbon in the template's kpiRibbon slot (#3140), so
    // its "Executive performance" h2 is gone; "Portfolio NAV" is the
    // ribbon's first KPI label.
    expect(container.textContent).toContain("Portfolio NAV");
    expect(container.textContent).toContain("Job outcomes");
  });

  it.each(SHELL_TABS)(
    "the %s sub-tab carries exactly one h1 (%s)",
    async (subTab, crumb) => {
      await mountHub(subTab);
      expect(h1s()).toEqual([crumb]);
    },
  );

  it("the order tab collapses to one h1 too (its panel shell is tab-hosted, only the risk tab was)", async () => {
    await mountHub("order");
    expect(h1s()).toEqual(["Order Ticket"]);
  });

  it("the options tab keeps its single h1 (no inner shell)", async () => {
    await mountHub("options");
    expect(h1s()).toEqual(["Options"]);
  });
});
