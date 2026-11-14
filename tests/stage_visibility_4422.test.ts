// @vitest-environment node
/**
 * Issue #4422 ([Stage visibility] raw per-symbol chain view) — what a shard
 * recorded about its symbol, surfaced honestly.
 *
 * The fetched chain is NOT persisted: `executeOptionsSymbol` keeps only the
 * derived `OpportunityScanResult`. So the slice exposes the recorded
 * per-symbol evidence (verdict, skip reason, target, fit gate, one cell per
 * strategy type, and the quoted legs of each cell's best candidate) and says
 * plainly that the full chain is not retained.
 *
 * Pins:
 *  - 4422-P01 the normalizer reads the recorded matrix row: verdict, skip
 *    reason, target, gate, and per-strategy counts.
 *  - 4422-P02 the best candidate's quoted legs ride through with their quote
 *    fields (bid/ask/IV/OI/volume) — the contracts the scan actually chose.
 *  - 4422-P03 a record with no matrix row answers null: a job that never
 *    scanned claims nothing about a symbol.
 *  - 4422-P04 the caps name what they trimmed (strategyTypeCount, legCount)
 *    instead of dropping it silently.
 *  - 4422-P05 the read model attaches the evidence to the shard row only.
 *  - 4422-P06 a skipped symbol with no cells is still one row of evidence —
 *    its skip reason is the answer to "why was no data retrieved?".
 */
import { describe, expect, it } from "vitest";
import {
  runFromJobs,
  shardSymbolEvidence,
  type WorkflowRunJobRow,
} from "../src/services/workflowRuns";

const T0 = Date.parse("2026-11-13T12:00:00.000Z");
const CHAIN_ID = "chain-4422";

function leg(over: Record<string, unknown> = {}) {
  return {
    symbol: "AAPL",
    optionType: "CALL",
    side: "BUY",
    quantity: 2,
    strike: 200,
    expirationDate: "2026-12-18",
    entryPrice: 4.25,
    bid: 4.1,
    ask: 4.4,
    impliedVolatility: 0.32,
    delta: 0.41,
    gamma: 0.01,
    theta: -0.05,
    vega: 0.12,
    openInterest: 1200,
    volume: 340,
    spreadPct: 0.07,
    quoteTimestamp: "2026-11-13T14:00:00.000Z",
    ...over,
  };
}

function cell(over: Record<string, unknown> = {}) {
  return {
    strategyType: "bull_call",
    evaluatedCount: 12,
    passedCount: 2,
    rejectedCount: 10,
    rejectionReasons: { debit_too_high: 6, low_open_interest: 4 },
    best: {
      candidateId: "cand-1",
      label: "Bull call spread 200/210",
      compositeScore: 71,
      score: 68,
      expirationDate: "2026-12-18",
      legs: [leg(), leg({ optionType: "CALL", side: "SELL", strike: 210, entryPrice: 1.9, bid: 1.8, ask: 2 })],
      netDebit: 235,
      maxLoss: 235,
      maxProfit: 765,
      maxProfitUnbounded: false,
      targetRewardRisk: 3.25,
      probabilityOfProfit: 0.63,
    },
    ...over,
  };
}

function result(over: Record<string, unknown> = {}) {
  return {
    scanned: 1,
    withTrades: 1,
    opportunities: [],
    skipped: [],
    truncatedSymbols: 0,
    assumptions: [],
    matrix: [
      {
        symbol: "AAPL",
        verdict: "pass",
        targetPrice: 205,
        targetSource: "analyst",
        targetEmUnits: 0.8,
        gateBucket: "fit",
        gateReasons: [],
        cells: [cell()],
        ...over,
      },
    ],
    typeRollup: [],
    mode: "strategy_fit",
    fits: [],
    fitsTotal: 0,
    gate: { fit: 1, borderline: 0, noFit: 0 },
    borderline: [],
    gateParams: {},
    profileRef: null,
  };
}

function shardRow(payload: Record<string, unknown>, resultJson: unknown): WorkflowRunJobRow {
  return {
    job_id: "shard-aapl-4422",
    capability: "shard.execute",
    display_name: "Shard: feed/AAPL",
    status: "completed",
    created_at: new Date(T0).toISOString(),
    started_at: new Date(T0).toISOString(),
    completed_at: new Date(T0 + 6_000).toISOString(),
    chain_id: CHAIN_ID,
    stage: "feed",
    job_kind: "main",
    payload_json: JSON.stringify({
      shard: { stage: "feed", key: "AAPL" },
      chain: { chainId: CHAIN_ID, screenType: "options" },
    }),
    result_json: resultJson === undefined ? null : JSON.stringify(resultJson),
    ...payload,
  };
}

describe("4422-P01 the recorded matrix row is read, not invented", () => {
  it("carries verdict, target, gate and per-strategy counts", () => {
    const evidence = shardSymbolEvidence(shardRow({}, result()))!;
    expect(evidence.symbol).toBe("AAPL");
    expect(evidence.verdict).toBe("pass");
    expect(evidence.skipReason).toBeNull();
    expect(evidence.targetPrice).toBe(205);
    expect(evidence.targetSource).toBe("analyst");
    expect(evidence.gateBucket).toBe("fit");
    expect(evidence.gateReasons).toEqual([]);
    expect(evidence.strategyTypeCount).toBe(1);
    expect(evidence.strategies[0]).toMatchObject({
      strategyType: "bull_call",
      evaluatedCount: 12,
      passedCount: 2,
      rejectedCount: 10,
    });
    expect(evidence.strategies[0].rejectionReasons[0]).toEqual({ reason: "debit_too_high", count: 6 });
  });

  it("carries a skip verdict with its reason", () => {
    const evidence = shardSymbolEvidence(
      shardRow(
        {},
        result({
          verdict: "skipped",
          skipReason: "Option chain unavailable for AAPL",
          targetPrice: null,
          targetEmUnits: null,
          gateBucket: null,
          cells: [],
        }),
      ),
    )!;
    expect(evidence.verdict).toBe("skipped");
    expect(evidence.skipReason).toBe("Option chain unavailable for AAPL");
    expect(evidence.strategyTypeCount).toBe(0);
    expect(evidence.strategies).toEqual([]);
  });
});

describe("4422-P02 the quoted contracts ride through", () => {
  it("keeps every quote field the scan chose from", () => {
    const evidence = shardSymbolEvidence(shardRow({}, result()))!;
    const best = evidence.strategies[0].best!;
    expect(best.label).toBe("Bull call spread 200/210");
    expect(best.netDebit).toBe(235);
    expect(best.maxProfit).toBe(765);
    expect(best.probabilityOfProfit).toBe(0.63);
    expect(best.legs).toHaveLength(2);
    expect(best.legs[0]).toMatchObject({
      side: "BUY",
      optionType: "CALL",
      strike: 200,
      expirationDate: "2026-12-18",
      entryPrice: 4.25,
      bid: 4.1,
      ask: 4.4,
      impliedVolatility: 0.32,
      openInterest: 1200,
      volume: 340,
    });
    expect(best.legs[1]).toMatchObject({ side: "SELL", strike: 210 });
    expect(best.legCount).toBe(2);
  });
});

describe("4422-P03 nothing recorded, nothing claimed", () => {
  it("answers null for a shard with no result", () => {
    expect(shardSymbolEvidence(shardRow({}, undefined))).toBeNull();
  });

  it("answers null for a result with no matrix row", () => {
    expect(shardSymbolEvidence(shardRow({}, { ...result(), matrix: [] }))).toBeNull();
  });

  it("answers null for a job that is not a shard", () => {
    expect(
      shardSymbolEvidence(shardRow({ capability: "feed.snapshot" }, result())),
    ).toBeNull();
  });
});

describe("4422-P04 the caps name what they trimmed", () => {
  it("caps strategy types and reports the recorded count", () => {
    const cells = Array.from({ length: 20 }, (_, index) =>
      cell({ strategyType: `type_${index}` }),
    );
    const evidence = shardSymbolEvidence(shardRow({}, result({ cells })))!;
    expect(evidence.strategyTypeCount).toBe(20);
    expect(evidence.strategies).toHaveLength(12);
  });

  it("caps legs and reports the recorded count", () => {
    const manyLegs = Array.from({ length: 12 }, (_, index) => leg({ strike: 190 + index }));
    const cells = [cell({ best: { ...cell().best, legs: manyLegs } })];
    const evidence = shardSymbolEvidence(shardRow({}, result({ cells })))!;
    const best = evidence.strategies[0].best!;
    expect(best.legCount).toBe(12);
    expect(best.legs).toHaveLength(8);
  });
});

describe("4422-P05 the read model attaches it to the shard row", () => {
  it("carries the evidence on the shard stage and not on other rows", () => {
    const run = runFromJobs(
      [shardRow({}, result()), shardRow({ job_id: "shard-msft-4422" }, undefined)],
      [],
      undefined,
      T0,
    );
    const aapl = run.stages.find((stage) => stage.key === "shard-aapl-4422")!;
    const msft = run.stages.find((stage) => stage.key === "shard-msft-4422")!;
    expect(aapl.symbolEvidence?.symbol).toBe("AAPL");
    expect(msft.symbolEvidence).toBeUndefined();
  });
});

describe("4422-P06 a skipped symbol is still evidence", () => {
  it("keeps one row for a symbol with no evaluated strategy type", () => {
    const run = runFromJobs(
      [
        shardRow(
          {},
          result({
            verdict: "skipped",
            skipReason: "host died before the chain fetch",
            cells: [],
            gateBucket: null,
          }),
        ),
      ],
      [],
      undefined,
      T0,
    );
    const evidence = run.stages[0].symbolEvidence!;
    expect(evidence.verdict).toBe("skipped");
    expect(evidence.skipReason).toBe("host died before the chain fetch");
    expect(evidence.strategies).toEqual([]);
  });
});
