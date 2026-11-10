/**
 * Issue #2599 (F1 only): options auth freshness — the token
 * freshness probe, the documented degraded mode, and the
 * never-Yahoo-chains rule.
 *
 * Pins:
 * - classifyChainFreshness: fresh at/below the threshold, stale
 *   past it, unknown when the scan timestamp is missing or
 *   unparseable (never guessed), with labels that always name the
 *   stale/unknown state (degraded, labelled).
 * - guardManualOptionsAuth: the scheduled verify → renew → block
 *   policy applied to manual panel runs — fresh proceeds, expired
 *   + renewed proceeds, expired + unrenewable blocks with a
 *   catalog-coded 401 and "No scan ran", no-session in PROD blocks
 *   the same way, non-PROD no-tokens keeps pass-through, and a
 *   guard-internal failure fails OPEN (never takes the run down).
 *   A blocked manual error never claims an alert was sent: the
 *   manual guard sends none (the 401 is the notice; the scheduled
 *   guard keeps one-alert-per-episode).
 * - Yahoo declares quotes / historicalBars / fundamentals / news
 *   only — no optionsChains — so no options path may substitute
 *   Yahoo data for broker chains.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_OPTIONS_CHAIN_MAX_AGE_MINUTES,
  classifyChainFreshness,
  guardManualOptionsAuth,
  panelAuthResponse,
} from "../src/services/optionsAuthFreshness";
import type { ETradeAuthPreflightDeps } from "../src/services/etradeAuthPreflight";
import { createYahooDataProvider } from "../src/trading/dataProviders/adapters";
import { recordStrategyScreenRun } from "../src/services/optionsServeRecord";

function deps(over: Partial<ETradeAuthPreflightDeps>): ETradeAuthPreflightDeps {
  return {
    getTokens: async () => ({ storedAt: "2026-10-23T14:00:00.000Z" }),
    renew: async () => ({ storedAt: "2026-10-23T15:00:00.000Z" }),
    isExpired: () => false,
    now: () => Date.parse("2026-10-23T15:00:00.000Z"),
    ...over,
  };
}

const NOW = Date.parse("2026-10-23T15:00:00.000Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

describe("classifyChainFreshness", () => {
  it("a 2-minute-old snapshot is fresh and labelled live", () => {
    const f = classifyChainFreshness(minutesAgo(2), NOW);
    expect(f.state).toBe("fresh");
    expect(f.ageMinutes).toBe(2);
    expect(f.label).toMatch(/live/);
  });

  it("exactly at the default threshold is still fresh (inclusive boundary)", () => {
    expect(DEFAULT_OPTIONS_CHAIN_MAX_AGE_MINUTES).toBe(15);
    const f = classifyChainFreshness(
      minutesAgo(DEFAULT_OPTIONS_CHAIN_MAX_AGE_MINUTES),
      NOW,
    );
    expect(f.state).toBe("fresh");
    expect(f.ageMinutes).toBe(15);
  });

  it("one minute past the threshold is stale and the label names age, threshold, and degraded mode", () => {
    const f = classifyChainFreshness(minutesAgo(16), NOW);
    expect(f.state).toBe("stale");
    expect(f.ageMinutes).toBe(16);
    expect(f.label).toMatch(/16m old/);
    expect(f.label).toMatch(/older than 15m/);
    expect(f.label).toMatch(/degraded, labelled/);
  });

  it("a custom threshold is honoured, not the default", () => {
    expect(classifyChainFreshness(minutesAgo(20), NOW, 30).state).toBe("fresh");
    expect(classifyChainFreshness(minutesAgo(20), NOW, 10).state).toBe("stale");
  });

  it("missing, empty, and unparseable timestamps are unknown, never guessed fresh", () => {
    for (const scannedAt of [null, undefined, "", "not-a-date"]) {
      const f = classifyChainFreshness(scannedAt, NOW);
      expect(f.state).toBe("unknown");
      expect(f.ageMinutes).toBeNull();
      expect(f.label).toMatch(/unknown/);
      expect(f.label).toMatch(/degraded, labelled/);
    }
  });

  it("a future timestamp (clock skew) clamps to age 0, fresh", () => {
    const f = classifyChainFreshness(minutesAgo(-5), NOW);
    expect(f.state).toBe("fresh");
    expect(f.ageMinutes).toBe(0);
  });
});

describe("guardManualOptionsAuth", () => {
  it("fresh token proceeds and renewal is never attempted", async () => {
    const renew = vi.fn(async () => null);
    const res = await guardManualOptionsAuth({
      env: {} as never,
      userLogin: "venus",
      deps: deps({ renew }),
    });
    expect(res).toEqual({ proceed: true, renewed: false });
    expect(renew).not.toHaveBeenCalled();
  });

  it("expired token + successful renewal proceeds as renewed", async () => {
    const res = await guardManualOptionsAuth({
      env: {} as never,
      userLogin: "venus",
      deps: deps({ isExpired: () => true }),
    });
    expect(res).toEqual({ proceed: true, renewed: true });
  });

  it("expired token + failed renewal blocks with a coded 401 and no scan ran", async () => {
    const res = await guardManualOptionsAuth({
      env: {} as never,
      userLogin: "venus",
      deps: deps({ isExpired: () => true, renew: async () => null }),
    });
    expect(res.proceed).toBe(false);
    if (res.proceed) return;
    expect(res.status).toBe(401);
    expect(res.error).toMatch(/FAILURE_AUTH_TOKEN_EXPIRED/);
    expect(res.error).toMatch(/No scan ran/);
    expect(res.error).not.toMatch(/alert/);
  });

  it("no stored tokens in PROD blocks as no-session with a coded 401", async () => {
    const res = await guardManualOptionsAuth({
      env: {} as never,
      userLogin: "venus",
      environment: "PROD",
      deps: deps({ getTokens: async () => null, isProduction: () => true }),
    });
    expect(res.proceed).toBe(false);
    if (res.proceed) return;
    expect(res.status).toBe(401);
    expect(res.error).toMatch(/FAILURE_AUTH_NO_SESSION/);
    expect(res.error).toMatch(/No scan ran/);
    expect(res.error).not.toMatch(/alert/);
  });

  it("no stored tokens outside PROD keeps pass-through (caller owns that state)", async () => {
    const res = await guardManualOptionsAuth({
      env: {} as never,
      userLogin: "venus",
      deps: deps({ getTokens: async () => null }),
    });
    expect(res).toEqual({ proceed: true, renewed: false });
  });

  it("a guard-internal failure fails open and never throws", async () => {
    const res = await guardManualOptionsAuth({
      env: {} as never,
      userLogin: "venus",
      deps: deps({
        getTokens: async () => {
          throw new Error("token store blip");
        },
      }),
    });
    expect(res).toEqual({ proceed: true, renewed: false });
  });
});

describe("panelAuthResponse (the route-facing seam)", () => {
  it("fresh token → null (proceed)", async () => {
    const res = await panelAuthResponse({} as never, "venus", undefined, deps({}));
    expect(res).toBeNull();
  });

  it("expired token + failed renewal → coded 401 Response", async () => {
    const res = await panelAuthResponse(
      {} as never,
      "venus",
      undefined,
      deps({ isExpired: () => true, renew: async () => null }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toMatch(/FAILURE_AUTH_TOKEN_EXPIRED/);
    expect(body.error).toMatch(/No scan ran/);
  });

  it("no stored tokens in PROD → coded 401 no-session Response", async () => {
    const res = await panelAuthResponse(
      {} as never,
      "venus",
      "PROD",
      deps({ getTokens: async () => null, isProduction: () => true }),
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error: string };
    expect(body.error).toMatch(/FAILURE_AUTH_NO_SESSION/);
  });
});

describe("record-layer freshness derivation (#2599 F1)", () => {
  function captureOrm() {
    let captured: any = null;
    const orm = {
      storeCanonicalReport: (input: any) => {
        captured = input;
        return { reportId: "r1", created: true };
      },
    };
    return { orm: orm as never, get: () => captured };
  }

  function recordWithScreen(screen: unknown, extra: Record<string, unknown> = {}) {
    const { orm, get } = captureOrm();
    recordStrategyScreenRun(orm, {
      userLogin: "venus",
      symbol: "TSLA",
      trigger: "manual",
      mode: "strategies",
      ranked: [],
      screen,
      createdAt: "2026-10-23T15:00:00.000Z",
      ...extra,
    } as never);
    return get();
  }

  it("a fresh scannedAt derives a fresh label on body.feed and the feed stage", () => {
    const body = recordWithScreen({
      scannedAt: "2026-10-23T14:58:00.000Z",
      underlyingsScanned: 1,
      contractsEvaluated: 2,
      contractsMatched: 0,
    });
    expect(body.body.feed.chainFreshness.state).toBe("fresh");
    expect(body.body.feed.chainFreshness.ageMinutes).toBe(2);
    expect(body.body.stages[0].evidence.chainFreshnessState).toBe("fresh");
    expect(body.body.stages[0].evidence.chainFreshnessLabel).toMatch(/live/);
  });

  it("a stale scannedAt derives a stale label naming the threshold", () => {
    const body = recordWithScreen({
      scannedAt: "2026-10-23T14:00:00.000Z",
      underlyingsScanned: 1,
      contractsEvaluated: 2,
      contractsMatched: 0,
    });
    expect(body.body.feed.chainFreshness.state).toBe("stale");
    expect(body.body.feed.chainFreshness.ageMinutes).toBe(60);
    expect(body.body.stages[0].evidence.chainFreshnessLabel).toMatch(/older than 15m/);
  });

  it("a missing scannedAt leaves the label null (no probe), never guessed", () => {
    const body = recordWithScreen({
      underlyingsScanned: 1,
      contractsEvaluated: 2,
      contractsMatched: 0,
    });
    expect(body.body.feed.chainFreshness).toBeNull();
    expect(body.body.stages[0].evidence.chainFreshnessState).toBeNull();
  });

  it("an explicit input.chainFreshness wins over derivation", () => {
    const body = recordWithScreen(
      {
        scannedAt: "2026-10-23T14:58:00.000Z",
        underlyingsScanned: 1,
        contractsEvaluated: 2,
        contractsMatched: 0,
      },
      {
        chainFreshness: { state: "stale", ageMinutes: 99, label: "explicit" },
      },
    );
    expect(body.body.feed.chainFreshness.label).toBe("explicit");
    expect(body.body.stages[0].evidence.chainFreshnessAgeMinutes).toBe(99);
  });
});

describe("never Yahoo-substituted chains", () => {
  it("the Yahoo adapter declares quotes/bars/fundamentals/news only — no optionsChains", () => {
    const inner = {
      providerId: "yfinance",
      name: "yfinance (fake)",
      isConfigured: vi.fn(() => true),
      getQuote: vi.fn(async (symbol: string) => ({ symbol, price: 100 })),
      getFundamentals: vi.fn(async (symbol: string) => ({ symbol })),
      getHistoricalBars: vi.fn(async (symbol: string) => [{ symbol }]),
    };
    const adapter = createYahooDataProvider(inner as never);
    // #3932: news joins the declared capabilities (Yahoo News
    // search); the pin is still the absence of optionsChains.
    expect(adapter.capabilities).toEqual([
      "quotes",
      "historicalBars",
      "fundamentals",
      "news",
    ]);
    expect(adapter.capabilities).not.toContain("optionsChains");
  });
});
