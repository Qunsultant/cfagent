/** @vitest-environment jsdom */
/**
 * Issue #4432 (S4c): the Stock Hub "Schedule this screen" bridge.
 *
 * Pins, mounting StockHub directly (harness follows
 * tests/paid_screen_client_3239.test.tsx):
 *  - the new-screen form shows "Schedule this screen"; opening it shows
 *    a confirm strip summarising the snapshot (universe, sector, max
 *    items, preset-or-custom, criteria count) before anything is created
 *  - confirming POSTs /api/schedules/create with the form's criteria
 *    (universe/sector/maxItems top-level, merged filter as `filters`)
 *    and shows the success notice with a "View in Schedules" action
 *  - universe All disables scheduling with a named hint (the route
 *    refuses ALL for scheduled screens)
 *  - an applied preset arms the schedule with presetId, not frozen
 *    filters; a manual criteria edit after Apply disarms it again
 *  - the create POST carries no broker/mode/provider claims — the
 *    route stamps the server-resolved tenant selections
 *
 * The preset arming itself is threaded through ScreenerPresetManager's
 * optional onApplyPresetIdentity (see tests/screener_preset_manager.test.tsx
 * for the manager-level pins); these tests pin the hub end of it.
 */
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { StockHub } from "../src/client/StockHub";
import {
  resetTenantProvidersStateForTest,
  setTenantProvidersStateForTest,
} from "../src/client/tenantProviders";
import type { ScreenerPreset } from "../src/client/ScreenerPresetManager";

let container: HTMLDivElement;
let root: Root;
const realFetch = globalThis.fetch;

const presetA: ScreenerPreset = {
  id: "p1",
  name: "RSI bounce",
  assetClass: "stocks",
  criteria: { minRsi: 30, maxRsi: 70 },
  createdAt: "2026-11-16T09:00:00Z",
  updatedAt: "2026-11-16T09:00:00Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let createBodies: Array<Record<string, unknown>>;

function installFetch() {
  createBodies = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/api/payments/agentic/commercial/pricing")) {
      return Response.json({ monetizationEnabled: false });
    }
    if (url.includes("/offer/compare")) {
      return Response.json({});
    }
    if (url.includes("/api/screener/latest")) {
      return Response.json({ runs: [] });
    }
    if (url === "/api/screener/presets" && method === "GET") {
      return jsonResponse(200, {
        presets: [
          {
            id: presetA.id,
            name: presetA.name,
            assetClass: presetA.assetClass,
            criteria: presetA.criteria,
            createdAt: presetA.createdAt,
            updatedAt: presetA.updatedAt,
          },
        ],
      });
    }
    if (url === "/api/schedules/create" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      createBodies.push(body);
      return jsonResponse(200, { success: true, schedule: { id: "sched-1" } });
    }
    return Response.json({});
  }) as typeof fetch;
}

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value")!.set!;
  act(() => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll("button")).find((b) =>
    b.textContent?.includes(text),
  ) as HTMLButtonElement | undefined;
}

function findInputByLabel(labelText: string): HTMLInputElement | undefined {
  const label = Array.from(container.querySelectorAll("label")).find((l) =>
    l.textContent?.includes(labelText),
  );
  if (!label) return undefined;
  const forId = label.getAttribute("for");
  if (forId) return container.querySelector(`#${forId}`) as HTMLInputElement | undefined;
  return label.parentElement?.querySelector("input") as HTMLInputElement | undefined;
}

async function renderNewScreen() {
  await act(async () => {
    root.render(<StockHub activeEnv="PROD" userLogin="tester" initialTab="new-screen" />);
  });
  await flush();
  await flush();
}

async function openCapture() {
  const button = findButton("Schedule this screen");
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await flush();
}

async function confirmCapture() {
  const button = findButton("Create schedule");
  expect(button).toBeDefined();
  await act(async () => {
    button!.click();
  });
  await flush();
  await flush();
}

beforeEach(() => {
  // Issue #4430 (S1a): the hub form runs under a hub-variant tenant
  // provider (etrade), so the form is fully enabled.
  setTenantProvidersStateForTest({ dataProviderId: "etrade" });
  installFetch();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root.unmount();
    });
  }
  container?.remove();
  globalThis.fetch = realFetch;
  resetTenantProvidersStateForTest();
  vi.restoreAllMocks();
});

describe("stock-hub schedule capture (#4432)", () => {
  it("opens a confirm strip summarising the form's snapshot", async () => {
    await renderNewScreen();
    await openCapture();
    const strip = container.querySelector('[aria-label="Confirm scheduled screen"]');
    expect(strip).not.toBeNull();
    expect(strip?.textContent).toContain("Schedule THIS screen:");
    expect(strip?.textContent).toContain("TECH");
    expect(strip?.textContent).toContain("max 100");
    expect(strip?.textContent).toContain("custom thresholds");
    // The default form's merged filter carries one criterion — the
    // exchange default (ALL) — alongside the top-level universe/sector.
    expect(strip?.textContent).toContain("1 criteria");
  });

  it("confirming creates the schedule with the form's criteria", async () => {
    await renderNewScreen();
    await openCapture();
    await confirmCapture();
    expect(createBodies).toHaveLength(1);
    expect(createBodies[0]).toEqual({
      callback: "autonomousMarketScreen",
      scheduleType: "interval",
      intervalSeconds: 3600,
      payload: {
        universe: "TECH",
        sector: "ALL",
        maxItems: 100,
        trigger: "scheduled",
        pushToSlack: true,
        // The default form's merged filter: the exchange default rides
        // as the one filter criterion (the manual run sends it too).
        filters: { exchange: "ALL" },
      },
    });
    expect(container.textContent).toContain("Scheduled this screen");
    expect(findButton("View in Schedules")).toBeDefined();
  });

  it("the create POST carries no broker/mode/provider claims", async () => {
    await renderNewScreen();
    await openCapture();
    await confirmCapture();
    expect(createBodies).toHaveLength(1);
    const payload = createBodies[0].payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("brokerId");
    expect(payload).not.toHaveProperty("dataProviderId");
    expect(payload).not.toHaveProperty("mode");
    expect(payload).not.toHaveProperty("provider");
  });

  it("universe All disables scheduling with a named hint", async () => {
    await renderNewScreen();
    const universeSelect = Array.from(container.querySelectorAll("select")).find((s) =>
      Array.from(s.options).some((o) => o.textContent?.includes("auto-sharded")),
    );
    expect(universeSelect).toBeDefined();
    setSelectValue(universeSelect as HTMLSelectElement, "ALL");
    await flush();
    const button = findButton("Schedule this screen");
    expect(button).toBeDefined();
    expect(button!.disabled).toBe(true);
    expect(container.textContent).toContain(
      "Pick a specific universe to schedule — scheduled screens cannot run over All.",
    );
  });

  it("an applied preset arms the schedule with presetId, not frozen filters", async () => {
    await renderNewScreen();
    // Load the preset from the in-form manager.
    const presetCard = Array.from(container.querySelectorAll("strong")).find(
      (el) => el.textContent === "RSI bounce",
    );
    expect(presetCard).toBeDefined();
    const loadButton = Array.from(
      presetCard!.closest("div")!.parentElement!.querySelectorAll("button"),
    ).find((b) => b.textContent?.includes("Load"));
    expect(loadButton).toBeDefined();
    await act(async () => {
      loadButton!.click();
    });
    await flush();
    await flush();
    await openCapture();
    const strip = container.querySelector('[aria-label="Confirm scheduled screen"]');
    expect(strip?.textContent).toContain("preset RSI bounce");
    await confirmCapture();
    expect(createBodies).toHaveLength(1);
    const payload = createBodies[0].payload as Record<string, unknown>;
    expect(payload.presetId).toBe("p1");
    expect(payload).not.toHaveProperty("filters");
  });

  it("a manual criteria edit after Apply disarms the preset", async () => {
    await renderNewScreen();
    const presetCard = Array.from(container.querySelectorAll("strong")).find(
      (el) => el.textContent === "RSI bounce",
    );
    const loadButton = Array.from(
      presetCard!.closest("div")!.parentElement!.querySelectorAll("button"),
    ).find((b) => b.textContent?.includes("Load"));
    await act(async () => {
      loadButton!.click();
    });
    await flush();
    await flush();
    // Edit the loaded Min RSI value: the arming must clear.
    const minRsi = findInputByLabel("Min RSI");
    expect(minRsi).toBeDefined();
    setInputValue(minRsi!, "35");
    await flush();
    await openCapture();
    const strip = container.querySelector('[aria-label="Confirm scheduled screen"]');
    expect(strip?.textContent).toContain("custom thresholds");
    expect(strip?.textContent).not.toContain("preset RSI bounce");
    await confirmCapture();
    expect(createBodies).toHaveLength(1);
    const payload = createBodies[0].payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty("presetId");
    // The edited criteria ride as filters — alongside the form's
    // exchange default, which the merged filter always carries.
    expect(payload.filters).toEqual({ minRsi: 35, maxRsi: 70, exchange: "ALL" });
  });
});
