/**
 * Issue #5121 (#5109 Sub-issue: Data layer) — the research canonical leg:
 * stores `options_research` reports through the engine's tenant-aware leg
 * (createTenantAwareCanonicalReportStore, #3940) in both residencies
 * (workflow + host) using one shared normalization (`researchReportToStoreInput`).
 *
 * Mirrors `src/workflows/optionsCanonicalLeg.ts` — no parallel store leg,
 * no silent failures. Never throws: a door refusal or throw records
 * `status: "failed"` with its coded reason.
 */
import type { CanonicalReportStoreSeam } from "../services/canonicalReportLeg";
import type { ScheduledReportInput } from "../services/scheduledReports";
import type { ResearchReport } from "../services/researchPipeline";
import type { ResearchReportArtifactOutcome } from "../trading";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "workflows/researchCanonicalLeg",
});

export const RESEARCH_CANONICAL_LEG_REASONS = {
  missingOwner: "research_canonical_missing_owner",
  storeRefused: "research_canonical_store_refused",
  storeThrew: "research_canonical_store_threw",
} as const;

export type ResearchCanonicalLegStatus = "wired" | "failed";

export interface ResearchCanonicalLegReport {
  status: ResearchCanonicalLegStatus;
  reason?: string;
}

/**
 * Single normalization from a `ResearchReport` + artifact outcomes onto
 * `ScheduledReportInput`. Shared by both the legacy `researchPublish.ts`
 * host path and the engine's tenant-aware canonical leg.
 */
export function researchReportToStoreInput(
  report: ResearchReport,
  artifacts: Partial<ResearchReportArtifactOutcome>,
  userLogin: string,
): ScheduledReportInput {
  const cleanArtifacts = Object.fromEntries(
    Object.entries(artifacts).filter(([, value]) => value !== undefined),
  );
  const artifactKeys = [artifacts.pdfKey, artifacts.xlsxKey, artifacts.csvKey].filter(
    (k): k is string => typeof k === "string" && k.length > 0,
  );
  const jobRunId = `research:${report.runId}`;
  const stages = [
    {
      stage: "feed",
      status: report.stats.quotesRetrieved > 0 || report.stats.universeSize > 0 ? "completed" : "completed",
      durationMs: null,
      inputIds: [`universe:${report.stats.universeSize}`],
      outputIds: [`quotes:${report.stats.quotesRetrieved}`],
      errorCode: null,
      error: null,
      evidence: { universeSize: report.stats.universeSize, quotesRetrieved: report.stats.quotesRetrieved },
    },
    {
      stage: "gather",
      status: "completed",
      durationMs: null,
      inputIds: [`quotes:${report.stats.quotesRetrieved}`],
      outputIds: [`chains:${report.stats.chainsFetched}`],
      errorCode: null,
      error: null,
      evidence: { chainsFetched: report.stats.chainsFetched, chainsCalibrated: report.stats.chainsCalibrated },
    },
    {
      stage: "analysis",
      status: "completed",
      durationMs: report.stats.durationMs,
      inputIds: [`candidates:${report.stats.candidatesEvaluated}`],
      outputIds: [`qualified:${report.stats.qualified}`, `watchlist:${report.stats.watchlist}`],
      errorCode: null,
      error: null,
      evidence: {
        qualified: report.stats.qualified,
        watchlist: report.stats.watchlist,
        rejected: report.stats.rejected,
        oodaIterations: report.stats.oodaIterations,
      },
    },
    {
      stage: "generation",
      status: artifactKeys.length > 0 ? "completed" : "failed",
      durationMs: null,
      inputIds: [report.runId],
      outputIds: artifactKeys,
      errorCode: null,
      error: null,
      evidence: { artifactCount: artifactKeys.length },
    },
    {
      stage: "recording",
      status: "completed",
      durationMs: null,
      inputIds: artifactKeys,
      outputIds: [jobRunId],
      errorCode: null,
      error: null,
      evidence: { jobRunId, generationId: report.generationId },
    },
    {
      stage: "delivery",
      status: "completed",
      durationMs: null,
      inputIds: [jobRunId],
      outputIds: [],
      errorCode: null,
      error: null,
      evidence: { trigger: report.trigger },
    },
  ];
  return {
    runId: report.runId,
    generationId: report.generationId,
    title: `Options research — ${report.createdAt.slice(0, 10)} (${report.trigger})`,
    source: "options_research",
    summary: report.summary,
    userLogin,
    createdAt: report.createdAt,
    body: {
      ...(report as unknown as Record<string, unknown>),
      ...cleanArtifacts,
      success: true,
      jobRunId,
      engineVersion: (report as { modelVersion?: string }).modelVersion ?? "rules-1.0.0",
      inputHash: report.generationId,
      captureIds: [report.runId],
      stages,
    },
  };
}

/**
 * Write one research report through the engine's tenant-aware canonical leg.
 * Never throws: a missing owner, door refusal, or throw returns `created: false`
 * with a coded `ResearchCanonicalLegReport` reason.
 */
export async function recordResearchRunThroughLeg(
  seam: CanonicalReportStoreSeam,
  input: {
    report: ResearchReport;
    artifacts?: Partial<ResearchReportArtifactOutcome>;
    userLogin?: string;
  },
): Promise<{ reportId: string | null; created: boolean; leg: ResearchCanonicalLegReport }> {
  const owner = input.userLogin?.trim() || seam.ownerLogin?.trim() || "";
  if (!owner) {
    return {
      reportId: null,
      created: false,
      leg: { status: "failed", reason: RESEARCH_CANONICAL_LEG_REASONS.missingOwner },
    };
  }

  try {
    const stored = await seam.store(
      researchReportToStoreInput(input.report, input.artifacts ?? {}, owner),
    );
    if (!stored || !stored.reportId) {
      return {
        reportId: null,
        created: false,
        leg: { status: "failed", reason: RESEARCH_CANONICAL_LEG_REASONS.storeRefused },
      };
    }
    return {
      reportId: stored.reportId,
      created: stored.created,
      leg: { status: "wired" },
    };
  } catch (err) {
    structuredLog.warn("researchCanonicalLeg.store_threw", {
      runId: input.report.runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      reportId: null,
      created: false,
      leg: { status: "failed", reason: RESEARCH_CANONICAL_LEG_REASONS.storeThrew },
    };
  }
}
