/** @vitest-environment jsdom */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * Issue #2482 — the client-side single environment source.
 *
 * The module clears the stale keys on import and never reads them
 * again; the server value (via apiFetch) is the only authority, and a
 * failed load or switch leaves the current value standing rather than
 * surfacing a stale key.
 *
 * Module state is per-import, so each test resets modules and imports
 * fresh after arranging localStorage / fetch mocks.
 */

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function importModule() {
  const mod = await import("../src/client/brokerEnvironment");
  return mod;
}

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("broker environment client module (#2482)", () => {
  it("clears both stale keys on import and defaults to TEST (paper, #3857)", async () => {
    window.localStorage.setItem("cfagent_env", "TEST");
    window.localStorage.setItem("etrade_active_env", "PROD");
    const mod = await importModule();
    expect(window.localStorage.getItem("cfagent_env")).toBeNull();
    expect(window.localStorage.getItem("etrade_active_env")).toBeNull();
    expect(mod.getBrokerEnvironment()).toBe("TEST");
  });

  it("stale-key disagreement resolves to TEST, never to either stale key", async () => {
    // One key TEST, the other PROD — the exact live split. The module
    // ignores both and starts at the server default.
    window.localStorage.setItem("cfagent_env", "TEST");
    window.localStorage.setItem("etrade_active_env", "PROD");
    const mod = await importModule();
    expect(mod.getBrokerEnvironment()).toBe("TEST");
    expect(window.localStorage.getItem("cfagent_env")).toBeNull();
    expect(window.localStorage.getItem("etrade_active_env")).toBeNull();
  });

  it("fetch adopts the server selection and broadcasts it", async () => {
    // The server returns PROD — a change from the TEST (paper) import
    // default, so adoption broadcasts. (A server TEST would adopt
    // silently: the value is already TEST, so there is nothing to
    // converge — setCurrent is a no-op when the value is unchanged.)
    const seen: unknown[] = [];
    window.addEventListener("etrade-env-changed", (e) => {
      seen.push((e as CustomEvent).detail?.env);
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("/api/broker/etrade/environment");
        return jsonResponse({ environment: "PROD" });
      }),
    );
    const mod = await importModule();
    const adopted = await mod.fetchBrokerEnvironment();
    expect(adopted).toBe("PROD");
    expect(mod.getBrokerEnvironment()).toBe("PROD");
    expect(seen).toEqual(["PROD"]);
  });

  it("fetch failure or an invalid server value keeps the current value", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ environment: "BOGUS" })));
    const mod = await importModule();
    expect(await mod.fetchBrokerEnvironment()).toBe("TEST");
    expect(mod.getBrokerEnvironment()).toBe("TEST");

    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new Error("network down");
    }));
    expect(await mod.fetchBrokerEnvironment()).toBe("TEST");
  });

  it("switch POSTs the target, adopts the echoed value, and writes no local key", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : undefined });
        return jsonResponse({ success: true, environment: "TEST" });
      }),
    );
    const mod = await importModule();
    const adopted = await mod.switchBrokerEnvironment("TEST");
    expect(adopted).toBe("TEST");
    expect(mod.getBrokerEnvironment()).toBe("TEST");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("/api/environment/switch");
    expect(calls[0].body).toEqual({ environment: "TEST" });
    expect(window.localStorage.getItem("cfagent_env")).toBeNull();
    expect(window.localStorage.getItem("etrade_active_env")).toBeNull();
  });

  it("switch failure keeps the current value and writes nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "nope" }, 500)));
    const mod = await importModule();
    expect(await mod.switchBrokerEnvironment("TEST")).toBe("TEST");
    expect(mod.getBrokerEnvironment()).toBe("TEST");
  });
});
