/**
 * Issue #291 slice T5b — options data reads on the platform contract.
 *
 * Characterization: ETradeTradingPlatform's getOptionChains /
 * getOptionExpireDates are VERBATIM client passthroughs — the same
 * semantics ETradeService exposes today (its methods are one-line
 * delegations to the same client). No caching, fallback, or rewriting
 * may creep into this layer; the migration of caller sites depends on
 * byte-level equivalence.
 */

import { describe, it, expect } from "vitest";
import { ETradeTradingPlatform } from "../src/trading/etrade/platform";
import type { Env } from "../src/types";

const env = { ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env;

describe("ETradeTradingPlatform options data reads (#291 T5b)", () => {
  it("delegates chains and expire dates to the client verbatim", async () => {
    const calls: any[] = [];
    const chainResult = { symbol: "AAPL", underlyingPrice: 150 };
    const expiryResult = [{ year: 2027, month: 1, day: 15 }];
    const fakeClient = {
      getOptionChains: async (params: any) => {
        calls.push(["chains", params]);
        return chainResult;
      },
      getOptionExpireDates: async (symbol: string, expiryType?: string) => {
        calls.push(["expiries", symbol, expiryType]);
        return expiryResult;
      },
    } as any;
    const platform = new ETradeTradingPlatform(env, undefined, "default_trader", undefined, fakeClient);

    const params = { symbol: "AAPL", expiryYear: 2027, expiryMonth: 1, chainType: "CALLPUT" as const };
    await expect(platform.getOptionChains!(params)).resolves.toBe(chainResult);
    await expect(platform.getOptionExpireDates!("AAPL")).resolves.toBe(expiryResult);
    await expect(platform.getOptionExpireDates!("AAPL", "ALL")).resolves.toBe(expiryResult);
    expect(calls).toEqual([
      ["chains", params],
      ["expiries", "AAPL", undefined],
      ["expiries", "AAPL", "ALL"],
    ]);
  });

  it("the contract marks both reads optional, and Alpaca now implements them (#291 T5b, #3233)", async () => {
    // Optionality is a CONTRACT property: both reads are declared with `?`, so a
    // platform that omits them still satisfies ITradingPlatform. That invariant
    // is pinned against the interface source below, not against one broker.
    //
    // This test used to assert Alpaca omitted both reads — that was the gap
    // #3233 closed (options chains/expiries for Alpaca). A broker's gap must
    // never be re-pinned as if it were the contract rule.
    const { readFileSync } = await import("node:fs");
    const contract = readFileSync(new URL("../src/trading/interfaces.ts", import.meta.url), "utf8");
    expect(contract).toMatch(/getOptionChains\?\(/);
    expect(contract).toMatch(/getOptionExpireDates\?\(/);
    expect(contract).toMatch(/getQuoteDetailed\?\(/);

    const { AlpacaTradingPlatform } = await import("../src/trading/alpaca/platform");
    const alpaca: any = new AlpacaTradingPlatform(env, undefined, "default_trader");
    expect(typeof alpaca.getOptionChains).toBe("function");
    expect(typeof alpaca.getOptionExpireDates).toBe("function");
    expect(typeof alpaca.getQuoteDetailed).toBe("function");
  });

  it("getQuoteDetailed delegates verbatim, carrying the error (#291 Q1)", async () => {
    const ok = { quote: { symbol: "AAPL", lastPrice: 150 }, error: null };
    const bad = { quote: null, error: "OAuth token expired" };
    const fakeClient = {
      fetchQuoteDetailed: async (symbol: string) => (symbol === "AAPL" ? ok : bad),
    } as any;
    const platform = new ETradeTradingPlatform(env, undefined, "default_trader", undefined, fakeClient);
    await expect(platform.getQuoteDetailed!("AAPL")).resolves.toBe(ok);
    await expect(platform.getQuoteDetailed!("MSFT")).resolves.toBe(bad);
  });
});

describe("TradingPlatformRegistry overrideEnv plumbing (#291 T5c)", () => {
  it("passes the caller's requested environment through to the factory", async () => {
    const { TradingPlatformRegistry } = await import("../src/trading");
    const seen: unknown[] = [];
    TradingPlatformRegistry.register("fakeenv291" as any, ((_env: any, _orm: any, userLogin?: string, overrideEnv?: string) => {
      seen.push([userLogin, overrideEnv]);
      return { platformId: "fakeenv291" };
    }) as any);
    TradingPlatformRegistry.getPlatform("fakeenv291" as any, env, undefined, "alice", "sandbox");
    TradingPlatformRegistry.getPlatform("fakeenv291" as any, env, undefined, "alice");
    expect(seen).toEqual([
      ["alice", "sandbox"],
      ["alice", undefined],
    ]);
  });
});
