/**
 * Issue #3368 — the last two client calls that ignored the broker selection.
 *
 * What these tests defend:
 *   1. Sync asks the selected broker: E*TRADE's diagnostics for E*TRADE, the
 *      neutral status read for every other selection, and E*TRADE's window
 *      events only when E*TRADE's diagnostics are the ones running.
 *   2. The autopilot feed reads the broker-neutral draft ledger.
 *   3. Neither surface can regress to a hardcoded E*TRADE route, and the menu no
 *      longer invents a latency when the answer carries none.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { syncTarget } from "../src/client/brokerEndpoints";

/** The menu reads the live selection from storage; these assert the rule itself. */
describe("Sync follows the selection (#3368)", () => {
  it("asks E*TRADE's diagnostics for E*TRADE, and fires its events", () => {
    expect(syncTarget("etrade")).toEqual({ path: "/api/etrade/diagnostics", diagnostics: true });
  });

  it("asks the neutral status read for Alpaca, and fires no E*TRADE event", () => {
    expect(syncTarget("alpaca")).toEqual({ path: "/api/broker/status", diagnostics: false });
  });

  it("treats an unknown selection as non-E*TRADE, like every other endpoint helper", () => {
    expect(syncTarget("sandbox").diagnostics).toBe(false);
    expect(syncTarget("").diagnostics).toBe(false);
    expect(syncTarget("").path).toBe("/api/broker/status");
  });
});

describe("no surface calls an E*TRADE route by habit (#3368)", () => {
  it("the autopilot feed reads the neutral draft ledger", () => {
    const source = readFileSync("src/client/components/AutopilotControlCenter.tsx", "utf8");
    expect(source).toContain('fetch("/api/broker/orders")');
    expect(source).not.toContain("/api/etrade/");
  });

  it("the Sync control routes through the helper and invents no latency", () => {
    const source = readFileSync("src/client/BrokerDynamicMenu.tsx", "utf8");
    expect(source).toContain("syncTarget(selectedBrokerId)");
    // The defect this replaced: a hardcoded diagnostics route and `?? 42`.
    expect(source).not.toContain("`/api/etrade/diagnostics`");
    expect(source).not.toContain("?? 42");
  });
});
