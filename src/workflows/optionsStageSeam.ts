/**
 * Issue #3072 (S2 under #3069) - the options seam.
 *
 * RETIRED (#3186 step 3d): no live caller remains. The manual handler
 * was the seam's only caller and now runs the one options pipeline,
 * which publishes per-stage messages instead. The module stays (no
 * deletion) with its contract tests, as the seam's record - its
 * successor is the pipeline's per-stage publishing
 * (optionsScreenWorkflow + stageQueueTransport).
 *
 * Options is the awkward family and it is worth being explicit about why:
 * an options screen is a **request handler**, not a durable workflow. There
 * is no `step.do`, so there is no platform-persisted step record to point a
 * boundary message at. What the handler does have, by the time it finishes,
 * is persisted evidence for each of its three phases: the screen result
 * (inside the recorded run outcome and the report row), the report
 * artifacts (pdf/xlsx/csv keys), and the delivery states it recorded.
 *
 * So the boundaries are published ONCE at the end of a successful run, in
 * phase order, each referencing the artifact that actually exists - never
 * mid-flight, where the artifact would not exist yet. A run that fails
 * before its artifacts land publishes nothing, which is the honest outcome:
 * a boundary is evidence, not a progress bar.
 */
import { buildStageBoundaryMessage, publishStageBoundaryMessage, type StageQueueSend } from "./stageQueueTransport";
import type { StageFamily } from "./stageMessage";

export interface OptionsStageArtifacts {
  /** One id for the whole run; the caller decides how it is derived. */
  readonly runId: string;
  readonly userLogin: string;
  /** Keys that were actually persisted this run, by phase. */
  readonly reportKey?: string;
  readonly deliveryState?: string;
}

export interface EmitOptionsBoundariesResult {
  readonly published: string[];
  readonly skipped: Array<{ stageId: string; reason: string }>;
}

/**
 * Publish the options run's stage boundaries. Never throws: a seam gap must
 * not turn a completed screen into a failed request.
 */
export async function emitOptionsStageBoundaries(args: {
  family?: StageFamily;
  artifacts: OptionsStageArtifacts;
  queue?: StageQueueSend | null;
  warn?: (message: string) => void;
}): Promise<EmitOptionsBoundariesResult> {
  const family = args.family ?? "options";
  const warn = args.warn ?? ((message: string) => console.warn(message));
  const published: string[] = [];
  const skipped: Array<{ stageId: string; reason: string }> = [];
  const { runId, userLogin } = args.artifacts;

  // Phase order, each with the artifact the phase produced. `screen` is
  // persisted with the run outcome/report row; `report` is the pdf/xlsx/csv
  // key the pipeline returned; `deliver` is the recorded delivery state.
  const phases: Array<{ stageId: string; artifactKey?: string }> = [
    { stageId: "provider-screen", artifactKey: args.artifacts.reportKey ? `options:screen:${runId}` : undefined },
    { stageId: "report-pipeline", artifactKey: args.artifacts.reportKey },
    { stageId: "deliver", artifactKey: args.artifacts.deliveryState },
  ];

  for (const phase of phases) {
    if (!phase.artifactKey) {
      const reason = `no persisted artifact for ${phase.stageId}; boundary not published (evidence, not progress)`;
      skipped.push({ stageId: phase.stageId, reason });
      warn(`[stage-seam] options/${phase.stageId}: ${reason}`);
      continue;
    }
    try {
      const message = buildStageBoundaryMessage({
        family,
        runId,
        userLogin,
        stageId: phase.stageId,
        artifactKeys: [phase.artifactKey],
      });
      const result = await publishStageBoundaryMessage({ queue: args.queue, message });
      if (result.published) published.push(phase.stageId);
      else skipped.push({ stageId: phase.stageId, reason: result.reason });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      skipped.push({ stageId: phase.stageId, reason });
      warn(`[stage-seam] options/${phase.stageId}: ${reason}`);
    }
  }

  return { published, skipped };
}
