/**
 * Issue #4014 — the Alpaca option-chain tool.
 *
 * The copilot's broker is Alpaca, but its only chain path was the E*TRADE
 * options routes behind the tenant data-provider capability gate: with an
 * Alpaca data provider every chain read refused, so a multi-leg strategy
 * (PMCC) could not be priced at all. The platform already assembles the chain
 * (#3233); this tool exposes it, live-only and with no substitutes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const { getPlatform } = vi.hoisted(() => ({ getPlatform: vi.fn() }));

vi.mock("../src/trading", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    TradingPlatformRegistry: { getPlatform },
  };
});

import { AlpacaGetOptionChainCommand } from "../src/mcps/openaimp/marketDataCommands";

function context() {
  const audit = vi.fn();
  return { ctx: { env: {}, orm: {}, sessionId: "sess-1", audit } as never, audit };
}

const EXPIRIES = [
  { year: 2026, month: 11, day: 21 },
  { year: 2027, month: 12, day: 17 },
];

const CHAIN = {
  symbol: "QBTS",
  underlyingPrice: 9.5,
  pairs: [
    {
      call: {
        optionType: "CALL" as const,
        strikePrice: 11,
        symbol: "QBTS261217C00011000",
        bid: 5.2,
        ask: 5.6,
        lastPrice: 5.4,
      },
      put: {
        optionType: "PUT" as const,
        strikePrice: 11,
        symbol: "QBTS261217P00011000",
        bid: 3.1,
        ask: 3.4,
        lastPrice: 3.25,
      },
    },
  ],
};

describe("Issue #4014 — alpaca_get_option_chain", () => {
  beforeEach(() => getPlatform.mockReset());

  it("reads the chain and picks the earliest expiry when none is named", async () => {
    const getOptionExpireDates = vi.fn().mockResolvedValue(EXPIRIES);
    const getOptionChains = vi.fn().mockResolvedValue(CHAIN);
    getPlatform.mockReturnValue({ getOptionExpireDates, getOptionChains });
    const { ctx, audit } = context();

    const result = (await new AlpacaGetOptionChainCommand().execute(
      { symbol: "QBTS" },
      ctx,
    )) as Record<string, unknown>;

    expect(result.provider).toBe("alpaca");
    expect(result.provenance).toBe("live");
    expect(result.expiration).toBe("2026-11-21");
    expect((result.pairs as unknown[]).length).toBe(1);
    expect(result.underlyingPrice).toBe(9.5);
    expect(getOptionChains).toHaveBeenCalledWith(
      expect.objectContaining({ symbol: "QBTS", expiryYear: 2026, expiryMonth: 11, expiryDay: 21 }),
    );
    expect(audit).toHaveBeenCalledWith(
      "alpaca.option_chain_read",
      "trading",
      expect.objectContaining({ symbol: "QBTS", pairs: 1 }),
    );
  });

  it("throws an explicit unavailable error instead of inventing a chain", async () => {
    getPlatform.mockReturnValue({
      getOptionExpireDates: vi.fn().mockResolvedValue(EXPIRIES),
      getOptionChains: vi.fn().mockResolvedValue(null),
    });
    const { ctx } = context();

    await expect(
      new AlpacaGetOptionChainCommand().execute({ symbol: "QBTS" }, ctx),
    ).rejects.toThrow(/no option chain for QBTS/i);
  });

  it("names a platform without chain reads instead of throwing a TypeError", async () => {
    getPlatform.mockReturnValue({});
    const { ctx } = context();

    await expect(
      new AlpacaGetOptionChainCommand().execute({ symbol: "QBTS" }, ctx),
    ).rejects.toThrow(/does not expose an option chain/i);
  });
});
