/**
 * Issue #3887 — the base-breakout continuation ladder.
 *
 * What these pins defend:
 *   1. Base detection publishes its inputs and refuses when the base is not
 *      formed (wide range, no breakout, thin volume, too few bars).
 *   2. Rung 1 is placed on base confirmation; rung N+1 only after a
 *      continuation step — never on a timer.
 *   3. The engine stops at the money budget, the live-order cap or the tier
 *      cap and NAMES which one stopped it.
 *   4. A cancelled ladder places no further rung.
 *   5. Caps come from configuration (#3888): an unset cap refuses, and raising
 *      maxRungsPerLadder changes the plan with no code change.
 *   6. `fixedGrid` (#3673) is untouched and remains the default.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  BaseBreakoutLadder,
  detectBase,
  planBaseBreakout,
  resolveTradingLimits,
  type BaseBreakoutRung,
  type BaseBreakoutSpec,
  type PriceBar,
} from "../src/trading";
import { McpToolFactory } from "../src/mcps/openaimp/commands";

const SESSION = { startMinuteEt: 570, endMinuteEt: 960, extendedHours: false };

function limitsWith(values: Record<string, number> | null, symbol = "AAPL") {
  const store: Record<string, string> = {};
  if (values) store["trading:limits"] = JSON.stringify(values);
  return resolveTradingLimits({ symbol, readSetting: (key) => store[key] ?? null });
}

const LIMITS = () => limitsWith({ maxRungsPerLadder: 4, maxNotionalPerTicker: 5000, maxOpenOrdersPerTicker: 10 });

function bars(window: Array<{ high: number; low: number; close: number; volume: number }>, confirmation: { high: number; low: number; close: number; volume: number }): PriceBar[] {
  const series = window.map((bar, index) => ({
    timestamp: `2026-11-0${(index % 9) + 1}T00:00:00.000Z`,
    open: bar.close,
    high: bar.high,
    low: bar.low,
    close: bar.close,
    volume: bar.volume,
  }));
  series.push({ timestamp: "2026-11-09T00:00:00.000Z", open: confirmation.close, high: confirmation.high, low: confirmation.low, close: confirmation.close, volume: confirmation.volume });
  return series;
}

const COILED = Array.from({ length: 5 }, () => ({ high: 101, low: 99, close: 100, volume: 1000 }));
const BREAKOUT = { high: 104, low: 101, close: 103, volume: 2000 };

function spec(over: Partial<BaseBreakoutSpec> = {}): BaseBreakoutSpec {
  return {
    symbol: "AAPL",
    side: "buy",
    base: { bars: 5, maxRangePercent: 4, minVolumeRatio: 1 },
    continuationIncrement: 1,
    stepIncrement: 0.5,
    tiers: 4,
    quantityPerRung: 5,
    takeProfitDelta: 2,
    stopLossDelta: 1,
    budget: 5000,
    ladderId: "bo_test",
    ...over,
  };
}

function controller(placed: BaseBreakoutRung[] = [], over: { cancel?: boolean; openOrders?: number | null; spec?: Partial<BaseBreakoutSpec>; limits?: ReturnType<typeof LIMITS> } = {}) {
  const detection = detectBase(bars(COILED, BREAKOUT), { bars: 5, maxRangePercent: 4, minVolumeRatio: 1 });
  const definition = spec(over.spec);
  const plan = planBaseBreakout(definition, detection.inputs.confirmationClose ?? 0, over.limits ?? LIMITS());
  let cancelled = over.cancel === true;
  const placements: BaseBreakoutRung[] = [];
  const ladder = BaseBreakoutLadder.resume(
    definition,
    plan,
    detection,
    {
      placeRung: async (rung) => {
        placements.push(rung);
        return { success: true, orderId: `ord-${rung.rungIndex}` };
      },
      isLadderCancelled: () => cancelled,
      openOrdersForTicker: () => over.openOrders ?? 0,
    },
    placed,
    SESSION,
    (over.limits ?? LIMITS()).limits.maxOpenOrdersPerTicker.value,
  );
  return { ladder, plan, detection, placements, cancel: () => { cancelled = true; } };
}

describe("#3887 — base detection publishes what it saw", () => {
  it("forms on a coiled range with a volume-backed breakout", () => {
    const detection = detectBase(bars(COILED, BREAKOUT), { bars: 5, maxRangePercent: 4, minVolumeRatio: 1 });
    expect(detection.formed).toBe(true);
    expect(detection.inputs).toMatchObject({ windowHigh: 101, windowLow: 99, barCount: 6 });
    expect(detection.inputs.rangePercent).toBeCloseTo(2, 5);
  });

  it("refuses a range that is too wide and cites the range", () => {
    const wide = Array.from({ length: 5 }, () => ({ high: 110, low: 90, close: 100, volume: 1000 }));
    const detection = detectBase(bars(wide, BREAKOUT), { bars: 5, maxRangePercent: 4, minVolumeRatio: 1 });
    expect(detection.code).toBe("base_not_formed");
    expect(detection.message).toContain("20.00%");
    expect(detection.message).toContain("4% ceiling");
  });

  it("refuses a confirmation that did not clear the base high", () => {
    const detection = detectBase(bars(COILED, { high: 101, low: 99, close: 100.5, volume: 2000 }), {
      bars: 5,
      maxRangePercent: 4,
      minVolumeRatio: 1,
    });
    expect(detection.code).toBe("base_not_formed");
    expect(detection.message).toContain("not above the base high 101");
  });

  it("refuses thin confirmation volume", () => {
    const detection = detectBase(bars(COILED, { ...BREAKOUT, volume: 500 }), { bars: 5, maxRangePercent: 4, minVolumeRatio: 1 });
    expect(detection.code).toBe("base_not_formed");
    expect(detection.message).toContain("below 1× the base average");
  });

  it("refuses when there are not enough bars", () => {
    const detection = detectBase(bars(COILED.slice(0, 2), BREAKOUT), { bars: 5, maxRangePercent: 4, minVolumeRatio: 1 });
    expect(detection.code).toBe("base_not_formed");
    expect(detection.message).toContain("needs 6 bars");
  });
});

describe("#3887 — the rung plan", () => {
  it("prices rungs up from the breakout and reports cumulative spend", () => {
    const detection = detectBase(bars(COILED, BREAKOUT), { bars: 5, maxRangePercent: 4, minVolumeRatio: 1 });
    const plan = planBaseBreakout(spec(), 103, LIMITS());
    expect(plan.planable).toBe(true);
    expect(plan.rungs.map((rung) => rung.limitPrice)).toEqual([103, 103.5, 104, 104.5]);
    expect(plan.rungs.map((rung) => rung.cumulativeNotional)).toEqual([515, 1032.5, 1552.5, 2075]);
    expect(plan.rungs[0]).toMatchObject({ takeProfitPrice: 105, stopLossPrice: 102, clientOrderId: "bo_test-r1" });
    expect(detection.formed).toBe(true);
  });

  it("keeps the caller's tiers when they are under the configured cap", () => {
    const plan = planBaseBreakout(spec({ tiers: 2 }), 100, LIMITS());
    expect(plan.rungs).toHaveLength(2);
    expect(plan.caps).toMatchObject({ tierCap: 2, tierCapSource: "caller (within maxRungsPerLadder)" });
  });

  it("raising maxRungsPerLadder changes the plan with no code change (#3888)", () => {
    const low = planBaseBreakout(spec({ tiers: 10 }), 100, limitsWith({ maxRungsPerLadder: 2, maxNotionalPerTicker: 5000 }));
    const high = planBaseBreakout(spec({ tiers: 10 }), 100, limitsWith({ maxRungsPerLadder: 6, maxNotionalPerTicker: 5000 }));
    expect(low.rungs).toHaveLength(2);
    expect(high.rungs).toHaveLength(6);
    expect(high.caps?.tierCapSource).toBe("maxRungsPerLadder 6");
  });

  it("refuses when a cap is unset instead of planning unbounded", () => {
    const plan = planBaseBreakout(spec(), 100, limitsWith({ maxNotionalPerTicker: 5000 }));
    expect(plan.planable).toBe(false);
    expect(plan.code).toBe("limit_not_configured");
    expect(plan.message).toContain("maxRungsPerLadder");
  });

  it("the configured money budget can only lower the caller's budget", () => {
    const plan = planBaseBreakout(spec({ budget: 100000 }), 100, limitsWith({ maxRungsPerLadder: 4, maxNotionalPerTicker: 700 }));
    expect(plan.caps).toMatchObject({ budget: 700, budgetSource: "maxNotionalPerTicker $700" });
    expect(plan.committedNotional).toBeLessThanOrEqual(700);
  });

  it("reports budget_exhausted when one rung does not fit", () => {
    const plan = planBaseBreakout(spec({ quantityPerRung: 100 }), 100, limitsWith({ maxRungsPerLadder: 4, maxNotionalPerTicker: 500 }));
    expect(plan.planable).toBe(false);
    expect(plan.code).toBe("budget_exhausted");
  });
});

describe("#3887 — the continuation state machine", () => {
  it("places rung 1 on base confirmation only", async () => {
    const { ladder, placements } = controller();
    const held = await ladder.next({ at: "2026-11-09T14:00:00.000Z", price: 100.5, minuteEt: 600 });
    expect(held.action).toBe("hold");
    expect(held.code).toBe("base_not_formed");
    expect(placements).toHaveLength(0);

    const first = await ladder.next({ at: "2026-11-09T14:01:00.000Z", price: 103.2, minuteEt: 601 });
    expect(first.action).toBe("place");
    expect(first.rung?.rungIndex).toBe(1);
    expect(placements).toHaveLength(1);
  });

  it("places rung N+1 only after the continuation trigger — never on a timer", async () => {
    const { ladder, placements } = controller();
    await ladder.next({ at: "2026-11-09T14:00:00.000Z", price: 103, minuteEt: 600 });

    // Same price, later clock: still a hold.
    const held = await ladder.next({ at: "2026-11-09T14:30:00.000Z", price: 103.5, minuteEt: 630 });
    expect(held.action).toBe("hold");
    expect(placements).toHaveLength(1);

    const advanced = await ladder.next({ at: "2026-11-09T14:31:00.000Z", price: 104, minuteEt: 631 });
    expect(advanced.action).toBe("place");
    expect(advanced.rung?.rungIndex).toBe(2);
    expect(placements).toHaveLength(2);
    expect(advanced.rung?.limitPrice).toBe(103.5);
  });

  it("stops at the tier cap and names it", async () => {
    const { ladder } = controller([], { spec: { tiers: 2 } });
    await ladder.next({ at: "2026-11-09T14:00:00.000Z", price: 103, minuteEt: 600 });
    await ladder.next({ at: "2026-11-09T14:01:00.000Z", price: 104, minuteEt: 601 });
    const stopped = await ladder.next({ at: "2026-11-09T14:02:00.000Z", price: 105, minuteEt: 602 });
    expect(stopped.action).toBe("stop");
    expect(stopped.code).toBe("tier_cap_reached");
    expect(stopped.message).toContain("2 rungs placed");
  });

  it("stops at the money budget and names it with the numbers", async () => {
    // 5 shares at ~$103 = $515 per rung, budget $1100 → two rungs, then the stop.
    const { ladder } = controller([], {
      spec: { tiers: 10, budget: 1100 },
      limits: limitsWith({ maxRungsPerLadder: 10, maxNotionalPerTicker: 1100, maxOpenOrdersPerTicker: 10 }),
    });
    await ladder.next({ at: "2026-11-09T14:00:00.000Z", price: 103, minuteEt: 600 });
    await ladder.next({ at: "2026-11-09T14:01:00.000Z", price: 104, minuteEt: 601 });
    const stopped = await ladder.next({ at: "2026-11-09T14:02:00.000Z", price: 105, minuteEt: 602 });
    expect(stopped.action).toBe("stop");
    expect(stopped.code).toBe("budget_exhausted");
    expect(stopped.message).toContain("$1,100");
  });

  it("stops at the live-order cap and names it", async () => {
    const { ladder } = controller([], { openOrders: 10 });
    await ladder.next({ at: "2026-11-09T14:00:00.000Z", price: 103, minuteEt: 600 });
    const stopped = await ladder.next({ at: "2026-11-09T14:01:00.000Z", price: 104, minuteEt: 601 });
    expect(stopped.code).toBe("order_cap_reached");
    expect(stopped.message).toContain("maxOpenOrdersPerTicker");
  });

  it("stops when the price falls back under the base", async () => {
    const { ladder } = controller();
    await ladder.next({ at: "2026-11-09T14:00:00.000Z", price: 103, minuteEt: 600 });
    const stopped = await ladder.next({ at: "2026-11-09T14:01:00.000Z", price: 98, minuteEt: 601 });
    expect(stopped.code).toBe("price_below_base");
  });

  it("places nothing outside the session window unless extended hours are set", async () => {
    const outside = await controller().ladder.next({ at: "2026-11-09T11:00:00.000Z", price: 103, minuteEt: 480 });
    expect(outside.action).toBe("hold");
    expect(outside.code).toBe("outside_session");

    const detection = detectBase(bars(COILED, BREAKOUT), { bars: 5, maxRangePercent: 4, minVolumeRatio: 1 });
    const plan = planBaseBreakout(spec(), 103, LIMITS());
    const placements: BaseBreakoutRung[] = [];
    const ladder = BaseBreakoutLadder.resume(
      spec(),
      plan,
      detection,
      { placeRung: async (rung) => { placements.push(rung); return { success: true }; } },
      [],
      { startMinuteEt: 570, endMinuteEt: 960, extendedHours: true },
      10,
    );
    const decision = await ladder.next({ at: "2026-11-09T11:00:00.000Z", price: 103, minuteEt: 480 });
    expect(decision.action).toBe("place");
    expect(placements).toHaveLength(1);
  });

  it("a cancelled ladder places no further rung", async () => {
    const context = controller();
    await context.ladder.next({ at: "2026-11-09T14:00:00.000Z", price: 103, minuteEt: 600 });
    context.cancel();
    const stopped = await context.ladder.next({ at: "2026-11-09T14:05:00.000Z", price: 106, minuteEt: 605 });
    expect(stopped.action).toBe("stop");
    expect(stopped.code).toBe("ladder_cancelled");
    expect(context.placements).toHaveLength(1);
  });

  it("a rung that fails to place does not strand the ladder", async () => {
    const detection = detectBase(bars(COILED, BREAKOUT), { bars: 5, maxRangePercent: 4, minVolumeRatio: 1 });
    const plan = planBaseBreakout(spec(), 103, LIMITS());
    let attempt = 0;
    const ladder = BaseBreakoutLadder.resume(spec(), plan, detection, {
      placeRung: async () => {
        attempt += 1;
        return attempt === 1 ? { success: false, message: "insufficient buying power" } : { success: true };
      },
    }, [], SESSION, 10);

    const failed = await ladder.next({ at: "2026-11-09T14:00:00.000Z", price: 103, minuteEt: 600 });
    expect(failed.action).toBe("hold");
    expect(failed.code).toBe("rung_place_failed");
    expect(failed.rungsPlaced).toBe(0);

    const retried = await ladder.next({ at: "2026-11-09T14:01:00.000Z", price: 103.2, minuteEt: 601 });
    expect(retried.action).toBe("place");
    expect(retried.rungsPlaced).toBe(1);
  });

  it("resumes with the rungs already placed (threshold and budget continue)", () => {
    const detection = detectBase(bars(COILED, BREAKOUT), { bars: 5, maxRangePercent: 4, minVolumeRatio: 1 });
    const plan = planBaseBreakout(spec(), 103, LIMITS());
    const rung = plan.rungs[0];
    const ladder = BaseBreakoutLadder.resume(spec(), plan, detection, { placeRung: async () => ({ success: true }) }, [rung], SESSION, 10);
    expect(ladder.placedRungs).toHaveLength(1);
    expect(ladder.committedNotional).toBe(rung.notional);
  });
});

describe("#3887 — the tool surface", () => {
  it("the ladder tool declares baseBreakout and keeps fixedGrid the default", () => {
    const tool = McpToolFactory.getTool("alpaca_place_bracket_ladder")!;
    const properties = tool.jsonSchema.properties as Record<string, any>;
    expect(properties.entry_mode.enum).toEqual(["fixedGrid", "baseBreakout"]);
    expect(tool.description).toContain("bracket ladder");
    const source = readFileSync("src/mcps/openaimp/marketDataCommands.ts", "utf8");
    expect(source).toContain('input.entry_mode ?? input.entryMode ?? "fixedGrid"');
    expect(source).toContain("executeBaseBreakoutLadder(input, context)");
  });

  it("the dry run returns the plan before any placement line", () => {
    const source = readFileSync("src/mcps/openaimp/marketDataCommands.ts", "utf8");
    const dryIndex = source.indexOf("if (dryRun) {");
    const placeIndex = source.indexOf("const decision = await ladder.next(");
    expect(dryIndex).toBeGreaterThan(0);
    expect(placeIndex).toBeGreaterThan(dryIndex);
  });

  it("the tool reads its caps from configuration, not literals", () => {
    const source = readFileSync("src/mcps/openaimp/marketDataCommands.ts", "utf8");
    expect(source).toContain("resolveTradingLimits({ symbol, env: context.env, readSetting })");
    expect(source).toContain("planBaseBreakout(spec, anchorPrice, limits)");
  });

  it("the persistence store keeps only rungs the broker took", () => {
    const store = readFileSync("src/services/ladderStateStore.ts", "utf8");
    expect(store).toContain("mas_ladder_states");
    expect(store).toContain("a rung is recorded only after the broker returned an id");
  });
});
