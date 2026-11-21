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
import { researchEngineJobId } from "./researchDataPorts";
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
  const jobRunId = researchEngineJobId(report.runId);
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
      success: !report.dataRefusal,
      jobRunId,
      engineVersion: (report as { modelVersion?: string }).modelVersion ?? "rules-1.0.0",
      inputHash: report.generationId,
      captureIds: [report.runId],
      // The report is created inside J-stack's generate/deliver path. The
      // six engine stages are read from J-stack checkpoints by the run view;
      // this report body must not synthesize a competing stage ledger.
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
