/**
 * Issue #5190 — the Copilot screen tool takes an explicit run target and states
 * it back. The venue itself is pinned by the context tests (#5188/#5189); this
 * pins the tool contract.
 */
import { describe, expect, it } from "vitest";
import { RunOptionsStrategyScreenCommand } from "../src/mcps/openaimp/meshDoorCommands";

const command = new RunOptionsStrategyScreenCommand();

describe("run_options_strategy_screen run target (#5190)", () => {
  it("accepts broker, mode and account", () => {
    const parsed = command.zodSchema.parse({
      universe: "NASDAQ100",
      broker: "alpaca",
      mode: "paper",
      accountId: "acct-1",
    });

    expect(parsed).toMatchObject({ broker: "alpaca", mode: "paper", accountId: "acct-1" });
  });

  it("refuses a broker that serves no option chains", () => {
    expect(() => command.zodSchema.parse({ broker: "tastytrade" })).toThrow();
  });

  it("keeps the fields optional, so every existing call site is unchanged", () => {
    expect(command.zodSchema.parse({ universe: "SP500" })).toEqual({ universe: "SP500" });
  });

  it("describes the broker argument in the published JSON schema", () => {
    const broker = (command.jsonSchema as any).properties.broker;

    expect(broker.enum).toEqual(["etrade", "alpaca", "public"]);
    expect(String(broker.description)).toContain("option chains");
  });
});
