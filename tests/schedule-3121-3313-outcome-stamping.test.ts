/**
 * Issue #3313: stamp the originating scheduleId/workflowId onto
 * ScreenerRunOutcome at run producers (stock / options / goal /
 * strategy screens, manual + scheduled), so the bridge record, the
 * follow-up payloads, and the job_run_records row all join to the
 * same schedule/workflow/async job. S1 null-handling stays: a run
 * with genuinely no originating schedule records explicit nulls —
 * the linkage resolver stamps null, never an invented id.
 *
 * Pins:
 * - 3313-P01: bus event carrying scheduleId → outcome + linkage join.
 * - 3313-P02: run-result record carrying scheduleId/workflowId →
 *   outcome + linkage join both.
 * - 3313-P03: run-result record with no ids → outcome carries
 *   neither; linkage stamps explicit nulls.
 * - 3313-P04: discovery builder input carrying scheduleId →
 *   outcome carries it.
 * - 3313-P05: failed bus event carrying scheduleId → outcome
 *   carries it (failed legs join too).
 * - 3313-P06: auth-preflight blocked outcome carries the trace's
 *   scheduleId (lives in tests/etrade_auth_preflight.test.ts).
 */
import { describe, expect, it } from "vitest";
import {
  followupLedgerLinkage,
  screenerOutcomeFromEvent,
  screenerOutcomeFromRunResult,
} from "../src/services/screenerFollowups";
import { buildDiscoveryDeliveryOutcome } from "../src/services/scheduledTasks";
import type { DiscoverySymbolOutcome } from "../src/trading";
import type { ScreenerEvent } from "../src/events/screenerEvents";

describe("3313-P01 bus event carries the arming schedule onto the outcome", () => {
  it("stock completed event with scheduleId joins the bridge row to the schedule", () => {
    const event: ScreenerEvent = {
      type: "screener.completed",
      timestamp: "2026-11-11T12:00:00.000Z",
      sector: "ALL",
      totalScanned: 10,
      matchedCount: 1,
      opportunities: [],
      scheduleId: "sched-3313-stock",
    };
    const outcome = screenerOutcomeFromEvent(event);
    expect(outcome.scheduleId).toBe("sched-3313-stock");
    expect(followupLedgerLinkage(outcome).scheduleId).toBe("sched-3313-stock");
  });

  it("stock completed event with no scheduleId leaves the outcome unjoined", () => {
    const event: ScreenerEvent = {
      type: "screener.completed",
      timestamp: "2026-11-11T12:00:00.000Z",
      sector: "ALL",
      totalScanned: 10,
      matchedCount: 1,
      opportunities: [],
    };
    const outcome = screenerOutcomeFromEvent(event);
    expect(outcome.scheduleId).toBeUndefined();
    expect(followupLedgerLinkage(outcome).scheduleId).toBeNull();
  });
});

describe("3313-P02 run-result record carries scheduleId/workflowId onto the outcome", () => {
  it("stock run-result with both ids joins the bridge row to the schedule and the workflow", () => {
    const outcome = screenerOutcomeFromRunResult("stock", {
      success: true,
      universe: "NASDAQ100",
      totalScanned: 50,
      matchedCount: 2,
      scheduleId: "sched-3313-manual",
      workflowId: "wf-3313-manual",
    });
    expect(outcome.scheduleId).toBe("sched-3313-manual");
    expect(outcome.workflowId).toBe("wf-3313-manual");
    const linkage = followupLedgerLinkage(outcome);
    expect(linkage.scheduleId).toBe("sched-3313-manual");
    expect(linkage.workflowId).toBe("wf-3313-manual");
  });

  it("options run-result with scheduleId only joins the schedule; workflow stays null", () => {
    const outcome = screenerOutcomeFromRunResult("options", {
      success: true,
      thesis: "volatility",
      totalScanned: 12,
      matchedCount: 3,
      scheduleId: "sched-3313-options",
    });
    expect(outcome.scheduleId).toBe("sched-3313-options");
    expect(outcome.workflowId).toBeUndefined();
    const linkage = followupLedgerLinkage(outcome);
    expect(linkage.scheduleId).toBe("sched-3313-options");
    expect(linkage.workflowId).toBeNull();
  });
});

describe("3313-P03 run-result record with no ids records explicit nulls", () => {
  it("manual run with no originating schedule carries neither id", () => {
    const outcome = screenerOutcomeFromRunResult("stock", {
      success: true,
      universe: "NASDAQ100",
      totalScanned: 50,
      matchedCount: 2,
    });
    expect(outcome.scheduleId).toBeUndefined();
    expect(outcome.workflowId).toBeUndefined();
    const linkage = followupLedgerLinkage(outcome);
    expect(linkage.scheduleId).toBeNull();
    expect(linkage.workflowId).toBeNull();
  });
});

describe("3313-P04 discovery builder carries scheduleId onto the outcome", () => {
  it("discovery input with scheduleId stamps it on the delivery outcome", () => {
    const outcome = buildDiscoveryDeliveryOutcome({
      runId: "run-3313",
      status: "completed",
      inputModel: "saved-request",
      symbols: ["NVDA"],
      summary: "Strategy discovery completed.",
      trigger: "scheduled",
      matchedCount: 1,
      totalScanned: 1,
      outcomes: [
        {
          symbol: "NVDA",
          status: "completed",
          ranked: [{ candidate: { label: "Bull Call Spread", underlyingPrice: 187.5 } }],
          bestTrade: { best: { candidate: { label: "Bull Call Spread", underlyingPrice: 187.5 } } },
        } as unknown as DiscoverySymbolOutcome,
      ],
      chainMode: true,
      scheduleId: "sched-3313-discovery",
    });
    expect(outcome.scheduleId).toBe("sched-3313-discovery");
    expect(followupLedgerLinkage(outcome).scheduleId).toBe("sched-3313-discovery");
  });
});

describe("3313-P05 failed bus event carries scheduleId onto the outcome", () => {
  it("options failed event with scheduleId joins the failed outcome to the schedule", () => {
    const event: ScreenerEvent = {
      type: "options.failed",
      timestamp: "2026-11-11T12:00:00.000Z",
      thesis: "volatility",
      error: "E*TRADE unavailable",
      scheduleId: "sched-3313-options-failed",
    };
    const outcome = screenerOutcomeFromEvent(event);
    expect(outcome.success).toBe(false);
    expect(outcome.scheduleId).toBe("sched-3313-options-failed");
    expect(followupLedgerLinkage(outcome).scheduleId).toBe("sched-3313-options-failed");
  });
});
