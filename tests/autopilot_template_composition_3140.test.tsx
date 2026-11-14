/** @vitest-environment jsdom */
/**
 * Issue #3140 — composition test, not a source-text pin.
 *
 * Round 1: AutopilotControlCenter swaps its own PageShell for
 * PageTemplate (chrome only). Round 2 (this slice): the interior
 * slot rewire — the executive ribbon moves into the template's
 * kpiRibbon slot as a KpiRibbon, and the chart, limits and
 * verdict/policy cards become DetailCards with CardHeaders. Zero
 * behavior change: same data, same live sources, same interactions.
 *
 * Under the hub's "tab" context the template collapses to body-only,
 * so the hub shell's "Autopilot" crumb stays the only h1 — this test
 * guards the migration against the #3138 doubling defect (two h1s)
 * and against the template swallowing the workspace.
 *
 * The slot assertions are the red drivers for round 2: the ribbon
 * renders as .ui-stat-grid in the template Stack ahead of the
 * workspace sections (no "Executive performance" h2 anymore — the
 * slot carries no title), and the five cards render as elevated
 * DetailCards (.ui-card.elevated) with CardHeaders carrying their
 * source lines. The h1 / scopeNote / section assertions are
 * regression guards: they pass before and after, and fail if the
 * migration doubles the header or drops a section.
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

function h2s(): string[] {
  return [...container.querySelectorAll("h2")].map((h) => h.textContent?.trim() ?? "");
}

/** The <section> for a titled workspace section. */
function sectionFor(title: string): HTMLElement {
  const h2 = [...container.querySelectorAll("h2")].find(
    (h) => h.textContent?.trim() === title,
  );
  expect(h2).toBeDefined();
  const section = h2!.closest("section");
  expect(section).not.toBeNull();
  return section as HTMLElement;
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

describe("autopilot page template composition (#3140)", () => {
  it("the composed autopilot page carries exactly one h1 — the hub shell, not the template's", async () => {
    await mountHub("autopilot");
    expect(h1s()).toEqual(["Autopilot"]);
  });

  it("the template's scopeNote is inert under tab context (no duplicate description)", async () => {
    await mountHub("autopilot");
    // The hub shell's own scope note is the route description; the
    // template's drafted scopeNote must not render a second one.
    expect(container.textContent).not.toContain(
      "Autonomous execution within your written policy",
    );
  });

  it("the template Stack holds the ribbon slot first, then the six workspace sections", async () => {
    await mountHub("autopilot");
    // PageTemplate wraps slots + children in <Stack gap="4">; the
    // kpiRibbon slot renders ahead of the workspace sections in the
    // same Stack. This is the round-2 red driver.
    const ribbon = container.querySelector(".ui-stat-grid");
    expect(ribbon).not.toBeNull();
    const stack = ribbon!.parentElement;
    expect(stack?.className).toContain("ui-stack");
    expect(stack?.parentElement?.className).toContain(
      "ui-page-shell-sections",
    );
    // Ribbon first, then the workspace sections, in DOM order. The
    // sections are not all direct children of the Stack — Status and
    // Live policy limits sit inside the two-column Grid, and Job
    // outcomes sits inside its ui-anchor div — so the order check
    // walks the Stack's descendants in document order.
    const ordered = [...stack!.querySelectorAll(".ui-stat-grid, section")];
    const at = (el: Element) => ordered.indexOf(el);
    const chart = sectionFor("Strategy Equity vs S&P 500 Benchmark");
    expect(at(chart)).toBeGreaterThan(at(ribbon as Element));
    expect(at(sectionFor("Live policy limits"))).toBeGreaterThan(at(ribbon as Element));
    expect(at(sectionFor("Job outcomes"))).toBeGreaterThan(at(ribbon as Element));
  });

  it("the executive ribbon renders in the kpiRibbon slot as a KpiRibbon", async () => {
    await mountHub("autopilot");
    const ribbon = container.querySelector(".ui-stat-grid");
    expect(ribbon).not.toBeNull();
    // The four KPI labels and values (stubbed state: no verdicts).
    expect(ribbon!.textContent).toContain("Portfolio NAV");
    expect(ribbon!.textContent).toContain("Drawdown vs Alert");
    expect(ribbon!.textContent).toContain("Cash Reserve Target");
    expect(ribbon!.textContent).toContain("Risk Policy Engine");
    expect(ribbon!.textContent).toContain("5.00%");
    expect(ribbon!.textContent).toContain("0 Verdicts");
    expect(ribbon!.textContent).toContain("No verdicts recorded");
    // The ribbon's source line travels with the slot (#4407).
    expect(ribbon!.parentElement?.textContent).toContain(
      "Source: GET /api/autopilot — verdict count from mas_policy_verdicts",
    );
    // The slot carries no title: the "Executive performance" h2 is gone.
    expect(h2s()).not.toContain("Executive performance");
  });

  it("all seven content blocks render: the ribbon slot plus six workspace sections", async () => {
    await mountHub("autopilot");
    expect(h2s()).toEqual([
      "Strategy Equity vs S&P 500 Benchmark",
      "Live policy limits",
      "Job outcomes",
      "Recent autonomous actions",
      "Policy decisions",
    ]);
    // The untitled Status section has no h2; its card content proves
    // it rendered (stubbed state: not running, no kill switch).
    expect(container.textContent).toContain("Paused");
    expect(container.textContent).toContain("No performance history recorded");
    // The seventh block is the ribbon slot, not a section.
    expect(container.querySelector(".ui-stat-grid")).not.toBeNull();
  });

  it("the chart card renders as a DetailCard (elevated surface, no hand-rolled card)", async () => {
    await mountHub("autopilot");
    const section = sectionFor("Strategy Equity vs S&P 500 Benchmark");
    const card = section.querySelector(".ui-card.elevated");
    expect(card).not.toBeNull();
    expect(card!.textContent).toContain("No performance history recorded");
    // The chart card's title lives in the PageSection above it, so its
    // CardHeader is empty here — the DetailCard doc's meta-only case.
    expect(card!.querySelector(".ui-card-header")).toBeNull();
  });

  it("the live policy limits card renders as a DetailCard with a CardHeader", async () => {
    await mountHub("autopilot");
    const section = sectionFor("Live policy limits");
    const card = section.querySelector(".ui-card.elevated");
    expect(card).not.toBeNull();
    const header = card!.querySelector(".ui-card-header");
    expect(header).not.toBeNull();
    // Source line in the header; Edit limits action in the header meta.
    expect(header!.textContent).toContain(
      "Source: GET /api/autopilot — OrchestratorAgent state",
    );
    expect(header!.textContent).toContain("Edit limits");
    expect(card!.textContent).toContain("Max position");
    expect(card!.textContent).toContain("10.00%");
  });

  it("the verdict and policy rows render as DetailCards with CardHeaders", async () => {
    await mountHub("autopilot");
    for (const [title, source] of [
      ["Job outcomes", "Source: GET /api/autopilot/jobs — mas_job_outcomes"],
      ["Recent autonomous actions", "Source: GET /api/audit (mas_events)"],
      ["Policy decisions", "Source: GET /api/autopilot — mas_policy_verdicts"],
    ] as const) {
      const section = sectionFor(title);
      const card = section.querySelector(".ui-card.elevated");
      expect(card).not.toBeNull();
      const header = card!.querySelector(".ui-card-header");
      expect(header).not.toBeNull();
      expect(header!.textContent).toContain(source);
    }
  });

  it("the template does not swallow the workspace: verdict and policy rows render", async () => {
    await mountHub("autopilot");
    expect(container.textContent).toContain("Job outcomes");
    expect(container.textContent).toContain("Policy decisions");
    expect(container.textContent).toContain("No verdicts recorded");
  });
});
