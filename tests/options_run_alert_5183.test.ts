/**
 * Issue #5183 — one failure notice that names the schedule, dispatch, workflow,
 * mode, broker and run. Incident #5181 shipped four copies of a message that
 * named none of them.
 * Issue #5232 — it must also name the OWNER and always render the schedule,
 * because "no one ran this" is what an unattributed alert produces.
 */
import { describe, expect, it } from "vitest";
import { ensureCodedOutcome, optionsFailureAlertText, optionsRunContextLine } from "../src/services/optionsRunAlertFormat";

describe("options run alert format (#5183, #5232)", () => {
  it("names every field the reader needs", () => {
    const line = optionsRunContextLine({
      trigger: "scheduled",
      owner: "trader_alice",
      scheduleId: "sched-42",
      mode: "live",
      modeSource: "pin",
      broker: "etrade",
      accountId: "acct-9",
      runId: "run_abc",
    });

    expect(line).toBe(
      "dispatch scheduled · owner trader_alice · schedule sched-42 · workflow optionsScreenWorkflow · mode live (pin) · broker etrade · account acct-9 · run run_abc",
    );
  });

  it("renders unknown values as unknown, never blank", () => {
    const line = optionsRunContextLine({});

    expect(line).toContain("owner unknown");
    expect(line).toContain("schedule unknown");
    expect(line).toContain("mode unknown");
    expect(line).toContain("broker unknown");
    expect(line).toContain("run unknown");
    expect(line).not.toMatch(/·\s*·/);
    expect(line.endsWith("· ")).toBe(false);
  });

  it("always renders the schedule field, even when the run carried none (#5232)", () => {
    const line = optionsRunContextLine({ owner: "trader_bob", broker: "alpaca" });

    expect(line).toContain("schedule unknown");
  });

  it("defaults the dispatch to scheduled and the workflow to the options pipeline", () => {
    const line = optionsRunContextLine({ broker: "alpaca" });

    expect(line.startsWith("dispatch scheduled")).toBe(true);
    expect(line).toContain("workflow optionsScreenWorkflow");
  });

  it("builds the failure notice with the context line between cause and time", () => {
    const text = optionsFailureAlertText({
      universe: "NASDAQ100",
      thesis: "bullish",
      context: {
        trigger: "triggered",
        owner: "trader_alice",
        scheduleId: "sched-7",
        mode: "paper",
        modeSource: "selection",
        broker: "alpaca",
        runId: "run_1",
      },
      errorMessage: "[FAILURE_AUTH_NO_SESSION] No E*TRADE session is stored for this account.",
      timestamp: "2026-11-17T21:35:03.509Z",
    });
    const lines = text.split("\n");

    expect(lines[0]).toContain("Scheduled Options Screen FAILED — NASDAQ100 (bullish)");
    expect(lines[1]).toContain("dispatch triggered");
    expect(lines[1]).toContain("owner trader_alice");
    expect(lines[1]).toContain("schedule sched-7");
    expect(lines[1]).toContain("broker alpaca");
    expect(lines[2]).toContain("FAILURE_AUTH_NO_SESSION");
    expect(lines[3]).toBe("_Time: 2026-11-17T21:35:03.509Z_");
  });
});

describe("coded failures at the seam (#5231)", () => {
  it("wraps a raw provider message with the catalogue outcome and keeps the detail", () => {
    const coded = ensureCodedOutcome("internal error", "alpaca");

    expect(coded).toContain("[FAILURE_UNEXPECTED_ERROR]");
    expect(coded).toContain("broker alpaca: internal error");
  });

  it("never double-wraps an already coded failure", () => {
    const original = "[FAILURE_AUTH_NO_SESSION] No E*TRADE session is stored for this account.";

    expect(ensureCodedOutcome(original, "etrade")).toBe(original);
  });

  it("copes with a missing message", () => {
    expect(ensureCodedOutcome(undefined, "alpaca")).toContain("[FAILURE_UNEXPECTED_ERROR]");
    expect(ensureCodedOutcome(undefined, "alpaca")).toContain("unknown failure");
  });
});
