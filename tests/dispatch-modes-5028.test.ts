/**
 * Issue #5028 (#3214) — the five dispatch modes exist in code.
 *
 * Venus ruling 2026-11-17: dispatch modes are 1) manual (UX),
 * 2) scheduled, 3) triggered (scheduler Run-now button), 4) copilot,
 * 5) autopilot. Before this slice only manual + scheduled existed
 * as trigger values: the engine's JobRunTrigger, the ledger's
 * derivation, and resolveScheduleRunTrigger all collapsed anything
 * else to scheduled/manual. This pin proves the five modes exist
 * end-to-end in the vocabulary (types + resolvers + ledger) BEFORE
 * any producer stamps them (stamping is #5052 triggered, #5053
 * copilot, #5054 autopilot).
 *
 * Deliberate pin update, not a bypass: the #3121 S1 parity pin
 * "derives trigger from triggeredBy and keeps triggeredBy
 * two-valued" (schedule-3121-s1-parity.test.ts) is updated in the
 * same PR to the five-valued vocabulary, with this ruling recorded.
 * worker-cron / async-chain stay mechanism values, never dispatch
 * modes: they are still rejected as triggeredBy values.
 */
import { describe, it, expect } from "vitest";
import {
  buildJobRunRecord,
  resolveScheduleRunTrigger,
} from "../src/services/jobRunRecords";
import {
  LEDGER_TRIGGERS,
  resolveLedgerTrigger,
  buildLedgerLinkage,
} from "../src/services/consolidatedScheduling";

const base = (over: Record<string, unknown> = {}) => ({
  system: "job-pipeline",
  jobId: "job_dispatch_modes",
  operation: "test.op",
  started: "2026-11-17T05:00:00.000Z",
  finished: "2026-11-17T05:00:01.000Z",
  outcome: "success",
  triggeredBy: "manual",
  ...over,
});

describe("dispatch modes — the five trigger values exist (#5028, #3214)", () => {
  it("resolveScheduleRunTrigger maps each payload trigger to itself", () => {
    expect(resolveScheduleRunTrigger({ trigger: "manual" })).toBe("manual");
    expect(resolveScheduleRunTrigger({ trigger: "scheduled" })).toBe("scheduled");
    expect(resolveScheduleRunTrigger({ trigger: "triggered" })).toBe("triggered");
    expect(resolveScheduleRunTrigger({ trigger: "copilot" })).toBe("copilot");
    expect(resolveScheduleRunTrigger({ trigger: "autopilot" })).toBe("autopilot");
    expect(resolveScheduleRunTrigger({})).toBe("scheduled");
    expect(resolveScheduleRunTrigger(null)).toBe("scheduled");
  });

  it("resolveLedgerTrigger maps each triggeredBy mode to the same ledger trigger", () => {
    expect(resolveLedgerTrigger({}, "manual")).toBe("manual");
    expect(resolveLedgerTrigger({}, "scheduled")).toBe("scheduled");
    expect(resolveLedgerTrigger({}, "triggered")).toBe("triggered");
    expect(resolveLedgerTrigger({}, "copilot")).toBe("copilot");
    expect(resolveLedgerTrigger({}, "autopilot")).toBe("autopilot");
    expect(resolveLedgerTrigger({}, undefined)).toBe("scheduled");
  });

  it("resolveLedgerTrigger: an explicit new-mode trigger wins", () => {
    expect(resolveLedgerTrigger({ trigger: "triggered" }, "manual")).toBe("triggered");
    expect(resolveLedgerTrigger({ trigger: "copilot" }, "manual")).toBe("copilot");
    expect(resolveLedgerTrigger({ trigger: "autopilot" }, "scheduled")).toBe("autopilot");
    expect(resolveLedgerTrigger({ trigger: "unknown" }, "copilot")).toBe("copilot");
    expect(resolveLedgerTrigger({ trigger: "bogus" }, "autopilot")).toBe("autopilot");
  });

  it("buildLedgerLinkage carries the new modes through", () => {
    expect(buildLedgerLinkage({ triggeredBy: "triggered" }).trigger).toBe("triggered");
    expect(buildLedgerLinkage({ triggeredBy: "copilot" }).trigger).toBe("copilot");
    expect(buildLedgerLinkage({ triggeredBy: "autopilot" }).trigger).toBe("autopilot");
    expect(
      buildLedgerLinkage({ trigger: "copilot", triggeredBy: "manual" }).trigger,
    ).toBe("copilot");
  });

  it("buildJobRunRecord accepts the new triggeredBy values and records the same trigger", () => {
    for (const mode of ["triggered", "copilot", "autopilot"] as const) {
      const rec = buildJobRunRecord(base({ triggeredBy: mode }));
      expect(rec.triggeredBy).toBe(mode);
      expect(rec.trigger).toBe(mode);
    }
  });

  it("pins the eight-valued ledger vocabulary (five modes + worker-cron/async-chain/unknown)", () => {
    expect([...LEDGER_TRIGGERS]).toEqual([
      "scheduled",
      "manual",
      "triggered",
      "copilot",
      "autopilot",
      "worker-cron",
      "async-chain",
      "unknown",
    ]);
  });

  it("still rejects worker-cron, async-chain and unknown as triggeredBy values", () => {
    for (const bad of ["worker-cron", "async-chain", "unknown"]) {
      expect(() => buildJobRunRecord(base({ triggeredBy: bad }))).toThrow(
        /Unknown job run trigger/,
      );
    }
  });
});
