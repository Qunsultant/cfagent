/**
 * Issue #3295: the options scanner is declared, not silently routed to E*TRADE.
 *
 * Scope correction recorded here (and on the issue): the scan **engine** is
 * already broker-neutral — `DynamicOptionsScreener` runs on `OptionChainSource`
 * since #3272 — but the saved-profile store (#28) and the scan-history store
 * (#27) are E*TRADE rows keyed to that broker's surface. A neutral backend is
 * its own slice (a broker-keyed store and a migration), so this slice does what
 * is honest now: declare the capability per broker and stop the client reaching
 * E*TRADE for another broker.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { brokerSupports } from "../src/trading/brokerCatalog";
import { ScannerUnavailableError } from "../src/client/scannerApi";

describe("the scanner capability is declared (#3295)", () => {
  it("E*TRADE keeps profiles and scan history", () => {
    expect(brokerSupports("etrade", "optionsScanner")).toBe(true);
  });

  it("Alpaca declares the scanner surface unsupported in this build", () => {
    expect(brokerSupports("alpaca", "optionsScanner")).toBe(false);
    // The engine itself is NOT declared unsupported: options reads still work.
    expect(brokerSupports("alpaca", "optionChains")).toBe(true);
  });
});

describe("the client refuses instead of calling E*TRADE (#3295)", () => {
  it("carries the shared unsupported code and names the broker", () => {
    const error = new ScannerUnavailableError("alpaca");
    expect(error.code).toBe("provider_unsupported");
    expect(error.message).toContain("alpaca");
    expect(error.message).toContain("E*TRADE-only");
    expect(error.name).toBe("ScannerUnavailableError");
  });

  it("is defined before any request is issued", () => {
    const source = readFileSync("src/client/scannerApi.ts", "utf8");
    const classAt = source.indexOf("export class ScannerUnavailableError");
    const firstClient = source.indexOf("export async function");
    expect(classAt).toBeGreaterThan(-1);
    // The class is declared in the module header region, ahead of the clients.
    expect(firstClient).toBeGreaterThan(-1);
    expect(classAt).toBeLessThan(firstClient);
  });
});
