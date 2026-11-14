/**
 * Sharded jobs (issue #1355) + stored CSV artifacts (issue #1346).
 *
 * Characterization-first pins for the pivot onto the EXISTING
 * rails: shards are mas_async_jobs rows (planner only — no new
 * table), retry is withRetry + the Retry-After override (no new
 * retry implementation), and the CSV generators mirror the
 * goal-screen CSV + the runs' XLSX tabs (no second format).
 *
 * Run RED before implementation against the intended surface
 * (missing modules); green after. No existing test is touched.
 */

import { describe, expect, it } from "vitest";
import {
  generateOptionsCsv,
  generateScreenerCsv,
  isOptionsCsvKey,
  isScreenerCsvKey,
  OPTIONS_CSV_COLUMNS,
  optionsCsvFileName,
  parseScreenerCsv,
  SCREENER_CSV_COLUMNS,
  screenerCsvFileName,
} from "../src/trading/screenerReportCsv";
import {
  RateLimitError,
  parseRetryAfterSeconds,
  retryAfterMsForError,
  withRetry,
} from "../src/services/resilience";
import { resolvePipelinePolicy } from "../src/services/pipelinePolicy";
import { resolveShardPacing, SHARD_PACING } from "../src/config/shardPacing";
import {
  assessFeedGate,
  planAssembleShard,
  planFeedStart,
  planGenerateShards,
  planNextFeedShard,
  planServeJob,
  planShardAdvance,
  applyShardPacing,
  planOptionsFeedShards,
  planStoreShards,
  SHARD_RETRY_BUCKET,
  shardProvenanceIds,
  staggerRunAt,
  type ShardChainContext,
  type ShardRow,
} from "../src/services/shardJobs";
import { executeShardJob } from "../src/services/shardExecutors";
import { collateOpportunityScanShards } from "../src/trading/options/opportunityScanner";
import { marketScreenScheduleCriteriaSchema, optionsAnalysisScheduleCriteriaSchema } from "../src/trading/screeningSchemas";
import {
  runSummaryFromReport,
  runSummaryFromScreenerRun,
} from "../src/services/runSummaries";

const chain = (over: Partial<ShardChainContext> = {}): ShardChainContext => ({
  chainId: "chain-1",
  universe: "NASDAQ100",
  userLogin: "u1",
  trigger: "scheduled",
  timestamp: "2026-10-24T12:00:00.000Z",
  channels: ["slack"],
  ...over,
});

const row = (over: Partial<ShardRow> & { jobId: string }): ShardRow => ({
  stage: "feed",
  status: "completed",
  createdAt: "2026-10-24T12:00:00.000Z",
  ...over,
});

const stockResult = (over: Record<string, unknown> = {}) => ({
  timestamp: "2026-10-24T12:00:00.000Z",
  universe: "NASDAQ100",
  allStocks: [
    {
      symbol: "AAPL",
      companyName: "Apple, Inc.",
      sector: "Technology",
      lastPrice: 250.126,
      changePercent: 1.234,
      technicals: { gapPercent: 0.567, rsi14: 62.34, macdHistogram: 0.123 },
      indicators: { sentiment: "very_bullish", screenScore: 87 },
      factorGrades: { quantRating: "A", value: "B", momentum: "A" },
      peRatio: 28.44,
      signal: "BULLISH_MOMENTUM",
      source: "E*TRADE live",
    },
  ],
  opportunities: [],
  ...over,
});

const optionsResult = (over: Record<string, unknown> = {}) => ({
  scannedAt: "2026-10-24T12:00:00.000Z",
  contracts: [
    {
      underlyingSymbol: "AAPL",
      underlyingPrice: 250.12,
      optionType: "call",
      strikePrice: 260,
      expirationDate: "2026-11-21",
      daysToExpiration: 28,
      moneyness: "OTM",
      bid: 1.2,
      ask: 1.35,
      lastPrice: 1.28,
      spreadPct: 11.76,
      volume: 120,
      openInterest: 1500,
      volumeOiRatio: 0.08,
      impliedVolatility: 0.234,
      delta: 0.3214,
      gamma: 0.0456,
      theta: -0.0123,
      vega: 0.1234,
      quoteFreshness: "FRESH",
      technicalSignal: "BULLISH",
      highlightReason: "High OI",
    },
  ],
  ...over,
});

describe("CSV generators (issue #1346, mirroring goal-screen CSV + XLSX tabs)", () => {
  it("stock columns match the XLSX Screened Stocks tab order", () => {
    expect(SCREENER_CSV_COLUMNS).toEqual([
      "Symbol", "Company Name", "Sector", "Price", "Chg%", "Gap%",
      "Sentiment", "Quant Rating", "Value Grade", "Momentum Grade",
      "RSI-14", "MACD Histogram", "Score", "P/E Ratio",
      "Technical Signal", "Data Source",
    ]);
  });

  it("stock rows mirror the XLSX mapping (rounding, defaults, sentiment spaces)", () => {
    const csv = generateScreenerCsv(stockResult() as any);
    const parsed = parseScreenerCsv(csv);
    expect(parsed[0]).toEqual([...SCREENER_CSV_COLUMNS]);
    expect(parsed[1]).toEqual([
      "AAPL", "Apple, Inc.", "Technology", "250.13", "1.23", "0.57",
      "very bullish", "A", "B", "A", "62.3", "0.12", "87", "28.4",
      "BULLISH_MOMENTUM", "E*TRADE live",
    ]);
  });

  it("stock CSV falls back to opportunities when allStocks is empty", () => {
    const csv = generateScreenerCsv(
      stockResult({ allStocks: [], opportunities: [{ symbol: "MSFT", lastPrice: 10 }] }) as any
    );
    expect(parseScreenerCsv(csv)).toHaveLength(2);
    expect(parseScreenerCsv(csv)[1][0]).toBe("MSFT");
  });

  it("a 0-record stock run yields a headers-only CSV (acceptance)", () => {
    const csv = generateScreenerCsv(stockResult({ allStocks: [], opportunities: [] }) as any);
    expect(csv).toBe(`${SCREENER_CSV_COLUMNS.join(",")}\n`);
  });

  it("options columns match the XLSX Screened Contracts tab order", () => {
    expect(OPTIONS_CSV_COLUMNS).toEqual([
      "Underlying", "Underlying Price", "Type", "Strike", "Expiration",
      "DTE", "Moneyness", "Bid", "Ask", "Last", "Spread %", "Volume",
      "Open Interest", "Vol/OI", "IV %", "Delta", "Gamma", "Theta",
      "Vega", "Quote Freshness", "Technical Signal", "Highlight",
    ]);
  });

  it("options rows mirror the XLSX mapping (greeks 3dp, IV% x100)", () => {
    const parsed = parseScreenerCsv(generateOptionsCsv(optionsResult() as any));
    expect(parsed[1]).toEqual([
      "AAPL", "250.12", "call", "260", "2026-11-21", "28", "OTM",
      "1.2", "1.35", "1.28", "11.8", "120", "1500", "0.08", "23.4",
      "0.321", "0.046", "-0.012", "0.123", "FRESH", "BULLISH", "High OI",
    ]);
  });

  it("a 0-contract options run yields a headers-only CSV (acceptance)", () => {
    const csv = generateOptionsCsv(optionsResult({ contracts: [] }) as any);
    expect(csv).toBe(`${OPTIONS_CSV_COLUMNS.join(",")}\n`);
  });

  it("escaping matches the goal-screen escape; LF endings with trailing newline", () => {
    const csv = generateScreenerCsv(
      stockResult({
        allStocks: [{ symbol: 'A"B', companyName: "Acme, Co\nLine2", lastPrice: 1 }],
      }) as any
    );
    expect(csv).toContain('"A""B"');
    expect(csv).toContain('"Acme, Co\nLine2"');
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv).not.toContain("\r");
  });

  it("filenames mirror the XLSX filenames with a .csv extension", () => {
    expect(screenerCsvFileName({ universe: "NASDAQ100", timestamp: "2026-10-24T12:00:00.000Z" })).toBe(
      "screener-report-nasdaq100-2026-10-24.csv"
    );
    expect(optionsCsvFileName({ scannedAt: "2026-10-24T12:00:00.000Z" })).toBe(
      "options-report-2026-10-24.csv"
    );
  });

  it("key predicates accept only their own CSV family", () => {
    expect(isScreenerCsvKey("screener:csv:abcd1234")).toBe(true);
    expect(isScreenerCsvKey("screener:pdf:abcd1234")).toBe(false);
    expect(isScreenerCsvKey("options:csv:abcd1234")).toBe(false);
    expect(isOptionsCsvKey("options:csv:abcd1234")).toBe(true);
    expect(isOptionsCsvKey("options:xlsx:abcd1234")).toBe(false);
    expect(isOptionsCsvKey("screener:csv:abcd1234")).toBe(false);
  });
});

describe("Retry-After override on withRetry (issue #1355)", () => {
  const policy = { maxAttempts: 3, baseDelayMs: 250, maxDelayMs: 4000, jitterRatio: 0 };

  it("parses bare seconds, numeric strings, and HTTP dates; rejects the rest", () => {
    expect(parseRetryAfterSeconds(30)).toBe(30);
    expect(parseRetryAfterSeconds("45")).toBe(45);
    expect(parseRetryAfterSeconds("Wed, 21 Oct 2026 07:28:00 GMT", Date.parse("Wed, 21 Oct 2026 07:27:30 GMT"))).toBe(30);
    expect(parseRetryAfterSeconds("garbage")).toBeUndefined();
    expect(parseRetryAfterSeconds(-5)).toBeUndefined();
    expect(parseRetryAfterSeconds(undefined)).toBeUndefined();
  });

  it("reads Retry-After off RateLimitError and 429-shaped errors only", () => {
    expect(retryAfterMsForError(new RateLimitError("slow down", 5))).toBe(5000);
    expect(retryAfterMsForError({ status: 429, "retry-after": "12" })).toBe(12000);
    expect(retryAfterMsForError({ status: 500, "retry-after": "12" })).toBeUndefined();
    expect(retryAfterMsForError(new Error("boom"))).toBeUndefined();
  });

  it("a 429's Retry-After wins over policy backoff for that retry only", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    const out = await withRetry(
      async () => {
        attempts++;
        if (attempts < 3) throw new RateLimitError("slow down", 5);
        return "ok";
      },
      policy,
      { sleep: async (ms) => { sleeps.push(ms); } }
    );
    expect(out).toBe("ok");
    expect(sleeps).toEqual([5000, 5000]);
  });

  it("the attempt cap still bounds a Retry-After storm", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new RateLimitError("slow down", 60);
        },
        policy,
        { sleep: async (ms) => { sleeps.push(ms); } }
      )
    ).rejects.toThrow("slow down");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([60000, 60000]);
  });

  it("without Retry-After the policy schedule applies", async () => {
    const sleeps: number[] = [];
    let attempts = 0;
    await expect(
      withRetry(
        async () => {
          attempts++;
          throw new Error("plain failure");
        },
        policy,
        { sleep: async (ms) => { sleeps.push(ms); } }
      )
    ).rejects.toThrow("plain failure");
    expect(attempts).toBe(3);
    expect(sleeps).toEqual([250, 500]);
  });
});

describe("shard planner + completeness gate on mas_async_jobs rows (issue #1355)", () => {
  it("plans paced per-symbol option feed shards", () => {
    const specs = planOptionsFeedShards(chain({
      screenType: "options",
      options: { symbols: ["AAPL", "MSFT", "NVDA"] },
      staggerMs: 1_000,
    }), "2026-10-24T12:00:00.000Z");
    expect(specs.map((spec) => (spec.payload as any).shard.key)).toEqual(["AAPL", "MSFT", "NVDA"]);
    expect(specs.map((spec) => spec.runAt)).toEqual([
      "2026-10-24T12:00:00.000Z",
      "2026-10-24T12:00:01.000Z",
      "2026-10-24T12:00:02.000Z",
    ]);
    expect(specs.every((spec) => spec.stage === "feed")).toBe(true);
  });

  it("stamps the dispatch provenance onto every shard submission (#4415)", () => {
    const specs = planOptionsFeedShards(chain({
      screenType: "options",
      options: { symbols: ["AAPL", "MSFT"] },
      scheduleId: "sched-9",
    }), "2026-10-24T12:00:00.000Z");
    for (const spec of specs) {
      expect(spec.trigger).toBe("scheduled");
      expect(spec.triggeredBy).toBe("u1");
      expect(spec.scheduleId).toBe("sched-9");
    }
  });

  it("plans options assembly only after every symbol is terminal", () => {
    const optionsChain = chain({
      screenType: "options",
      options: { symbols: ["AAPL", "MSFT"] },
    });
    const first = planShardAdvance({
      chain: optionsChain,
      rows: [row({ jobId: "aapl", shardKey: "AAPL" })],
      completedStage: "feed",
      completedKey: "AAPL",
      rootJobId: "aapl",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(first).toEqual([]);
    const ready = planShardAdvance({
      chain: optionsChain,
      rows: [row({ jobId: "aapl", shardKey: "AAPL" }), row({ jobId: "msft", shardKey: "MSFT", status: "failed", error: "timeout" })],
      completedStage: "feed",
      completedKey: "AAPL",
      rootJobId: "aapl",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect((ready[0]?.payload as any)?.shard).toEqual({ stage: "generate", key: "assemble" });
  });
  it("the chain starts with the nasdaq feed shard (chain root, no parent)", () => {
    const spec = planFeedStart(chain()) as any;
    expect(spec.capability).toBe("shard.execute");
    expect(spec.payload.shard).toEqual({ stage: "feed", key: "nasdaq" });
    expect(spec.stage).toBe("feed");
    expect(spec.chainId).toBe("chain-1");
    expect(spec.parentJobId).toBeUndefined();
  });

  it("feed advances nasdaq -> etrade -> yahoo -> null (dependency order)", () => {
    expect((planNextFeedShard(chain(), "nasdaq", "root") as any).payload.shard.key).toBe("etrade");
    expect((planNextFeedShard(chain(), "etrade", "root") as any).payload.shard.key).toBe("yahoo");
    expect(planNextFeedShard(chain(), "yahoo", "root")).toBeNull();
  });

  it("the gate is ready only when all three feed shards completed", () => {
    const ready = [
      row({ jobId: "j1", shardKey: "nasdaq" }),
      row({ jobId: "j2", shardKey: "etrade" }),
      row({ jobId: "j3", shardKey: "yahoo" }),
    ];
    expect(assessFeedGate(ready)).toEqual({ ready: true });
    const blocked = assessFeedGate([
      row({ jobId: "j1", shardKey: "nasdaq" }),
      row({ jobId: "j2", shardKey: "etrade", status: "failed", error: "broker 429" }),
    ]);
    expect(blocked).toEqual({
      ready: false,
      blockedBy: [
        { shardKey: "etrade", reason: "broker 429" },
        { shardKey: "yahoo", reason: "feed shard not submitted" },
      ],
    });
    const pending = assessFeedGate([
      row({ jobId: "j1", shardKey: "nasdaq" }),
      row({ jobId: "j2", shardKey: "etrade" }),
      row({ jobId: "j3", shardKey: "yahoo", status: "running" }),
    ]);
    expect(pending).toEqual({
      ready: false,
      blockedBy: [{ shardKey: "yahoo", reason: "feed shard status: running" }],
    });
  });

  it("advance: feed completions walk the dependency order, then the gate submits assemble", () => {
    const c = chain();
    const afterNasdaq = planShardAdvance({
      chain: c,
      rows: [row({ jobId: "n", shardKey: "nasdaq" })],
      completedStage: "feed",
      completedKey: "nasdaq",
      rootJobId: "n",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(afterNasdaq).toHaveLength(1);
    expect((afterNasdaq[0] as any).payload.shard.key).toBe("etrade");
    const afterYahoo = planShardAdvance({
      chain: c,
      rows: [
        row({ jobId: "n", shardKey: "nasdaq" }),
        row({ jobId: "e", shardKey: "etrade", parentJobId: "n" }),
        row({ jobId: "y", shardKey: "yahoo", parentJobId: "n" }),
      ],
      completedStage: "feed",
      completedKey: "yahoo",
      rootJobId: "n",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(afterYahoo).toHaveLength(1);
    expect((afterYahoo[0] as any).payload.shard).toEqual({ stage: "generate", key: "assemble" });
  });

  it("advance: a failed sibling blocks advancement (stop point)", () => {
    const specs = planShardAdvance({
      chain: chain(),
      rows: [
        row({ jobId: "n", shardKey: "nasdaq" }),
        row({ jobId: "e", shardKey: "etrade", status: "failed", error: "x" }),
      ],
      completedStage: "feed",
      completedKey: "nasdaq",
      rootJobId: "n",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(specs).toEqual([]);
  });

  it("advance: assemble completion plans three staggered generate shards", () => {
    const c = chain({ staggerMs: 1000 });
    const specs = planShardAdvance({
      chain: c,
      rows: [
        row({ jobId: "n", shardKey: "nasdaq" }),
        row({ jobId: "e", shardKey: "etrade" }),
        row({ jobId: "y", shardKey: "yahoo" }),
        row({ jobId: "a", stage: "generate", shardKey: "assemble", parentJobId: "n" }),
      ],
      completedStage: "generate",
      completedKey: "assemble",
      rootJobId: "n",
      assembleJobId: "a",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(specs.map((s: any) => s.payload.shard.key)).toEqual(["pdf", "xlsx", "csv"]);
    expect(specs.map((s: any) => s.runAt)).toEqual([
      "2026-10-24T12:00:00.000Z",
      "2026-10-24T12:00:01.000Z",
      "2026-10-24T12:00:02.000Z",
    ]);
    expect(specs.every((s: any) => s.parentJobId === "a")).toBe(true);
  });

  it("advance: generate completion plans store shards with embedded inputs; store completion plans serve", () => {
    const c = chain();
    const genRows = [
      row({ jobId: "n", shardKey: "nasdaq" }),
      row({ jobId: "e", shardKey: "etrade" }),
      row({ jobId: "y", shardKey: "yahoo" }),
      row({ jobId: "a", stage: "generate", shardKey: "assemble", parentJobId: "n", result: { totalScanned: 10, matchedCount: 2 } }),
      row({ jobId: "p", stage: "generate", shardKey: "pdf", parentJobId: "a", result: { format: "pdf", key: "screener:pdf:1", fileName: "r.pdf" } }),
      row({ jobId: "x", stage: "generate", shardKey: "xlsx", parentJobId: "a", result: { format: "xlsx", key: "screener:xlsx:1", fileName: "r.xlsx" } }),
      row({ jobId: "v", stage: "generate", shardKey: "csv", parentJobId: "a", result: { format: "csv", key: "screener:csv:1", fileName: "r.csv" } }),
    ];
    const storeSpecs = planShardAdvance({
      chain: c,
      rows: genRows,
      completedStage: "generate",
      completedKey: "csv",
      rootJobId: "n",
      assembleJobId: "a",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(storeSpecs.map((s: any) => s.payload.shard.key)).toEqual(["pdf", "xlsx", "csv"]);
    expect((storeSpecs[2] as any).payload.inputs).toEqual({
      format: "csv",
      key: "screener:csv:1",
      fileName: "r.csv",
    });
    const storeRows = [
      ...genRows,
      row({ jobId: "s1", stage: "store", shardKey: "pdf", parentJobId: "a" }),
      row({ jobId: "s2", stage: "store", shardKey: "xlsx", parentJobId: "a" }),
      row({ jobId: "s3", stage: "store", shardKey: "csv", parentJobId: "a" }),
    ];
    const serveSpecs = planShardAdvance({
      chain: c,
      rows: storeRows,
      completedStage: "store",
      completedKey: "csv",
      rootJobId: "n",
      assembleJobId: "a",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(serveSpecs).toHaveLength(1);
    const serve = serveSpecs[0] as any;
    expect(serve.capability).toBe("followup.report");
    expect(serve.stage).toBe("serve");
    expect(serve.chainId).toBe("chain-1");
    expect(serve.payload.outcome.pdfKeys).toEqual(["screener:pdf:1"]);
    expect(serve.payload.outcome.xlsxKey).toBe("screener:xlsx:1");
    expect(serve.payload.outcome.csvKey).toBe("screener:csv:1");
  });

  it("advance is idempotent: an already-advanced stage is never resubmitted", () => {
    const specs = planShardAdvance({
      chain: chain(),
      rows: [
        row({ jobId: "n", shardKey: "nasdaq" }),
        row({ jobId: "e", shardKey: "etrade", parentJobId: "n" }),
      ],
      completedStage: "feed",
      completedKey: "nasdaq",
      rootJobId: "n",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(specs).toEqual([]);
  });

  it("advance heals: a failed row WITH a completed retry row does not block", () => {
    const specs = planShardAdvance({
      chain: chain(),
      rows: [
        row({ jobId: "n", shardKey: "nasdaq" }),
        row({ jobId: "e1", shardKey: "etrade", status: "failed", error: "x", parentJobId: "n" }),
        row({ jobId: "e2", shardKey: "etrade", parentJobId: "n" }),
        row({ jobId: "y", shardKey: "yahoo", parentJobId: "n" }),
      ],
      completedStage: "feed",
      completedKey: "yahoo",
      rootJobId: "n",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(specs).toHaveLength(1);
    expect((specs[0] as any).payload.shard).toEqual({ stage: "generate", key: "assemble" });
  });

  it("advance heals: a failed generate row WITH a completed retry row still advances to store", () => {
    const base = [
      row({ jobId: "n", shardKey: "nasdaq" }),
      row({ jobId: "e", shardKey: "etrade" }),
      row({ jobId: "y", shardKey: "yahoo" }),
      row({ jobId: "a", stage: "generate", shardKey: "assemble", parentJobId: "n" }),
      row({ jobId: "p", stage: "generate", shardKey: "pdf", parentJobId: "a", result: { format: "pdf", key: "k1", fileName: "r.pdf" } }),
      row({ jobId: "x1", stage: "generate", shardKey: "xlsx", parentJobId: "a", status: "failed", error: "x" }),
      row({ jobId: "x2", stage: "generate", shardKey: "xlsx", parentJobId: "a", result: { format: "xlsx", key: "k2", fileName: "r.xlsx" } }),
      row({ jobId: "v", stage: "generate", shardKey: "csv", parentJobId: "a", result: { format: "csv", key: "k3", fileName: "r.csv" } }),
    ];
    const specs = planShardAdvance({
      chain: chain(),
      rows: base,
      completedStage: "generate",
      completedKey: "xlsx",
      rootJobId: "n",
      assembleJobId: "a",
      nowIso: "2026-10-24T12:00:00.000Z",
    });
    expect(specs.map((s: any) => s.payload.shard.key)).toEqual(["pdf", "xlsx", "csv"]);
  });

  it("stagger math and retry-bucket pins", () => {
    expect(staggerRunAt("2026-10-24T12:00:00.000Z", 2, 1500)).toBe("2026-10-24T12:00:03.000Z");
    expect(SHARD_RETRY_BUCKET).toEqual({
      feed: "acquisition",
      generate: "report",
      store: "report",
      deliver: "delivery",
    });
    const policy = resolvePipelinePolicy({});
    expect(policy.retry.acquisition.maxAttempts).toBe(3);
    expect(policy.retry.report.maxAttempts).toBe(2);
    expect(policy.retry.delivery.maxAttempts).toBe(3);
  });

  it("provenance lists chain ids in pipeline order", () => {
    const ids = shardProvenanceIds([
      row({ jobId: "s1", stage: "store", shardKey: "pdf", createdAt: "2026-10-24T12:05:00.000Z" }),
      row({ jobId: "a", stage: "generate", shardKey: "assemble", createdAt: "2026-10-24T12:02:00.000Z" }),
      row({ jobId: "n", shardKey: "nasdaq", createdAt: "2026-10-24T12:00:00.000Z" }),
    ]);
    expect(ids).toEqual(["n", "a", "s1"]);
  });

  it("serve planning is a followup.report spec with the chain outcome", () => {
    const serve = planServeJob(
      chain(),
      "a",
      [
        row({ jobId: "a", stage: "generate", shardKey: "assemble", result: { totalScanned: 5, matchedCount: 1 } }),
        row({ jobId: "p", stage: "generate", shardKey: "pdf", result: { format: "pdf", key: "k1", fileName: "r.pdf" } }),
      ],
      "2026-10-24T12:00:00.000Z"
    ) as any;
    expect(serve.capability).toBe("followup.report");
    expect(serve.parentJobId).toBe("a");
    expect(serve.payload.outcome.kind).toBe("stock");
    expect(serve.payload.outcome.pdfKeys).toEqual(["k1"]);
    expect(serve.payload.outcome.csvKey).toBeUndefined();
  });

  it("planStoreShards embeds generate outputs as inputs", () => {
    const specs = planStoreShards(
      chain(),
      "a",
      [
        row({ jobId: "p", stage: "generate", shardKey: "pdf", result: { format: "pdf", key: "k1", fileName: "r.pdf" } }),
      ],
      "2026-10-24T12:00:00.000Z"
    );
    expect(specs).toHaveLength(1);
    expect((specs[0] as any).payload.inputs).toEqual({ format: "pdf", key: "k1", fileName: "r.pdf" });
  });

  it("planAssembleShard + planGenerateShards carry the chain", () => {
    const a = planAssembleShard(chain(), "n") as any;
    expect(a.payload.shard).toEqual({ stage: "generate", key: "assemble" });
    expect(a.parentJobId).toBe("n");
    const g = planGenerateShards(chain(), "a", "2026-10-24T12:00:00.000Z");
    expect(g.map((s: any) => s.payload.shard.key)).toEqual(["pdf", "xlsx", "csv"]);
  });
});

describe("options shard collation", () => {
  it("reranks successful symbol results and records exhausted shards as partial coverage", () => {
    const make = (symbol: string, score: number) => ({
      symbol,
      score,
      pick: { best: { candidate: { type: "call" } } },
      gateBucket: "borderline",
      gateReasons: [],
    });
    const scan = (symbol: string, score: number): any => ({
      scanned: 1,
      withTrades: 1,
      opportunities: [make(symbol, score)],
      skipped: [],
      truncatedSymbols: 0,
      assumptions: [],
      matrix: [{ symbol, verdict: "pass", targetPrice: 10, targetSource: "thesis", targetEmUnits: null, cells: [], gateBucket: "borderline", gateReasons: [] }],
      typeRollup: [],
      mode: "per_name_best",
      fits: [],
      fitsTotal: 0,
      gate: { fit: 0, borderline: 1, noFit: 0 },
      borderline: [],
      gateParams: {},
      profileRef: null,
      generatedAt: "2026-10-24T12:00:00.000Z",
      modelVersion: "1.2.0",
      requestSnapshot: { template: {}, mode: "per_name_best", riskProfile: "balanced", profile: null },
      configSnapshot: {},
      coverage: { considered: 1, scanned: 1, truncated: 0, evaluated: 1, errors: 0, withTrades: 1, eventCalendar: { covered: 1, total: 1, coveragePct: 100 } },
    });
    const result = collateOpportunityScanShards(
      ["AAPL", "MSFT", "NVDA"],
      [scan("AAPL", 50), scan("MSFT", 80)],
      [{ symbol: "NVDA", reason: "rate limit" }],
      new Date("2026-10-24T12:01:00.000Z")
    );
    expect(result.opportunities.map((item) => item.symbol)).toEqual(["MSFT", "AAPL"]);
    expect(result.coverage).toMatchObject({ considered: 3, scanned: 3, evaluated: 2, errors: 1, withTrades: 2 });
    expect(result.partial).toMatchObject({ evaluatedCount: 2, consideredCount: 3, coverageErrors: 1, topSkipReason: "rate limit" });
  });
});

describe("assemble gate enforced at execution (issue #1355 job2.1)", () => {
  it("a retried assemble with a failed feed shard throws naming the blocker", async () => {
    const sql = {
      exec: () => [
        {
          job_id: "n", stage: "feed", status: "completed",
          payload_json: JSON.stringify({ shard: { stage: "feed", key: "nasdaq" } }),
          result_json: JSON.stringify({ listings: [] }), error: null,
          created_at: "2026-10-24T12:00:00.000Z", parent_job_id: null,
        },
        {
          job_id: "e", stage: "feed", status: "failed",
          payload_json: JSON.stringify({ shard: { stage: "feed", key: "etrade" } }),
          result_json: null, error: "broker 429",
          created_at: "2026-10-24T12:01:00.000Z", parent_job_id: "n",
        },
      ],
    };
    await expect(
      executeShardJob(
        { sql, env: {}, orm: {} as any, storage: {}, createETradeService: (() => { throw new Error("unused"); }) as any, sessionId: "s1" },
        { shard: { stage: "generate", key: "assemble" }, chain: chain() }
      )
    ).rejects.toThrow("Assembly blocked by feed shard(s): etrade (broker 429)");
  });

  it("fails cleanly when every options shard failed", async () => {
    const sql = {
      exec: () => [{
        job_id: "aapl", stage: "feed", status: "failed",
        payload_json: JSON.stringify({ shard: { stage: "feed", key: "AAPL" } }),
        result_json: null, error: "chain rate limited",
        created_at: "2026-10-24T12:01:00.000Z", parent_job_id: null,
      }],
    };
    await expect(executeShardJob(
      { sql, env: {}, orm: {} as any, storage: {}, createETradeService: (() => { throw new Error("unused"); }) as any, sessionId: "s1" },
      { shard: { stage: "generate", key: "assemble" }, chain: chain({ screenType: "options", options: { symbols: ["AAPL"] } } as any) }
    )).rejects.toThrow("Options chain shards produced no evaluable symbols. AAPL: chain rate limited");
  });
});

describe("schedule schema + RunSummary surfacing (issues #1355, #1346)", () => {
  it("keeps options sharding an explicit schedule opt-in", () => {
    expect(optionsAnalysisScheduleCriteriaSchema.safeParse({ universe: "NASDAQ100", sharded: true }).success).toBe(true);
    expect(optionsAnalysisScheduleCriteriaSchema.safeParse({ universe: "NASDAQ100" }).success).toBe(true);
    expect(optionsAnalysisScheduleCriteriaSchema.safeParse({ universe: "NASDAQ100", sharded: "yes" }).success).toBe(false);
  });
  it("the market-screen schedule schema accepts sharded and stays strict", () => {
    expect(marketScreenScheduleCriteriaSchema.safeParse({ sharded: true }).success).toBe(true);
    expect(marketScreenScheduleCriteriaSchema.safeParse({ sharded: true, bogus: 1 }).success).toBe(false);
  });

  it("report rows surface csvUrl per source (screener, options, goal-screen, discovery)", () => {
    const hit = (source: string, body: Record<string, unknown>) => ({
      id: "r1", source, createdAt: "2026-10-24T12:00:00.000Z",
      title: "t", summary: "s", body,
    }) as any;
    expect(runSummaryFromReport(hit("screener", { csvKey: "screener:csv:abc" })).csvUrl).toBe(
      "/api/screener/report.csv?key=screener%3Acsv%3Aabc"
    );
    expect(runSummaryFromReport(hit("options_scanner", { csvKey: "options:csv:abc" })).csvUrl).toBe(
      "/api/options/report.csv?key=options%3Acsv%3Aabc"
    );
    expect(runSummaryFromReport(hit("goal_screen", { csvKey: "goal_screen:csv:abc" })).csvUrl).toBe(
      "/api/screening/goal-screen/report.csv?key=goal_screen%3Acsv%3Aabc"
    );
    // Issue #2180: discovery runs now serve their own CSV.
    expect(runSummaryFromReport(hit("discovery", { csvKey: "discovery:csv:abc" })).csvUrl).toBe(
      "/api/discovery/report.csv?key=discovery%3Acsv%3Aabc"
    );
    expect(runSummaryFromReport(hit("screener", {})).csvUrl).toBeNull();
  });

  it("screener-run rows surface csvUrl from the run's csvKey", () => {
    const row = runSummaryFromScreenerRun({
      timestamp: "2026-10-24T12:00:00.000Z",
      trigger: "scheduled",
      provider: "etrade",
      universe: "NASDAQ100",
      sector: "ALL",
      success: true,
      totalScanned: 5,
      matchedCount: 1,
      opportunities: [],
      allStocks: [],
      discoveryMessage: "",
      csvKey: "screener:csv:abc",
    } as any);
    expect(row.csvKey).toBe("screener:csv:abc");
    expect(row.csvUrl).toBe("/api/screener/report.csv?key=screener%3Acsv%3Aabc");
  });
});
describe("shard-chain dispatch pacing (#4424)", () => {
  it("releases a burst of inFlightCap shards, then paces the rest by the interval", () => {
    const specs = ["a", "b", "c", "d", "e"].map((key) => ({ key }));
    const paced = applyShardPacing(
      specs,
      { inFlightCap: 3, paceIntervalMs: 2000, staggerMs: 1000 },
      "2026-10-24T12:00:00.000Z",
    );
    expect(paced.map((spec) => spec.runAt)).toEqual([
      "2026-10-24T12:00:00.000Z",
      "2026-10-24T12:00:01.000Z",
      "2026-10-24T12:00:02.000Z",
      "2026-10-24T12:00:05.000Z",
      "2026-10-24T12:00:07.000Z",
    ]);
  });

  it("reads the knobs from config and honours the environment overrides", () => {
    expect(SHARD_PACING).toMatchObject({ inFlightCap: 8, paceIntervalMs: 2000, staggerMs: 1000 });
    expect(resolveShardPacing({ SHARD_CHAIN_IN_FLIGHT_CAP: "5" }).inFlightCap).toBe(5);
    expect(resolveShardPacing({ SHARD_CHAIN_PACE_INTERVAL_MS: "750" }).paceIntervalMs).toBe(750);
    expect(resolveShardPacing({ SHARD_CHAIN_STAGGER_MS: "nonsense" }).staggerMs).toBe(1000);
  });
});