/**
 * Issue #3272 (S4): paper/live is a choice for BOTH brokers.
 *
 * The defect this pins: `TradingPlatformRegistry.register("alpaca", (env, orm,
 * userLogin) => new AlpacaTradingPlatform(env, orm, userLogin))` dropped
 * `overrideEnv`, so the hub's TEST/PROD switch — the one control that names the
 * trading type — could never reach Alpaca. `paper` was an inference from which
 * env keys happened to be set, not a selection.
 *
 * The precedence fixed here, in order:
 *   1. `ALPACA_TRADING_TYPE` — a deployment pin. An operator who pins paper
 *      cannot be pushed live by a UI click.
 *   2. the persisted selection (TEST → paper, PROD → live), the same mapping
 *      the catalog declares for every broker (#3232).
 *   3. `ALPACA_BASE_URL` inference, which preserves legacy behaviour.
 *
 * `source` is part of the return value so status, account mapping and order
 * placement can all say WHY they think they are paper or live.
 */
import { describe, it, expect } from "vitest";
import { resolveAlpacaTradingBase } from "../src/trading/alpaca/platform";
import "../src/trading";
import { TradingPlatformRegistry } from "../src/trading/registry";

const env = (vars: Record<string, string> = {}) => vars as any;

describe("the persisted selection drives Alpaca's trading type (#3272)", () => {
  it("TEST selects the paper host", () => {
    const resolved = resolveAlpacaTradingBase(env(), "TEST");
    expect(resolved.isLive).toBe(false);
    expect(resolved.baseUrl).toContain("paper-api");
    expect(resolved.source).toBe("selection");
  });

  it("PROD selects the live host", () => {
    const resolved = resolveAlpacaTradingBase(env(), "PROD");
    expect(resolved.isLive).toBe(true);
    expect(resolved.baseUrl).not.toContain("paper-api");
    expect(resolved.source).toBe("selection");
  });

  it("PROD honours an explicit live base URL", () => {
    const resolved = resolveAlpacaTradingBase(env({ ALPACA_BASE_URL: "https://api.alpaca.markets" }), "PROD");
    expect(resolved.baseUrl).toBe("https://api.alpaca.markets");
    expect(resolved.isLive).toBe(true);
  });

  it("TEST never lands on a live host, even with a live base URL configured", () => {
    const resolved = resolveAlpacaTradingBase(env({ ALPACA_BASE_URL: "https://api.alpaca.markets" }), "TEST");
    expect(resolved.baseUrl).toContain("paper-api");
    expect(resolved.isLive).toBe(false);
  });
});

describe("a deployment pin outranks the UI selection (#3272)", () => {
  it("ALPACA_TRADING_TYPE=paper holds against a PROD selection", () => {
    const resolved = resolveAlpacaTradingBase(env({ ALPACA_TRADING_TYPE: "paper" }), "PROD");
    expect(resolved.isLive).toBe(false);
    expect(resolved.source).toBe("pin");
  });

  it("ALPACA_TRADING_TYPE=live holds against a TEST selection", () => {
    const resolved = resolveAlpacaTradingBase(env({ ALPACA_TRADING_TYPE: "live" }), "TEST");
    expect(resolved.isLive).toBe(true);
    expect(resolved.source).toBe("pin");
  });
});

describe("without a pin or a selection, legacy inference stands (#3272)", () => {
  it("defaults to paper", () => {
    const resolved = resolveAlpacaTradingBase(env());
    expect(resolved.isLive).toBe(false);
    expect(resolved.source).toBe("inference");
  });

  it("a live base URL alone still means live", () => {
    const resolved = resolveAlpacaTradingBase(env({ ALPACA_BASE_URL: "https://api.alpaca.markets" }));
    expect(resolved.isLive).toBe(true);
    expect(resolved.source).toBe("inference");
  });

  it("an unknown selection is ignored rather than guessed", () => {
    const resolved = resolveAlpacaTradingBase(env(), "STAGING");
    expect(resolved.source).toBe("inference");
    expect(resolved.isLive).toBe(false);
  });
});

describe("the registry passes the selection through to Alpaca (#3272)", () => {
  it("constructs the platform with the caller's environment", () => {
    const platform = TradingPlatformRegistry.getPlatform(
      "alpaca",
      env({ ALPACA_API_KEY: "k", ALPACA_SECRET_KEY: "s" }),
      undefined,
      "user-1",
      "TEST",
    ) as any;
    // The override is what makes `paper` a choice rather than a guess.
    expect(platform.overrideEnv).toBe("TEST");
  });
});
