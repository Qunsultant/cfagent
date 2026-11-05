/** @vitest-environment jsdom */
/**
 * Issue #3411 — Alpaca and routed brokers must not be blocked by FAILURE_BROKER_UNAVAILABLE
 *
 * What these tests defend:
 *   1. isBrokerId recognizes all registered brokers (etrade, alpaca), refusing unknown ones.
 *   2. OptionsScreenerPage renders without FAILURE_BROKER_UNAVAILABLE when broker is alpaca.
 *   3. OptionsScreenerPage renders FAILURE_BROKER_UNAVAILABLE only for unrecognized brokers.
 *   4. Chat.tsx admits any valid routed broker into ETradeTradingHub rather than blocking on
 *      legacy `tenantProviders.brokerId !== "etrade"`.
 *   5. ETradeTradingHub subscribes to useTenantProviders() so broker switches reactively update.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "fs";
import { join } from "path";
import { OptionsScreenerPage } from "../src/client/OptionsScreenerPage";
import { isBrokerId, TENANT_PROVIDERS_CHANGED_EVENT } from "../src/client/tenantProviders";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  if (root) act(() => root.unmount());
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

describe("isBrokerId helper in tenantProviders (#3411)", () => {
  it("recognizes etrade and alpaca as valid broker IDs", () => {
    expect(isBrokerId("etrade")).toBe(true);
    expect(isBrokerId("alpaca")).toBe(true);
  });

  it("refuses unknown or invalid broker IDs", () => {
    expect(isBrokerId("unknown")).toBe(false);
    expect(isBrokerId("robinhood")).toBe(false);
    expect(isBrokerId("")).toBe(false);
    expect(isBrokerId(null)).toBe(false);
    expect(isBrokerId(undefined)).toBe(false);
  });
});

describe("OptionsScreenerPage broker availability gate (#3411)", () => {
  it("does not render FAILURE_BROKER_UNAVAILABLE when broker is alpaca", async () => {
    localStorage.setItem("cfagent_tenant_broker", "alpaca");
    localStorage.setItem("cfagent_tenant_data_provider", "alpaca");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ brokerId: "alpaca", dataProviderId: "alpaca" }),
    })) as any);

    await act(async () => {
      root.render(<OptionsScreenerPage />);
    });
    await flush();

    expect(container.textContent).not.toContain("FAILURE_BROKER_UNAVAILABLE");
    expect(container.textContent).not.toContain("Broker surface unavailable");
  });

  it("does not render FAILURE_BROKER_UNAVAILABLE when broker is etrade", async () => {
    localStorage.setItem("cfagent_tenant_broker", "etrade");
    localStorage.setItem("cfagent_tenant_data_provider", "etrade");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ brokerId: "etrade", dataProviderId: "etrade" }),
    })) as any);

    await act(async () => {
      root.render(<OptionsScreenerPage />);
    });
    await flush();

    expect(container.textContent).not.toContain("FAILURE_BROKER_UNAVAILABLE");
  });

  it("renders FAILURE_BROKER_UNAVAILABLE when broker is unrecognized", async () => {
    localStorage.setItem("cfagent_tenant_broker", "unsupported_broker");
    vi.stubGlobal("fetch", vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ brokerId: "unsupported_broker", dataProviderId: "etrade" }),
    })) as any);

    await act(async () => {
      root.render(<OptionsScreenerPage />);
    });
    await flush();

    expect(container.textContent).toContain("FAILURE_BROKER_UNAVAILABLE");
    expect(container.textContent).toContain("Broker surface unavailable");
  });
});

describe("Chat.tsx and ETradeTradingHub.tsx source pins (#3411)", () => {
  it("Chat.tsx does not block trading hub on tenantProviders.brokerId !== 'etrade'", () => {
    const chatSrc = readFileSync(join(__dirname, "../src/client/Chat.tsx"), "utf8");
    expect(chatSrc).not.toContain('tenantProviders.brokerId !== "etrade"');
    expect(chatSrc).toMatch(/!isBrokerId\(tenantProviders\.brokerId\)/);
  });

  it("ETradeTradingHub.tsx subscribes to useTenantProviders for reactive broker updates", () => {
    const hubSrc = readFileSync(join(__dirname, "../src/client/ETradeTradingHub.tsx"), "utf8");
    expect(hubSrc).toContain("useTenantProviders");
    expect(hubSrc).toMatch(/useTenantProviders\(\)/);
  });
});

