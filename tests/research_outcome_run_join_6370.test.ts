/**
 * Issue #6370 — a completed research run must read as completed.
 *
 * Live symptom (2026-11-23): a finished manual OODA run sat in the ledger as
 * OUTCOME "skipped", TRIGGER "Not recorded by the source", TRIGGERED BY "Not
 * recorded", Outputs `{ "status": null }` — while its six stages were completed
 * and its canonical report was stored. The outcome→run join read fields the
 * research canonical body did not carry (or the report-only run hardwired).
 *
 * What this file pins, end to end over the two real mappers:
 *
 *  J1  the research canonical body carries the join facts it is read by —
 *      `success`, `trigger` and `userLogin` — at persist time;
 *  J2  `runSummaryFromReport` maps that body to status "completed", the recorded
 *      trigger, and the row owner;
 *  J3  the report-only run renders that owner as "Triggered by" and shows the
 *      normalised status verb in its outputs (never `null` for a completed run).
 */
import { describe, it, expect } from "vitest";
import { researchReportToStoreInput } from "../src/workflows/researchCanonicalLeg";
import { runSummaryFromReport } from "../src/services/runSummaries";
import { runFromReportDocument } from "../src/services/workflowRuns";
import type { ResearchReport } from "../src/services/researchPipeline";

function report(overrides: Partial<ResearchReport> = {}): ResearchReport {
  const base = {
    runId: "mwttxg38-2",
    generationId: "options_research:mwttxg38-2",
    trigger: "manual",
    userLogin: "owner",
    createdAt: "2026-11-23T22:20:51.000Z",
    rulesVersion: "1.0.0",
    configSnapshot: {},
    summary: "3 qualified idea(s); 1 watchlist; 2 rejected.",
    ideas: [],
    watchlist: [],
    rejected: [],
    stats: {},
    oodaTrace: [],
    stageTrace: [],
  } as unknown as ResearchReport;
  return { ...base, ...overrides };
}

function hit(reportInput = report()) {
  const input = researchReportToStoreInput(reportInput, {}, "owner");
  return {
    id: "report-id-1",
    runId: input.runId,
    title: input.title,
    source: input.source,
    summary: input.summary,
    body: JSON.stringify(input.body),
    createdAt: input.createdAt,
    generationId: input.generationId ?? null,
    userLogin: "owner",
    bodyR2Key: null,
    fanoutOutcome: null,
  };
}

describe("#6370 — the outcome→run join", () => {
  it("J1: the canonical body carries success, trigger and the owner", () => {
    const body = researchReportToStoreInput(report(), {}, "owner").body as Record<string, unknown>;
    expect(body.success).toBe(true);
    expect(body.trigger).toBe("manual");
    expect(body.userLogin).toBe("owner");
  });

  it("J1: a refused-data run is a failed body, not a silent completed one", () => {
    const refused = researchReportToStoreInput(
      report({ dataRefusal: { code: "research_data_unavailable", message: "no quotes" } } as never),
      {},
      "owner",
    ).body as Record<string, unknown>;
    expect(refused.success).toBe(false);
  });

  it("J2: the summary reads completed, the recorded trigger and the owner", () => {
    const summary = runSummaryFromReport(hit() as never);
    expect(summary.status).toBe("completed");
    expect(summary.trigger).toBe("manual");
    expect(summary.userLogin).toBe("owner");
  });

  it("J3: the report-only run renders Triggered by and the status verb", () => {
    const summary = runSummaryFromReport(hit() as never);
    const run = runFromReportDocument({
      reportId: "report-id-1",
      runId: summary.runId,
      title: summary.title,
      engineFamily: "research",
      documents: {
        reportId: "report-id-1",
        runId: summary.runId,
        title: summary.title,
        createdAt: summary.createdAt,
        pdfUrl: null,
        xlsxUrl: null,
        csvUrl: null,
      } as never,
      trigger: summary.trigger,
      status: summary.status,
      triggeredBy: summary.userLogin ?? null,
      createdAt: summary.createdAt,
    });
    expect(run.trigger).toBe("manual");
    expect(run.triggeredBy).toBe("owner");
    expect(run.status).toBe("completed");
    expect(run.outputs).toEqual({ status: "completed" });
  });
});
