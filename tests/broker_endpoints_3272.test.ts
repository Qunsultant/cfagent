/** @vitest-environment jsdom */
/**
 * Issue #3272 (S5): the client asks the endpoint that can serve its broker.
 *
 * Defect this pins away: every surface hardcoded `/api/trading/options/screen`
 * and `/api/etrade/screen`, so a tenant on another broker was sent somewhere
 * that cannot answer for it. The rule is explicit:
 *
 *   etrade  → its own route (legacy paid seam, universe discovery intact)
 *   other   → the neutral route (#3272), whose refusals are coded and named
 *
 * No fallback: an unknown selection gets the neutral route, never E*TRADE's.
 */
import { describe, it, expect } from "vitest";
import {
  LEGACY_OPTION_SCREEN_ENDPOINT,
  LEGACY_STOCK_SCREEN_ENDPOINT,
  NEUTRAL_OPTION_SCREEN_ENDPOINT,
  NEUTRAL_STOCK_SCREEN_ENDPOINT,
  connectStatusEndpoint,
  optionScreenEndpoint,
  stockScreenEndpoint,
} from "../src/client/brokerEndpoints";

describe("the option screen endpoint follows the selection (#3272)", () => {
  it("keeps E*TRADE on its own route, unchanged", () => {
    expect(optionScreenEndpoint("etrade")).toBe(LEGACY_OPTION_SCREEN_ENDPOINT);
    expect(LEGACY_OPTION_SCREEN_ENDPOINT).toBe("/api/trading/options/screen");
  });

  it("sends every other broker to the neutral route", () => {
    expect(optionScreenEndpoint("alpaca")).toBe(NEUTRAL_OPTION_SCREEN_ENDPOINT);
    expect(NEUTRAL_OPTION_SCREEN_ENDPOINT).toBe("/api/broker/options/screen");
  });

  it("never defaults an unknown selection to E*TRADE", () => {
    expect(optionScreenEndpoint("interactive_brokers")).toBe(NEUTRAL_OPTION_SCREEN_ENDPOINT);
    expect(optionScreenEndpoint("")).toBe(NEUTRAL_OPTION_SCREEN_ENDPOINT);
  });
});

describe("the stock screen endpoint follows the selection (#3272)", () => {
  it("keeps E*TRADE on its own route, unchanged", () => {
    expect(stockScreenEndpoint("etrade")).toBe(LEGACY_STOCK_SCREEN_ENDPOINT);
    expect(LEGACY_STOCK_SCREEN_ENDPOINT).toBe("/api/etrade/screen");
  });

  it("sends every other broker to the neutral route", () => {
    expect(stockScreenEndpoint("alpaca")).toBe(NEUTRAL_STOCK_SCREEN_ENDPOINT);
    expect(NEUTRAL_STOCK_SCREEN_ENDPOINT).toBe("/api/broker/screen");
  });
});

describe("the connect-status endpoint follows the selection (#3669)", () => {
  it("keeps E*TRADE on its OAuth status read", () => {
    expect(connectStatusEndpoint("etrade")).toBe("/api/etrade/oauth/status");
  });

  it("sends Alpaca to its neutral connect read — the same one the menu uses", () => {
    expect(connectStatusEndpoint("alpaca")).toBe("/api/broker/connect/alpaca");
  });

  it("returns null for a broker with no connect surface here — never another broker's status", () => {
    expect(connectStatusEndpoint("interactive_brokers")).toBeNull();
    expect(connectStatusEndpoint("")).toBeNull();
  });
});
