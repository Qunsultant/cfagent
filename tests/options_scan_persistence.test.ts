/**
 * Issue #27: scan provenance + persistence. Until now an
 * OpportunityScanResult was computed, returned, and thrown away — no
 * generatedAt, no model version, no record of the template/caps that
 * produced it, and no store to retrieve or diff it from later.
 *
 * Pinned here:
 *  1. Provenance — every result carries generatedAt (from the injected
 *     clock), modelVersion, a requestSnapshot echoing exactly what was
 *     asked, a configSnapshot of the resolved scanner config, and
 *     coverage math (considered/scanned/truncated/evaluated/errors).
 *  2. Stores — InMemoryScanRunStore and SqlScanRunStore (over a fake
 *     executor implementing the store's exact statements — the repo's
 *     MockSqlStorage only supports = / LIKE in WHERE clauses, so it
 *     cannot execute the retention deletes' range/subquery semantics)
 *     round-trip a run identically: save → get returns the full result;
 *     list returns summaries newest-first with pagination.
 *  3. Retention — rows older than 365 days are pruned on save/prune;
 *     the row cap prunes oldest first.
 *  4. Diff — diffScanRuns reports new fits, dropped fits, still-fitting
 *     names, gate-bucket changes, and added/removed symbols exactly.
 *  5. Wiring — the NLQ scan path and the unified opportunities action
 *     persist when a store is supplied (returning scanRunId +
 *     persisted: true), and a store whose save throws still returns a
 *     successful scan flagged persisted: false.
 *  6. Issue #103 polish — summaries carry profileRef; saves may be
 *     stamped with the saver's userLogin and list/get then scope per
 *     user (legacy unscoped runs visible to everyone; the SQL store
 *     migrates a pre-scoping table by adding user_login); the unified
 *     opportunities request grew statedTarget/minDte/maxDte/offset,
 *     forwards them into the scan, and both scan paths record the
 *     original request on requestSnapshot.request for verbatim replay.
 *     (The FakeScanSql harness was extended for the new statements:
 *     PRAGMA table_info, the ALTER, the 7-column INSERT, and the
 *     visibility-filtered list SELECT.)
 *
 * Fixtures are deterministic (fake screener / stub client patterns from
 * tests/options_scanner.test.ts). No live market data, no network.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
// Issue #3460 slice 3: the unified service reads the broker through the
// presence-aware seam (no default). These tests drive the E*TRADE path,
// so the selection is explicit here instead of relying on the default.
vi.mock("../src/services/providerConnections", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/services/providerConnections")>();
  return {
    ...actual,
    readTenantBrokerSelection: async () => ({
      status: "ok",
      brokerId: "etrade",
    }),
  };
});

import {
  MAX_SCAN_SYMBOLS,
  OpportunityScanner,
  SCAN_MODEL_VERSION,
  type FitGateBucket,
  type OpportunityScanResult,
  type ScanMatrixRow,
  type ScanRequestTemplate,
} from "../src/trading/options/opportunityScanner";
import {
  InMemoryScanRunStore,
  SCAN_RUN_MAX_ROWS,
  SCAN_RUN_RETENTION_DAYS,
  SqlScanRunStore,
  diffScanRuns,
  type ScanRunStore,
  type ScanSqlExecutor,
} from "../src/trading/options/scanRunStore";
import { parseOptionsStrategyIntent, runOptionsStrategyAction } from "../src/agents/nlqOptionsStrategy";
import { UnifiedOptionsService } from "../src/trading/options/unifiedOptionsService";
import { DynamicOptionsScreener } from "../src/trading/optionsScreener";
import type { Env, ETradeOptionChain, OptionScreenResult, ScreenedOptionContractItem } from "../src/types";

// ---------------------------------------------------------------------------
// Fixtures (duplicated per repo convention from tests/options_scanner.test.ts)
// ---------------------------------------------------------------------------

const expiryDate = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);

function baseTemplate(overrides: Partial<ScanRequestTemplate> = {}): ScanRequestTemplate {
  return {
    thesis: "bullish",
    targetDate: expiryDate,
    expectedIvDirection: "unchanged",
    maxPlannedLoss: 5_000,
    minRewardRisk: 0.1,
    allowedStrategies: ["long_call", "call_debit_spread", "put_credit_spread"],
    minDte: 14,
    maxDte: 60,
    contractLimit: 500,
    candidateLimit: 10,
    maxStrikesPerSide: 12,
    maxIronCondors: 100,
    maxQuoteAgeSeconds: 60,
    eventPolicy: "warn",
    ...overrides,
  };
}

function legMid(spot: number, strike: number, type: "CALL" | "PUT"): number {
  const intrinsic = type === "CALL" ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  const timeValue = Math.max(0.3, 3 - Math.abs(strike - spot) * 0.12);
  return Math.max(0.3, intrinsic + timeValue);
}

const FULL_MULTS = [0.9, 0.95, 1, 1.05, 1.1];

function makeContracts(symbol: string, spot: number, mults: number[] = FULL_MULTS): ScreenedOptionContractItem[] {
  const now = Date.now();
  return mults.flatMap((mult) => {
    const strike = Math.round(spot * mult * 100) / 100;
    const callMid = legMid(spot, strike, "CALL");
    const putMid = legMid(spot, strike, "PUT");
    const delta = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    const base = {
      underlyingSymbol: symbol,
      underlyingPrice: spot,
      daysToExpiration: 30,
      expirationDate: expiryDate,
      moneyness: "ATM" as const,
      strikeDistancePct: (Math.abs(strike - spot) / spot) * 100,
      spreadPct: 8,
      quoteAgeSeconds: 0,
      quoteTimestamp: new Date(now).toISOString(),
      quoteFreshness: "FRESH" as const,
      lastPrice: 2.5,
      volume: 1_000,
      openInterest: 2_000,
      gamma: 0.02,
      theta: -0.03,
      vega: 0.12,
      impliedVolatility: 0.3,
      adjustedFlag: false,
      technicalSignal: "fixture",
      highlightReason: "fixture",
    };
    return [
      { ...base, optionType: "CALL" as const, symbol: `${symbol}${strike}C`, osiKey: `${symbol}-${strike}C`, strikePrice: strike, bid: callMid - 0.1, ask: callMid + 0.1, delta },
      { ...base, optionType: "PUT" as const, symbol: `${symbol}${strike}P`, osiKey: `${symbol}-${strike}P`, strikePrice: strike, bid: putMid - 0.1, ask: putMid + 0.1, delta: -delta },
    ];
  });
}

type SymbolBehavior =
  | { kind: "trade"; spot: number }
  | { kind: "empty"; validationError?: string; fetchErrorReason?: string }
  | { kind: "throw"; message: string };

const trade = (spot: number): SymbolBehavior => ({ kind: "trade", spot });

function fakeScreener(behaviors: Record<string, SymbolBehavior>): DynamicOptionsScreener {
  return {
    screenOptions: async (filter: { underlyingSymbols?: string[] }) => {
      const symbol = filter.underlyingSymbols?.[0] ?? "";
      const behavior = behaviors[symbol] ?? trade(100);
      if (behavior.kind === "throw") throw new Error(behavior.message);
      if (behavior.kind === "empty") {
        return {
          contracts: [],
          matchedCount: 0,
          totalContractsEvaluated: 0,
          totalUnderlyingsScanned: 1,
          scannedAt: new Date().toISOString(),
          rejections: [],
          ...(behavior.validationError ? { validationError: behavior.validationError } : {}),
          ...(behavior.fetchErrorReason ? { fetchErrors: [{ symbol, reason: behavior.fetchErrorReason }] } : {}),
        } as unknown as OptionScreenResult;
      }
      const contracts = makeContracts(symbol, behavior.spot);
      return {
        contracts,
        matchedCount: contracts.length,
        totalContractsEvaluated: contracts.length,
        totalUnderlyingsScanned: 1,
        scannedAt: new Date().toISOString(),
        rejections: [],
      } as unknown as OptionScreenResult;
    },
  } as unknown as DynamicOptionsScreener;
}

/** Minimal OpportunityScanResult fabrication for store/diff tests: only
 *  the fields those layers read are meaningful (matrix gate buckets,
 *  gate counts, provenance); the rest is inert filler. */
function fabricatedResult(
  generatedAt: string,
  rows: Array<{ symbol: string; gateBucket: FitGateBucket | null }>,
): OpportunityScanResult {
  const matrix: ScanMatrixRow[] = rows.map((r) => ({
    symbol: r.symbol,
    verdict: r.gateBucket === null ? "skipped" : r.gateBucket === "no_fit" ? "no_pass" : "pass",
    targetPrice: null,
    targetSource: null,
    cells: [],
    gateBucket: r.gateBucket,
    gateReasons: [],
  }));
  const gate = { fit: 0, borderline: 0, noFit: 0 };
  for (const r of rows) {
    if (r.gateBucket === "fit") gate.fit++;
    else if (r.gateBucket === "borderline") gate.borderline++;
    else if (r.gateBucket === "no_fit") gate.noFit++;
  }
  return {
    scanned: rows.length,
    withTrades: gate.fit + gate.borderline,
    opportunities: [],
    skipped: [],
    truncatedSymbols: 0,
    assumptions: [],
    matrix,
    typeRollup: [],
    mode: "strategy_fit",
    fits: [],
    fitsTotal: gate.fit,
    gate,
    borderline: [],
    gateParams: { minCompositeScore: 55, minProbabilityOfProfit: 0.35, requireFresh: true, minConfidence: "MEDIUM" },
    profileRef: null,
    generatedAt,
    modelVersion: SCAN_MODEL_VERSION,
    requestSnapshot: {
      template: {
        thesis: "bullish",
        targetDate: "2026-11-20",
        maxPlannedLoss: 5_000,
        minRewardRisk: 0.1,
        allowedStrategies: ["long_call"],
      },
      mode: "strategy_fit",
      riskProfile: "balanced",
      profile: null,
    },
    configSnapshot: {
      maxScanSymbols: MAX_SCAN_SYMBOLS,
      targetFactors: { bullish: 1.05, bearish: 0.95, large_move: 1.1, range_bound: 1 },
    },
    coverage: {
      considered: rows.length,
      scanned: rows.length,
      truncated: 0,
      evaluated: rows.filter((r) => r.gateBucket !== null).length,
      errors: rows.filter((r) => r.gateBucket === null).length,
      withTrades: gate.fit + gate.borderline,
    },
  };
}

// ---------------------------------------------------------------------------
// Statement-exact fake SQL executor for SqlScanRunStore. Implements the
// store's fixed statement set against an in-memory row array with real
// semantics (range delete, NOT IN cap subquery, generated_at/id
// ordering) and throws on anything else, so the test fails loudly if the
// store's SQL ever drifts from what is implemented here.
// ---------------------------------------------------------------------------

interface FakeScanRow {
  id: string;
  generated_at: string;
  mode: string;
  model_version: string;
  user_login: string | null;
  summary_json: string;
  result_json: string;
}

/** Column sets for the issue #103 migration: tables created before
 *  per-user scoping have no user_login column until ensure() ALTERs
 *  one in. Tests seed `tableExists`/`columns` to simulate a legacy
 *  table. */
const LEGACY_SCAN_COLUMNS = ["id", "generated_at", "mode", "model_version", "summary_json", "result_json"];
const FULL_SCAN_COLUMNS = ["id", "generated_at", "mode", "model_version", "user_login", "summary_json", "result_json"];

class FakeScanSql implements ScanSqlExecutor {
  rows: FakeScanRow[] = [];
  tableExists = false;
  columns: string[] = [];

  private sorted(): FakeScanRow[] {
    return [...this.rows].sort((a, b) =>
      a.generated_at !== b.generated_at
        ? a.generated_at < b.generated_at
          ? 1
          : -1
        : a.id < b.id
          ? 1
          : a.id > b.id
            ? -1
            : 0,
    );
  }

  exec(query: string, ...params: unknown[]): Iterable<unknown> {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("CREATE TABLE")) {
      // CREATE TABLE IF NOT EXISTS: a pre-existing (legacy) table
      // keeps its columns; a fresh table gets the full current set.
      if (!this.tableExists) {
        this.tableExists = true;
        this.columns = [...FULL_SCAN_COLUMNS];
      }
      return [];
    }
    if (q.startsWith("CREATE INDEX")) return [];
    if (q.startsWith("PRAGMA table_info")) {
      return this.columns.map((name) => ({ name }));
    }
    if (q.startsWith("ALTER TABLE mas_opportunity_scans ADD COLUMN user_login")) {
      if (!this.columns.includes("user_login")) this.columns.push("user_login");
      for (const row of this.rows) row.user_login = null;
      return [];
    }
    if (q.startsWith("INSERT INTO mas_opportunity_scans")) {
      const [id, generated_at, mode, model_version, user_login, summary_json, result_json] = params as [
        string, string, string, string, string | null, string, string,
      ];
      if (!this.rows.some((r) => r.id === id)) {
        this.rows.push({ id, generated_at, mode, model_version, user_login, summary_json, result_json });
      }
      return [];
    }
    if (q.startsWith("SELECT summary_json, result_json FROM mas_opportunity_scans WHERE id = ?")) {
      return this.rows
        .filter((r) => r.id === params[0])
        .map((r) => ({ summary_json: r.summary_json, result_json: r.result_json }));
    }
    if (q.startsWith("UPDATE mas_opportunity_scans SET summary_json = ?, result_json = ? WHERE id = ?")) {
      const [summary_json, result_json, id] = params as [string, string, string];
      const row = this.rows.find((r) => r.id === id);
      if (!row) return [];
      row.summary_json = summary_json;
      row.result_json = result_json;
      return [];
    }
    if (q.startsWith("SELECT summary_json FROM mas_opportunity_scans WHERE")) {
      // Issue #103: the visibility predicate is part of the statement
      // (user_login IS NULL OR user_login = scope); a NULL scope
      // parameter matches only the legacy rows, exactly like SQLite's
      // `= NULL` never being true.
      const [scope, limit, offset] = params as [string | null, number, number];
      return this.sorted()
        .filter((r) => r.user_login == null || (scope != null && r.user_login === scope))
        .slice(offset, offset + limit)
        .map((r) => ({ summary_json: r.summary_json }));
    }
    if (q.startsWith("SELECT COUNT(*)")) return [{ count: this.rows.length }];
    if (q.startsWith("DELETE FROM mas_opportunity_scans WHERE generated_at < ?")) {
      const cutoff = params[0] as string;
      this.rows = this.rows.filter((r) => !(r.generated_at < cutoff));
      return [];
    }
    if (q.startsWith("DELETE FROM mas_opportunity_scans WHERE id NOT IN")) {
      const keep = new Set(this.sorted().slice(0, params[0] as number).map((r) => r.id));
      this.rows = this.rows.filter((r) => keep.has(r.id));
      return [];
    }
    throw new Error(`FakeScanSql: unhandled statement: ${q}`);
  }
}

/** Deterministic id factory: hands out the given ids in order. */
function idQueue(...ids: string[]): () => string {
  let i = 0;
  return () => ids[i++] ?? `auto-${i}`;
}

// ---------------------------------------------------------------------------
// 1. Provenance on the scan result
// ---------------------------------------------------------------------------

describe("scan provenance (issue #27)", () => {
  it("stamps generatedAt from the injected clock, the model version, and faithful request/config snapshots", async () => {
    const now = new Date("2026-10-16T14:30:00.000Z");
    const scanner = new OpportunityScanner(fakeScreener({ NVDA: trade(250), AMD: trade(40) }));
    const template = baseTemplate({
      statedTarget: { price: 260, symbol: "NVDA" },
      perSymbol: { AMD: { statedTarget: { percent: 8 } } },
    });
    const result = await scanner.scan(["NVDA", "AMD"], template, {
      now,
      mode: "strategy_fit",
      riskProfile: "aggressive",
    });

    expect(result.generatedAt).toBe("2026-10-16T14:30:00.000Z");
    expect(result.modelVersion).toBe("1.2.1");
    expect(result.modelVersion).toBe(SCAN_MODEL_VERSION);

    // The snapshot echoes exactly what was asked (not what the gate or
    // the scorer later decided): scoped stated target and the per-name
    // override travel verbatim, the shared filters by reference.
    // Issue #2600 exception: strategyMode is stamped as resolved by
    // scan() (default "thesis"), never re-derived from the alias.
    expect(result.requestSnapshot.mode).toBe("strategy_fit");
    expect(result.requestSnapshot.riskProfile).toBe("aggressive");
    expect(result.requestSnapshot.strategyFilter).toBeUndefined();
    expect(result.requestSnapshot.template).toEqual({
      thesis: "bullish",
      targetDate: expiryDate,
      minDte: 14,
      maxDte: 60,
      maxPlannedLoss: 5_000,
      minRewardRisk: 0.1,
      allowedStrategies: ["long_call", "call_debit_spread", "put_credit_spread"],
      strategyMode: "thesis",
      statedTarget: { price: 260, symbol: "NVDA" },
      perSymbol: { AMD: { statedTarget: { percent: 8 } } },
    });

    // The resolved scanner config, not caller input.
    expect(result.configSnapshot.maxScanSymbols).toBe(MAX_SCAN_SYMBOLS);
    expect(result.configSnapshot.targetFactors.bullish).toBe(1.05);
    expect(result.configSnapshot.targetFactors.bearish).toBe(0.95);
    expect(result.configSnapshot.targetFactors.large_move).toBe(1.1);
    expect(result.configSnapshot.targetFactors.range_bound).toBe(1);
  });

  it("coverage math on a mixed batch: trades + validation skip + screener error + truncation", async () => {
    const tradingNames = Array.from({ length: 18 }, (_, i) => `F${String(i + 1).padStart(2, "0")}`);
    const behaviors: Record<string, SymbolBehavior> = {};
    for (const name of tradingNames) behaviors[name] = trade(100);
    behaviors["ERR"] = { kind: "empty", validationError: "bad request" };
    behaviors["THR"] = { kind: "throw", message: "upstream chain fetch failed" };
    behaviors["X21"] = trade(100); // 21st unique name — beyond the batch cap

    const scanner = new OpportunityScanner(fakeScreener(behaviors));
    const requested = [...tradingNames, "ERR", "THR", "X21"];
    const result = await scanner.scan(requested, baseTemplate(), {
      now: new Date("2026-10-16T14:30:00.000Z"),
      mode: "strategy_fit",
    });

    // considered counts the unique request (21), scanned the capped
    // batch (20), truncated the overflow (1); the two skipped rows are
    // errors, the 18 trading rows were evaluated, and every evaluated
    // row had a trade (withTrades is the pre-slice count).
    expect(result.coverage).toEqual({
      considered: 21,
      scanned: 20,
      truncated: 1,
      evaluated: 18,
      errors: 2,
      withTrades: 18,
      // Issue #16: no calendars were supplied to this scan.
      eventCalendar: { covered: 0, total: 20, coveragePct: 0 },
    });
    // And the coverage fields agree with the matrix they summarize.
    expect(result.matrix).toHaveLength(20);
    expect(result.matrix.filter((r) => r.verdict === "skipped")).toHaveLength(2);
  });

  it("coverage for a screened-but-rejected symbol: evaluated, zero trades, no error", async () => {
    const scanner = new OpportunityScanner(fakeScreener({ NP1: trade(100) }));
    const result = await scanner.scan(["NP1"], baseTemplate(), {
      strategyFilter: { minProbabilityOfProfit: 1.01 }, // rejects every candidate
    });
    expect(result.coverage).toEqual({
      considered: 1,
      scanned: 1,
      truncated: 0,
      evaluated: 1,
      errors: 0,
      withTrades: 0,
      // Issue #16: no calendars were supplied to this scan.
      eventCalendar: { covered: 0, total: 1, coveragePct: 0 },
    });
    expect(result.matrix[0]).toMatchObject({ symbol: "NP1", verdict: "no_pass", gateBucket: "no_fit" });
  });
});

// ---------------------------------------------------------------------------
// 2. Store round-trips (both implementations, identical semantics)
// ---------------------------------------------------------------------------

describe("scan run stores (issue #27)", () => {
  it("retention constants match the settled decisions", () => {
    expect(SCAN_RUN_RETENTION_DAYS).toBe(365);
    expect(SCAN_RUN_MAX_ROWS).toBe(1000);
  });

  async function saveTwoRuns(store: ScanRunStore): Promise<{ first: OpportunityScanResult; second: OpportunityScanResult }> {
    const first = fabricatedResult("2026-10-15T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "fit" },
      { symbol: "BBB", gateBucket: "no_fit" },
      { symbol: "CCC", gateBucket: null },
    ]);
    const second = fabricatedResult("2026-10-16T14:30:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]);
    await store.save(first);
    await store.save(second);
    return { first, second };
  }

  /** The same round-trip contract, run against both stores. */
  async function expectRoundTrip(store: ScanRunStore): Promise<void> {
    const { first, second } = await saveTwoRuns(store);

    const gotFirst = await store.get("run-1");
    expect(gotFirst).not.toBeNull();
    expect(gotFirst!.id).toBe("run-1");
    expect(gotFirst!.generatedAt).toBe(first.generatedAt);
    expect(gotFirst!.mode).toBe("strategy_fit");
    expect(gotFirst!.modelVersion).toBe(SCAN_MODEL_VERSION);
    expect(gotFirst!.gate).toEqual({ fit: 1, borderline: 0, noFit: 1 });
    expect(gotFirst!.coverage).toEqual(first.coverage);
    // The full result round-trips byte-for-byte (JSON) — matrix,
    // snapshots, gateParams and all.
    expect(gotFirst!.result).toEqual(first);
    expect((await store.get("run-2"))!.result).toEqual(second);
    expect(await store.get("missing")).toBeNull();

    // Listings are summaries (no full result), newest first.
    const all = await store.list();
    expect(all.map((s) => s.id)).toEqual(["run-2", "run-1"]);
    expect(all[0]).not.toHaveProperty("result");
    expect(all[1].gate).toEqual({ fit: 1, borderline: 0, noFit: 1 });

    // Pagination: limit + offset walk the newest-first listing.
    expect((await store.list({ limit: 1, offset: 0 })).map((s) => s.id)).toEqual(["run-2"]);
    expect((await store.list({ limit: 1, offset: 1 })).map((s) => s.id)).toEqual(["run-1"]);
    expect(await store.list({ limit: 1, offset: 2 })).toEqual([]);
  }

  it("InMemoryScanRunStore round-trips a run", async () => {
    await expectRoundTrip(new InMemoryScanRunStore({ idFactory: idQueue("run-1", "run-2") }));
  });

  it("SqlScanRunStore round-trips a run over its exact statements", async () => {
    const fake = new FakeScanSql();
    const store = new SqlScanRunStore(fake, { idFactory: idQueue("run-1", "run-2") });
    await expectRoundTrip(store);
    // Two rows landed in the table, with the summary and result JSON
    // stored as separate columns.
    expect(fake.rows).toHaveLength(2);
    expect(JSON.parse(fake.rows[0].summary_json).id).toBe("run-1");
    expect(JSON.parse(fake.rows[0].result_json).generatedAt).toBe("2026-10-15T14:30:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// 3. Retention
// ---------------------------------------------------------------------------

describe("scan run retention (issue #27)", () => {
  it("prunes rows older than 365 days on save (in-memory)", async () => {
    const store = new InMemoryScanRunStore({ idFactory: idQueue("old", "fresh") });
    await store.save(fabricatedResult("2025-10-01T00:00:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]));
    // Saving the fresh run prunes against the fresh run's own clock:
    // 2025-10-01 is more than 365 days before 2026-10-16.
    await store.save(fabricatedResult("2026-10-16T00:00:00.000Z", [{ symbol: "BBB", gateBucket: "fit" }]));
    expect(await store.get("old")).toBeNull();
    expect(await store.get("fresh")).not.toBeNull();
    expect((await store.list()).map((s) => s.id)).toEqual(["fresh"]);
  });

  it("prune(now) deletes expired rows and reports the count; rows inside the window survive", async () => {
    const store = new InMemoryScanRunStore({ idFactory: idQueue("a", "b") });
    await store.save(fabricatedResult("2026-01-10T00:00:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]));
    await store.save(fabricatedResult("2026-01-11T00:00:00.000Z", [{ symbol: "BBB", gateBucket: "fit" }]));
    // Pruning "now" in mid-2026: both rows are inside 365 days.
    expect(await store.prune(new Date("2026-06-01T00:00:00.000Z"))).toBe(0);
    expect(await store.list()).toHaveLength(2);
    // Pruning "now" in mid-2027: both rows are beyond 365 days.
    expect(await store.prune(new Date("2027-06-01T00:00:00.000Z"))).toBe(2);
    expect(await store.list()).toEqual([]);
  });

  it("prunes rows older than 365 days on save (SQL store)", async () => {
    const fake = new FakeScanSql();
    const store = new SqlScanRunStore(fake, { idFactory: idQueue("old", "fresh") });
    await store.save(fabricatedResult("2025-10-01T00:00:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]));
    await store.save(fabricatedResult("2026-10-16T00:00:00.000Z", [{ symbol: "BBB", gateBucket: "fit" }]));
    expect(await store.get("old")).toBeNull();
    expect(await store.get("fresh")).not.toBeNull();
    expect(fake.rows.map((r) => r.id)).toEqual(["fresh"]);
  });

  it("enforces the row cap oldest-first (in-memory)", async () => {
    const store = new InMemoryScanRunStore({ idFactory: idQueue("r1", "r2", "r3", "r4", "r5"), maxRows: 3 });
    for (let day = 1; day <= 5; day++) {
      await store.save(fabricatedResult(`2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`, [
        { symbol: "AAA", gateBucket: "fit" },
      ]));
    }
    expect((await store.list()).map((s) => s.id)).toEqual(["r5", "r4", "r3"]);
    expect(await store.get("r1")).toBeNull();
    expect(await store.get("r2")).toBeNull();
  });

  it("enforces the row cap oldest-first (SQL store)", async () => {
    const fake = new FakeScanSql();
    const store = new SqlScanRunStore(fake, { idFactory: idQueue("r1", "r2", "r3", "r4", "r5"), maxRows: 3 });
    for (let day = 1; day <= 5; day++) {
      await store.save(fabricatedResult(`2026-10-${String(day).padStart(2, "0")}T00:00:00.000Z`, [
        { symbol: "AAA", gateBucket: "fit" },
      ]));
    }
    expect((await store.list()).map((s) => s.id)).toEqual(["r5", "r4", "r3"]);
    expect(fake.rows).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// 4. Run-over-run diff
// ---------------------------------------------------------------------------

describe("diffScanRuns (issue #27)", () => {
  it("reports new fits, a dropped fit, still-fitting names, bucket changes, and added/removed symbols exactly", () => {
    const older = fabricatedResult("2026-10-15T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "fit" }, // → borderline in the newer run
      { symbol: "BBB", gateBucket: "fit" }, // → still fit
      { symbol: "CCC", gateBucket: "borderline" }, // → fit (new fit)
      { symbol: "FFF", gateBucket: "no_fit" }, // → skipped in the newer run: never judged, no bucket change
      { symbol: "GGG", gateBucket: null }, // only in the older run
    ]);
    const newer = fabricatedResult("2026-10-16T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "borderline" },
      { symbol: "BBB", gateBucket: "fit" },
      { symbol: "CCC", gateBucket: "fit" },
      { symbol: "DDD", gateBucket: "fit" }, // only in the newer run, and fit
      { symbol: "FFF", gateBucket: null },
    ]);

    expect(diffScanRuns(older, newer)).toEqual({
      newFits: ["CCC", "DDD"],
      droppedFits: ["AAA"],
      stillFitting: ["BBB"],
      bucketChanges: [
        { symbol: "AAA", from: "fit", to: "borderline" },
        { symbol: "CCC", from: "borderline", to: "fit" },
      ],
      addedSymbols: ["DDD"],
      removedSymbols: ["GGG"],
    });
  });

  it("diffing a run against itself is empty", () => {
    const run = fabricatedResult("2026-10-16T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "fit" },
      { symbol: "BBB", gateBucket: null },
    ]);
    const diff = diffScanRuns(run, run);
    expect(diff.newFits).toEqual([]);
    expect(diff.droppedFits).toEqual([]);
    expect(diff.stillFitting).toEqual(["AAA"]);
    expect(diff.bucketChanges).toEqual([]);
    expect(diff.addedSymbols).toEqual([]);
    expect(diff.removedSymbols).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Wiring: persistence rides the scan paths, and never fails a scan
// ---------------------------------------------------------------------------

/** E*TRADE chain fixture for the stub client (copied exactly from
 *  tests/options_scanner.test.ts: legs carry timeStamp/adjustedFlag/
 *  impliedVolatility, the chain carries underlyingPrice +
 *  selectedExpiry, and the client methods take args objects). */
function chainFor(symbol: string, spot: number, expiry: { year: number; month: number; day: number }): ETradeOptionChain {
  const quoteTimestamp = Date.now();
  const leg = (type: "CALL" | "PUT", strike: number) => {
    const mid = legMid(spot, strike, type);
    const deltaMag = Math.max(0.15, Math.min(0.85, 0.5 + (spot - strike) / 40));
    return {
      timeStamp: quoteTimestamp,
      adjustedFlag: false,
      optionType: type,
      strikePrice: strike,
      symbol: `${symbol}${strike}${type === "CALL" ? "C" : "P"}`,
      bid: Math.max(0.05, mid - 0.1),
      ask: mid + 0.1,
      lastPrice: mid,
      volume: 1_000,
      openInterest: 2_000,
      delta: type === "CALL" ? deltaMag : -deltaMag,
      gamma: 0.02,
      theta: -0.03,
      impliedVolatility: 0.3,
    };
  };
  return {
    symbol,
    underlyingPrice: spot,
    selectedExpiry: expiry,
    pairs: [0.9, 0.95, 1, 1.05, 1.1].map((mult) => {
      const strike = Math.round(spot * mult * 100) / 100;
      return { call: leg("CALL", strike), put: leg("PUT", strike) };
    }),
  } as unknown as ETradeOptionChain;
}

const expiryDateObj = new Date(Date.now() + 30 * 86_400_000);
const expiryObj = {
  year: expiryDateObj.getUTCFullYear(),
  month: expiryDateObj.getUTCMonth() + 1,
  day: expiryDateObj.getUTCDate(),
};

describe("scan persistence wiring (issue #27)", () => {
  const intent = parseOptionsStrategyIntent("Best bullish option trades for NVDA and AMD max loss $5000");
  const spots: Record<string, number> = { NVDA: 250, AMD: 40 };
  const client = {
    getOptionExpireDates: async () => [expiryObj],
    getOptionChains: async (args: { symbol: string }) =>
      spots[args.symbol] !== undefined ? chainFor(args.symbol, spots[args.symbol], expiryObj) : null,
  };
  const etrade = { client, environment: { kind: "sandbox" as const } };

  it("NLQ opportunities scan persists with a store and returns scanRunId", async () => {
    const store = new InMemoryScanRunStore({ idFactory: idQueue("nlq-run-1") });
    const result = await runOptionsStrategyAction(etrade as never, intent.action, intent.filters, { scanRunStore: store });

    expect(result.status).toBe("ranked_opportunities");
    expect(result.persisted).toBe(true);
    expect(result.scanRunId).toBe("nlq-run-1");

    // The stored run is the scan that was just returned — full matrix,
    // provenance and all — retrievable afterwards (acceptance: a scan
    // from yesterday can be fetched and diffed against today's).
    const stored = await store.get("nlq-run-1");
    expect(stored).not.toBeNull();
    expect(stored!.mode).toBe("per_name_best");
    expect(stored!.modelVersion).toBe(SCAN_MODEL_VERSION);
    expect(stored!.result.matrix).toHaveLength(2);
    expect(stored!.result.generatedAt).toBe(stored!.generatedAt);
    expect(stored!.result.requestSnapshot.template.thesis).toBe("bullish");
    expect(stored!.result.gateParams.minCompositeScore).toBe(55);
    expect(stored!.result.coverage).toMatchObject({ considered: 2, scanned: 2, errors: 0 });
  });

  it("a store whose save throws still returns a successful scan, flagged persisted: false", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const broken: ScanRunStore = {
        save: async () => {
          throw new Error("storage unavailable");
        },
        list: async () => [],
        get: async () => null,
        updatePdfKey: async () => false,
        updateXlsxKey: async () => false,
        updateCsvKey: async () => false,
        prune: async () => 0,
      };
      const result = await runOptionsStrategyAction(etrade as never, intent.action, intent.filters, {
        scanRunStore: broken,
      });
      expect(result.status).toBe("ranked_opportunities");
      expect(result.persisted).toBe(false);
      expect(result.scanRunId).toBeUndefined();
      expect(result.rows).toHaveLength(2);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("without a store the NLQ scan behaves exactly as before (no persistence fields)", async () => {
    const result = await runOptionsStrategyAction(etrade as never, intent.action, intent.filters);
    expect(result.status).toBe("ranked_opportunities");
    expect(result.persisted).toBeUndefined();
    expect(result.scanRunId).toBeUndefined();
  });
});

describe("unified opportunities persistence (issue #27)", () => {
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  it("persists the scan and stamps executionData with scanRunId when a store is injected", async () => {
    DynamicOptionsScreener.setTestChainsFixture({
      NVDA: chainFor("NVDA", 250, expiryObj),
      AMD: chainFor("AMD", 40, expiryObj),
    });
    const store = new InMemoryScanRunStore({ idFactory: idQueue("unified-run-1") });
    const service = new UnifiedOptionsService(
      { ETRADE_ENVIRONMENT: "sandbox" } as Env,
      "default_trader",
      undefined,
      undefined,
      store,
    );
    const result = await service.execute({ action: "opportunities", symbols: ["NVDA", "AMD"], targetDate: expiryDate });

    expect(result.success).toBe(true);
    const data = result.data as unknown as OpportunityScanResult & { scanRunId?: string; persisted?: boolean };
    expect(data.scanRunId).toBe("unified-run-1");
    expect(data.persisted).toBe(true);

    // Issue #103: the save was stamped with the service's userLogin,
    // so the read-back names its owner scope (another login — or no
    // scope at all — would read the run as absent).
    const stored = await store.get("unified-run-1", { userLogin: "default_trader" });
    expect(stored).not.toBeNull();
    expect(stored!.userLogin).toBe("default_trader");
    expect(stored!.result.generatedAt).toBe(data.generatedAt);
    expect(stored!.result.matrix).toHaveLength(2);
    expect(stored!.result.requestSnapshot.template.thesis).toBe("bullish");
  });

  it("without a store the unified scan carries no persistence fields", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ MSFT: chainFor("MSFT", 500, expiryObj) });
    const service = new UnifiedOptionsService({ ETRADE_ENVIRONMENT: "sandbox" } as Env, "test-user");
    const result = await service.execute({ action: "opportunities", symbols: ["MSFT"], targetDate: expiryDate });
    expect(result.success).toBe(true);
    const data = result.data as unknown as { scanRunId?: string; persisted?: boolean };
    expect(data.scanRunId).toBeUndefined();
    expect(data.persisted).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 6. Issue #103: profileRef in summaries, per-user scoping, replayable
//    request records
// ---------------------------------------------------------------------------

describe("scan history polish — profileRef in summaries (issue #103)", () => {
  async function expectProfileRef(store: ScanRunStore): Promise<void> {
    const withProfile: OpportunityScanResult = {
      ...fabricatedResult("2026-10-16T09:00:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]),
      profileRef: { id: "prof-9", name: "Income", version: 3 },
    };
    const withoutProfile = fabricatedResult("2026-10-16T10:00:00.000Z", [{ symbol: "BBB", gateBucket: "fit" }]);
    await store.save(withProfile);
    await store.save(withoutProfile);

    const summaries = await store.list();
    expect(summaries).toHaveLength(2);
    // The profile stamp rides the SUMMARY — a history list can label
    // the profile without fetching every run in full.
    expect(summaries.find((s) => s.id === "prof-run")!.profileRef).toEqual({ id: "prof-9", name: "Income", version: 3 });
    expect(summaries.find((s) => s.id === "plain-run")!.profileRef).toBeNull();
    expect((await store.get("prof-run"))!.profileRef).toEqual({ id: "prof-9", name: "Income", version: 3 });
  }

  it("InMemoryScanRunStore summaries carry profileRef (null when no profile ran)", async () => {
    await expectProfileRef(new InMemoryScanRunStore({ idFactory: idQueue("prof-run", "plain-run") }));
  });

  it("SqlScanRunStore summaries carry profileRef (null when no profile ran)", async () => {
    await expectProfileRef(new SqlScanRunStore(new FakeScanSql(), { idFactory: idQueue("prof-run", "plain-run") }));
  });
});

describe("scan history polish — per-user scoping (issue #103)", () => {
  /** The same scoping contract against both stores: a run saved
   *  under a login is visible only to it; a legacy unscoped run is
   *  visible to everyone; an unscoped caller sees only legacy runs.
   *  The routes' diff composes two scoped gets, so a cross-scope get
   *  returning null here is exactly the route's 404 precondition. */
  async function expectScoping(store: ScanRunStore): Promise<void> {
    await store.save(fabricatedResult("2026-10-16T10:00:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]), {
      userLogin: "alice",
    });
    await store.save(fabricatedResult("2026-10-16T11:00:00.000Z", [{ symbol: "BBB", gateBucket: "fit" }]), {
      userLogin: "bob",
    });
    await store.save(fabricatedResult("2026-10-16T09:00:00.000Z", [{ symbol: "CCC", gateBucket: "fit" }]));

    expect((await store.list({ userLogin: "alice" })).map((s) => s.id)).toEqual(["alice-run", "legacy-run"]);
    expect((await store.list({ userLogin: "bob" })).map((s) => s.id)).toEqual(["bob-run", "legacy-run"]);
    expect((await store.list()).map((s) => s.id)).toEqual(["legacy-run"]);
    // Summaries expose whose run each is (legacy carries no login).
    expect((await store.list({ userLogin: "alice" })).find((s) => s.id === "alice-run")!.userLogin).toBe("alice");
    expect((await store.list({ userLogin: "alice" })).find((s) => s.id === "legacy-run")!.userLogin).toBeUndefined();

    // Pagination walks only visible rows (filter before slicing).
    expect((await store.list({ userLogin: "alice", limit: 1 })).map((s) => s.id)).toEqual(["alice-run"]);
    expect((await store.list({ userLogin: "alice", limit: 1, offset: 1 })).map((s) => s.id)).toEqual(["legacy-run"]);

    // Get: the owner reads it, anyone else — and an unscoped read —
    // gets null (existence never leaks across users).
    expect((await store.get("alice-run", { userLogin: "alice" }))!.id).toBe("alice-run");
    expect(await store.get("alice-run", { userLogin: "bob" })).toBeNull();
    expect(await store.get("alice-run")).toBeNull();
    expect((await store.get("legacy-run", { userLogin: "bob" }))!.id).toBe("legacy-run");
    expect((await store.get("legacy-run"))!.id).toBe("legacy-run");
  }

  it("InMemoryScanRunStore scopes list/get per user", async () => {
    await expectScoping(new InMemoryScanRunStore({ idFactory: idQueue("alice-run", "bob-run", "legacy-run") }));
  });

  it("SqlScanRunStore scopes list/get per user", async () => {
    await expectScoping(new SqlScanRunStore(new FakeScanSql(), { idFactory: idQueue("alice-run", "bob-run", "legacy-run") }));
  });

  it("SQL store migrates a pre-scoping table (no user_login column) at ensure time", async () => {
    const fake = new FakeScanSql();
    const legacyResult = fabricatedResult("2026-10-10T00:00:00.000Z", [{ symbol: "AAA", gateBucket: "fit" }]);
    // A summary exactly as pre-#103 code wrote it: no profileRef, no
    // userLogin — and a table without the user_login column.
    const legacySummary = {
      id: "legacy-1",
      generatedAt: legacyResult.generatedAt,
      mode: legacyResult.mode,
      modelVersion: legacyResult.modelVersion,
      gate: legacyResult.gate,
      coverage: legacyResult.coverage,
    };
    fake.tableExists = true;
    fake.columns = [...LEGACY_SCAN_COLUMNS];
    fake.rows.push({
      id: "legacy-1",
      generated_at: legacyResult.generatedAt,
      mode: legacyResult.mode,
      model_version: legacyResult.modelVersion,
      user_login: null,
      summary_json: JSON.stringify(legacySummary),
      result_json: JSON.stringify(legacyResult),
    });

    const store = new SqlScanRunStore(fake, { idFactory: idQueue("post-migration") });
    // The legacy row reads back under any scope (it has no login)…
    expect((await store.list({ userLogin: "alice" })).map((s) => s.id)).toEqual(["legacy-1"]);
    expect((await store.get("legacy-1", { userLogin: "bob" }))!.result.generatedAt).toBe(legacyResult.generatedAt);
    // …and ensure() added the column exactly once.
    expect(fake.columns).toContain("user_login");

    // New scoped saves land in the migrated column and scope normally.
    await store.save(fabricatedResult("2026-10-16T00:00:00.000Z", [{ symbol: "BBB", gateBucket: "fit" }]), {
      userLogin: "alice",
    });
    expect(fake.rows.find((r) => r.id === "post-migration")!.user_login).toBe("alice");
    expect((await store.list({ userLogin: "alice" })).map((s) => s.id)).toEqual(["post-migration", "legacy-1"]);
    expect((await store.list({ userLogin: "bob" })).map((s) => s.id)).toEqual(["legacy-1"]);
  });
});

describe("scan history polish — recorded request + forwarding (issue #103)", () => {
  afterEach(() => {
    DynamicOptionsScreener.clearTestChainsFixture();
  });

  it("unified opportunities forwards statedTarget/minDte/maxDte into the scan and records the original request", async () => {
    DynamicOptionsScreener.setTestChainsFixture({ NVDA: chainFor("NVDA", 250, expiryObj) });
    const store = new InMemoryScanRunStore({ idFactory: idQueue("recorded-run-1") });
    const service = new UnifiedOptionsService(
      { ETRADE_ENVIRONMENT: "sandbox" } as Env,
      "alice",
      undefined,
      undefined,
      store,
    );
    const request = {
      action: "opportunities" as const,
      symbols: ["NVDA"],
      targetDate: expiryDate,
      statedTarget: { price: 300, symbol: "NVDA" },
      minDte: 10,
      maxDte: 45,
    };
    const result = await service.execute(request);
    expect(result.success).toBe(true);
    expect(result.meta.cached).toBe(false);
    const data = result.data as unknown as OpportunityScanResult & { scanRunId?: string };

    // Forwarding: the fields reached the scan template, so the
    // snapshot's effective template carries them…
    expect(data.requestSnapshot.template.statedTarget).toEqual({ price: 300, symbol: "NVDA" });
    expect(data.requestSnapshot.template.minDte).toBe(10);
    expect(data.requestSnapshot.template.maxDte).toBe(45);
    // …and the stated target actually governed NVDA's row: its source
    // is "stated" and its price is the stated one, not a derivation.
    const nvdaRow = data.matrix.find((r) => r.symbol === "NVDA")!;
    expect(nvdaRow.targetSource).toBe("stated");
    expect(nvdaRow.targetPrice).toBe(300);

    // The recorded request is the caller's original ask — the
    // replayable form — attached before return AND before persistence.
    expect(data.requestSnapshot.request).toEqual({
      symbols: ["NVDA"],
      targetDate: expiryDate,
      statedTarget: { price: 300, symbol: "NVDA" },
      minDte: 10,
      maxDte: 45,
    });
    const stored = await store.get("recorded-run-1", { userLogin: "alice" });
    expect(stored).not.toBeNull();
    expect(stored!.result.requestSnapshot.request).toEqual(data.requestSnapshot.request);
    expect(stored!.userLogin).toBe("alice");
    expect((await store.list({ userLogin: "alice" })).map((s) => s.id)).toEqual(["recorded-run-1"]);
    expect(await store.list({ userLogin: "bob" })).toEqual([]);

    // Cache: an identical call is served from cache; a different
    // stated target must NOT be (the key segments on it).
    const again = await service.execute(request);
    expect(again.meta.cached).toBe(true);
    const differentTarget = await service.execute({ ...request, statedTarget: { price: 310, symbol: "NVDA" } });
    expect(differentTarget.meta.cached).toBe(false);
    expect((differentTarget.data as unknown as OpportunityScanResult).requestSnapshot.template.statedTarget).toEqual({
      price: 310,
      symbol: "NVDA",
    });
  });

  it("NLQ opportunities scan records its request and scopes the save by deps.userLogin", async () => {
    const intent = parseOptionsStrategyIntent("Best bullish option trades for NVDA and AMD max loss $5000");
    const spots: Record<string, number> = { NVDA: 250, AMD: 40 };
    const client = {
      getOptionExpireDates: async () => [expiryObj],
      getOptionChains: async (args: { symbol: string }) =>
        spots[args.symbol] !== undefined ? chainFor(args.symbol, spots[args.symbol], expiryObj) : null,
    };
    const etrade = { client, environment: { kind: "sandbox" as const } };
    const store = new InMemoryScanRunStore({ idFactory: idQueue("nlq-recorded-1") });

    const result = await runOptionsStrategyAction(etrade as never, intent.action, intent.filters, {
      scanRunStore: store,
      userLogin: "carol",
    });
    expect(result.status).toBe("ranked_opportunities");
    expect(result.scanRunId).toBe("nlq-recorded-1");

    const stored = await store.get("nlq-recorded-1", { userLogin: "carol" });
    expect(stored).not.toBeNull();
    expect(stored!.userLogin).toBe("carol");
    expect(await store.get("nlq-recorded-1", { userLogin: "dave" })).toBeNull();
    // The NLQ record: the resolved batch and the question's expressed
    // fields (thesis, loss cap) — no stated target was asked, so none
    // is recorded; the profile selection would ride as profileName.
    const record = stored!.result.requestSnapshot.request;
    expect(record).toBeDefined();
    expect(record!.symbols).toEqual(["NVDA", "AMD"]);
    expect(record!.thesis).toBe("bullish");
    expect(record!.maxPlannedLoss).toBe(5000);
    expect(record!.statedTarget).toBeUndefined();
    expect(record!.profileId).toBeUndefined();
  });
});

describe("updatePdfKey (issue #1209: interactive scan-row PDF wiring)", () => {
  async function expectUpdateContract(store: ScanRunStore): Promise<void> {
    const result = fabricatedResult("2026-10-15T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "fit" },
    ]);
    const saved = await store.save(result, { userLogin: "carol" });
    expect(saved.pdfKey).toBeNull();

    // Stamps summary + result; visible via get and list.
    expect(await store.updatePdfKey(saved.id, "options:pdf:k1", { userLogin: "carol" })).toBe(true);
    const got = await store.get(saved.id, { userLogin: "carol" });
    expect(got!.pdfKey).toBe("options:pdf:k1");
    expect(got!.result.pdfKey).toBe("options:pdf:k1");
    expect((await store.list({ userLogin: "carol" }))[0].pdfKey).toBe("options:pdf:k1");

    // A later PDF overwrites (regeneration replaces the key).
    expect(await store.updatePdfKey(saved.id, "options:pdf:k2", { userLogin: "carol" })).toBe(true);
    expect((await store.get(saved.id, { userLogin: "carol" }))!.pdfKey).toBe("options:pdf:k2");

    // Unknown id, wrong user, and empty key all fail closed without changes.
    expect(await store.updatePdfKey("missing", "options:pdf:k3", { userLogin: "carol" })).toBe(false);
    expect(await store.updatePdfKey(saved.id, "options:pdf:k3", { userLogin: "dave" })).toBe(false);
    expect(await store.updatePdfKey(saved.id, "", { userLogin: "carol" })).toBe(false);
    expect((await store.get(saved.id, { userLogin: "carol" }))!.pdfKey).toBe("options:pdf:k2");
  }

  it("InMemoryScanRunStore stamps pdfKey after save", async () => {
    await expectUpdateContract(new InMemoryScanRunStore({ idFactory: idQueue("run-1") }));
  });

  it("SqlScanRunStore stamps pdfKey after save", async () => {
    await expectUpdateContract(new SqlScanRunStore(new FakeScanSql(), { idFactory: idQueue("run-1") }));
  });
});

describe("updateXlsxKey/updateCsvKey (issue #2524: scan-row XLSX/CSV wiring)", () => {
  async function expectUpdateContract(store: ScanRunStore): Promise<void> {
    const result = fabricatedResult("2026-10-15T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "fit" },
    ]);
    // summarize() copies XLSX/CSV keys stamped at save time.
    result.xlsxKey = "options:xlsx:saved";
    result.csvKey = "options:csv:saved";
    const saved = await store.save(result, { userLogin: "carol" });
    expect(saved.xlsxKey).toBe("options:xlsx:saved");
    expect(saved.csvKey).toBe("options:csv:saved");
    expect((await store.list({ userLogin: "carol" }))[0].xlsxKey).toBe("options:xlsx:saved");

    // Backfills stamp summary + result, mirroring updatePdfKey.
    const plain = await store.save(fabricatedResult("2026-10-16T14:30:00.000Z", [{ symbol: "BBB", gateBucket: "fit" }]), { userLogin: "carol" });
    expect(await store.updateXlsxKey(plain.id, "options:xlsx:k1", { userLogin: "carol" })).toBe(true);
    expect(await store.updateCsvKey(plain.id, "options:csv:k1", { userLogin: "carol" })).toBe(true);
    const got = await store.get(plain.id, { userLogin: "carol" });
    expect(got!.xlsxKey).toBe("options:xlsx:k1");
    expect(got!.result.xlsxKey).toBe("options:xlsx:k1");
    expect(got!.csvKey).toBe("options:csv:k1");
    expect(got!.result.csvKey).toBe("options:csv:k1");

    // Unknown id, wrong user, and empty key all fail closed.
    expect(await store.updateXlsxKey("missing", "options:xlsx:k2", { userLogin: "carol" })).toBe(false);
    expect(await store.updateCsvKey(plain.id, "options:csv:k2", { userLogin: "dave" })).toBe(false);
    expect(await store.updateXlsxKey(plain.id, "", { userLogin: "carol" })).toBe(false);
    expect((await store.get(plain.id, { userLogin: "carol" }))!.xlsxKey).toBe("options:xlsx:k1");
  }

  it("InMemoryScanRunStore stamps xlsxKey/csvKey after save", async () => {
    await expectUpdateContract(new InMemoryScanRunStore({ idFactory: idQueue("run-1", "run-2") }));
  });

  it("SqlScanRunStore stamps xlsxKey/csvKey after save", async () => {
    await expectUpdateContract(new SqlScanRunStore(new FakeScanSql(), { idFactory: idQueue("run-1", "run-2") }));
  });
});

describe("partial projection (issue #1850)", () => {
  async function expectPartialContract(store: ScanRunStore): Promise<void> {
    const withPartial = fabricatedResult("2026-10-15T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "fit" },
    ]);
    withPartial.partial = {
      evaluatedCount: 7,
      consideredCount: 10,
      coverageErrors: 2,
      truncatedCount: 1,
      topSkipReason: "fetch failed",
      topSkipCount: 2,
    };
    const withoutPartial = fabricatedResult("2026-10-16T14:30:00.000Z", [
      { symbol: "AAA", gateBucket: "fit" },
    ]);
    await store.save(withPartial, { userLogin: "carol" });
    await store.save(withoutPartial, { userLogin: "carol" });

    // The summary projection carries partial; the full result always did.
    const got = await store.get("run-1", { userLogin: "carol" });
    expect(got!.partial).toEqual(withPartial.partial);
    const summaries = await store.list({ userLogin: "carol" });
    expect(summaries.find((s) => s.id === "run-1")!.partial).toEqual(withPartial.partial);
    // Absent reads as null, never undefined — same pattern as pdfKey.
    expect((await store.get("run-2", { userLogin: "carol" }))!.partial).toBeNull();
    expect(summaries.find((s) => s.id === "run-2")!.partial).toBeNull();
  }

  it("InMemoryScanRunStore projects partial onto summaries", async () => {
    await expectPartialContract(new InMemoryScanRunStore({ idFactory: idQueue("run-1", "run-2") }));
  });

  it("SqlScanRunStore projects partial onto summaries", async () => {
    await expectPartialContract(new SqlScanRunStore(new FakeScanSql(), { idFactory: idQueue("run-1", "run-2") }));
  });
});
