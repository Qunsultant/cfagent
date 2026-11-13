/** @vitest-environment jsdom */
/**
 * Issue #3139 — composition test, not a source-text pin.
 *
 * The #3138 per-file pin asserted only that OrderTicketPanel's FILE
 * contains "<PageTemplate" — isolation, not composition — so the live
 * order page shipped with TWO "Order Ticket" h1s (hub shell crumb +
 * template title) because the hub provided no PageChromeContext.
 * #4167 fixed the host (the hub now provides "tab" context), and
 * this test guards the options page against the same doubling: it
 * mounts the composed options page (hub shell + OptionsHub) and
 * counts h1s in the rendered DOM.
 *
 * Under "tab" context the template collapses to body-only: the hub
 * shell's "Options" crumb stays the only h1, and the template's own
 * scopeNote is inert (not rendered). The tab row and panels must
 * still render — the template must not swallow the workspace.
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

describe("options page template composition (#3139)", () => {
  it("the composed options page carries exactly one h1 — the hub shell, not the template's", async () => {
    await mountHub("options");
    expect(h1s()).toEqual(["Options"]);
  });

  it("the template's scopeNote is inert under tab context (no duplicate description)", async () => {
    await mountHub("options");
    // The hub shell's own scope note is the route description; the
    // template's drafted scopeNote must not render a second one.
    expect(container.textContent).not.toContain("nothing is submitted");
  });

  it("the template does not swallow the workspace: tab row and panels render", async () => {
    await mountHub("options");
    expect(container.textContent).toContain("Strategy Scanner");
    expect(container.textContent).toContain("Options Runs");
    expect(container.textContent).toContain("Strategy Discovery");
  });
});
