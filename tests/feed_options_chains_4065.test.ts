// @vitest-environment node
/**
 * Issue #4065 (sub of #3551) — options feed: chains as a
 * registered feed job with a persisted dataset.
 *
 * Decision (a) of #4065, on evidence: the chain source CAN
 * execute in workflow residency — the #3941 proof (PR #4056)
 * constructs the same broker clients inside the residency
 * from env through createCaptureWiredFeedProvider, and this
 * slice's runner builds its provider the same way, through
 * the same providerFor seam. So options-chains is registered
 * as a feed job (one per optionsChains-serving source:
 * etrade, alpaca, public — the #3990 taxonomy; Yahoo
 * declares no optionsChains and gets no chains job), with a
 * persisted dataset in the #3530 feed-dataset store, and
 * chainFetch consumes it through the dataset-backed source.
 *
 * Pinned here:
 * - Registry: three chains jobs (etrade/alpaca/public),
 *   dataset "options-chains", elements ["optionsChains"],
 *   parameterized; no Yahoo chains job.
 * - Runner: per-symbol rows (eligible expiries, one chain
 *   per eligible expiry, fetchErrors); DTE window + per-symbol
 *   expiration cap mirror the screener's fetch; provenance
 *   verified per envelope; a run that fetched nothing is
 *   FAILED; per-symbol failures are named, never dropped.
 * - Universe: explicit symbols that are all members of the
 *   stored list ⇒ index-kind (subset); any non-member ⇒
 *   symbols-kind (used as-is, never silently filtered).
 * - Dataset source: fetchChains over the persisted dataset
 *   returns exactly what the live source returns.
 * - Residency: the same chains job runs to completion in
 *   workflow residency AND host residency, with identical
 *   dataset output and provenance; FEED_JOB_NOT_CONFIGURED
 *   still fires by name where wiring genuinely cannot be built.
 *
 * Standing rules: one branch, one PR, Merge Queue only, no
 * deletions, locally rebased and re-verified before the PR
 * opens; §15 draft only with separate approval.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  buildFeedJobRegistry,
  FEED_JOB_CODES,
  runFeedOptionsChainsJob,
  ALPACA_OPTIONS_CHAINS_JOB_ID,
  ETRADE_OPTIONS_CHAINS_JOB_ID,
  PUBLIC_OPTIONS_CHAINS_JOB_ID,
  type FeedJobDefinition,
} from "../src/services/feedJobs";
import { feedDatasetRowCount } from "../src/data/feedDatasetPorts";
import {
  createDatasetOptionChainSource,
  readPersistedOptionsChains,
} from "../src/services/feedOptionsChainSource";
import { createCaptureWiredFeedProvider } from "../src/services/feedProviderWiring";
import { createR2CaptureBlobStorage } from "../src/data/r2CaptureBlobAdapter";
import { feedStepDepsForWorkflow } from "../src/workflows/jobPipelineWorkflow";
import { feedStepDepsForScheduledAgent } from "../src/agents/scheduledTasksPipeline";
import { createProviderCaptureAdapter } from "../src/data/createProviderCapturePorts";
import {
  createD1ProviderCaptureDb,
  ensureProviderCaptureSchema,
  D1ProviderCaptureAdapter,
} from "../src/data/d1ProviderCaptureAdapter";
import { InMemoryProviderCaptureAdapter } from "../src/data/inMemoryProviderCaptureAdapter";
import { createFeedDatasetAdapter } from "../src/data/createFeedDatasetPorts";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { D1IndexListStore } from "../src/data/d1IndexListAdapter";
import { InMemoryIndexListStore } from "../src/data/inMemoryIndexListAdapter";
import { createJobPipelineStoresFromD1 } from "../src/data/createJobPipelinePorts";
import { createFeedStepRegistry, ensureFeedPipelineJobs, resolveFeedJob } from "../src/services/feedPipelineJobs";
import {
  JobPipelineControl,
  jobRunRecorderFromStore,
} from "../src/services/jobPipelineEngine";
import { createInMemoryJobPipelineStores } from "../src/data/inMemoryJobPipelineAdapter";
import { InMemoryJobRunRecordStore } from "../src/data/inMemoryJobRunRecordAdapter";
import { InMemoryMessagingAdapter } from "../src/messaging/inMemoryMessagingAdapter";
import type { MessagingPorts } from "../src/messaging/messagingPorts";
import type { Env } from "../src/types";
import type {
  DataProvider,
  DataResult,
} from "../src/trading/dataProviders/contract";
import type { ETradeOptionChain, ETradeOptionExpireDate } from "../src/types";
import type { OptionChainSource } from "../src/trading/optionChainSource";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";

const T0 = Date.parse("2026-11-07T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const SYMBOLS = ["AAPL", "MSFT"];

/** Expiries the stub serves (DTE from T0: 13, 41, 377). */
const STUB_EXPIRIES: ETradeOptionExpireDate[] = [
  { year: 2026, month: 11, day: 20 },
  { year: 2026, month: 12, day: 18 },
  { year: 2027, month: 11, day: 19 },
];

function stubChain(
  symbol: string,
  expiry: ETradeOptionExpireDate,
  strikes: number[] = [150, 155],
): ETradeOptionChain {
  return {
    symbol,
    underlyingPrice: 150.25,
    selectedExpiry: { ...expiry },
    pairs: strikes.map((strike) => ({
      call: {
        optionType: "CALL",
        strikePrice: strike,
        symbol: `${symbol}${expiry.year}${expiry.month}${expiry.day}C${strike}`,
        bid: 1.2,
        ask: 1.4,
        lastPrice: 1.3,
      },
      put: {
        optionType: "PUT",
        strikePrice: strike,
        symbol: `${symbol}${expiry.year}${expiry.month}${expiry.day}P${strike}`,
        bid: 1.1,
        ask: 1.3,
        lastPrice: 1.2,
      },
    })),
  };
}

interface StubKnobs {
  /** Symbols whose expiries fetch throws. */
  throwExpiriesFor?: Set<string>;
  /** Symbols whose expiries fetch returns []. */
  emptyExpiriesFor?: Set<string>;
  /** Symbols whose chain fetch throws for one expiry (the 2nd). */
  throwChainFor?: Set<string>;
  /** Symbols whose first chain carries a WRONG selectedExpiry. */
  mismatchFor?: Set<string>;
}

/** A provider serving canned chains for any symbol. */
function stubChainsProvider(knobs: StubKnobs = {}): DataProvider {
  return {
    id: "alpaca",
    name: "alpaca",
    capabilities: ["quotes", "optionsChains"],
    isConfigured: () => true,
    getOptionExpiryDates: async (symbol: string) => {
      if (knobs.throwExpiriesFor?.has(symbol)) {
        throw new Error(`stub expiries failure for ${symbol}`);
      }
      const expiries = knobs.emptyExpiriesFor?.has(symbol)
        ? []
        : STUB_EXPIRIES;
      return {
        providerId: "alpaca",
        capability: "optionsChains",
        result: expiries,
      } as DataResult<ETradeOptionExpireDate[]>;
    },
    getOptionsChain: async (request: {
      symbol: string;
      expiryYear?: number;
      expiryMonth?: number;
      expiryDay?: number;
    }) => {
      const expiry = STUB_EXPIRIES.find(
        (e) =>
          e.year === request.expiryYear &&
          e.month === request.expiryMonth &&
          e.day === request.expiryDay,
      )!;
      if (
        knobs.throwChainFor?.has(request.symbol) &&
        expiry.day === 18 &&
        expiry.month === 12
      ) {
        throw new Error(`stub chain failure for ${request.symbol}`);
      }
      let chain = stubChain(request.symbol, expiry);
      if (knobs.mismatchFor?.has(request.symbol) && expiry.day === 20) {
        chain = {
          ...chain,
          selectedExpiry: { year: 2026, month: 12, day: 18 },
        };
      }
      return {
        providerId: "alpaca",
        capability: "optionsChains",
        result: chain,
      } as DataResult<ETradeOptionChain | null>;
    },
  } as DataProvider;
}

/** A live-shaped source over the same canned data (for the equivalence test). */
function stubLiveSource(knobs: StubKnobs = {}): OptionChainSource {
  const provider = stubChainsProvider(knobs);
  return {
    getOptionExpireDates: async (symbol: string) => {
      const envelope = await provider.getOptionExpiryDates!(symbol);
      return envelope.result ?? [];
    },
    getOptionChains: async (params: {
      symbol: string;
      expiryYear?: number;
      expiryMonth?: number;
      expiryDay?: number;
    }) => {
      const envelope = await provider.getOptionsChain!(params);
      return envelope.result ?? null;
    },
  };
}

async function seededUniverseStore() {
  const store = new InMemoryIndexListStore();
  await store.store({
    index: "nasdaq100",
    snapshotDate: "2026-11-02",
    symbols: SYMBOLS.map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (Nasdaq-100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  await store.store({
    index: "sp100",
    snapshotDate: "2026-11-02",
    symbols: ["AAPL", "XOM"].map((symbol) => ({ symbol })),
    source: "wikipedia",
    sourceLabel: "Wikipedia (S&P 100 table)",
    derivedFromHoldings: false,
    nowIso: iso(T0 - 4 * 24 * 3600_000),
  });
  return store;
}

describe("the options-chains registry (#4065)", () => {
  it("registers one chains job per optionsChains-serving source, none for Yahoo", () => {
    const registry = buildFeedJobRegistry({});
    for (const [jobId, sourceId] of [
      [ETRADE_OPTIONS_CHAINS_JOB_ID, "etrade"],
      [ALPACA_OPTIONS_CHAINS_JOB_ID, "alpaca"],
      [PUBLIC_OPTIONS_CHAINS_JOB_ID, "public"],
    ] as const) {
      const def = registry.get(jobId)!;
      expect(def.sourceId).toBe(sourceId);
      expect(def.dataset).toBe("options-chains");
      expect(def.elements).toEqual(["optionsChains"]);
      expect(def.parameterizedUniverse).toBe(true);
      expect(def.universe).toEqual({
        kind: "index",
        index: "nasdaq100",
        label: "Nasdaq-100",
      });
    }
    expect(registry.get("yahoo-options-chains")).toBeUndefined();
    expect(resolveFeedJob("alpaca options chains")?.jobId).toBe(
      ALPACA_OPTIONS_CHAINS_JOB_ID,
    );
    expect(resolveFeedJob("yahoo options chains")).toBeNull();
  });

  it("the capture-wired factory builds the chains providers with the same honesty as quotes", () => {
    const env = {} as Env;
    const bucket = makeFakeBucket();
    const base = {
      env,
      capturePort: new InMemoryProviderCaptureAdapter(),
      blobStorage: createR2CaptureBlobStorage({ REPORTS_BUCKET: bucket as never })!,
    };
    const alpacaDef = buildFeedJobRegistry({}).get(ALPACA_OPTIONS_CHAINS_JOB_ID)!;
    const alpaca = createCaptureWiredFeedProvider(alpacaDef, base)!;
    expect(alpaca.id).toBe("alpaca");
    expect(alpaca.capabilities).toContain("optionsChains");
    const etradeDef = buildFeedJobRegistry({}).get(ETRADE_OPTIONS_CHAINS_JOB_ID)!;
    expect(createCaptureWiredFeedProvider(etradeDef, base)).toBeUndefined();
    expect(
      createCaptureWiredFeedProvider(etradeDef, { ...base, userLogin: "svc-test" })?.id,
    ).toBe("etrade");
    const publicDef = buildFeedJobRegistry({}).get(PUBLIC_OPTIONS_CHAINS_JOB_ID)!;
    expect(createCaptureWiredFeedProvider(publicDef, base)).toBeUndefined();
    expect(
      createCaptureWiredFeedProvider(publicDef, { ...base, userLogin: "svc-test" })?.id,
    ).toBe("public");
  });
});

describe("the options-chains runner (#4065)", () => {
  async function runChains(
    knobs: StubKnobs = {},
    opts: {
      symbols?: string[];
      universe?: "nasdaq100" | "sp100";
      minDte?: number;
      maxDte?: number;
      maxExpirationsPerSymbol?: number;
      seedUniverse?: boolean;
    } = {},
  ) {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const deps = {
      provider: stubChainsProvider(knobs),
      universeStore:
        opts.seedUniverse === false
          ? new InMemoryIndexListStore()
          : await seededUniverseStore(),
      datasetStore,
    };
    const result = await runFeedOptionsChainsJob(
      registry,
      deps,
      ALPACA_OPTIONS_CHAINS_JOB_ID,
      {
        ...(opts.symbols ? { symbols: opts.symbols } : {}),
        ...(opts.universe ? { universe: opts.universe } : {}),
        ...(opts.minDte !== undefined ? { minDte: opts.minDte } : {}),
        ...(opts.maxDte !== undefined ? { maxDte: opts.maxDte } : {}),
        ...(opts.maxExpirationsPerSymbol !== undefined
          ? { maxExpirationsPerSymbol: opts.maxExpirationsPerSymbol }
          : {}),
        runId: "feed-chains-test",
        now: () => new Date(T0),
      },
    );
    const artifact = await datasetStore.latest("alpaca", "options-chains");
    return { result, artifact: artifact! };
  }

  it("explicit symbols that are all list members stay an index-kind subset", async () => {
    const { result, artifact } = await runChains({}, { symbols: ["AAPL", "MSFT"] });
    expect(result.status).toBe("completed");
    expect(result.received).toBe(2);
    expect(result.requested).toBe(2);
    expect(artifact.universe).toEqual({
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: "2026-11-02",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 2,
    });
    expect(artifact.providerId).toBe("alpaca");
    expect(artifact.elements).toEqual(["optionsChains"]);
    expect(artifact.chains).toHaveLength(2);
    const aapl = artifact.chains!.find((r) => r.symbol === "AAPL")!;
    // Default window 0–365 DTE from T0: the 377-DTE expiry is out.
    expect(aapl.expiries).toEqual([
      { year: 2026, month: 11, day: 20 },
      { year: 2026, month: 12, day: 18 },
    ]);
    expect(aapl.chains).toHaveLength(2);
    expect(aapl.fetchErrors).toEqual([]);
    expect(aapl.chains[0]?.selectedExpiry).toEqual({
      year: 2026,
      month: 11,
      day: 20,
    });
    expect(feedDatasetRowCount(artifact)).toBe(2);
  });

  it("explicit symbols with a non-member become a symbols-kind run, nothing dropped", async () => {
    const { result, artifact } = await runChains(
      {},
      { symbols: ["AAPL", "ZZZZ"] },
    );
    expect(result.status).toBe("completed");
    expect(result.received).toBe(2);
    expect(artifact.universe).toEqual({
      kind: "symbols",
      symbols: ["AAPL", "ZZZZ"],
      label: "Run symbols (2)",
      snapshotDate: null,
      sourceLabel: null,
      size: 2,
    });
    expect(artifact.chains!.map((r) => r.symbol).sort()).toEqual(["AAPL", "ZZZZ"]);
  });

  it("no symbols input pulls the stored list (index-kind)", async () => {
    const { result, artifact } = await runChains({}, {});
    expect(result.status).toBe("completed");
    expect(result.received).toBe(2);
    expect(artifact.universe.kind).toBe("index");
    if (artifact.universe.kind === "index") {
      expect(artifact.universe.index).toBe("nasdaq100");
    }
  });

  it("no symbols and no stored list fails FEED_UNIVERSE_MISSING", async () => {
    const { result } = await runChains({}, { seedUniverse: false });
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.universeMissing);
  });

  it("the DTE window filters expiries (screener semantics)", async () => {
    const { artifact } = await runChains(
      {},
      { symbols: ["AAPL"], minDte: 0, maxDte: 30 },
    );
    const aapl = artifact.chains!.find((r) => r.symbol === "AAPL")!;
    expect(aapl.expiries).toEqual([{ year: 2026, month: 11, day: 20 }]);
    expect(aapl.chains).toHaveLength(1);
  });

  it("expirations exist but none in-window is a legitimate empty row", async () => {
    const { result, artifact } = await runChains(
      {},
      { symbols: ["AAPL", "MSFT"], minDte: 100, maxDte: 200 },
    );
    expect(result.status).toBe("completed");
    expect(result.received).toBe(2);
    for (const row of artifact.chains!) {
      expect(row.expiries).toEqual([]);
      expect(row.chains).toEqual([]);
      expect(row.fetchErrors).toEqual([]);
    }
  });

  it("maxExpirationsPerSymbol caps the fetched expiries", async () => {
    const { artifact } = await runChains(
      {},
      {
        symbols: ["AAPL"],
        minDte: 0,
        maxDte: 400,
        maxExpirationsPerSymbol: 2,
      },
    );
    const aapl = artifact.chains!.find((r) => r.symbol === "AAPL")!;
    expect(aapl.expiries).toEqual([
      { year: 2026, month: 11, day: 20 },
      { year: 2026, month: 12, day: 18 },
    ]);
    expect(aapl.chains).toHaveLength(2);
  });

  it("a misconfigured window fails by name, never persists an empty dataset", async () => {
    const { result, artifact } = await runChains(
      {},
      { symbols: ["AAPL"], minDte: 30, maxDte: 10 },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.fetchFailed);
    expect(result.received).toBe(0);
    expect(artifact.chains).toEqual([]);
  });

  it("a symbol with no expirations is missing and the run goes partial", async () => {
    const { result, artifact } = await runChains(
      { emptyExpiriesFor: new Set(["MSFT"]) },
      { symbols: ["AAPL", "MSFT"] },
    );
    expect(result.status).toBe("partial");
    expect(result.missingSymbols).toEqual(["MSFT"]);
    expect(result.received).toBe(1);
    expect(artifact.chains!.map((r) => r.symbol)).toEqual(["AAPL"]);
  });

  it("a symbol whose expiries fetch throws is missing and the run goes partial", async () => {
    const { result } = await runChains(
      { throwExpiriesFor: new Set(["MSFT"]) },
      { symbols: ["AAPL", "MSFT"] },
    );
    expect(result.status).toBe("partial");
    expect(result.missingSymbols).toEqual(["MSFT"]);
  });

  it("a chain fetch that fails for one expiry names it and the run goes partial", async () => {
    const { result, artifact } = await runChains(
      { throwChainFor: new Set(["MSFT"]) },
      { symbols: ["AAPL", "MSFT"] },
    );
    expect(result.status).toBe("partial");
    expect(result.missingSymbols).toEqual([]);
    const msft = artifact.chains!.find((r) => r.symbol === "MSFT")!;
    expect(msft.chains).toHaveLength(1);
    expect(msft.fetchErrors).toHaveLength(1);
    expect(msft.fetchErrors[0]).toContain("stub chain failure");
  });

  it("a chain naming the wrong expiry is refused, never stored under it", async () => {
    const { result, artifact } = await runChains(
      { mismatchFor: new Set(["AAPL"]) },
      { symbols: ["AAPL"] },
    );
    expect(result.status).toBe("partial");
    const aapl = artifact.chains!.find((r) => r.symbol === "AAPL")!;
    expect(aapl.chains).toHaveLength(1);
    expect(aapl.chains[0]?.selectedExpiry).toEqual({
      year: 2026,
      month: 12,
      day: 18,
    });
    expect(aapl.fetchErrors).toHaveLength(1);
    expect(aapl.fetchErrors[0]).toContain("different expiry");
  });

  it("a provider without the chain methods fails FEED_PROVIDER_OPTIONS_CHAINS_UNSUPPORTED", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    const noChains = {
      id: "alpaca",
      name: "alpaca",
      capabilities: ["quotes"],
      isConfigured: () => true,
    } as DataProvider;
    const result = await runFeedOptionsChainsJob(
      registry,
      {
        provider: noChains,
        universeStore: await seededUniverseStore(),
        datasetStore,
      },
      ALPACA_OPTIONS_CHAINS_JOB_ID,
      { symbols: ["AAPL", "MSFT"], runId: "feed-chains-test", now: () => new Date(T0) },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.optionsChainsUnsupported);
    expect(result.missingSymbols).toEqual(["AAPL", "MSFT"]);
  });

  it("a run that fetched nothing is FAILED with FEED_NO_CHAINS_RETURNED", async () => {
    const { result } = await runChains(
      { throwExpiriesFor: new Set(["AAPL", "MSFT"]) },
      { symbols: ["AAPL", "MSFT"] },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(FEED_JOB_CODES.noChainsReturned);
  });

  it("the persisted-chains read serves rows by symbol with staleness", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    await runFeedOptionsChainsJob(
      registry,
      {
        provider: stubChainsProvider(),
        universeStore: await seededUniverseStore(),
        datasetStore,
      },
      ALPACA_OPTIONS_CHAINS_JOB_ID,
      { symbols: ["AAPL", "MSFT"], runId: "feed-chains-test", now: () => new Date(T0) },
    );
    const read = await readPersistedOptionsChains(datasetStore, "alpaca", {
      nowMs: T0 + 60_000,
    });
    expect(read).not.toBeUndefined();
    expect([...read!.chainsBySymbol.keys()].sort()).toEqual(["AAPL", "MSFT"]);
    expect(read!.universeLabel).toBe("Nasdaq-100");
    expect(read!.stale).toBe(false);
    const stale = await readPersistedOptionsChains(datasetStore, "alpaca", {
      nowMs: T0 + 3600_000,
      maxAgeSeconds: 60,
    });
    expect(stale!.stale).toBe(true);
    expect(
      await readPersistedOptionsChains(datasetStore, "etrade", { nowMs: T0 }),
    ).toBeUndefined();
  });
});

describe("the dataset-backed source serves fetchChains identically (#4065)", () => {
  it("live source and dataset source return the same fetchChains result", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    await runFeedOptionsChainsJob(
      registry,
      {
        provider: stubChainsProvider(),
        universeStore: await seededUniverseStore(),
        datasetStore,
      },
      ALPACA_OPTIONS_CHAINS_JOB_ID,
      { symbols: ["AAPL", "MSFT"], runId: "feed-chains-test", now: () => new Date(T0) },
    );
    const artifact = await datasetStore.latest("alpaca", "options-chains");
    expect(artifact).not.toBeUndefined();
    const datasetSource = createDatasetOptionChainSource(artifact!);
    const liveSource = stubLiveSource();
    const filter = { underlyingSymbols: ["AAPL", "MSFT"] };
    const live = await new DynamicOptionsScreener(liveSource).fetchChains(filter);
    const fromDataset = await new DynamicOptionsScreener(datasetSource).fetchChains(filter);
    expect(fromDataset).toEqual(live);
    expect(fromDataset.chains).toHaveLength(4);
    expect(fromDataset.fetchErrors).toEqual([]);
    expect(fromDataset.deferredSymbols).toEqual([]);
  });

  it("the dataset source answers expiries, scoped and unscoped chains, and misses honestly", async () => {
    const registry = buildFeedJobRegistry({});
    const datasetStore = new InMemoryFeedDatasetStore();
    await runFeedOptionsChainsJob(
      registry,
      {
        provider: stubChainsProvider(),
        universeStore: await seededUniverseStore(),
        datasetStore,
      },
      ALPACA_OPTIONS_CHAINS_JOB_ID,
      { symbols: ["AAPL"], runId: "feed-chains-test", now: () => new Date(T0) },
    );
    const artifact = await datasetStore.latest("alpaca", "options-chains");
    const source = createDatasetOptionChainSource(artifact!);
    expect(await source.getOptionExpireDates("AAPL")).toEqual([
      { year: 2026, month: 11, day: 20 },
      { year: 2026, month: 12, day: 18 },
    ]);
    expect(await source.getOptionExpireDates("MSFT")).toEqual([]);
    const scoped = await source.getOptionChains({
      symbol: "AAPL",
      expiryYear: 2026,
      expiryMonth: 12,
      expiryDay: 18,
    });
    expect(scoped?.selectedExpiry).toEqual({ year: 2026, month: 12, day: 18 });
    expect(
      await source.getOptionChains({
        symbol: "AAPL",
        expiryYear: 2027,
        expiryMonth: 1,
        expiryDay: 15,
      }),
    ).toBeNull();
    const unscoped = await source.getOptionChains({ symbol: "AAPL" });
    expect(unscoped?.selectedExpiry).toEqual({ year: 2026, month: 11, day: 20 });
    expect(await source.getOptionChains({ symbol: "MSFT" })).toBeNull();
  });
});

/** Minimal D1Database stand-in over node:sqlite (the #3941 double). */
class MockD1Database {
  readonly sqlite = new DatabaseSync(":memory:");
  prepare(sql: string) {
    const db = this.sqlite;
    const runStmt = (params: unknown[]) => ({
      async run() {
        const info = db.prepare(sql).run(...(params as never[]));
        return {
          success: true,
          meta: { changes: info.changes, last_row_id: info.lastInsertRowid },
          results: [],
        };
      },
      async all() {
        return { results: db.prepare(sql).all(...(params as never[])) };
      },
      async first() {
        return db.prepare(sql).get(...(params as never[])) ?? null;
      },
      async raw() {
        return db
          .prepare(sql)
          .all(...(params as never[]))
          .map((row: Record<string, unknown>) => Object.values(row));
      },
    });
    return {
      ...runStmt([]),
      bind(...params: unknown[]) {
        return runStmt(params);
      },
    };
  }
  async batch(statements: { run: () => Promise<unknown> }[]) {
    const results: unknown[] = [];
    this.sqlite.exec("BEGIN");
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.sqlite.exec("COMMIT");
    } catch (err) {
      this.sqlite.exec("ROLLBACK");
      throw err;
    }
    return results;
  }
}

/** node:sqlite double for the SqlStorage seam (same shape as the J1 suite's). */
class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

interface FakeObject {
  bytes: Uint8Array;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

/** Fake R2 bucket (the blob_store_1777 idiom). */
function makeFakeBucket() {
  const objects = new Map<string, FakeObject>();
  const puts: Array<{ key: string; options?: unknown }> = [];
  return {
    objects,
    puts,
    async put(key: string, value: Uint8Array | string, options?: Record<string, unknown>) {
      const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
      objects.set(key, {
        bytes,
        contentType: (options?.httpMetadata as { contentType?: string } | undefined)
          ?.contentType,
        customMetadata: options?.customMetadata as Record<string, string> | undefined,
      });
      puts.push({ key, options });
    },
    async get(key: string) {
      const obj = objects.get(key);
      if (!obj) return null;
      return {
        async arrayBuffer() {
          return obj.bytes.buffer.slice(
            obj.bytes.byteOffset,
            obj.bytes.byteOffset + obj.bytes.byteLength,
          ) as ArrayBuffer;
        },
        async text() {
          return new TextDecoder().decode(obj.bytes);
        },
        httpMetadata: obj.httpMetadata ?? {},
        customMetadata: obj.customMetadata ?? {},
      };
    },
    async delete(key: string) {
      objects.delete(key);
    },
    async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
      const keys = [...objects.keys()]
        .filter((k) => !options?.prefix || k.startsWith(options.prefix))
        .sort();
      const start = options?.cursor ? Number(options.cursor) : 0;
      const limit = options?.limit ?? 1000;
      const page = keys.slice(start, start + limit);
      return {
        objects: page.map((key) => ({ key })),
        truncated: start + limit < keys.length,
        cursor: start + limit < keys.length ? String(start + limit) : undefined,
      };
    },
  };
}

/** Map-backed DO-shaped storage (the host's blobStorage shape). */
function makeDoStorage() {
  const kv = new Map<string, unknown>();
  return {
    kv,
    get: async <T>(key: string): Promise<T | undefined> => kv.get(key) as T | undefined,
    put: async (key: string, value: unknown): Promise<void> => {
      kv.set(key, value);
    },
  };
}

/** Alpaca contracts for one symbol: 2 expiries x 2 strikes x call/put. */
function alpacaContracts(symbol: string) {
  const strikes = symbol === "AAPL" ? [150, 155] : [300, 305];
  const rows: Array<Record<string, unknown>> = [];
  for (const expiry of ["2026-11-20", "2026-12-18"]) {
    for (const strike of strikes) {
      for (const type of ["call", "put"]) {
        const tag = expiry.replaceAll("-", "").slice(2);
        rows.push({
          symbol: `${symbol}${tag}${type === "call" ? "C" : "P"}${String(strike * 1000).padStart(8, "0")}`,
          underlying_symbol: symbol,
          expiration_date: expiry,
          strike_price: strike,
          type,
        });
      }
    }
  }
  return rows;
}

/** Stub the Alpaca options read path (contracts + snapshots + quote). */
function stubAlpaca() {
  vi.stubGlobal("fetch", async (url: string) => {
    const u = new URL(String(url));
    if (
      u.hostname === "paper-api.alpaca.markets" &&
      u.pathname === "/v2/options/contracts"
    ) {
      const symbol = (u.searchParams.get("underlying_symbols") ?? "").toUpperCase();
      return {
        ok: true,
        status: 200,
        json: async () => ({ option_contracts: alpacaContracts(symbol) }),
      };
    }
    if (
      u.hostname === "data.alpaca.markets" &&
      u.pathname.startsWith("/v1beta1/options/snapshots/")
    ) {
      const symbols = (u.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
      const snapshots: Record<string, unknown> = {};
      for (const s of symbols) {
        snapshots[s] = {
          latestQuote: { bp: 1.2, ap: 1.4 },
          latestTrade: { p: 1.3 },
          dailyBar: { v: 100 },
          greeks: { delta: 0.5, gamma: 0.05, theta: -0.02, vega: 0.1, rho: 0.01 },
          impliedVolatility: 0.25,
        };
      }
      return { ok: true, status: 200, json: async () => ({ snapshots }) };
    }
    if (
      u.hostname === "data.alpaca.markets" &&
      /^\/v2\/stocks\/[^/]+\/quotes\/latest$/.test(u.pathname)
    ) {
      const symbol = u.pathname.split("/")[3]!.toUpperCase();
      const mid = symbol === "AAPL" ? { bp: 150.2, ap: 150.3 } : { bp: 300.4, ap: 300.6 };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          quote: { ...mid, bs: 10, as: 10, t: "2026-11-11T12:00:00Z" },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${u.toString()}`);
  });
}

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("the chains job across residencies (#4065)", () => {
  async function seedUniverse(mock: MockD1Database) {
    const store = new D1IndexListStore(mock as never);
    await store.store({
      index: "nasdaq100",
      snapshotDate: "2026-11-02",
      symbols: SYMBOLS.map((symbol) => ({ symbol })),
      source: "wikipedia",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      derivedFromHoldings: false,
      nowIso: iso(T0 - 4 * 24 * 3600_000),
    });
  }

  async function makeControl(steps: ReturnType<typeof createFeedStepRegistry>) {
    const stores = createInMemoryJobPipelineStores();
    const runStore = new InMemoryJobRunRecordStore();
    const messaging = new InMemoryMessagingAdapter();
    const ports: MessagingPorts = {
      producer: messaging,
      consumer: messaging,
      publisher: messaging,
      subscriber: messaging,
    };
    const control = new JobPipelineControl({
      stores,
      runRecorder: jobRunRecorderFromStore(runStore),
      publisher: ports.publisher,
      steps,
      now: () => new Date(T0),
    });
    await ensureFeedPipelineJobs(control, stores, {});
    return control;
  }

  async function runAlpacaChains(
    deps: ReturnType<typeof feedStepDepsForWorkflow>,
  ) {
    const control = await makeControl(createFeedStepRegistry(deps));
    const dispatch = await control.runJob(ALPACA_OPTIONS_CHAINS_JOB_ID, {
      trigger: "manual",
    });
    const outcome = await dispatch.completion!;
    return { dispatch, outcome };
  }

  function alpacaEnv(mock: MockD1Database, bucket: ReturnType<typeof makeFakeBucket>) {
    return {
      AGENT_DB: mock,
      REPORTS_BUCKET: bucket,
      ALPACA_API_KEY_ID: "fake-key",
      ALPACA_API_SECRET_KEY: "fake-secret",
    } as unknown as Env;
  }

  it("an Alpaca pull completes in workflow residency with a persisted chains dataset", async () => {
    stubAlpaca();
    const mock = new MockD1Database();
    await ensureProviderCaptureSchema(createD1ProviderCaptureDb(mock as never));
    await seedUniverse(mock);
    const bucket = makeFakeBucket();
    const env = alpacaEnv(mock, bucket);
    const deps = feedStepDepsForWorkflow(env, createJobPipelineStoresFromD1(mock as never));
    const { dispatch, outcome } = await runAlpacaChains(deps);
    expect(outcome.state).toBe("completed");
    const dataset = await createFeedDatasetAdapter({ AGENT_DB: mock })!.latest(
      "alpaca",
      "options-chains",
    );
    expect(dataset).not.toBeNull();
    expect(dataset!.providerId).toBe("alpaca");
    expect(dataset!.jobId).toBe(ALPACA_OPTIONS_CHAINS_JOB_ID);
    expect(dataset!.chains).toHaveLength(2);
    for (const row of dataset!.chains!) {
      expect(row.expiries).toEqual([
        { year: 2026, month: 11, day: 20 },
        { year: 2026, month: 12, day: 18 },
      ]);
      expect(row.chains).toHaveLength(2);
      expect(row.fetchErrors).toEqual([]);
      for (const chain of row.chains) {
        expect(chain.pairs.length).toBe(2);
        expect(chain.selectedExpiry).toEqual(row.expiries[row.chains.indexOf(chain)]);
      }
    }
    const captures = await new D1ProviderCaptureAdapter(
      createD1ProviderCaptureDb(mock as never),
    ).listCapturesByRun("default", dispatch.runId);
    expect(captures.length).toBeGreaterThan(0);
    for (const capture of captures) {
      expect(capture.providerId).toBe("alpaca");
      expect(capture.capability).toBe("optionsChains");
      expect(capture.status).toBe("captured");
    }
  });

  it("the same pull in host residency produces the identical dataset and provenance", async () => {
    stubAlpaca();
    async function runOnce() {
      const mock = new MockD1Database();
      await ensureProviderCaptureSchema(createD1ProviderCaptureDb(mock as never));
      await seedUniverse(mock);
      const bucket = makeFakeBucket();
      return { mock, bucket };
    }
    // Workflow residency.
    const wf = await runOnce();
    const wfEnv = alpacaEnv(wf.mock, wf.bucket);
    const wfDeps = feedStepDepsForWorkflow(
      wfEnv,
      createJobPipelineStoresFromD1(wf.mock as never),
    );
    const wfRun = await runAlpacaChains(wfDeps);
    expect(wfRun.outcome.state).toBe("completed");
    // Host residency (same D1 stores, DO-shaped capture storage).
    const host = await runOnce();
    const hostSql = new SqliteTestStorage();
    const hostStorage = makeDoStorage();
    const hostEnv = alpacaEnv(host.mock, host.bucket);
    const hostCtx = {
      env: hostEnv,
      agentCtx: {
        storage: { sql: hostSql, get: hostStorage.get, put: hostStorage.put },
      },
    } as never;
    const hostDeps = feedStepDepsForScheduledAgent(hostCtx);
    const hostRun = await runAlpacaChains(hostDeps);
    expect(hostRun.outcome.state).toBe("completed");

    const readDataset = async (mock: MockD1Database) =>
      (await createFeedDatasetAdapter({ AGENT_DB: mock })!.latest(
        "alpaca",
        "options-chains",
      ))!;
    const readCaptures = async (mock: MockD1Database, runId: string) =>
      new D1ProviderCaptureAdapter(
        createD1ProviderCaptureDb(mock as never),
      ).listCapturesByRun("default", runId);
    const wfDataset = await readDataset(wf.mock);
    const hostDataset = await readDataset(host.mock);
    const valueFields = (d: typeof wfDataset) => ({
      providerId: d.providerId,
      jobId: d.jobId,
      dataset: d.dataset,
      elements: d.elements,
      universe: d.universe,
      chains: (d.chains ?? []).map((row) => ({
        symbol: row.symbol,
        expiries: row.expiries,
        fetchErrors: row.fetchErrors,
        chains: row.chains.map((chain) => ({
          symbol: chain.symbol,
          underlyingPrice: chain.underlyingPrice,
          selectedExpiry: chain.selectedExpiry,
          pairs: chain.pairs,
        })),
      })),
    });
    expect(valueFields(hostDataset)).toEqual(valueFields(wfDataset));
    const wfCaptures = await readCaptures(wf.mock, wfRun.dispatch.runId);
    const hostCaptures = await readCaptures(host.mock, hostRun.dispatch.runId);
    expect(hostCaptures).toHaveLength(wfCaptures.length);
    for (let i = 0; i < wfCaptures.length; i++) {
      expect(hostCaptures[i]?.providerId).toBe(wfCaptures[i]?.providerId);
      expect(hostCaptures[i]?.capability).toBe(wfCaptures[i]?.capability);
      expect(hostCaptures[i]?.status).toBe(wfCaptures[i]?.status);
      expect(hostCaptures[i]?.rawByteSize).toBe(wfCaptures[i]?.rawByteSize);
    }
  });

  it("R2 unbound in workflow residency still refuses by name", async () => {
    const mock = new MockD1Database();
    await ensureProviderCaptureSchema(createD1ProviderCaptureDb(mock as never));
    await seedUniverse(mock);
    const env = {
      AGENT_DB: mock,
      ALPACA_API_KEY_ID: "fake-key",
      ALPACA_API_SECRET_KEY: "fake-secret",
    } as unknown as Env;
    const deps = feedStepDepsForWorkflow(
      env,
      createJobPipelineStoresFromD1(mock as never),
    );
    const def = buildFeedJobRegistry({}).get(ALPACA_OPTIONS_CHAINS_JOB_ID)!;
    expect(deps.providerFor(def)).toBeUndefined();
    const { outcome } = await runAlpacaChains(deps);
    expect(outcome.state).toBe("failed");
    expect(outcome.error ?? "").toContain("FEED_JOB_NOT_CONFIGURED");
  });

  it("E*TRADE/Public chains in workflow residency need the configured service login", async () => {
    const mock = new MockD1Database();
    const bucket = makeFakeBucket();
    const plain = { AGENT_DB: mock, REPORTS_BUCKET: bucket } as unknown as Env;
    const plainDeps = feedStepDepsForWorkflow(
      plain,
      createJobPipelineStoresFromD1(mock as never),
    );
    const registry = buildFeedJobRegistry({});
    expect(
      plainDeps.providerFor(registry.get(ETRADE_OPTIONS_CHAINS_JOB_ID)!),
    ).toBeUndefined();
    expect(
      plainDeps.providerFor(registry.get(PUBLIC_OPTIONS_CHAINS_JOB_ID)!),
    ).toBeUndefined();
    const withLogin = {
      AGENT_DB: mock,
      REPORTS_BUCKET: bucket,
      SERVICE_USER_LOGIN: "svc-test",
    } as unknown as Env;
    const loginDeps = feedStepDepsForWorkflow(
      withLogin,
      createJobPipelineStoresFromD1(mock as never),
    );
    expect(
      loginDeps.providerFor(registry.get(ETRADE_OPTIONS_CHAINS_JOB_ID)!)?.id,
    ).toBe("etrade");
    expect(
      loginDeps.providerFor(registry.get(PUBLIC_OPTIONS_CHAINS_JOB_ID)!)?.id,
    ).toBe("public");
  });
});
