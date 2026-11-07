/** @vitest-environment jsdom */
/**
 * Issue #2481 — one global auto-refresh switch, system-wide.
 *
 * OFF must mean no periodic refresh at all; ON must restore the
 * existing cadences. These tests pin the decision module, the
 * usePolling gate, the shared options-latest gate, and the
 * quotes one-shot load — the surfaces that previously refreshed
 * unconditionally or from their own localStorage copies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import {
  readAutoRefreshState,
  setAutoRefresh,
  saveAutoRefresh,
  loadAutoRefreshFromServer,
  resetAutoRefreshCacheForTests,
  subscribeAutoRefresh,
  AUTO_REFRESH_ENABLED_KEY,
  AUTO_REFRESH_INTERVAL_KEY,
} from "../src/client/autoRefresh";
import { usePolling } from "../src/client/usePolling";
import {
  subscribeOptionsLatest,
  refreshOptionsLatest,
} from "../src/client/optionsLatestShared";
import { createQuotesService } from "../src/client/quotes/quotesService";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function clearSwitchStorage() {
  window.localStorage.clear();
  resetAutoRefreshCacheForTests();
}

describe("autoRefresh module (#2481)", () => {
  beforeEach(() => {
    clearSwitchStorage();
  });

  it("defaults to OFF with no stored value (existing default, preserved)", () => {
    expect(readAutoRefreshState()).toEqual({ enabled: false, interval: 15 });
  });

  it("writes only the global key family, never the legacy keys", () => {
    setAutoRefresh(true, 30);
    expect(window.localStorage.getItem(AUTO_REFRESH_ENABLED_KEY)).toBe("true");
    expect(window.localStorage.getItem(AUTO_REFRESH_INTERVAL_KEY)).toBe("30");
    expect(window.localStorage.getItem("cfagent_options_autorefresh_enabled")).toBeNull();
    expect(window.localStorage.getItem("cfagent_options_research_autorefresh_enabled")).toBeNull();
    expect(readAutoRefreshState()).toEqual({ enabled: true, interval: 30 });
  });

  it("migrates a legacy options value into the global keys", () => {
    window.localStorage.setItem("cfagent_options_autorefresh_enabled", "true");
    window.localStorage.setItem("cfagent_options_autorefresh_interval", "60");
    expect(readAutoRefreshState()).toEqual({ enabled: true, interval: 60 });
    expect(window.localStorage.getItem(AUTO_REFRESH_ENABLED_KEY)).toBe("true");
  });

  it("notifies subscribers when the switch flips", () => {
    const seen: boolean[] = [];
    const unsub = subscribeAutoRefresh((state) => seen.push(state.enabled));
    setAutoRefresh(true);
    setAutoRefresh(false);
    unsub();
    setAutoRefresh(true);
    expect(seen).toEqual([true, false]);
  });

  it("loads the tenant setting from the server into execution context", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        expect(String(input)).toBe("/api/tenant/settings/auto-refresh");
        return {
          ok: true,
          status: 200,
          json: async () => ({ tenantId: "primary", enabled: true, intervalS: 30 }),
        };
      }),
    );
    const loaded = await loadAutoRefreshFromServer();
    expect(loaded).toEqual({ enabled: true, interval: 30 });
    expect(readAutoRefreshState()).toEqual({ enabled: true, interval: 30 });
    vi.unstubAllGlobals();
  });

  it("save POSTs to the tenant store and reverts when the server rejects", async () => {
    const post = vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    vi.stubGlobal("fetch", post);
    expect(await saveAutoRefresh(true, 60)).toBe(false);
    expect(readAutoRefreshState()).toEqual({ enabled: false, interval: 15 });
    expect(String((post.mock.calls[0] as unknown[])[0])).toBe("/api/tenant/settings/auto-refresh");
    vi.unstubAllGlobals();
  });
});

describe("usePolling gate (#2481)", () => {
  let container: HTMLDivElement;
  let root: Root;

  function Probe(props: { enabled: boolean; run: () => void }) {
    usePolling(props.run, { fastMs: 1000, idleMs: 1000, enabled: props.enabled });
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    clearSwitchStorage();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("schedules nothing while OFF and resumes when flipped ON", async () => {
    const run = vi.fn();
    await act(async () => {
      root.render(<Probe enabled={false} run={run} />);
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).not.toHaveBeenCalled();
    await act(async () => {
      root.render(<Probe enabled={true} run={run} />);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(run).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.render(<Probe enabled={false} run={run} />);
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("optionsLatest shared poll gate (#2481)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clearSwitchStorage();
    resetAutoRefreshCacheForTests();
    (window as any).__POLLING_CONFIG__ = { optionsLatestPollMs: 1000 };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ runs: [] }),
      })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (window as any).__POLLING_CONFIG__;
    vi.useRealTimers();
  });

  it("initial load happens, periodic poll does not while OFF, and toggling gates the poller", async () => {
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const seen: number[] = [];
    const unsub = subscribeOptionsLatest(() => seen.push(1));
    // Initial load only.
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // OFF: no periodic fetch.
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // ON: the shared poller starts and fires at cadence.
    await act(async () => {
      setAutoRefresh(true);
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // OFF again: polling stops.
    await act(async () => {
      setAutoRefresh(false);
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // Manual refresh still fetches while OFF.
    refreshOptionsLatest();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    unsub();
    expect(seen.length).toBeGreaterThan(0);
  });
});

describe("quotes one-shot load (#2481)", () => {
  it("loadOnce fetches once with no socket and no poll", async () => {
    const fetchQuotes = vi.fn(async () => ({
      quotes: [{ symbol: "NVDA", price: 100 }],
    }));
    const createSocket = vi.fn(() => {
      throw new Error("socket must not be created for a one-shot load");
    });
    const service = createQuotesService({ fetchQuotes: fetchQuotes as never, createSocket: createSocket as never });
    await service.loadOnce(["nvda"]);
    expect(fetchQuotes).toHaveBeenCalledTimes(1);
    expect(createSocket).not.toHaveBeenCalled();
    expect(service.getSnapshot().quotes.NVDA).toBeDefined();
  });
});

describe("centralisation pins (#2481)", () => {
  it("Chat and the dynamic menu no longer write their own autorefresh keys", () => {
    for (const path of ["src/client/Chat.tsx", "src/client/BrokerDynamicMenu.tsx"]) {
      const src = readFileSync(path, "utf8");
      expect(src).not.toContain("cfagent_options_autorefresh");
      expect(src).not.toContain("cfagent_global_autorefresh_enabled\", String");
      expect(src).toContain("autoRefresh");
    }
  });

  it("quotes hook and landing page read the global switch", () => {
    expect(readFileSync("src/client/quotes/useMarketQuotes.ts", "utf8")).toContain("useAutoRefresh");
    expect(readFileSync("src/client/landing.ts", "utf8")).toContain("autoRefreshEnabled()");
  });
});
