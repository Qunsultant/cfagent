import { describe, it, expect } from "vitest";
import { AlpacaPlaceOrderCommand } from "../src/mcps/openaimp/marketDataCommands";

describe("Gap 15 — GTD accepted by Alpaca MCP schema (#4669)", () => {
  it("accepts time_in_force='gtd' in both jsonSchema and zodSchema", () => {
    const cmd = new AlpacaPlaceOrderCommand({} as never);
    const tifProp = cmd.jsonSchema.properties.time_in_force as { enum?: readonly string[] };
    expect(tifProp.enum).toContain("gtd");

    const parsed = cmd.zodSchema.parse({
      symbol: "AAPL",
      qty: 1,
      side: "buy",
      type: "limit",
      limit_price: 180,
      time_in_force: "gtd",
      good_till_date: "2026-12-31T21:00:00Z",
    });
    expect(parsed.time_in_force).toBe("gtd");
    expect(parsed.good_till_date).toBe("2026-12-31T21:00:00Z");
  });
});
