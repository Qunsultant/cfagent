/**
 * Issue #6371 — a research run must be addressable under kind=workflow.
 *
 * Live: `research:mwttxg38-2` (a research engine job with six completed
 * stages) was invisible under the Workflow Runs filter, because its ledger
 * KIND read "Options": the report-only run took its family from the Docs
 * family ("options", the artifact family) instead of the engine family.
 *
 * The interim decision (recorded here, evidence over preference): re-kind the
 * report-only research run as its engine family — the run IS a research engine
 * job — and leave the Docs family (and the Docs tab) untouched. The one ledger
 * filter then shows it under kind=workflow, with its stages addressable.
 *
 * What this file pins:
 *
 *  K1  the engine family of a report-only run: research rows read "research",
 *      strategy rows still read "discovery", everything else is unchanged;
 *  K2  through the real ledger attach, a research run's ledgerKind is
 *      "workflow" — the filter value the Workflow Runs entry point asks for;
 *  K3  an options screen run keeps kind "options" (no collateral re-kinding).
 */
import { describe, it, expect } from "vitest";
import {
  engineFamilyForReportOnlyRun,
  runFromReportDocument,
} from "../src/services/workflowRuns";
import { attachWorkflowRuns } from "../src/services/runLedgerWorkflowRuns";

function run(engineFamily: Parameters<typeof runFromReportDocument>[0]["engineFamily"]) {
  return runFromReportDocument({
    reportId: "report-1",
    runId: "run-1",
    title: "Options research — 2026-11-23 (manual)",
    engineFamily,
    documents: {
      reportId: "report-1",
      runId: "run-1",
      title: "Options research — 2026-11-23 (manual)",
      createdAt: "2026-11-23T22:20:51.000Z",
      pdfUrl: null,
      xlsxUrl: null,
      csvUrl: null,
    } as never,
    trigger: "manual",
    status: "completed",
    createdAt: "2026-11-23T22:20:51.000Z",
    stages: [
      { id: "feed", status: "completed" },
      { id: "analyze", status: "completed" },
    ] as never,
  });
}

describe("#6371 — the research run's ledger kind", () => {
  it("K1: a research row reads the research engine family", () => {
    expect(engineFamilyForReportOnlyRun({ source: "options_research" }, "options")).toBe("research");
    // Unchanged: the strategy Docs family is still the discovery engine.
    expect(engineFamilyForReportOnlyRun({ source: "discovery" }, "strategy")).toBe("discovery");
    // Unchanged: other Docs families keep their own engine family.
    expect(engineFamilyForReportOnlyRun({ source: "options_screen" }, "options")).toBe("options");
    expect(engineFamilyForReportOnlyRun({ source: "screener" }, "stock")).toBe("stock");
  });

  it("K2: the ledger kind is workflow, so kind=workflow finds it", () => {
    const entries = attachWorkflowRuns([], [run("research")]);
    expect(entries).toHaveLength(1);
    expect(entries[0].row.ledgerKind).toBe("workflow");
    expect(entries[0].run.stages.map((stage) => stage.id)).toEqual(["feed", "analyze"]);
  });

  it("K3: an options screen run keeps kind options", () => {
    const entries = attachWorkflowRuns([], [run("options")]);
    expect(entries[0].row.ledgerKind).toBe("options");
  });
});
