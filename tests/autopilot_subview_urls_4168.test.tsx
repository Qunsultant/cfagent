/** @vitest-environment jsdom */
/**
 * Issue #4168 — Autopilot sub-views have no URLs.
 *
 * Measured before writing: the Autopilot page has NO sub-views. There is
 * no view state in AutopilotControlCenter — its inner controls are filters
 * (`actionsFilter`, `chartTimeframe`) and always-rendered PageSections.
 * The one genuinely addressable target is the Job outcomes section
 * (the #3275 job-truth feed), so this slice registers exactly one:
 * `?tab=autopilot&view=job-outcomes`.
 *
 * `?tab=autopilot&orderTab=risk` is NOT a real autopilot address: nothing
 * on the page reads `orderTab`, and #3238's own pin documents it as the
 * foreign-param leak case. Autopilot does NOT own `orderTab` — the
 * canonical replacement for the #3275 link is `view=job-outcomes`.
 *
 * Pattern: #2784 (options research adopts `?research=` on mount + on
 * route changes and scrolls to the section); `view` is the shared
 * sub-view param, so no TAB_PARAM_OWNERS entry is needed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AutopilotControlCenter } from "../src/client/components/AutopilotControlCenter";
import { ToastProvider } from "../src/client/components/ui/Toast";
import {
  DEEP_LINK_OVERRIDES,
  deepLinkHref,
  deepLinkHrefForNavNode,
  SURFACE_TAB_CATALOG,
} from "../src/client/deepLinks";
import { buildSearchWithTab } from "../src/client/router";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}

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
    if (method === "POST" || method === "PUT") return jsonResponse({ success: true });
    return jsonResponse({});
  });
}

async function flush(times = 8) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

let container: HTMLDivElement;
let root: Root;

async function mountAutopilot(search: string) {
  window.history.pushState(null, "", `/${search}`);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ToastProvider>
        <AutopilotControlCenter user={{ login: "alice" }} />
      </ToastProvider>,
    );
  });
  await flush();
}

beforeEach(() => {
  vi.stubGlobal("fetch", stubFetch());
  localStorage.clear();
  localStorage.setItem("nextgen_autopilot_running", "false");
  (Element.prototype as any).scrollIntoView = vi.fn();
});

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("autopilot sub-view URLs (#4168)", () => {
  it("deep link autopilot:job-outcomes resolves to ?tab=autopilot&view=job-outcomes", () => {
    expect(DEEP_LINK_OVERRIDES["autopilot:job-outcomes"]).toEqual({
      tab: "autopilot",
      view: "job-outcomes",
    });
    expect(
      deepLinkHref(DEEP_LINK_OVERRIDES["autopilot:job-outcomes"] as any),
    ).toBe("?tab=autopilot&view=job-outcomes");
    expect(deepLinkHrefForNavNode(null, "autopilot")).toBe("?tab=autopilot");
  });

  it("the surface catalog carries the autopilot job-outcomes entry", () => {
    const entry = SURFACE_TAB_CATALOG.find(
      (e) => e.surface === "autopilot" && e.value === "job-outcomes",
    );
    expect(entry).toBeDefined();
    expect(entry?.page).toBe("autopilot");
    expect(entry?.param).toBe("view");
    expect(entry?.href).toBe("?tab=autopilot&view=job-outcomes");
  });

  it("router: orderTab is still stripped on the way to autopilot; view survives", () => {
    // The #3275 link's param was foreign on autopilot — #3238 strips it,
    // and this slice does NOT make autopilot an orderTab owner.
    expect(buildSearchWithTab("?tab=order&orderTab=risk", "autopilot")).toBe(
      "?tab=autopilot",
    );
    expect(
      buildSearchWithTab("?tab=portfolio&view=job-outcomes", "autopilot"),
    ).toBe("?tab=autopilot&view=job-outcomes");
  });

  it("mounting with ?tab=autopilot&view=job-outcomes scrolls to the Job outcomes section", async () => {
    await mountAutopilot("?tab=autopilot&view=job-outcomes");
    const section = document.getElementById("autopilot-job-outcomes");
    expect(section).not.toBeNull();
    expect(section?.textContent).toContain("Job outcomes");
    expect((Element.prototype as any).scrollIntoView).toHaveBeenCalled();
  });

  it("mounting without a view does not scroll", async () => {
    await mountAutopilot("?tab=autopilot");
    expect((Element.prototype as any).scrollIntoView).not.toHaveBeenCalled();
  });

  it("navigating to ?tab=autopilot&view=job-outcomes while mounted scrolls too", async () => {
    await mountAutopilot("?tab=autopilot");
    expect((Element.prototype as any).scrollIntoView).not.toHaveBeenCalled();
    await act(async () => {
      window.history.pushState(null, "", "/?tab=autopilot&view=job-outcomes");
      window.dispatchEvent(new Event("routechange"));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await flush();
    expect((Element.prototype as any).scrollIntoView).toHaveBeenCalled();
  });
});
