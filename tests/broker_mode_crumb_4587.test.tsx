/** @vitest-environment jsdom */
/**
 * Issue #4587 — the top-left crumb shows broker + mode, not mode alone.
 * "Platform Admin / Paper" must read "Alpaca / Paper" (broker + mode).
 *
 * Pins: the brokerModeLabel helper for both modes and both brokers, the
 * wiring (Chat's crumb-subtitle span renders the helper), and the
 * composed render (a mounted Chat shows "Alpaca / Paper" by default).
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Chat } from "../src/client/Chat";
import { brokerModeLabel } from "../src/client/brokerEnvironment";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const HERE = join(__dirname, "..");
const CHAT = "src/client/Chat.tsx";

function src(p: string): string {
  return readFileSync(join(HERE, p), "utf8");
}

describe("broker + mode crumb label (#4587)", () => {
  // Issue #4649: the helper takes the broker id as well, because the mode word
  // is the broker's capability — Public.com has no paper account.
  it("paper mode reads broker / Paper", () => {
    expect(brokerModeLabel({ broker: "alpaca", brokerLabel: "Alpaca", accountMode: "paper" })).toBe("Alpaca / Paper");
    expect(brokerModeLabel({ broker: "etrade", brokerLabel: "E*TRADE", accountMode: "paper" })).toBe("E*TRADE / Paper");
  });

  it("live mode reads broker / Live Execution", () => {
    expect(brokerModeLabel({ broker: "alpaca", brokerLabel: "Alpaca", accountMode: "live" })).toBe("Alpaca / Live Execution");
    expect(brokerModeLabel({ broker: "etrade", brokerLabel: "E*TRADE", accountMode: "live" })).toBe("E*TRADE / Live Execution");
  });

  // Issue #4649 (matrix gap 1): Public.com has no paper mode, so the crumb must
  // never read "Public.com / Paper" — the stored mode is auto-switched to live
  // and the crumb says so in both states.
  it("Public.com never reads Paper, in either stored mode", () => {
    expect(brokerModeLabel({ broker: "public", brokerLabel: "Public.com", accountMode: "paper" })).toBe(
      "Public.com / Live Execution",
    );
    expect(brokerModeLabel({ broker: "public", brokerLabel: "Public.com", accountMode: "live" })).toBe(
      "Public.com / Live Execution",
    );
  });

  it("Chat's crumb-subtitle span renders the helper, not mode alone", () => {
    const chat = src(CHAT);
    const start = chat.indexOf('className="crumb-subtitle top-nav-control"');
    expect(start).toBeGreaterThanOrEqual(0);
    const block = chat.slice(start, chat.indexOf("</span>", start));
    expect(block).toContain("brokerModeLabel({");
    expect(block).toContain("brokerLabel: selectedBrokerLabel");
    expect(block).toContain("accountMode");
    // Issue #4649: the crumb passes the broker id, so the mode word can read
    // the broker's paper-mode capability instead of assuming TEST = paper.
    expect(block).toContain("broker: tenantProviders.brokerId");
    expect(block).not.toContain('"Paper"');
    expect(block).not.toContain('"Live Execution"');
  });
});

describe("mounted Chat crumb (#4587 composition)", () => {
  const realFetch = globalThis.fetch;
  let root: Root | undefined;

  beforeEach(() => {
    window.history.replaceState({}, "", "/?tab=autopilot");
    (window as any).__FEATURES__ = { screener: true };
    globalThis.fetch = vi.fn(async () => Response.json({})) as any;
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    root = undefined;
    document.body.innerHTML = "";
    globalThis.fetch = realFetch;
  });

  it("the crumb subtitle shows broker + mode by default", async () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(<Chat user={{ login: "tester", name: "Tester", avatar: "" }} />);
    });
    const subtitle = host.querySelector(".crumb-subtitle");
    expect(subtitle).not.toBeNull();
    expect(subtitle!.textContent).toBe("Alpaca / Paper");
  });
});
