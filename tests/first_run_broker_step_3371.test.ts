/**
 * Issue #3371 — first-run step 3 asks the selected broker.
 *
 * What these tests defend:
 *   1. The wizard's connect step is decided by the catalogue's credential kind,
 *      not by a broker name written into the screen.
 *   2. A key-pair broker (Alpaca) never gets the OAuth branch: no status poll, no
 *      redirect, and the copy names where the sign-in actually happens.
 *   3. E*TRADE is unchanged — its status read and Connect button still exist.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { firstRunBrokerStep } from "../src/client/firstRunBrokerStep";

describe("first-run step 3 follows the broker (#3371)", () => {
  it("keeps E*TRADE's OAuth connect in the wizard", () => {
    expect(firstRunBrokerStep("etrade")).toEqual({
      broker: "etrade",
      label: "E*TRADE",
      mode: "oauth",
      connectsInWizard: true,
    });
  });

  it("points an Alpaca tenant at the panel, not at an E*TRADE authorization", () => {
    expect(firstRunBrokerStep("alpaca")).toEqual({
      broker: "alpaca",
      label: "Alpaca",
      mode: "key_pair",
      connectsInWizard: false,
    });
  });

  it("treats an unknown selection as E*TRADE, as every other consumer does", () => {
    expect(firstRunBrokerStep("sandbox")).toEqual(firstRunBrokerStep("etrade"));
    expect(firstRunBrokerStep(undefined)).toEqual(firstRunBrokerStep("etrade"));
  });
});

describe("the screen uses the decision (#3371)", () => {
  const source = readFileSync("src/client/FirstRunScreen.tsx", "utf8");

  it("does not poll E*TRADE status for a broker the wizard cannot connect", () => {
    expect(source).toContain("if (!brokerStep.connectsInWizard) return;");
  });

  it("offers Continue instead of a redirect for a key-pair broker", () => {
    expect(source).toContain("{!brokerStep.connectsInWizard ? (");
    expect(source).toContain("the trading view");
  });

  it("keeps the E*TRADE path intact", () => {
    expect(source).toContain("onClick={connectBrokerage}");
    expect(source).toContain("fetchETradeStatus");
    expect(source).toContain("startETradeOAuth");
  });
});
