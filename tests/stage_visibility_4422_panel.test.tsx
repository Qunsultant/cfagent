// @vitest-environment jsdom
/**
 * Issue #4422 — the shard detail renders what the shard recorded about its
 * symbol, and states that the full fetched chain is not retained.
 *
 * Pins:
 *  - 4422-P07 the per-symbol evidence renders: verdict, strategy counts, the
 *    best candidate and its quoted legs.
 *  - 4422-P08 the "full chain is not retained" limit is stated where the
 *    owner looks for the chain.
 *  - 4422-P09 a skipped symbol renders its skip reason as its evidence.
 *  - 4422-P10 a run with no recorded evidence renders no section at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RunDetail } from "../src/client/WorkflowRunsPanel";
import type {
  ShardSymbolEvidence,
  WorkflowRun,
  WorkflowRunStage,
} from "../src/services/workflowRuns";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root | null = null;

async function flush() {
  await act(async () => {
    await Promise.resolve();
  });
}

function evidence(over: Partial<ShardSymbolEvidence> = {}): ShardSymbolEvidence {
  return {
    symbol: "AAPL",
    verdict: "pass",
    skipReason: null,
    targetPrice: 205,
    targetSource: "analyst",
    targetEmUnits: 0.8,
    gateBucket: "fit",
    gateReasons: [],
    strategyTypeCount: 1,
    strategies: [
      {
        strategyType: "bull_call",
        evaluatedCount: 12,
        passedCount: 2,
        rejectedCount: 10,
        rejectionReasons: [{ reason: "debit_too_high", count: 6 }],
        best: {
          label: "Bull call spread 200/210",
          expirationDate: "2026-12-18",
          netDebit: 235,
          maxLoss: 235,
          maxProfit: 765,
          maxProfitUnbounded: false,
          probabilityOfProfit: 0.63,
          legs: [
            {
              side: "BUY",
              optionType: "CALL",
              quantity: 2,
              strike: 200,
              expirationDate: "2026-12-18",
              entryPrice: 4.25,
              bid: 4.1,
              ask: 4.4,
              impliedVolatility: 0.32,
              openInterest: 1200,
              volume: 340,
            },
          ],
          legCount: 1,
        },
      },
    ],
    ...over,
  };
}

function stage(over: Partial<WorkflowRunStage> = {}): WorkflowRunStage {
  return {
    key: "shard-aapl",
    order: 1,
    stage: "feed",
    label: "Feed",
    status: "completed",
    recordedBy: "job",
    startedAt: "2026-11-13T12:00:00.000Z",
    finishedAt: "2026-11-13T12:00:06.000Z",
    durationMs: 6_000,
    detail: "Shard: feed/AAPL",
    reason: null,
    error: null,
    capability: "shard.execute",
    jobKind: "main",
    channel: null,
    input: null,
    output: null,
    jobId: "shard-aapl",
    ...over,
  };
}

function run(over: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    id: "chain-4422",
    runId: "chain-4422",
    workflow: "Options screen",
    family: "options",
    title: "Scheduled options screen",
    source: "job-chain",
    trigger: "scheduled",
    triggerDetail: "Scheduled — recorded on the run's job tree",
    triggeredBy: "analyst",
    status: "completed",
    lifecycle: "completed",
    startedAt: "2026-11-13T12:00:00.000Z",
    finishedAt: "2026-11-13T12:00:06.000Z",
    durationMs: 6_000,
    stageCount: 1,
    completedStages: 1,
    failedStages: 0,
    stages: [stage()],
    artifacts: [],
    documents: null,
    schedule: null,
    stranded: false,
    deliveryStates: {},
    inputs: null,
    outputs: null,
    error: null,
    ...over,
  } as WorkflowRun;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  container.remove();
  root = null;
});

describe("per-symbol evidence in the shard detail (#4422)", () => {
  it("renders the verdict, strategy counts, best candidate and quoted legs", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<RunDetail run={run({ stages: [stage({ symbolEvidence: evidence() })] })} />);
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Per-symbol evidence");
    expect(text).toContain("AAPL");
    expect(text).toContain("pass");
    expect(text).toContain("bull_call");
    expect(text).toContain("12 / 2 / 10");
    expect(text).toContain("Bull call spread 200/210");
    expect(text).toContain("BUY 2 CALL 200 2026-12-18 @ 4.25");
    expect(text).toContain("bid 4.1 / ask 4.4");
  });

  it("states that the full fetched chain is not retained", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<RunDetail run={run({ stages: [stage({ symbolEvidence: evidence() })] })} />);
    });
    await flush();
    expect(container.textContent ?? "").toContain("The full fetched chain (every strike of every expiry) is not retained.");
  });

  it("renders a skipped symbol's reason as its evidence", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <RunDetail
          run={run({
            stages: [
              stage({
                symbolEvidence: evidence({
                  verdict: "skipped",
                  skipReason: "Option chain unavailable for AAPL",
                  strategies: [],
                  strategyTypeCount: 0,
                  gateBucket: null,
                }),
              }),
            ],
          })}
        />,
      );
    });
    await flush();
    const text = container.textContent ?? "";
    expect(text).toContain("Skipped: Option chain unavailable for AAPL");
    expect(text).toContain("No strategy type was evaluated");
  });

  it("renders no evidence section when nothing was recorded", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(<RunDetail run={run()} />);
    });
    await flush();
    expect(container.textContent ?? "").not.toContain("Per-symbol evidence");
  });
});
