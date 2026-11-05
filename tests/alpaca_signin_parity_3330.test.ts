/**
 * Issue #3330: Alpaca signs in with the credentials the deployment writes.
 *
 * The deploy sets `ALPACA_PAPER_*` / `ALPACA_LIVE_*`; the adapter read the
 * generic `ALPACA_API_KEY` / `ALPACA_SECRET_KEY` / `ALPACA_BASE_URL`. Nothing
 * mapped the two, so a deployed Worker reported Alpaca unconfigured — sign-in
 * parity failed before any surface was reached.
 *
 * What these tests defend:
 *   1. The side is decided ONCE (pin → selection → inference) and only that
 *      side's pair is mapped; a generic value already present always wins and
 *      the input env is never mutated.
 *   2. A deployed Worker therefore reports configured, with the right trading
 *      type, without any other change.
 *   3. The connect surface is told which credential kind the broker uses, and
 *      which deployment variables to name — from the catalogue, not a UI list.
 */
import { describe, it, expect } from "vitest";

import { AlpacaTradingPlatform, resolveAlpacaTradingBase } from "../src/trading/alpaca/platform";
import { alpacaTradingSide, withAlpacaCredentials } from "../src/trading/alpaca/credentials";
import { brokerCredentialGuidance, ROUTED_BROKER_IDS } from "../src/trading/brokerCatalog";

const deployed = {
  ALPACA_PAPER_API_KEY: "paper-key-not-a-secret",
  ALPACA_PAPER_SECRET_KEY: "paper-secret",
  ALPACA_PAPER_URL: "https://paper-api.alpaca.markets",
  ALPACA_LIVE_API_KEY: "live-key-not-a-secret",
  ALPACA_LIVE_SECRET_KEY: "live-secret",
  ALPACA_LIVE_URL: "https://api.alpaca.markets",
} as any;

describe("the deployed names map onto the ones the code reads (#3330)", () => {
  it("maps the paper pair for a TEST selection", () => {
    const env = withAlpacaCredentials(deployed, "TEST");
    expect(env.ALPACA_API_KEY).toBe("paper-key-not-a-secret");
    expect(env.ALPACA_SECRET_KEY).toBe("paper-secret");
    expect(env.ALPACA_BASE_URL).toBe("https://paper-api.alpaca.markets");
  });

  it("maps the live pair for a PROD selection", () => {
    const env = withAlpacaCredentials(deployed, "PROD");
    expect(env.ALPACA_API_KEY).toBe("live-key-not-a-secret");
    expect(env.ALPACA_BASE_URL).toBe("https://api.alpaca.markets");
  });

  it("a deployment pin wins over the selection", () => {
    const env = withAlpacaCredentials({ ...deployed, ALPACA_TRADING_TYPE: "paper" } as any, "PROD");
    expect(env.ALPACA_API_KEY).toBe("paper-key-not-a-secret");
  });

  it("a generic value already present wins", () => {
    const env = withAlpacaCredentials({ ...deployed, ALPACA_API_KEY: "generic" } as any, "PROD");
    expect(env.ALPACA_API_KEY).toBe("generic");
  });

  it("never mutates the input env", () => {
    const input = { ...deployed };
    withAlpacaCredentials(input as any, "TEST");
    expect(input.ALPACA_API_KEY).toBeUndefined();
  });

  it("leaves an env with no deployed names untouched", () => {
    const generic = { ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" } as any;
    expect(withAlpacaCredentials(generic, "TEST")).toBe(generic);
  });

  it("the side resolver agrees with the base resolver", () => {
    expect(alpacaTradingSide(deployed, "TEST")).toBe("paper");
    expect(alpacaTradingSide(deployed, "PROD")).toBe("live");
    expect(resolveAlpacaTradingBase(withAlpacaCredentials(deployed, "PROD") as any, "PROD").isLive).toBe(true);
    expect(resolveAlpacaTradingBase(withAlpacaCredentials(deployed, "TEST") as any, "TEST").isLive).toBe(false);
  });
});

describe("a deployed Worker now reports Alpaca configured (#3330)", () => {
  it("is configured with only the deployed paper names present", async () => {
    const platform = new AlpacaTradingPlatform(deployed, undefined, "user-1", "TEST");
    const status = await platform.getStatus();
    expect(status.configured).toBe(true);
    expect(status.broker).toBe("alpaca");
    expect(status.environment).toBe("paper");
  });

  it("reports live for a PROD selection", async () => {
    const platform = new AlpacaTradingPlatform(deployed, undefined, "user-1", "PROD");
    const status = await platform.getStatus();
    expect(status.configured).toBe(true);
    expect(status.environment).toBe("live");
  });

  it("without any credentials it stays honestly unconfigured", async () => {
    const platform = new AlpacaTradingPlatform({} as any, undefined, "user-2", "TEST");
    const status = await platform.getStatus();
    expect(status.configured).toBe(false);
  });
});

describe("the connect surface is told the broker's credential kind (#3330)", () => {
  it("Alpaca is an API key pair with deployment-named variables", () => {
    const guidance = brokerCredentialGuidance("alpaca");
    expect(guidance.kind).toBe("api_key_pair");
    expect(guidance.envNames.paper).toContain("ALPACA_PAPER_API_KEY");
    expect(guidance.envNames.live).toContain("ALPACA_LIVE_SECRET_KEY");
    expect(guidance.summary).toContain("API key pair");
  });

  it("E*TRADE stays OAuth, and its guidance asks for no environment pair", () => {
    const guidance = brokerCredentialGuidance("etrade");
    expect(guidance.kind).toBe("oauth1_per_login");
    expect(guidance.envNames.paper).toEqual([]);
    expect(guidance.summary).toContain("OAuth");
  });

  it("every broker answers, so a new broker cannot omit the connect contract", () => {
    for (const broker of ROUTED_BROKER_IDS) {
      const guidance = brokerCredentialGuidance(broker);
      expect(typeof guidance.kind).toBe("string");
      expect(guidance.summary.length).toBeGreaterThan(0);
    }
  });
});
