/**
 * Issue #6147 (S1, item 3) — the broker picker derives from the registry
 * with execution-capability gating.
 *
 * The registry carries IBKR as a hosted, enabled entry with no execution
 * adapter (`orderPlace` absent from its capabilities). The picker must
 * show it visible-but-unavailable — selectable false with a reason —
 * while the four catalog brokers stay selectable. IBKR must NOT be added
 * to BROKER_CATALOG (no execution adapter, #3410 open); the registry is
 * the one picker source.
 */
import { describe, it, expect } from "vitest";
import { BROKER_CATALOG, type BrokerAssetAccountRegistry } from "../src/trading";
import { buildDefaultBrokerAssetAccountRegistry } from "../src/trading/accountBindings";
import {
  brokerOptions,
  brokerOptionsFromRegistry,
} from "../src/client/brokerOptions";

describe("Issue #6147 (S1, item 3) — registry-derived broker picker with execution gating", () => {
  it("6147-S1-P01: the default registry yields IBKR visible-but-unavailable with a reason", () => {
    const options = brokerOptionsFromRegistry(buildDefaultBrokerAssetAccountRegistry());
    const ibkr = options.find((opt) => opt.id === "ibkr");
    expect(ibkr).toBeDefined();
    expect(ibkr?.label).toBe("Interactive Brokers");
    expect(ibkr?.selectable).toBe(false);
    expect(ibkr?.unavailableReason).toBe("Interactive Brokers has no execution adapter yet — read-only");
  });

  it("6147-S1-P02: the four catalog brokers stay selectable from the registry", () => {
    const options = brokerOptionsFromRegistry(buildDefaultBrokerAssetAccountRegistry());
    const ids = options.map((opt) => opt.id);
    expect(ids).toEqual(["etrade", "alpaca", "public", "tastytrade", "ibkr"]);
    for (const opt of options.filter((o) => o.id !== "ibkr")) {
      expect(opt.selectable).toBe(true);
      expect(opt.unavailableReason).toBeUndefined();
    }
  });

  it("6147-S1-P03: selectability follows the orderPlace capability, not the broker id", () => {
    const registry = buildDefaultBrokerAssetAccountRegistry();
    const noExec: BrokerAssetAccountRegistry = {
      ...registry,
      brokers: registry.brokers.map((entry) => ({
        ...entry,
        capabilities: { ...entry.capabilities, orderPlace: false },
      })),
    };
    expect(brokerOptionsFromRegistry(noExec).every((opt) => opt.selectable === false)).toBe(true);
    const withExec: BrokerAssetAccountRegistry = {
      ...registry,
      brokers: registry.brokers.map((entry) => ({
        ...entry,
        capabilities: { ...entry.capabilities, orderPlace: true },
      })),
    };
    expect(brokerOptionsFromRegistry(withExec).every((opt) => opt.selectable === true)).toBe(true);
  });

  it("6147-S1-P04: a disabled registry entry never reaches the picker", () => {
    const registry = buildDefaultBrokerAssetAccountRegistry();
    const disabledIbkr: BrokerAssetAccountRegistry = {
      ...registry,
      brokers: registry.brokers.map((entry) =>
        entry.id === "ibkr" ? { ...entry, enabled: false } : entry,
      ),
    };
    expect(brokerOptionsFromRegistry(disabledIbkr).map((opt) => opt.id)).not.toContain("ibkr");
  });

  it("6147-S1-P05: the catalog path is unchanged — four brokers, all selectable — and IBKR is not in the catalog", () => {
    expect(Object.keys(BROKER_CATALOG).sort()).toEqual(["alpaca", "etrade", "public", "tastytrade"]);
    expect("ibkr" in BROKER_CATALOG).toBe(false);
    const options = brokerOptions();
    expect(options.map((opt) => opt.id).sort()).toEqual(["alpaca", "etrade", "public", "tastytrade"]);
    expect(options.every((opt) => opt.selectable === true)).toBe(true);
  });
});
