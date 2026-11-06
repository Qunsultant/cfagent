/**
 * Issue #3186 step 3c - the goal leg's shapeReport / deliver for the
 * one options pipeline. A leg inside a composed run does not deliver
 * itself: the GOAL run delivers (email + Slack + UI in
 * executeGoalScreenRun, and the goal PDF/XLSX/CSV in
 * generateAndStoreGoalScreenArtifacts). The leg's stages record the
 * leg's contribution and the handoff to that delivery - nothing more.
 *
 *   shapeReport: the leg's report section (the options leg's contracts
 *     + counts + canonical record), persisted as the shapeReport
 *     artifact for the goal report to assemble and for Workflow Runs
 *     to surface. It does NOT generate the goal PDF.
 *   deliver: records the handoff - deliveryState "deferred-to-goal-run"
 *     with the goal run id. The goal run's delivery is the delivery.
 */
import type {
  OptionsDeliverFn,
  OptionsShapeReportFn,
} from "./optionsScreenPorts";

export function createGoalOptionsLegDelivery(input: {
  goalRunId: string;
}): { shapeReport: OptionsShapeReportFn; deliver: OptionsDeliverFn } {
  return {
    shapeReport: async ({ runId, canonical, screen }) => {
      const screened = (screen as { result?: Record<string, unknown> } | undefined)?.result ?? {};
      return {
        terminal: "completed",
        leg: "options",
        goalRunId: input.goalRunId,
        runId,
        reportId: canonical.reportId,
        created: canonical.created,
        summary: canonical.record.summary,
        matchedCount: screened["matchedCount"],
        totalUnderlyingsScanned: screened["totalUnderlyingsScanned"],
        contracts: screened["contracts"],
      };
    },
    deliver: async ({ runId, report }) => {
      return {
        terminal: "completed",
        deliveryState: "deferred-to-goal-run",
        goalRunId: input.goalRunId,
        runId,
        report,
      };
    },
  };
}
