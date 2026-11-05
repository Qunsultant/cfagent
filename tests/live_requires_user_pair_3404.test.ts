/**
 * Issue #3404 — deployment keys may trade paper, never live.
 *
 * The deployment pair is one Alpaca account shared by every tenant. It is the
 * fallback that lets the product open without setup, and it is fine for reads
 * and for paper. For LIVE it would let any signed-in user trade the operator's
 * account, so live requires the user's own verified pair.
 *
 * What these tests defend:
 *   1. Live + deployment keys refuses BEFORE anything reaches Alpaca, and says
 *      whose pair is missing.
 *   2. Paper + deployment keys is unchanged — no guard.
 *   3. Live + a stored user pair is allowed through the guard.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const stored = vi.hoisted(() => ({ record: null as null | { keyId: string; secretKey: string } }));

vi.mock("../src/trading/alpaca/credentialStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/trading/alpaca/credentialStore")>();
  return {
    ...actual,
    getAlpacaCredentials: async () => stored.record,
  };
});

import { AlpacaTradingPlatform } from "../src/trading/alpaca/platform";

const PAPER_ENV = {
  ALPACA_API_KEY: "paper-key",
  ALPACA_SECRET_KEY: "paper-secret",
  ALPACA_BASE_URL: "https://paper-api.alpaca.markets",
} as any;

const LIVE_ENV = {
  ALPACA_TRADING_TYPE: "live",
  ALPACA_LIVE_API_KEY: "live-key",
  ALPACA_LIVE_SECRET_KEY: "live-secret",
  ALPACA_LIVE_URL: "https://api.alpaca.markets",
} as any;

/** Any payload — the guard is evaluated before any order validation. */
const PREVIEW = {
  symbol: "AAPL",
  action: "BUY",
  quantity: 1,
  orderType: "MARKET",
} as any;

beforeEach(() => {
  stored.record = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function previewWith(env: any, login = "user@example.com") {
  const platform = new AlpacaTradingPlatform(env, undefined, login);
  try {
    await platform.previewOrder(PREVIEW);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe("live trading requires the user's own pair (#3404)", () => {
  it("refuses a live preview on the deployment's keys, naming the missing pair", async () => {
    const message = await previewWith(LIVE_ENV);
    expect(message).not.toBeNull();
    expect(message).toMatch(/your own Alpaca key pair/);
    expect(message).toMatch(/deployment's keys can trade paper only/);
  });

  it("reaches Alpaca on paper with the deployment's keys — no guard", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ account_number: "acct-1", status: "ACTIVE", equity: "1000" }),
      }) as any),
    );
    const message = await previewWith(PAPER_ENV);
    // Whatever the paper path does next, it must not be the live-trading refusal.
    expect(message ?? "").not.toMatch(/Live trading needs your own Alpaca key pair/);
  });

  it("allows a live preview once the user has stored their own pair", async () => {
    stored.record = { keyId: "user-live-key", secretKey: "user-live-secret" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => ({ account_number: "acct-live", status: "ACTIVE", equity: "1000" }),
      }) as any),
    );
    const message = await previewWith(LIVE_ENV);
    expect(message ?? "").not.toMatch(/Live trading needs your own Alpaca key pair/);
  });
});
