/**
 * Issue #3892 — the declarative advanced/complex order-type registry.
 *
 * What these pins defend:
 *   1. One table is the source for schema, validation and refusals: every
 *      broker/type pair the platform claims is declared exactly once.
 *   2. Support is explicit per broker: `native`, `emulated` or `none`, and a
 *      `none` is a NAMED refusal — never a silently simpler order.
 *   3. Required params, mutual exclusions and TIF constraints are enforced by
 *      the validator, with a coded refusal naming the supported set.
 *   4. The copilot can enumerate what a broker can and cannot place, with the
 *      reason (through the `trading_limits` introspection).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  ADVANCED_ORDER_TYPES,
  advancedOrderType,
  describeAdvancedOrderTypes,
  validateAdvancedOrder,
  validateReplaceOrder,
} from "../src/trading";
import { McpToolFactory } from "../src/mcps/openaimp/commands";
import { MockSqlStorage } from "./mock-sql";

describe("#3892 — one registry, every type", () => {
  it("declares every type the module names, exactly once", () => {
    const ids = ADVANCED_ORDER_TYPES.map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const required of [
      "market",
      "limit",
      "stop",
      "stop_limit",
      "bracket",
      "oco",
      "oto",
      "trailing_stop",
      "trailing_stop_limit",
      "notional",
      "gtd",
      "session_timed",
      "mleg",
      "vertical",
      "straddle",
      "strangle",
      "condor",
      "butterfly",
      "calendar",
      "covered_call",
      "cash_secured_put",
      "protective_exit",
      "scale_out",
      "replace",
    ]) {
      expect(ids).toContain(required);
    }
  });

  it("every entry declares both brokers and a refusal code", () => {
    for (const entry of ADVANCED_ORDER_TYPES) {
      expect(["native", "emulated", "none"]).toContain(entry.broker.alpaca);
      expect(["native", "emulated", "none"]).toContain(entry.broker.etrade);
      expect(entry.refusalCode.length).toBeGreaterThan(0);
      expect(entry.label.length).toBeGreaterThan(0);
    }
  });

  it("a bracket is day-only (#3839)", () => {
    expect(advancedOrderType("bracket")?.tif).toEqual(["day"]);
    const refused = validateAdvancedOrder({ type: "bracket", broker: "alpaca", params: { take_profit: {}, stop_loss: {}, time_in_force: "gtc" } });
    expect(refused).toMatchObject({ ok: false, code: "order_tif_unsupported" });
    if (refused.ok) return;
    expect(refused.message).toContain("day-only");
  });
});

describe("#3892 — no silent downgrade", () => {
  it("refuses a trailing stop on a broker that cannot place one, naming the supported set", () => {
    const refused = validateAdvancedOrder({ type: "trailing_stop", broker: "etrade", params: { trail_percent: 5 } });
    expect(refused).toMatchObject({ ok: false, code: "order_type_unsupported" });
    if (refused.ok) return;
    expect(refused.message).toContain("trailing_stop @ etrade");
    expect(refused.message).toContain("supported:");
    expect(refused.message).toContain("market");
  });

  it("refuses session-timed orders on both brokers instead of emulating them", () => {
    for (const broker of ["alpaca", "etrade"] as const) {
      const refused = validateAdvancedOrder({ type: "session_timed", broker, params: { time_in_force: "opg" } });
      expect(refused.ok).toBe(false);
    }
  });

  it("refuses an unknown type with the known list", () => {
    const refused = validateAdvancedOrder({ type: "iceberg", broker: "alpaca" });
    expect(refused).toMatchObject({ ok: false, code: "order_type_unknown" });
    if (refused.ok) return;
    expect(refused.message).toContain("trailing_stop");
  });

  it("enforces mutual exclusions and required params", () => {
    expect(validateAdvancedOrder({ type: "notional", broker: "alpaca", params: { qty: 1, notional: 500 } })).toMatchObject({
      ok: false,
      code: "conflicting_order_parameters",
    });
    expect(validateAdvancedOrder({ type: "limit", broker: "alpaca", params: {} })).toMatchObject({
      ok: false,
      code: "missing_order_parameter",
    });
    expect(validateAdvancedOrder({ type: "gtd", broker: "alpaca", params: { time_in_force: "gtd" } })).toMatchObject({
      ok: false,
      code: "missing_order_parameter",
    });
    expect(
      validateAdvancedOrder({ type: "trailing_stop", broker: "alpaca", params: { trail_price: 1, trail_percent: 2 } }),
    ).toMatchObject({ ok: false, code: "conflicting_order_parameters" });
  });

  it("accepts the types a broker does support", () => {
    expect(validateAdvancedOrder({ type: "trailing_stop", broker: "alpaca", params: { trail_percent: 5 } })).toMatchObject({
      ok: true,
      support: "native",
    });
    expect(validateAdvancedOrder({ type: "notional", broker: "alpaca", params: { notional: 250 } })).toMatchObject({ ok: true });
    expect(
      validateAdvancedOrder({ type: "gtd", broker: "alpaca", params: { time_in_force: "gtd", good_till_date: "2026-12-01T20:00:00Z" } }),
    ).toMatchObject({ ok: true });
  });
});

describe("#3892 — replace never detaches a parent's legs", () => {
  it("allows replacing a simple order on Alpaca", () => {
    expect(validateReplaceOrder({ broker: "alpaca", orderClass: "simple" })).toEqual({ ok: true });
  });

  it("refuses a compound parent and says why", () => {
    const refused = validateReplaceOrder({ broker: "alpaca", orderClass: "bracket" });
    expect(refused).toMatchObject({ ok: false, code: "replace_parent_unsupported" });
    if (refused.ok) return;
    expect(refused.message).toContain("detach");
  });

  it("refuses replace on a broker without it", () => {
    expect(validateReplaceOrder({ broker: "etrade", orderClass: "simple" })).toMatchObject({ ok: false, code: "replace_not_supported" });
  });
});

describe("#3892 — the copilot enumerates per broker", () => {
  it("describes available and refused types with reasons", () => {
    const alpaca = describeAdvancedOrderTypes("alpaca");
    const etrade = describeAdvancedOrderTypes("etrade");
    expect(alpaca.available.map((entry) => entry.id)).toContain("trailing_stop");
    expect(etrade.refused.map((entry) => entry.id)).toContain("trailing_stop");
    expect(etrade.refused.find((entry) => entry.id === "trailing_stop")?.reason).toContain("not available on etrade");
    expect(alpaca.available.find((entry) => entry.id === "trailing_stop")?.support).toBe("native");
  });

  it("the trading_limits tool returns the enumeration", async () => {
    const tool = McpToolFactory.getTool("trading_limits")!;
    const payload = (await tool.execute(
      {},
      { env: {} as any, orm: { getSql: () => new MockSqlStorage() } as any, sessionId: "s1" } as any,
    )) as any;
    expect(payload.orderTypes.alpaca.available.length).toBeGreaterThan(0);
    expect(payload.orderTypes.etrade.refused.length).toBeGreaterThan(0);
  });

  it("the tool schema the caller sees is declared in one place", () => {
    const source = readFileSync("src/trading/advancedOrders.ts", "utf8");
    expect(source).toContain("export const ADVANCED_ORDER_TYPES");
    expect(source).toContain("describeAdvancedOrderTypes");
  });
});
