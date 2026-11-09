/**
 * Issue #3892 — named option strategies compose the right legs.
 *
 * Six verified examples (vertical, straddle, strangle, condor, butterfly,
 * calendar), each asserted on leg count, sides, strikes, ratios and expiries —
 * the legs a caller would otherwise hand-build (and get wrong).
 *
 * Covered call / cash-secured put refuse when the collateral is not there:
 * a "covered" call without the shares is a naked call, and the platform never
 * places one by accident.
 */
import { describe, it, expect } from "vitest";
import {
  buildNamedOptionStrategy,
  validateCashSecuredPut,
  validateCoveredCall,
} from "../src/trading";

const BASE = { underlying: "AAPL", expiry: "2026-12-19", strikes: [] as number[] };

describe("#3892 — named strategies build their legs", () => {
  it("vertical: buy the lower strike, sell the higher", () => {
    const built = buildNamedOptionStrategy("vertical", { ...BASE, strikes: [200, 210], optionType: "call" });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.legs).toEqual([
      { action: "buy", optionType: "call", strike: 200, expiry: "2026-12-19", ratio: 1 },
      { action: "sell", optionType: "call", strike: 210, expiry: "2026-12-19", ratio: 1 },
    ]);
  });

  it("straddle: one strike, both rights, both bought", () => {
    const built = buildNamedOptionStrategy("straddle", { ...BASE, strikes: [200] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.legs.map((leg) => `${leg.action} ${leg.optionType} ${leg.strike}`)).toEqual([
      "buy call 200",
      "buy put 200",
    ]);
  });

  it("strangle: buy the put below and the call above", () => {
    const built = buildNamedOptionStrategy("strangle", { ...BASE, strikes: [190, 210] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.legs.map((leg) => `${leg.action} ${leg.optionType} ${leg.strike}`)).toEqual([
      "buy put 190",
      "buy call 210",
    ]);
  });

  it("condor: four strikes in wing/body/body/wing order", () => {
    const built = buildNamedOptionStrategy("condor", { ...BASE, strikes: [180, 190, 210, 220] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.legs.map((leg) => `${leg.action} ${leg.optionType} ${leg.strike}`)).toEqual([
      "buy put 180",
      "sell put 190",
      "sell call 210",
      "buy call 220",
    ]);
    expect(built.legs).toHaveLength(4);
  });

  it("butterfly: two bodies sold against the wings", () => {
    const built = buildNamedOptionStrategy("butterfly", { ...BASE, strikes: [190, 200, 210] });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.legs.map((leg) => `${leg.action} ${leg.optionType} ${leg.strike} x${leg.ratio}`)).toEqual([
      "buy call 190 x1",
      "sell call 200 x2",
      "buy call 210 x1",
    ]);
  });

  it("calendar: same strike, two expiries", () => {
    const built = buildNamedOptionStrategy("calendar", {
      ...BASE,
      strikes: [200],
      longExpiry: "2027-01-15",
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.legs).toEqual([
      { action: "sell", optionType: "call", strike: 200, expiry: "2026-12-19", ratio: 1 },
      { action: "buy", optionType: "call", strike: 200, expiry: "2027-01-15", ratio: 1 },
    ]);
  });

  it("refuses missing or wrong-shaped parameters instead of guessing strikes", () => {
    expect(buildNamedOptionStrategy("condor", { ...BASE, strikes: [200, 210] })).toMatchObject({ ok: false });
    expect(buildNamedOptionStrategy("calendar", { ...BASE, strikes: [200] })).toMatchObject({ ok: false });
    expect(buildNamedOptionStrategy("calendar", { ...BASE, strikes: [200], longExpiry: "2026-12-19" })).toMatchObject({
      ok: false,
    });
    expect(buildNamedOptionStrategy("straddle", { ...BASE, underlying: "", strikes: [200] })).toMatchObject({ ok: false });
  });
});

describe("#3892 — collateral checks", () => {
  it("a covered call needs the shares", () => {
    expect(validateCoveredCall({ shares: 300, contracts: 3, strike: 210 })).toMatchObject({ ok: true, coveredContracts: 3 });
    const refused = validateCoveredCall({ shares: 150, contracts: 2, strike: 210 });
    expect(refused).toMatchObject({ ok: false, code: "covered_call_shares_missing" });
    if (refused.ok) return;
    expect(refused.message).toContain("need 200 shares");
    expect(validateCoveredCall({ shares: 0, contracts: 1, strike: 210 })).toMatchObject({ ok: false });
  });

  it("a cash-secured put needs strike × 100 × contracts of cash", () => {
    expect(validateCashSecuredPut({ buyingPower: 25000, strike: 200, contracts: 1 })).toMatchObject({
      ok: true,
      requiredCollateral: 20000,
    });
    const refused = validateCashSecuredPut({ buyingPower: 15000, strike: 200, contracts: 1 });
    expect(refused).toMatchObject({ ok: false, code: "cash_secured_put_collateral_short" });
    if (refused.ok) return;
    expect(refused.message).toContain("$20,000");
    expect(refused.message).toContain("$15,000");
  });
});
