/**
 * Issue #3295: the options scanner is declared, not silently routed to E*TRADE.
 *
 * That issue declared Alpaca unsupported because the scan-history store held
 * E*TRADE rows. Issue #3327 supersedes the Alpaca half: scan runs now record
 * which broker's chains produced them and reads are scoped to the selection,
 * so the capability is true for both brokers. What survives from #3295 is the
 * client guard — a broker that lacks the capability is still refused by name
 * before any request, never answered with another broker's runs.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { brokerSupports } from "../src/trading/brokerCatalog";
import { ScannerUnavailableError } from "../src/client/scannerApi";

describe("the scanner capability is declared (#3295)", () => {
  it("E*TRADE keeps profiles and scan history", () => {
    expect(brokerSupports("etrade", "optionsScanner")).toBe(true);
  });

  it("Alpaca declares the scanner surface supported since #3327", () => {
    expect(brokerSupports("alpaca", "optionsScanner")).toBe(true);
    // The engine itself was never unsupported: options reads still work.
    expect(brokerSupports("alpaca", "optionChains")).toBe(true);
  });
});

describe("the client refuses instead of calling E*TRADE (#3295)", () => {
  it("carries the shared unsupported code and names the broker", () => {
    const error = new ScannerUnavailableError("alpaca");
    expect(error.code).toBe("provider_unsupported");
    expect(error.message).toContain("alpaca");
    expect(error.message).toContain("no other broker's runs");
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
