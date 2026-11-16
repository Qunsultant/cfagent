/**
 * Order capability matrix (issue #4573).
 *
 * The ticket offers exactly what `config/order-capabilities.json` lists and
 * disables the rest, so the matrix is the thing worth pinning: the vocab is
 * the ticket's own, unknown inputs fail closed, and the resolvers never keep
 * an unsupported selection.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  ALL_ORDER_TYPES,
  ALL_TIME_IN_FORCE,
  ORDER_CAPABILITY_MATRIX,
  orderCapabilitiesFor,
  resolveOrderType,
  resolveTimeInForce,
  supportsOrderType,
  supportsTimeInForce,
} from "../src/config/orderCapabilities";

const CONFIG_PATH = "config/order-capabilities.json";

describe("order capability matrix (#4573)", () => {
  it("is externalized data, not a code constant", async () => {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf8")) as {
      note?: string;
      brokers?: Record<string, Record<string, Record<string, unknown>>>;
    };
    expect(raw.note).toContain("#4573");
// Derive the expected broker list from the catalog instead of hardcoding it:
    // Public gained a live-only entry in #4958, and a hardcoded list made that a
    // pin failure rather than a data change.
    const { BROKER_CATALOG } = await import("../src/trading/brokerCatalog");
    expect(Object.keys(raw.brokers ?? {}).sort()).toEqual(Object.keys(BROKER_CATALOG).sort());
  });

  it("uses only the ticket's own vocabulary, with no duplicates", () => {
    const types = new Set<string>(ALL_ORDER_TYPES);
    const tifs = new Set<string>(ALL_TIME_IN_FORCE);
    for (const [broker, modes] of Object.entries(ORDER_CAPABILITY_MATRIX.brokers ?? {})) {
      for (const [mode, classes] of Object.entries(modes)) {
        for (const [assetClass, entry] of Object.entries(classes)) {
          const where = `${broker}/${mode}/${assetClass}`;
          expect(Array.isArray(entry.orderTypes), `${where} orderTypes`).toBe(true);
          expect(Array.isArray(entry.timeInForce), `${where} timeInForce`).toBe(true);
          for (const value of entry.orderTypes as string[]) {
            expect(types.has(value), `${where} unknown order type ${value}`).toBe(true);
          }
          for (const value of entry.timeInForce as string[]) {
            expect(tifs.has(value), `${where} unknown time in force ${value}`).toBe(true);
          }
        }
      }
    }
  });

  it("keeps every broker/mode/asset class non-empty", () => {
    for (const brokerId of ["etrade", "alpaca"]) {
      for (const mode of ["paper", "live"] as const) {
        for (const assetClass of ["equity", "options"] as const) {
          const caps = orderCapabilitiesFor({ brokerId, mode, assetClass });
          expect(caps.supported, `${brokerId}/${mode}/${assetClass}`).toBe(true);
          expect(caps.orderTypes.length).toBeGreaterThan(0);
          expect(caps.timeInForce.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps options narrower than equity, as the brokers' contracts are", () => {
    for (const brokerId of ["etrade", "alpaca"]) {
      const equity = orderCapabilitiesFor({ brokerId, mode: "live", assetClass: "equity" });
      const options = orderCapabilitiesFor({ brokerId, mode: "live", assetClass: "options" });
      expect(equity.orderTypes).toEqual(["MARKET", "LIMIT", "STOP", "STOP_LIMIT"]);
      expect(options.orderTypes).toEqual(["MARKET", "LIMIT"]);
      expect(supportsOrderType(options, "STOP")).toBe(false);
      expect(supportsOrderType(options, "STOP_LIMIT")).toBe(false);
    }
    // Alpaca restricts options time-in-force to day/gtc.
    const alpacaOptions = orderCapabilitiesFor({ brokerId: "alpaca", mode: "live", assetClass: "options" });
    expect(alpacaOptions.timeInForce).toEqual(["DAY", "GTC"]);
    expect(supportsTimeInForce(alpacaOptions, "IOC")).toBe(false);
    expect(supportsTimeInForce(alpacaOptions, "FOK")).toBe(false);
  });

  it("fails closed on an unknown broker, mode, or asset class", () => {
    for (const input of [
      { brokerId: "nope", mode: "paper" as const, assetClass: "equity" as const },
      { brokerId: "etrade", mode: "sandbox" as unknown as "paper", assetClass: "equity" as const },
      { brokerId: "etrade", mode: "paper" as const, assetClass: "crypto" as unknown as "equity" },
    ]) {
      const caps = orderCapabilitiesFor(input);
      expect(caps).toEqual({ supported: false, orderTypes: [], timeInForce: [] });
    }
  });

  it("resolves to a supported value and never keeps an unsupported one", () => {
    const options = orderCapabilitiesFor({ brokerId: "etrade", mode: "paper", assetClass: "options" });
    expect(resolveOrderType(options, "STOP")).toBe("MARKET");
    expect(resolveOrderType(options, "LIMIT")).toBe("LIMIT");

    const alpacaOptions = orderCapabilitiesFor({ brokerId: "alpaca", mode: "paper", assetClass: "options" });
    expect(resolveTimeInForce(alpacaOptions, "FOK")).toBe("DAY");
    expect(resolveTimeInForce(alpacaOptions, "GTC")).toBe("GTC");

    // Nothing supported → null, so the caller renders "not available".
    const unsupported = orderCapabilitiesFor({ brokerId: "nope", mode: "paper", assetClass: "equity" });
    expect(resolveOrderType(unsupported, "MARKET")).toBeNull();
    expect(resolveTimeInForce(unsupported, "DAY")).toBeNull();
  });
});
