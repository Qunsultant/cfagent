// @vitest-environment node
/**
 * Issue #5053 — #3214 copilot dispatch mode (runs dispatched by the copilot).
 *
 * TDD red→green pins for the copilot mode (loadable half — see the
 * companion file tests/dispatch-copilot-5053-workflow-runs.test.ts
 * for the Workflow Runs read-model pins):
 *  - the spec builder maps chat sources (nlq / mesh) to trigger
 *    "copilot", mirroring the goal -> "goal" precedent; every other
 *    source keeps its current default, and an explicit caller
 *    trigger always wins over the source default;
 *  - normalizeJobRunTrigger passes the five dispatch modes through
 *    and defaults anything else to "manual" (the never-invents rule);
 *  - the Docs Run Type reads "copilot" for a copilot run;
 *  - the unified options serve record stores trigger "copilot".
 *
 * Ruling (Venus, 2026-11-18, on #5053): stamp trigger `copilot`
 * (option a). No new actor field. The #5028 trigger-vs-actor
 * decision never existed on #5028 — this ruling settles it for
 * RUN dispatch only; actor stamping stays a separate concern for
 * the stage-action follow-up.
 */
import { describe, it, expect, vi } from "vitest";
import {
  buildStockScreenRunSpec,
  workflowTriggerForSpec,
} from "../src/workflows/stockScreenRunSpec";
import { normalizeJobRunTrigger } from "../src/data/jobRunRecordPorts";
import {
  recordUnifiedOptionsRun,
  unifiedOptionsRunRecordToStoreInput,
} from "../src/services/optionsServeRecord";
import { documentRunType } from "../src/client/docsAndReports";

function buildSpec(source: "etrade" | "market-data" | "goal" | "nlq" | "mesh" | "research" | "premium" | "scheduled", trigger?: "manual" | "scheduled" | "triggered" | "copilot" | "autopilot" | "nlq" | "mesh" | "goal" | "research") {
  return buildStockScreenRunSpec({
    env: {},
    method: "POST",
    rawFilters: {},
    query: new URLSearchParams(),
    asyncRequested: false,
    source,
    ...(trigger !== undefined ? { trigger } : {}),
  });
}

describe("copilot dispatch mode (#5053)", () => {
  it("the spec builder maps the nlq source to copilot", () => {
    const result = buildSpec("nlq");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.trigger).toBe("copilot");
    expect(workflowTriggerForSpec(result.spec)).toBe("copilot");
  });

  it("the spec builder maps the mesh source to copilot", () => {
    const result = buildSpec("mesh");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.spec.trigger).toBe("copilot");
    expect(workflowTriggerForSpec(result.spec)).toBe("copilot");
  });

  it("non-copilot sources keep their current defaults", () => {
    const cases = [
      ["goal", "goal"],
      ["research", "manual"],
      ["etrade", "manual"],
      ["market-data", "manual"],
      ["premium", "manual"],
      ["scheduled", "manual"],
    ] as const;
    for (const [source, expected] of cases) {
      const result = buildSpec(source);
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(result.spec.trigger).toBe(expected);
    }
  });

  it("an explicit caller trigger wins over the source default", () => {
    const scheduledOnNlq = buildSpec("nlq", "scheduled");
    expect(scheduledOnNlq.ok).toBe(true);
    if (scheduledOnNlq.ok) expect(scheduledOnNlq.spec.trigger).toBe("scheduled");
    const copilotOnEtrade = buildSpec("etrade", "copilot");
    expect(copilotOnEtrade.ok).toBe(true);
    if (copilotOnEtrade.ok) {
      expect(copilotOnEtrade.spec.trigger).toBe("copilot");
      expect(workflowTriggerForSpec(copilotOnEtrade.spec)).toBe("copilot");
    }
  });

  it("normalizeJobRunTrigger passes the five modes through and defaults anything else to manual", () => {
    expect(normalizeJobRunTrigger("copilot")).toBe("copilot");
    expect(normalizeJobRunTrigger("triggered")).toBe("triggered");
    expect(normalizeJobRunTrigger("autopilot")).toBe("autopilot");
    expect(normalizeJobRunTrigger("scheduled")).toBe("scheduled");
    expect(normalizeJobRunTrigger("manual")).toBe("manual");
    expect(normalizeJobRunTrigger("bogus")).toBe("manual");
    expect(normalizeJobRunTrigger(undefined)).toBe("manual");
  });

  it("the Docs Run Type reads copilot for a copilot run", () => {
    expect(documentRunType({ trigger: "copilot" })).toBe("copilot");
    expect(documentRunType({ trigger: "manual" })).toBe("manual");
    expect(documentRunType({ trigger: "scheduled" })).toBe("scheduled");
    expect(documentRunType({ trigger: "triggered" })).toBe("triggered");
    expect(documentRunType({ trigger: "goal" })).toBeNull();
  });

  it("the unified options serve record stores trigger copilot", async () => {
    const record = {
      runId: "options:2026-11-18T03:00:00.000Z",
      generationId: "options:2026-11-18T03:00:00.000Z",
      title: "Options analysis — copilot",
      source: "options_scanner",
      summary: "copilot",
      trigger: "copilot" as const,
      userLogin: "alice",
    };
    const stored = unifiedOptionsRunRecordToStoreInput(record);
    expect((stored.body as Record<string, unknown>).trigger).toBe("copilot");
    const orm = { storeCanonicalReport: vi.fn(() => ({ reportId: "u1", created: true })) };
    const out = await recordUnifiedOptionsRun(orm as never, record);
    expect(out).toEqual({ reportId: "u1", created: true });
    const call = orm.storeCanonicalReport.mock.calls[0][0] as {
      body: Record<string, unknown>;
    };
    expect(call.body.trigger).toBe("copilot");
  });
});
