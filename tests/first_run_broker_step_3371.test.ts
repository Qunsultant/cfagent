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
  const etrade = { broker: "etrade", label: "E*TRADE", credentialKind: "oauth1_per_login" } as const;
  const alpaca = { broker: "alpaca", label: "Alpaca", credentialKind: "api_key_pair" } as const;

  it("keeps E*TRADE's OAuth connect in the wizard", () => {
    expect(firstRunBrokerStep(etrade)).toEqual({
      broker: "etrade",
      label: "E*TRADE",
      mode: "oauth",
      connectsInWizard: true,
    });
  });

  it("points an Alpaca tenant at the panel, not at an E*TRADE authorization", () => {
    expect(firstRunBrokerStep(alpaca)).toEqual({
      broker: "alpaca",
      label: "Alpaca",
      mode: "key_pair",
      connectsInWizard: false,
    });
  });

  it("does not offer E*TRADE's authorization for an unrecognised selection", () => {
    // The hub renders Alpaca's panel for anything that is not "etrade"; the
    // wizard must not contradict it by offering an E*TRADE redirect.
    expect(firstRunBrokerStep({ broker: "sandbox", label: "Alpaca", credentialKind: "api_key_pair" })).toEqual(
      firstRunBrokerStep(alpaca),
    );
    expect(firstRunBrokerStep({ broker: undefined, label: "Alpaca", credentialKind: "api_key_pair" }).connectsInWizard).toBe(
      false,
    );
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
