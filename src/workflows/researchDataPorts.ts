/**
 * Issue #5121 (#5109 Sub-issue: Data layer) — Pinned data ports for the
 * nightly research (`research:<runId>`) engine job:
 *   1. Checkpoint artifact keys (`research:<runId>:<stageId>`).
 *   2. Engine persisted feed/enrich dataset resolution (via `FeedDatasetPort`).
 *   3. Pinned evaluation artifact & track-record store over the single
 *      `ResearchAgent` SQLite owner (`research_runs` / `research_evaluations`).
 *   4. Task-ledger reconciliation re-export (`reconcileResearchTaskWithRunRecord`).
 */
import type { DataProviderId, IndexId } from "../trading";
import type { FeedDatasetArtifact, FeedDatasetStore } from "../data/feedDatasetPorts";
import type { ResearchEvaluation } from "../services/researchPipeline";
import { buildTrackRecord, type TrackRecord } from "../services/researchTrackRecord";
import { runIdBody } from "../services/executionTreeIds";
export {
  reconcileResearchTaskWithRunRecord,
  type ResearchTaskReconciliation,
} from "../services/researchTaskLedger";

export const RESEARCH_JOB_ID_PREFIX = "research:";

/** Canonical engine job id for a research run (`research:<runId>`). */
export function researchEngineJobId(runId: string): string {
  // Issue #5911 — the platform's run ids carry the `run:` type marker; a
  // job-instance id is `<kind>:<runBody>`, so the marker is dropped here.
  // A legacy `rsr_…` id has no marker and passes through unchanged.
  return `${RESEARCH_JOB_ID_PREFIX}${runIdBody(runId)}`;
}

/** DO-storage checkpoint artifact key for a research stage. */
export function researchArtifactKey(runId: string, stageId: string): string {
  return `${RESEARCH_JOB_ID_PREFIX}${runIdBody(runId)}:${stageId}`;
}

export interface ResearchDatasetResolution {
  available: boolean;
  dataset: FeedDatasetArtifact | null;
  asOf: string | null;
  source: DataProviderId | null;
  reason?: string;
}

/**
 * Resolve the engine's latest usable persisted feed/enrich dataset for research.
 * Never fabricates data when no usable dataset exists.
 */
export async function resolveResearchDatasets(input: {
  feedDatasetPort: Pick<FeedDatasetStore, "latestUsable">;
  source: DataProviderId;
  index: IndexId;
}): Promise<ResearchDatasetResolution> {
  const dataset = await input.feedDatasetPort.latestUsable(input.source, input.index);
  if (!dataset) {
    return {
      available: false,
      dataset: null,
      asOf: null,
      source: input.source,
      reason: `No usable persisted feed dataset for ${input.source}:${input.index}`,
    };
  }
  return {
    available: true,
    dataset,
    asOf: dataset.asOf,
    source: dataset.sourceId,
  };
}

/**
 * Pinned store port for evaluation artifacts and track-record assembly over
 * the single SQLite owner (`research_runs` & `research_evaluations`).
 */
export interface ResearchEvaluationStorePort {
  listRunReportJson(): string[];
  listEvaluationJson(): string[];
  getRunReportJson(runId: string): string | null;
  saveEvaluation(runId: string, evalJson: string): void;
}

function safeJsonParse(raw: unknown): unknown {
  if (typeof raw !== "string") return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Build a track-record snapshot and persist evaluation artifacts through the
 * pinned `ResearchEvaluationStorePort` without duplicating storage tables.
 */
export function createResearchEvaluationStore(port: ResearchEvaluationStorePort) {
  return {
    getRunReportJson(runId: string): string | null {
      return port.getRunReportJson(runId);
    },
    saveEvaluation(runId: string, evaluation: ResearchEvaluation): void {
      port.saveEvaluation(runId, JSON.stringify(evaluation));
    },
    loadTrackRecord(): TrackRecord {
      return buildTrackRecord(
        port.listRunReportJson().map(safeJsonParse),
        port.listEvaluationJson().map(safeJsonParse),
      );
    },
  };
}
