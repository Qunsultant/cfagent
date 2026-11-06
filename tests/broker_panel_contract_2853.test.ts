/**
 * Issue #2853 (programme #3216, gap G2): the broker panel contract.
 *
 * What these tests defend:
 *   1. Availability is DERIVED from the broker catalog — not a second
 *      hand-written table that can drift from what the broker can do.
 *   2. An unsupported surface is refused with the code the server sends
 *      (`FAILURE_BROKER_UNAVAILABLE`) and a message naming the broker, and
 *      the refusal is produced by the real function, not by a fixture that
 *      repeats the expected string.
 *   3. No surface is "available" by default: every broker answers every
 *      surface, and a broker that cannot do it says so.
 *   4. The kill switch exists, inherits its parent, and an explicit OFF wins.
 */
import { describe, it, expect } from "vitest";
import {
  BROKER_PANEL_SURFACES,
  BROKER_UNAVAILABLE_CODE,
  SURFACE_OPERATIONS,
  availablePanels,
  panelAvailability,
  panelContract,
} from "../src/trading/brokerPanels";
import { BROKER_CATALOG, ROUTED_BROKER_IDS, type BrokerId } from "../src/trading/brokerCatalog";
import { ALL_FEATURE_FLAGS, OPTIONS_PRODUCT_FLAG_PARENTS, SURFACE_FLAG_PARENTS } from "../src/features/featureFlagPorts";
import { isFeatureEnabled } from "../src/config/featureFlags";

describe("panel availability is derived from the catalog (#2853)", () => {
  it("answers for every broker and every surface", () => {
    for (const broker of ROUTED_BROKER_IDS) {
      for (const surface of BROKER_PANEL_SURFACES) {
        const availability = panelAvailability(broker, surface);
        expect(availability.broker).toBe(broker);
        expect(availability.surface).toBe(surface);
      }
    }
  });

  it("is available exactly when the catalog supports every required operation", () => {
    for (const broker of ROUTED_BROKER_IDS) {
      for (const surface of BROKER_PANEL_SURFACES) {
        const required = SURFACE_OPERATIONS[surface];
        const expected = required.every((op) => BROKER_CATALOG[broker].supports[op] === true);
        expect(panelAvailability(broker, surface).available, `${broker}/${surface}`).toBe(expected);
      }
    }
  });

  it("gives E*TRADE every surface — it is the broker the hub was written for", () => {
    expect(availablePanels("etrade")).toEqual([...BROKER_PANEL_SURFACES]);
  });

  it("gives Alpaca every surface it declares, and names the one it does not (#3359, #3434)", () => {
    // The catalogue, not this test, is the authority. Since #3359 the account
    // history surfaces are part of the contract; since #3434 Alpaca's own
    // watchlists are too. What remains absent is alerts — Alpaca exposes no
    // alerts API — and it is named, not blank.
    expect(availablePanels("alpaca")).toEqual(
      BROKER_PANEL_SURFACES.filter((surface) => surface !== "alerts"),
    );
    expect(panelAvailability("alpaca", "options").available).toBe(true);

    for (const surface of ["alerts"] as const) {
      const gap = panelAvailability("alpaca", surface);
      expect(gap.available, surface).toBe(false);
      expect(gap.code).toBe(BROKER_UNAVAILABLE_CODE);
      expect(gap.message).toContain("Alpaca");
    }
  });

  it("produces a coded, named refusal when the catalog says the broker cannot", () => {
    // The refusal path is exercised against the REAL function by temporarily
    // withdrawing a capability from the catalog — the same edit a future
    // broker change would make. Restored in `finally`, so no other test sees it.
    const original = BROKER_CATALOG.alpaca.supports.accounts;
    try {
      (BROKER_CATALOG.alpaca.supports as { accounts: boolean }).accounts = false;

      const refused = panelAvailability("alpaca", "accounts");
      expect(refused.available).toBe(false);
      expect(refused.code).toBe(BROKER_UNAVAILABLE_CODE);
      expect(refused.capability).toBe("accounts");
      expect(refused.message).toContain("Alpaca");
      expect(refused.message).toContain("does not provide accounts");
      expect(refused.message).toContain("No other broker's data");

      // The gate is per-surface: withdrawing accounts must not withdraw positions.
      expect(panelAvailability("alpaca", "positions").available).toBe(true);
      expect(availablePanels("alpaca")).not.toContain("accounts");
    } finally {
      (BROKER_CATALOG.alpaca.supports as { accounts: boolean }).accounts = original;
    }
  });

  it("prints the broker's own label in a refusal, never a generic one", () => {
    const original = BROKER_CATALOG.alpaca.supports.optionChains;
    try {
      (BROKER_CATALOG.alpaca.supports as { optionChains: boolean }).optionChains = false;
      const refused = panelAvailability("alpaca", "options");
      expect(refused.available).toBe(false);
      expect(refused.message).toContain(BROKER_CATALOG.alpaca.label);
      expect(refused.message).toContain("optionChains");
    } finally {
      (BROKER_CATALOG.alpaca.supports as { optionChains: boolean }).optionChains = original;
    }
  });

  it("does not let a broker be silently omitted from the contract", () => {
    for (const broker of Object.keys(BROKER_CATALOG) as BrokerId[]) {
      const contract = panelContract(broker);
      expect(contract).toHaveLength(BROKER_PANEL_SURFACES.length);
      expect(contract.every((a) => a.broker === broker)).toBe(true);
    }
  });
});

describe("the broker panel kill switch (#2853)", () => {
  const env = (vars: Record<string, string>) => vars as any;

  it("is a registered flag with its own environment variable", () => {
    expect(ALL_FEATURE_FLAGS).toContain("broker_panel_contract");
  });

  it("inherits options_screener when absent, without joining the options product map", () => {
    expect(SURFACE_FLAG_PARENTS.broker_panel_contract).toBe("options_screener");
    // The options map's meaning is pinned by options_product_slice1 (#2596):
    // "the parent and one flag per options sub-product". This flag is not one.
    expect(OPTIONS_PRODUCT_FLAG_PARENTS.broker_panel_contract).toBeUndefined();
    expect(Object.keys(OPTIONS_PRODUCT_FLAG_PARENTS)).toHaveLength(11);
  });

  it("reads ON when its own variable is on", async () => {
    expect(await isFeatureEnabled(env({ FEATURE_BROKER_PANEL_CONTRACT: "1" }), "broker_panel_contract")).toBe(true);
  });

  it("reads ON when only its parent is on", async () => {
    expect(await isFeatureEnabled(env({ FEATURE_OPTIONS_SCREENER: "1" }), "broker_panel_contract")).toBe(true);
  });

  it("lets an explicit OFF win over an enabled parent", async () => {
    expect(
      await isFeatureEnabled(
        env({ FEATURE_BROKER_PANEL_CONTRACT: "0", FEATURE_OPTIONS_SCREENER: "1" }),
        "broker_panel_contract",
      ),
    ).toBe(false);
  });
});
