/** @vitest-environment jsdom */
/**
 * Issue #1497 (#940-C): preset save/load/delete UI + manual run with a
 * preset. Builds on #1495 (preset API) and #1496 (criteria panel).
 *
 * Wire-format decision (verified 2026-10-25): manual runs do NOT carry
 * presetId. The run request schema is z.strictObject, so an extra
 * presetId field would 400. Instead the manager resolves client-side:
 * Load re-lists and applies the preset's criteria into the panel, and
 * the existing Run button sends those criteria. Server-side preset
 * resolution for scheduled runs is #1499's contract, not this UI's.
 *
 * "Missing/foreign preset fails loudly, never a silent default":
 *  - Load re-lists before applying. If the id is gone (deleted
 *    elsewhere), Load errors loudly, refreshes the list, and applies
 *    NOTHING — the panel keeps its previous criteria.
 *  - A failed list fetch shows the server's business error, never an
 *    empty list masquerading as "no presets".
 *  - With no preset selected, the run uses the panel's explicit state
 *    (all-off = existing behavior) — never a substituted preset.
 *  - Foreign presets cannot appear: the API lists only the caller's own
 *    rows, and deleting another user's id 404s (pinned in #1495).
 *
 * Pins:
 *  - helpers: list filters to the tab's asset class; list/create/delete
 *    surface the server's business message on failure
 *  - stockFilterToCriteria: a full filter maps to enabled panel rows
 *    (market cap dollars -> $B string); an empty filter maps to all-off
 *  - manager: presets render; empty list (after a successful fetch)
 *    renders an honest empty state; Load applies the mapped criteria;
 *    Load of a vanished preset errors and applies nothing; Save POSTs
 *    name/assetClass/current filter; Delete asks for Modal confirmation
 *    showing the preset name, then deletes and refreshes
 *  - ScreenersHub wires the manager into the stock run form (source pin)
 *
 * Harness follows tests/stock_criteria_panel.test.tsx: react-dom/client
 * in jsdom, direct component renders, global fetch mocked. The Modal
 * renders through a portal, so dialog content is searched in
 * document.body, not the render container.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import {
  ScreenerPresetManager,
  listPresets,
  createPreset,
  deletePreset,
  type ScreenerPreset,
} from "../src/client/ScreenerPresetManager";
import {
  stockFilterToCriteria,
  stockCriteriaToFilter,
  defaultStockCriteria,
} from "../src/client/StockCriteriaPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const presetA: ScreenerPreset = {
  id: "p1",
  name: "RSI bounce",
  assetClass: "stocks",
  criteria: { minRsi: 30, maxRsi: 70 },
  createdAt: "2026-10-25T10:00:00Z",
  updatedAt: "2026-10-25T10:00:00Z",
};
const presetOptions: ScreenerPreset = {
  id: "p2",
  name: "Near-dated calls",
  assetClass: "options",
  criteria: { contractType: "CALL" },
  createdAt: "2026-10-25T10:00:00Z",
  updatedAt: "2026-10-25T10:00:00Z",
};

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

let fetchCalls: Array<{ url: string; method: string; body?: unknown }>;
let listPayload: ScreenerPreset[];

function installFetch() {
  fetchCalls = [];
  listPayload = [presetA, presetOptions];
  (globalThis as any).fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined;
    } catch {
      body = undefined;
    }
    fetchCalls.push({ url: String(url), method, body });
    if (url === "/api/screener/presets" && method === "GET") {
      return jsonResponse(200, {
        presets: listPayload.map((p) => ({
          id: p.id,
          name: p.name,
          assetClass: p.assetClass,
          criteria: p.criteria,
          createdAt: p.createdAt,
          updatedAt: p.updatedAt,
        })),
      });
    }
    if (url === "/api/screener/presets" && method === "POST") {
      return jsonResponse(201, { preset: { id: "p3", ...(body as object) } });
    }
    if (url.startsWith("/api/screener/presets/") && method === "DELETE") {
      return jsonResponse(200, { deleted: true });
    }
    return jsonResponse(404, { error: "Preset not found." });
  });
}

beforeEach(() => {
  installFetch();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

async function renderManager(onApplyPreset = vi.fn()) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <ScreenerPresetManager
        assetClass="stocks"
        userLogin="alice"
        currentFilter={{ minRsi: 25 }}
        onApplyPreset={onApplyPreset}
      />
    );
  });
  await act(async () => {});
  return { container, onApplyPreset };
}

describe("Issue #1497 — preset helpers", () => {
  it("list returns the caller's presets across asset classes (the component filters by tab)", async () => {
    const presets = await listPresets("alice");
    expect(presets.filter((p) => p.assetClass === "stocks")).toEqual([presetA]);
    expect(presets.some((p) => p.id === "p2")).toBe(true);
  });

  it("list surfaces the server's business message on failure", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse(500, { error: "Failed to list presets." })
    );
    await expect(listPresets("alice")).rejects.toThrow("Failed to list presets.");
  });

  it("create posts name, asset class, and criteria", async () => {
    await createPreset("alice", { name: "X", assetClass: "stocks", criteria: { minRsi: 30 } });
    const post = fetchCalls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({ name: "X", assetClass: "stocks", criteria: { minRsi: 30 } });
  });

  it("delete of a missing id surfaces 'Preset not found.'", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse(404, { error: "Preset not found." })
    );
    await expect(deletePreset("alice", "nope")).rejects.toThrow("Preset not found.");
  });
});

describe("Issue #1497 — stockFilterToCriteria", () => {
  it("a full filter maps to enabled panel rows, market cap in $B", () => {
    expect(
      stockFilterToCriteria({
        minRsi: 30,
        maxRsi: 70,
        minVolume: 100000,
        minMarketCap: 10000000000,
        maxPeRatio: 25,
        rsiFilter: "oversold",
        momentum: "bullish_breakout",
      })
    ).toEqual({
      minRsi: { enabled: true, value: "30" },
      maxRsi: { enabled: true, value: "70" },
      minVolume: { enabled: true, value: "100000" },
      minMarketCapB: { enabled: true, value: "10" },
      maxPeRatio: { enabled: true, value: "25" },
      rsiFilter: { enabled: true, value: "oversold" },
      momentum: { enabled: true, value: "bullish_breakout" },
      extra: {},
    });
  });

  it("an empty filter maps to all-off (never a substituted preset)", () => {
    expect(stockFilterToCriteria({})).toEqual(defaultStockCriteria);
  });
});

describe("Issue #1497 — ScreenerPresetManager", () => {
  it("renders the stocks presets, not the options one", async () => {
    const { container } = await renderManager();
    expect(container.textContent).toContain("RSI bounce");
    expect(container.textContent).not.toContain("Near-dated calls");
  });

  it("a failed list shows the error, not an empty state", async () => {
    (globalThis as any).fetch = vi.fn(async () =>
      jsonResponse(500, { error: "Failed to list presets." })
    );
    const { container } = await renderManager();
    expect(container.textContent).toContain("Failed to list presets.");
    expect(container.textContent).not.toMatch(/no saved presets/i);
  });

  it("Load re-lists and applies the mapped criteria", async () => {
    const { container, onApplyPreset } = await renderManager();
    const load = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Load"
    );
    expect(load).toBeDefined();
    await act(async () => {
      load!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(onApplyPreset).toHaveBeenCalledTimes(1);
    expect(onApplyPreset.mock.calls[0][0]).toEqual({
      minRsi: { enabled: true, value: "30" },
      maxRsi: { enabled: true, value: "70" },
      minVolume: { enabled: false, value: "" },
      minMarketCapB: { enabled: false, value: "" },
      maxPeRatio: { enabled: false, value: "" },
      rsiFilter: { enabled: false, value: "any" },
      momentum: { enabled: false, value: "any" },
      extra: {},
    });
  });

  it("Load of a vanished preset errors loudly and applies nothing", async () => {
    const { container, onApplyPreset } = await renderManager();
    listPayload = [presetOptions];
    const load = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Load"
    );
    await act(async () => {
      load!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(onApplyPreset).not.toHaveBeenCalled();
    expect(container.textContent).toMatch(/no longer exists/i);
  });

  it("Save posts the current filter and refreshes the list", async () => {
    const { container } = await renderManager();
    const nameInput = container.querySelector(
      "#preset-manager-name"
    ) as HTMLInputElement;
    await act(async () => {
      const nativeSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        "value"
      )!.set!;
      nativeSetter.call(nameInput, "My preset");
      nameInput.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const save = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Save preset"
    );
    await act(async () => {
      save!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    const post = fetchCalls.find((c) => c.method === "POST");
    expect(post?.body).toEqual({
      name: "My preset",
      assetClass: "stocks",
      criteria: { minRsi: 25 },
    });
  });

  it("Delete asks for Modal confirmation showing the name, then deletes", async () => {
    const { container } = await renderManager();
    const del = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Delete"
    );
    await act(async () => {
      del!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(document.body.textContent).toContain("RSI bounce");
    const confirm = Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent === "Delete preset"
    );
    expect(confirm).toBeDefined();
    await act(async () => {
      confirm!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(fetchCalls.some((c) => c.method === "DELETE" && c.url.endsWith("/p1"))).toBe(true);
  });

  it("StockHub wires the manager into the stock run form (source pin, #2896)", () => {
    const src = readFileSync("src/client/StockHub.tsx", "utf8");
    expect(src).toContain("ScreenerPresetManager");
    // Issue #2909 (G2): preset application goes through
    // handleCriteriaChange, which sets the criteria exactly as
    // setStockCriteria did and additionally clears any applied
    // pattern, so a preset-applied run is never misreported as
    // a pattern run. The pin follows the wiring, not the name.
    expect(src).toContain("onApplyPreset={handleCriteriaChange}");
    expect(src).toContain("onChange={handleCriteriaChange}");
  });
});

describe("Issue #2886 (S2) — empty saves refused, full filter round-trips", () => {
  it("non-panel filter keys survive load into extra and back out again", () => {
    const loaded = stockFilterToCriteria({
      minRsi: 30,
      minPrice: 5,
      gainersOnly: true,
      requireSqueezeGate: true,
    });
    expect(loaded.extra).toEqual({
      minPrice: 5,
      gainersOnly: true,
      requireSqueezeGate: true,
    });
    // Re-saving the loaded state stores the same keys — a preset
    // saved on either page loads identically on the other.
    expect(stockCriteriaToFilter(loaded)).toEqual({
      minPrice: 5,
      gainersOnly: true,
      requireSqueezeGate: true,
      minRsi: 30,
    });
  });

  it("Save is disabled and a loud notice shows when no criterion is on", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(
        <ScreenerPresetManager
          assetClass="stocks"
          userLogin="alice"
          currentFilter={{}}
          onApplyPreset={vi.fn()}
        />
      );
    });
    await act(async () => {});
    const save = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Save preset"
    );
    expect(save).toBeDefined();
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(container.textContent).toMatch(/no criteria are on/i);
    await act(async () => {
      save!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {});
    expect(fetchCalls.some((c) => c.method === "POST")).toBe(false);
  });

  it("StockHub wires the Presets tab to the live criteria, not {} (source pin)", () => {
    const src = readFileSync("src/client/StockHub.tsx", "utf8");
    expect(src).not.toContain("currentFilter={{}}");
    expect(src).toContain("currentFilter={stockCriteriaToFilter(stockCriteria)}");
  });
});
