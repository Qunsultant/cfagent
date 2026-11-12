/**
 * Issue #4262 (S3) — the options runs fold.
 *
 * Pins:
 *  - 4262S3-P01 options runs reach the one ledger: a workflow-runs row whose
 *    recorded family is options classifies as `options` (the read that #4069
 *    joined the scan runs into, attached by S2's adapter).
 *  - 4262S3-P02 the options research panel no longer keeps a run list of its
 *    own: it stops mapping its `/api/research/history` rows and links to the
 *    one ledger filtered to Options.
 *  - 4262S3-P03 the panel keeps its settings, run controls and latest report
 *    (the fold is lossless: only the run LIST moves).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { attachWorkflowRuns } from "../src/services/runLedgerWorkflowRuns";
import { classifyRunKind } from "../src/services/runLedgerKinds";
import type { WorkflowRun } from "../src/services/workflowRuns";

const here = dirname(fileURLToPath(import.meta.url));
const panelSource = readFileSync(
  join(here, "..", "src/client/options/ResearchRunsPanel.tsx"),
  "utf8",
);

function optionsRun(): WorkflowRun {
  return {
    id: "opt-run-1",
    runId: "opt-run-1",
    workflow: "options-screen",
    family: "options",
    title: "Options screen",
    source: "job-chain",
    trigger: "scheduled",
    triggerDetail: "Scheduled (job-tree)",
    triggeredBy: "schedule:opt-1",
    status: "completed",
    startedAt: "2026-11-12T10:00:00.000Z",
    finishedAt: "2026-11-12T10:05:00.000Z",
    durationMs: 300000,
    stageCount: 8,
    completedStages: 8,
    failedStages: 0,
    stages: [],
    inputs: null,
    outputs: null,
    artifacts: [],
    deliveryStates: {},
    error: null,
  } as WorkflowRun;
}

describe("4262S3-P01 options runs reach the one ledger", () => {
  it("classifies an options-family workflow run as options", () => {
    const [entry] = attachWorkflowRuns([], [optionsRun()]);
    expect(entry.row.system).toBe("workflow-runs");
    expect(classifyRunKind(entry.row)).toBe("options");
  });
});

describe("4262S3-P02 the panel keeps no run list of its own", () => {
  it("no longer renders the history rows", () => {
    expect(panelSource).not.toContain("history.map(");
  });

  it("links to the one ledger filtered to options", () => {
    expect(panelSource).toContain('navigateToTab("schedules", "runs", { kind: "options" })');
  });
});

describe("4262S3-P03 the fold is lossless", () => {
  it("keeps the settings editor, the run controls and the latest report", () => {
    expect(panelSource).toContain('title="Autonomous Options Research"');
    expect(panelSource).toContain("Run research now");
    expect(panelSource).toContain("Edit filters");
    expect(panelSource).toContain("ScreeningActivityPanel");
  });
});
