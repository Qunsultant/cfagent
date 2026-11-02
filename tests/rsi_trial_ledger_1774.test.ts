/**
 * #1774 (parent #1717, F-43) — RSI trial ledger port, Red pins.
 *
 * The trial ledger is append-only and hash-chained: a trial is
 * proposed, telemetry is appended while it runs, an evaluation is
 * appended, and a human-owner decision (approved/rejected) gates
 * adoption. Status is derived from the event log, never mutated
 * in place. No trial may be adopted without an approval decision.
 */
import { describe, expect, it } from "vitest";
import {
  createMemoryTrialLedgerStore,
  recordTrialDecision,
  recordTrialEvaluation,
  recordTrialTelemetry,
  proposeTrial,
  getTrial,
  listTrialEvents,
  startTrial,
  adoptTrial,
  verifyTrialChain,
  type TrialLedgerStore,
} from "../src/rsi/trialLedger";

function store(): TrialLedgerStore {
  return createMemoryTrialLedgerStore();
}

describe("RSI trial ledger (1774)", () => {
  it("proposes a trial in proposed status with no events beyond proposal", async () => {
    const s = store();
    const trial = await proposeTrial(s, {
      hypothesis: "Cache screener quotes for 60s to cut provider calls",
      owner: "ciso",
    });
    expect(trial.status).toBe("proposed");
    expect(trial.hypothesis).toContain("screener");
    const view = await getTrial(s, trial.id);
    expect(view?.status).toBe("proposed");
    expect(await listTrialEvents(s, trial.id)).toHaveLength(1);
  });

  it("rejects a blank hypothesis or owner", async () => {
    const s = store();
    await expect(
      proposeTrial(s, { hypothesis: "   ", owner: "ciso" }),
    ).rejects.toThrow();
    await expect(
      proposeTrial(s, { hypothesis: "h", owner: "" }),
    ).rejects.toThrow();
  });

  it("moves proposed -> running -> completed via telemetry and evaluation", async () => {
    const s = store();
    const trial = await proposeTrial(s, {
      hypothesis: "h",
      owner: "ciso",
    });
    await startTrial(s, trial.id);
    await recordTrialTelemetry(s, trial.id, {
      metric: "provider_calls",
      value: 42,
      unit: "count",
    });
    await recordTrialEvaluation(s, trial.id, {
      verdict: "pass",
      evidence: "calls fell 30% with no accuracy loss",
    });
    const view = await getTrial(s, trial.id);
    expect(view?.status).toBe("completed");
    expect(view?.metrics).toHaveLength(1);
    expect(view?.metrics[0].metric).toBe("provider_calls");
    expect(view?.evaluation?.verdict).toBe("pass");
  });

  it("refuses telemetry on an unknown trial and evaluation before start", async () => {
    const s = store();
    await expect(
      recordTrialTelemetry(s, "nope", {
        metric: "m",
        value: 1,
        unit: "count",
      }),
    ).rejects.toThrow();
    const trial = await proposeTrial(s, { hypothesis: "h", owner: "ciso" });
    await expect(
      recordTrialEvaluation(s, trial.id, {
        verdict: "pass",
        evidence: "e",
      }),
    ).rejects.toThrow();
  });

  it("refuses adoption without an approval decision, then adopts after approval", async () => {
    const s = store();
    const trial = await proposeTrial(s, { hypothesis: "h", owner: "ciso" });
    await startTrial(s, trial.id);
    await recordTrialEvaluation(s, trial.id, {
      verdict: "pass",
      evidence: "e",
    });
    await expect(adoptTrial(s, trial.id)).rejects.toThrow();
    await recordTrialDecision(s, trial.id, {
      decision: "approved",
      approver: "owner",
    });
    const adopted = await adoptTrial(s, trial.id);
    expect(adopted.status).toBe("adopted");
  });

  it("refuses adoption after a rejection decision", async () => {
    const s = store();
    const trial = await proposeTrial(s, { hypothesis: "h", owner: "ciso" });
    await startTrial(s, trial.id);
    await recordTrialEvaluation(s, trial.id, {
      verdict: "fail",
      evidence: "e",
    });
    await recordTrialDecision(s, trial.id, {
      decision: "rejected",
      approver: "owner",
    });
    await expect(adoptTrial(s, trial.id)).rejects.toThrow();
    expect((await getTrial(s, trial.id))?.status).toBe("rejected");
  });

  it("keeps a verifiable hash chain over the trial event log", async () => {
    const s = store();
    const trial = await proposeTrial(s, { hypothesis: "h", owner: "ciso" });
    await startTrial(s, trial.id);
    await recordTrialTelemetry(s, trial.id, {
      metric: "m",
      value: 1,
      unit: "count",
    });
    const events = await listTrialEvents(s, trial.id);
    expect(await verifyTrialChain(events)).toBe(true);
    const tampered = events.map((e) => ({ ...e }));
    tampered[1] = { ...tampered[1], payload: { kind: "forged" } };
    expect(await verifyTrialChain(tampered)).toBe(false);
  });

  it("exposes no update or delete operation on the store", () => {
    const s = store() as unknown as Record<string, unknown>;
    expect(s.update).toBeUndefined();
    expect(s.delete).toBeUndefined();
    expect(s.remove).toBeUndefined();
  });
});
