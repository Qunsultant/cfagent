/** @vitest-environment jsdom */
/**
 * Issue #3294: the hub's four reads follow the broker selection.
 *
 * Before this, `ETradeTradingHub` called `/api/etrade/status|positions|quote|
 * diagnostics` directly, so an Alpaca tenant's hub read E*TRADE. Diagnostics
 * read E*TRADE OAuth state and have no neutral equivalent — the contract is
 * therefore `null` (do not call), not a silent E*TRADE request.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  diagnosticsEndpoint,
  positionsEndpoint,
  quoteEndpoint,
  statusEndpoint,
} from "../src/client/brokerEndpoints";

const hub = readFileSync("src/client/ETradeTradingHub.tsx", "utf8");

describe("hub read selectors (#3294)", () => {
  it("keeps E*TRADE on its own routes", () => {
    expect(statusEndpoint("etrade")).toBe("/api/etrade/status");
    expect(positionsEndpoint("etrade")).toBe("/api/etrade/positions");
    expect(quoteEndpoint("etrade")).toBe("/api/etrade/quote");
    expect(diagnosticsEndpoint("etrade")).toBe("/api/etrade/diagnostics");
  });

  it("sends every other broker to the neutral routes", () => {
    expect(statusEndpoint("alpaca")).toBe("/api/broker/status");
    expect(positionsEndpoint("alpaca")).toBe("/api/broker/positions");
    expect(quoteEndpoint("alpaca")).toBe("/api/broker/quote");
  });

  it("refuses diagnostics for a non-E*TRADE broker instead of calling it", () => {
    expect(diagnosticsEndpoint("alpaca")).toBeNull();
    expect(diagnosticsEndpoint("")).toBeNull();
  });
});

describe("the hub no longer hardcodes those four reads (#3294)", () => {
  it.each(["/api/etrade/status", "/api/etrade/positions", "/api/etrade/diagnostics"])(
    "does not fetch %s directly",
    (path) => {
      expect(hub).not.toContain(`fetch("${path}"`);
    },
  );

  it("does not build the E*TRADE quote URL directly", () => {
    expect(hub).not.toContain("/api/etrade/quote?symbol=");
  });

  it("uses the selectors instead", () => {
    for (const call of ["statusEndpoint()", "positionsEndpoint()", "quoteEndpoint()", "diagnosticsEndpoint()"]) {
      expect(hub).toContain(call);
    }
  });
});
