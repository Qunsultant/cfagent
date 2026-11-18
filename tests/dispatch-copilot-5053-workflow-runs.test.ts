// @vitest-environment node
/**
 * Issue #5053 — #3214 copilot dispatch mode (runs dispatched by the copilot).
 *
 * Workflow Runs read-model pins for the copilot mode (companion to
 * tests/dispatch-copilot-5053.test.ts, which holds the loadable pins):
 *  - the ledger read-back distinguishes a copilot run from a manual
 *    run and a Run-now run — a copilot run never renders "Manual";
 *  - an outcome-only copilot run renders "copilot", never "unknown";
 *  - a canonical report carrying "copilot" renders "copilot".
 *
 * LOCAL-LOAD NOTE (verified, not assumed): this file imports
 * src/services/workflowRuns, whose import graph reaches
 * src/observability/otelLogs.ts, which imports
 * @opentelemetry/sdk-logs — absent from the stale local
 * node_modules (installed 2026-10-25; the whole @opentelemetry
 * directory is missing). The file therefore fails to LOAD in this
 * VM. The failure is pre-existing on main, not this slice: the
 * unmodified tests/dispatch-triggered-5052.test.ts and
 * tests/workflow_runs_3810.test.ts fail identically, and a probe
 * importing only workflowRuns fails the same way. Do NOT mock the
 * otel packages to force a local run — the mock would shadow the
 * real SDK in CI too. First execution of this file is PR CI's
 * fresh install, which is the arbiter.
 */
import { describe, it, expect } from "vitest";
import {
  buildWorkflowRuns,
  runFromReportDocument,
  triggerLabel,
  type WorkflowRunJobRow,
  type WorkflowRunOutcomeRow,
} from "../src/services/workflowRuns";

function job(overrides: Partial<WorkflowRunJobRow> & { job_id: string }): WorkflowRunJobRow {
  return {
    capability: "http.request",
    display_name: "Stock screen — NASDAQ100",
    status: "completed",
    created_at: "2026-11-18T03:00:00.000Z",
    completed_at: "2026-11-18T03:01:00.000Z",
    ...overrides,
  };
}

const copilotOutcome: WorkflowRunOutcomeRow = {
  id: "workflow:copilot-run:shard-1",
  kind: "options",
  trigger: "copilot",
  status: "completed",
  scanned: 10,
  matched: 2,
  origin: "options_scanner",
  createdAt: "2026-11-18T03:00:00.000Z",
};

describe("copilot dispatch mode — Workflow Runs read model (#5053)", () => {
  it("the ledger read-back distinguishes copilot from manual and triggered", () => {
    const runs = buildWorkflowRuns({
      jobs: [
        job({ job_id: "copilot-1", trigger: "copilot" }),
        job({ job_id: "manual-1", trigger: "manual" }),
        job({ job_id: "run-now-1", trigger: "triggered" }),
      ],
      outcomes: [],
      transitions: [],
    });
    expect(runs).toHaveLength(3);
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get("copilot-1")?.trigger).toBe("copilot");
    expect(byId.get("manual-1")?.trigger).toBe("manual");
    expect(byId.get("run-now-1")?.trigger).toBe("triggered");
    expect(triggerLabel("copilot")).toBe("Copilot");
  });

  it("an outcome-only copilot run renders copilot, not unknown", () => {
    const runs = buildWorkflowRuns({
      jobs: [],
      outcomes: [copilotOutcome],
      transitions: [],
    });
    expect(runs).toHaveLength(1);
    expect(runs[0].source).toBe("job-outcome");
    expect(runs[0].trigger).toBe("copilot");
  });

  it("a canonical report carrying copilot renders copilot, not unknown", () => {
    const run = runFromReportDocument({
      reportId: "rep-5053",
      runId: "copilot-1",
      title: "Options analysis — copilot",
      engineFamily: "options",
      documents: {
        reportId: "rep-5053",
        family: "options",
        pdfUrl: "/api/screening/options/report.pdf?key=o.pdf",
        pdfStatus: "generated",
        pdfError: null,
        xlsxUrl: null,
        xlsxStatus: null,
        xlsxError: null,
        csvUrl: null,
        csvStatus: null,
        csvError: null,
      },
      trigger: "copilot",
      status: "completed",
      createdAt: "2026-11-18T03:00:00.000Z",
    });
    expect(run.trigger).toBe("copilot");
  });
});
