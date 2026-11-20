/**
 * Issue #4214 — unify the three candidate → TradeOrderContext mappings.
 *
 * `candidateToTradeContext` (src/client/trading/tradeOrderContext.ts) is
 * the one canonical mapping. OptionsResearchPanel.toTradeContext was a
 * field-for-field copy of it, and ScannerPanel.matrixCellTradeContext a
 * second copy for the flattened ScanMatrixCellBest shape. Both are now
 * thin callers of the canonical mapping, so the three call sites can
 * never drift apart again.
 *
 * Pins:
 * - 4214-P01 the matrix path and the canonical path produce the
 *   identical context for the same candidate data (options legs,
 *   bearish thesis, stock leg).
 * - 4214-P02 the matrix path inherits the canonical null-max-loss
 *   label ("unlimited", never "$null").
 * - 4214-P03 a matrix call with no thesis behaves like the canonical
 *   call with a neutral thesis (BUY).
 * - 4214-P04 structural: no second copy of the mapping survives —
 *   OptionsResearchPanel defines no local toTradeContext, and
 *   matrixCellTradeContext delegates to candidateToTradeContext.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { candidateToTradeContext } from "../src/client/trading/tradeOrderContext";
import { matrixCellTradeContext } from "../src/client/ScannerPanel";
import type {
  ScanMatrixCell,
  ScanMatrixCellBest,
  ScanMatrixRow,
} from "../src/trading/options/opportunityScanner";
import type { StrategyCandidate } from "../src/trading/options/strategyEngine";

const here = join(process.cwd());
function read(rel: string): string {
  return readFileSync(join(here, rel), "utf8").replace(/\r\n/g, "\n");
}

function condorLegs() {
  return [
    {
      symbol: "AAPL261120P00230000",
      optionType: "PUT",
      side: "SELL",
      quantity: 1,
      strike: 230,
      expirationDate: "2026-11-20",
      entryPrice: 1.85,
    },
    {
      symbol: "AAPL261120P00225000",
      optionType: "PUT",
      side: "BUY",
      quantity: 1,
      strike: 225,
      expirationDate: "2026-11-20",
      entryPrice: 1.2,
    },
  ];
}

function condorCandidate(over: Record<string, unknown> = {}): StrategyCandidate {
  return {
    symbol: "AAPL",
    label: "Iron Condor",
    expirationDate: "2026-11-20",
    maxLoss: 290,
    netDebit: -2.1,
    legs: condorLegs(),
    ...over,
  } as unknown as StrategyCandidate;
}

function condorCell(over: Record<string, unknown> = {}): ScanMatrixCell {
  return {
    strategyType: "iron_condor",
    best: {
      candidateId: "condor-1",
      label: "Iron Condor",
      compositeScore: 82,
      score: 82,
      expirationDate: "2026-11-20",
      legs: condorLegs(),
      netDebit: -2.1,
      maxLoss: 290,
      maxProfit: 210,
      maxProfitUnbounded: false,
      targetRewardRisk: 0.72,
      probabilityOfProfit: 0.68,
      ...over,
    } as unknown as ScanMatrixCellBest,
    evaluatedCount: 4,
    passedCount: 1,
    rejectedCount: 3,
    rejectionReasons: {},
  };
}

const condorRow = {
  symbol: "AAPL",
  verdict: "pass",
  targetPrice: 262.5,
  targetSource: null,
  targetEmUnits: 0.6,
  cells: [],
  gateBucket: "fit",
  gateReasons: [],
} as unknown as ScanMatrixRow;

describe("4214-P01 matrix path and canonical path agree field-for-field", () => {
  it("options legs, bullish and bearish", () => {
    for (const thesis of ["bullish", "bearish"] as const) {
      expect(matrixCellTradeContext(condorRow, condorCell(), thesis)).toEqual(
        candidateToTradeContext(condorCandidate(), thesis),
      );
    }
  });

  it("a stock leg maps to an EQ leg and an equity asset class on both paths", () => {
    const stockLegs = [
      {
        symbol: "AAPL",
        optionType: "STOCK",
        side: "BUY",
        quantity: 1,
        strike: 0,
        expirationDate: "2026-11-20",
        entryPrice: 250,
      },
    ];
    const cell = condorCell({
      strategyType: "long_stock",
      best: undefined,
    });
    cell.best = {
      candidateId: "stock-1",
      label: "Long Stock",
      compositeScore: 70,
      score: 70,
      expirationDate: "2026-11-20",
      legs: stockLegs,
      netDebit: 250,
      maxLoss: 250,
      maxProfit: null,
      maxProfitUnbounded: true,
      targetRewardRisk: 0,
      probabilityOfProfit: 0.5,
    } as unknown as ScanMatrixCellBest;
    const candidate = condorCandidate({
      label: "Long Stock",
      maxLoss: 250,
      netDebit: 250,
      legs: stockLegs,
    });
    const viaMatrix = matrixCellTradeContext(condorRow, cell, "bullish");
    const viaCanonical = candidateToTradeContext(candidate, "bullish");
    expect(viaMatrix).toEqual(viaCanonical);
    expect(viaMatrix.assetClass).toBe("equity");
    expect(viaMatrix.optionLegs?.[0].securityType).toBe("EQ");
  });
});

describe("4214-P02 matrix path inherits the canonical null-max-loss label", () => {
  it("labels an unbounded max loss as unlimited, never $null", () => {
    const cell = condorCell({ maxLoss: null });
    const ctx = matrixCellTradeContext(condorRow, cell, "bullish");
    expect(ctx.label).toBe("Iron Condor (2026-11-20), max loss unlimited");
    expect(ctx).toEqual(
      candidateToTradeContext(condorCandidate({ maxLoss: null }), "bullish"),
    );
  });
});

describe("4214-P03 matrix call with no thesis behaves like a neutral canonical call", () => {
  it("action is BUY and the contexts are identical", () => {
    const viaMatrix = matrixCellTradeContext(condorRow, condorCell(), undefined);
    expect(viaMatrix.action).toBe("BUY");
    expect(viaMatrix).toEqual(candidateToTradeContext(condorCandidate(), "neutral"));
  });
});

describe("4214-P04 structural: no second copy of the mapping survives", () => {
  it("OptionsResearchPanel defines no local toTradeContext and calls the canonical mapping", () => {
    const src = read("src/client/options/OptionsResearchPanel.tsx");
    expect(src).not.toContain("function toTradeContext(");
    expect(src).toContain("candidateToTradeContext(");
  });

  it("matrixCellTradeContext delegates to candidateToTradeContext and carries no duplicated mapping", () => {
    const src = read("src/client/ScannerPanel.tsx");
    const start = src.indexOf("export function matrixCellTradeContext(");
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf("\n}\n", start);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    expect(body).toContain("candidateToTradeContext(");
    expect(body).not.toContain("SELL_SHORT");
    expect(body).not.toContain("max loss $");
    expect(body).not.toContain("securityType:");
  });
});
