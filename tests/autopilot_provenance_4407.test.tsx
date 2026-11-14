/** @vitest-environment jsdom */
/**
 * Autopilot data provenance (#4407): no fake/generated data anywhere on
 * the page. The hardcoded chart (CHART_TF_DATA), the `|| 14` verdict
 * fallback and the hardcoded "100% W3C DID Signed" claim are gone;
 * every section names its source; every table shows one canonical
 * timestamp format (date + time).
 *
 * Harness follows tests/autopilot_policy_decisions.test.tsx and
 * tests/autopilot_control_center_state.test.tsx: react-dom/client in
 * jsdom, direct component renders, stubbed fetch.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  AutopilotControlCenter,
  formatAutopilotTimestamp,
  mapPolicyVerdictToRow,
} from "../src/client/components/AutopilotControlCenter";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const DEFAULT_LIMITS = {
  maxPositionPct: 10.0,
  cashReservePct: 5.0,
  ordersPerDay: 10,
  drawdownAlertPct: 20.0,
  universe: "Default large caps/ETFs",
  riskProfile: "moderate",
};

const VERDICT_ISO = "2026-10-21T13:45:00.000Z";
const EVENT_ISO = "2026-10-21T14:05:00.000Z";
const TRADE_ISO = "2026-10-21T14:10:00.000Z";
const JOB_ISO = "2026-10-21T14:20:00.000Z";

/** Canonical date+time for one ISO instant, computed the same way the page must render it. */
function canonical(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { hour12: true });
}

const verdictsPayload = {
  running: false,
  killSwitch: false,
  killSwitchReason: null,
  ordersToday: 0,
  recentVerdicts: [
    {
      id: "v-1",
      symbol: "TSLA",
      action: "buy",
      quantity: 40,
      notional: 9600,
      mode: "live",
      dry_run: 0,
      passed: 0,
      execution_allowed: 0,
      requires_approval: 0,
      binding_rule: "maxPositionPct",
      detail: "Position would exceed 10% of NAV",
      signature: "sig_ed25519_x",
      created_at: VERDICT_ISO,
    },
    {
      id: "v-2",
      symbol: "AAPL",
      action: "buy",
      quantity: 10,
      notional: 2305,
      mode: "live",
      dry_run: 1,
      passed: 1,
      execution_allowed: 1,
      requires_approval: 0,
      binding_rule: null,
      detail: "Within all limits",
      signature: null,
      created_at: "not-a-date",
    },
  ],
};

const auditPayload = {
  events: [
    {
      id: "ev-1",
      type: "alpaca.order_placed",
      agent: "trading",
      payload: {
        symbol: "AAPL",
        side: "BUY",
        qty: 10,
        status: "placed",
        executionId: "alpaca-9f31",
      },
      created_at: EVENT_ISO,
    },
  ],
};

const ordersPayload = {
  trades: [
    {
      id: "tr-1",
      status: "executed",
      symbol: "MSFT",
      action: "BUY",
      quantity: 5,
      price: 400.5,
      orderType: "MARKET",
      previewNotes: "",
      proposerDid: "did:example:trading",
      proofSignature: "",
      orderRef: "alp-77",
      createdAt: TRADE_ISO,
    },
  ],
};

const jobsPayload = {
  jobs: [
    {
      id: "job-1",
      kind: "stock",
      trigger: "scheduled",
      status: "completed",
      scanned: 100,
      matched: 5,
      codedError: null,
      reportUrl: null,
      pdfKey: null,
      xlsxKey: null,
      csvKey: null,
      deliveryStates: {},
      origin: "research-tick",
      createdAt: JOB_ISO,
    },
  ],
};

function stubFetch(verdicts: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = new URL(
        typeof input === "string" ? input : (input as { url: string }).url,
        "http://localhost",
      );
      if (url.pathname === "/api/autopilot") {
        return new Response(
          JSON.stringify({
            running: false,
            killSwitch: false,
            limits: DEFAULT_LIMITS,
            recentVerdicts: verdicts,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      if (url.pathname === "/api/audit") {
        return new Response(JSON.stringify(auditPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/broker/orders") {
        return new Response(JSON.stringify(ordersPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.pathname === "/api/autopilot/jobs") {
        return new Response(JSON.stringify(jobsPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      throw new Error(`offline in test: ${url.pathname}`);
    }),
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function renderCenter(verdicts: unknown, view = "performance") {
  // #4409: each section lives on its own sub-tab — a test that needs
  // a table or source outside the default Performance tab mounts that
  // view. Re-mounting unmounts the previous root first.
  if (root) {
    await act(async () => {
      root!.unmount();
    });
    root = null;
  }
  container?.remove();
  container = null;
  stubFetch(verdicts);
  window.history.pushState(null, "", `/?tab=autopilot&view=${view}`);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <ToastProvider>
        <AutopilotControlCenter />
      </ToastProvider>,
    );
  });
  // Flush the mount effects' fetch promises.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  await act(async () => {});
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  root = null;
  container?.remove();
  container = null;
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Autopilot provenance — no fake/generated data (#4407)", () => {
  it("renders no hardcoded chart values, claims, or fallback counts", async () => {
    await renderCenter(verdictsPayload.recentVerdicts);
    const text = container!.textContent ?? "";
    expect(text).not.toContain("$142,850");
    expect(text).not.toContain("20.39");
    expect(text).not.toContain("8.40%");
    expect(text).not.toContain("14 Verdicts");
    expect(text).not.toContain("100% W3C DID Signed");
    expect(text).not.toContain("Real-time mark-to-market");
    expect(text).not.toContain("not-a-date");
  });

  it("renders the chart section as an empty state, not a generated curve", async () => {
    await renderCenter(verdictsPayload.recentVerdicts);
    const text = container!.textContent ?? "";
    expect(text).toContain("Strategy Equity vs S&P 500 Benchmark");
    expect(text).toContain("No performance history recorded");
  });

  it("shows no live NAV where no live source exists, and the real verdict count with a computed signed share", async () => {
    await renderCenter(verdictsPayload.recentVerdicts);
    const text = container!.textContent ?? "";
    expect(text).toContain("No live NAV source");
    expect(text).toContain("2 Verdicts");
    expect(text).toContain("1 of 2 DID-signed");
  });

  it("shows 0 verdicts — never the 14 fallback — when none are recorded", async () => {
    await renderCenter([]);
    const text = container!.textContent ?? "";
    expect(text).toContain("0 Verdicts");
    expect(text).not.toContain("14 Verdicts");
    expect(text).toContain("No verdicts recorded");
  });

  it("names every section's source on the page", async () => {
    // #4409: each section names its source on its own sub-tab.
    await renderCenter(verdictsPayload.recentVerdicts, "job-outcomes");
    expect(container!.textContent ?? "").toContain("mas_job_outcomes");
    await renderCenter(verdictsPayload.recentVerdicts, "actions");
    const actionsText = container!.textContent ?? "";
    expect(actionsText).toContain("mas_events");
    expect(actionsText).toContain("mas_trades");
    await renderCenter(verdictsPayload.recentVerdicts, "policy-decisions");
    const verdictsText = container!.textContent ?? "";
    expect(verdictsText).toContain("mas_policy_verdicts");
    expect(verdictsText).toContain("GET /api/autopilot");
  });

  it("shows one canonical date+time format on every table", async () => {
    // #4409: one table per sub-tab, so each format is checked on its own tab.
    await renderCenter(verdictsPayload.recentVerdicts, "policy-decisions");
    // Verdict row (ISO created_at) renders date + time.
    expect(container!.textContent ?? "").toContain(canonical(VERDICT_ISO));
    await renderCenter(verdictsPayload.recentVerdicts, "actions");
    const actionsText = container!.textContent ?? "";
    // Audit-event action row renders date + time, not time-only.
    expect(actionsText).toContain(canonical(EVENT_ISO));
    // Trade action row renders date + time, not time-only.
    expect(actionsText).toContain(canonical(TRADE_ISO));
    await renderCenter(verdictsPayload.recentVerdicts, "job-outcomes");
    // Job outcome row renders the same canonical format.
    expect(container!.textContent ?? "").toContain(canonical(JOB_ISO));
  });

  it("mapPolicyVerdictToRow never renders a raw stored timestamp", () => {
    const row = mapPolicyVerdictToRow({
      id: "v-x",
      symbol: "AAPL",
      action: "buy",
      quantity: 1,
      created_at: "not-a-date",
    });
    expect(row.timeLabel).toBe("—");
    const good = mapPolicyVerdictToRow({
      id: "v-y",
      symbol: "AAPL",
      action: "buy",
      quantity: 1,
      created_at: VERDICT_ISO,
    });
    expect(good.timeLabel).toBe(canonical(VERDICT_ISO));
  });

  it("formatAutopilotTimestamp is the one canonical formatter", () => {
    expect(formatAutopilotTimestamp(VERDICT_ISO)).toBe(canonical(VERDICT_ISO));
    expect(formatAutopilotTimestamp("not-a-date")).toBe("—");
    expect(formatAutopilotTimestamp(null)).toBe("—");
    expect(formatAutopilotTimestamp(undefined)).toBe("—");
  });
});
