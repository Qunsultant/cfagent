// @vitest-environment node
/**
 * Issue #5874 ([One engine] #4437 slice 3c) — the portfolio modifier
 * as an analyze input: positions ride the parent hand-off.
 *
 * Option (i) from the issue: the gather stage fetches the book (a live
 * broker leg, best-effort, never failing the stage) and carries the
 * JSON snapshot on the gather output as `portfolioBook`; the analyze
 * stage applies `applyPortfolioContextToOpportunities` purely from
 * that snapshot — it never touches the broker. Option (ii) (a live
 * fetch inside analyze) was rejected: analyze's input model is
 * persisted/hand-off data.
 *
 * - The gather leg is best-effort: no broker in scope ⇒ the
 *   `no-broker` snapshot; a failed fetch ⇒ `positions-unavailable`;
 *   a goal run skips the fetch entirely (the goal leg never
 *   consumes positions).
 * - A hand-off without the field degrades to `positions-unavailable`
 *   in analyze, never a failure — the run itself never fails for a
 *   modifier.
 * - The legacy `runScreenInner` path keeps its own live fetch until
 *   slice 7 (#5828) retires it; this slice moves the engine path only.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { ScreenerAgent } from "../src/agents/screener-agent";
import { loadPortfolioBook } from "../src/agents/screener-agent";
import type { PortfolioContextSnapshot } from "../src/services/portfolioContextRanking";

// The run clock: today at midnight UTC (never a fixed calendar date).
const T0 = Date.parse(`${new Date().toISOString().slice(0, 10)}T00:00:00.000Z`);
const iso = (ms: number) => new Date(ms).toISOString();

const PRICES: Record<string, number> = { AAPL: 150, MSFT: 300, NVDA: 180, AMZN: 200 };
const SYMBOLS = ["AAPL", "MSFT", "NVDA", "AMZN"];

function quote(symbol: string): any {
  const price = PRICES[symbol] ?? 100;
  return {
    symbol,
    provider: "yfinance",
    provenance: "live",
    price,
    lastPrice: price,
    change: 1,
    changePercent: 1,
    volume: 1_000_000,
    open: price - 1,
    high: price + 1,
    low: price - 2,
    previousClose: price - 1,
    timestamp: iso(T0),
  };
}

function bars(): any[] {
  const out: any[] = [];
  for (let i = 0; i < 30; i++) {
    const close = 100 + i;
    out.push({
      provenance: "live",
      timestamp: iso(T0 - (30 - 1 - i) * 24 * 3600_000),
      open: close - 0.5,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1_000_000,
    });
  }
  return out;
}

class FakeStorage {
  map = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.map.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.map.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.map.delete(key);
  }
}

function makeAgent(): ScreenerAgent {
  const storage = new FakeStorage();
  storage.map.set("screener:owner-login", "owner");
  return new ScreenerAgent({ storage } as any, {} as any);
}

function request(over: Record<string, unknown> = {}): any {
  return {
    trigger: "manual",
    userLogin: "owner",
    provider: "yahoo",
    ...over,
  };
}

function feedOutput(over: Record<string, unknown> = {}): any {
  const quotes = SYMBOLS.map(quote);
  return {
    timestamp: iso(T0),
    userLogin: "owner",
    universe: "nasdaq100",
    sector: "",
    provider: "yahoo",
    symbols: SYMBOLS.map((s) => ({ symbol: s })),
    expectedCount: 4,
    acquired: {
      quotes,
      discovery: { mode: "live_quotes", candidateCount: 4, listingCount: 4, message: "probe" },
    },
    platformRunId: "probe-platform",
    quoteTraceSummary: {},
    taskId: null,
    appliedLearnings: [],
    ...over,
  };
}

function gatherOutput(over: Record<string, unknown> = {}): any {
  return {
    ...feedOutput(),
    technicalsBySymbol: {},
    technicalsCoverage: { symbols: 4, withMacd: 0, withGap: 0, withAtr: 0 },
    persistedSentiment: null,
    ...over,
  };
}

/** A book flagging AAPL (60% of the book) — the first standout. */
const BOOK: PortfolioContextSnapshot = {
  ok: true,
  accountId: "et_live_1",
  positions: [
    { symbol: "AAPL", marketValue: 60 },
    { symbol: "XXXX", marketValue: 40 },
  ],
};

const src = (rel: string) =>
  readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");

describe("loadPortfolioBook (#5874) — the gather leg's fetch, pure at the seam", () => {
  const fakeEtrade = {
    fetchPortfolioRemote: async () => ({
      account: { accountId: "et_live_1" },
      positions: [
        { symbol: "AAPL", marketValue: 60 },
        { symbol: "XXXX", marketValue: 40 },
      ],
    }),
  };

  it("maps the fetched book to the modifier's snapshot", async () => {
    const book = await loadPortfolioBook("etrade", fakeEtrade as never);
    expect(book).toEqual(BOOK);
  });

  it("a failed fetch degrades to positions-unavailable, never a throw", async () => {
    const failing = {
      fetchPortfolioRemote: async () => {
        throw new Error("broker down");
      },
    };
    const book = await loadPortfolioBook("etrade", failing as never);
    expect(book).toEqual({ ok: false, reason: "positions-unavailable" });
  });

  it("no broker in scope degrades to no-broker, never a fetch", async () => {
    const throwing = {
      fetchPortfolioRemote: async () => {
        throw new Error("must not be called");
      },
    };
    expect(await loadPortfolioBook("etrade", null)).toEqual({
      ok: false,
      reason: "no-broker",
    });
    expect(await loadPortfolioBook("yahoo", throwing as never)).toEqual({
      ok: false,
      reason: "no-broker",
    });
  });
});

describe("screenAnalysisStage (#5874) — the modifier reads the hand-off, never the broker", () => {
  it("a portfolio run with the book on the hand-off re-ranks + marks applied", async () => {
    const agent = makeAgent();
    // Fresh run id: the per-run state has no broker client at all —
    // if analyze still fetched live it could only answer no-broker.
    const out = await agent.screenAnalysisStage("run-5874-pure", {
      request: request({ provider: "etrade", portfolioContext: true }),
      gatherOutput: gatherOutput({ provider: "etrade", portfolioBook: BOOK }),
    });
    expect(out.opportunities.map((o) => o.symbol)).toEqual([
      "MSFT",
      "NVDA",
      "AMZN",
      "AAPL",
    ]);
    expect(out.portfolioContext).toMatchObject({
      applied: true,
      demoted: ["AAPL"],
      accountId: "et_live_1",
    });
  });

  it("a portfolio run without the book on the hand-off degrades to positions-unavailable", async () => {
    const agent = makeAgent();
    const out = await agent.screenAnalysisStage("run-5874-nobook", {
      request: request({ provider: "etrade", portfolioContext: true }),
      gatherOutput: gatherOutput({ provider: "etrade" }),
    });
    expect(out.opportunities.map((o) => o.symbol)).toEqual([
      "AAPL",
      "MSFT",
      "NVDA",
      "AMZN",
    ]);
    expect(out.portfolioContext).toEqual({
      applied: false,
      reason: "positions-unavailable",
    });
  });

  it("a market run without the flag ignores a book on the hand-off", async () => {
    const agent = makeAgent();
    const out = await agent.screenAnalysisStage("run-5874-market", {
      request: request({ provider: "etrade" }),
      gatherOutput: gatherOutput({ provider: "etrade", portfolioBook: BOOK }),
    });
    expect(out.opportunities.map((o) => o.symbol)).toEqual([
      "AAPL",
      "MSFT",
      "NVDA",
      "AMZN",
    ]);
    expect(out.portfolioContext).toBeUndefined();
  });
});

describe("screenGatherStage (#5874) — the book rides the hand-off", () => {
  const historyDeps = {
    fetchBars: async () => bars(),
  };

  it("a non-broker run records the no-broker snapshot, never a fetch", async () => {
    const agent = makeAgent();
    const out = await agent.screenGatherStage("run-5874-gather-nobroker", {
      request: request({ provider: "yahoo", portfolioContext: true }),
      historyDeps: historyDeps as never,
      feedOutput: feedOutput({ provider: "yahoo" }),
    });
    expect(out.portfolioBook).toEqual({ ok: false, reason: "no-broker" });
  });

  it("a goal run skips the fetch entirely — no book on the hand-off", async () => {
    const agent = makeAgent();
    const out = await agent.screenGatherStage("run-5874-gather-goal", {
      request: request({ provider: "etrade", portfolioContext: true }),
      historyDeps: historyDeps as never,
      feedOutput: feedOutput({ provider: "etrade" }),
      goalScreen: {
        scenario: { goalKind: "growth", direction: "long" },
        scenarioSource: "built",
        symbols: ["AAPL"],
      } as never,
    });
    expect(out.portfolioBook).toBeUndefined();
  });

  it("a run without the flag carries no book", async () => {
    const agent = makeAgent();
    const out = await agent.screenGatherStage("run-5874-gather-market", {
      request: request({ provider: "yahoo" }),
      historyDeps: historyDeps as never,
      feedOutput: feedOutput({ provider: "yahoo" }),
    });
    expect(out.portfolioBook).toBeUndefined();
  });
});

describe("wiring pins (#5874) — the fetch lives in gather, never in analyze", () => {
  it("analyze reads the hand-off book; gather loads it; analyze never fetches", () => {
    const agent = src("agents/screener-agent.ts");
    const gatherStart = agent.indexOf("async screenGatherStage(");
    const goalStart = agent.indexOf("async screenGoalStage(", gatherStart);
    const gather = agent.slice(gatherStart, goalStart);
    expect(gather).toContain("loadPortfolioBook(");
    expect(gather).toContain("portfolioBook");

    const analysisStart = agent.indexOf("async screenAnalysisStage(");
    const storeStart = agent.indexOf("async screenStoreStage(", analysisStart);
    const analysis = agent.slice(analysisStart, storeStart);
    expect(analysis).toContain("gatherOutput.portfolioBook");
    expect(analysis).toContain("applyPortfolioContextToOpportunities(");
    expect(analysis).not.toContain("fetchPortfolioRemote");
  });
});
