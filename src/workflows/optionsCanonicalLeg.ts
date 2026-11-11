/**
 * Issue #4060 (#3551 slice 1) — the options canonical leg: the
 * options persistCanonicalResults stage writes its canonical row
 * through the engine's tenant-aware leg
 * (createTenantAwareCanonicalReportStore, #3940) instead of the
 * route's direct ORM write, in both residencies (workflow + host).
 *
 * The leg is the SAME seam the generate stage uses — no parallel
 * store leg, no fork of the store seam. The UnifiedOptionsRunRecord
 * shape rides the leg unchanged: unifiedOptionsRunRecordToStoreInput
 * is the one normalization, shared by the direct recorder and this
 * adapter. The stage's owner is always present (requireLogin
 * throws without one), so for an options report the leg records
 * "wired" — not_wired can never fire here; a door refusal or throw
 * records "failed" with its coded reason instead, and the run
 * still completes (the canonical write never fails the run).
 *
 * The goal leg's omitted-canonical case (#783) is decided here:
 * KEPT as an honest no-write. Wiring it would create a second
 * canonical row — the composing goal run's row is the single
 * canonical home, and the goal leg's store is a different SQLite
 * from the goal run's. The stage records the omission with the
 * coded reason below, identically in both residencies.
 */
import { actorGateway } from "../services/cloudflareActorGateway";
import {
  createTenantAwareCanonicalReportStore,
  type CanonicalReportStoreSeam,
  type PipelineGenerateReportDoor,
} from "../services/canonicalReportLeg";
import {
  getServiceUserLogin,
  SHARED_ORCHESTRATOR_INSTANCE,
} from "../security/serviceIdentity";
import {
  unifiedOptionsRunRecordToStoreInput,
  type UnifiedOptionsRunRecord,
} from "../services/optionsServeRecord";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import type { Env } from "../types";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "workflows/optionsCanonicalLeg",
});

/**
 * The coded reasons an options canonical write through the leg can
 * end somewhere other than "wired" — named, never silent.
 */
export const OPTIONS_CANONICAL_LEG_REASONS = {
  /** The goal leg omits the canonical store by decision (#783):
   *  the composing goal run's row is the single canonical home. */
  omittedGoalLeg: "options_canonical_omitted_goal_leg",
  /** The leg's door refused the write (returned null). */
  storeRefused: "options_canonical_store_refused",
  /** The leg's door threw. */
  storeThrew: "options_canonical_store_threw",
} as const;

/** The persist stage's canonical-leg report: how the canonical row
 *  was (or was not) written. "wired" — the leg stored (or deduped)
 *  the row; "failed" — the leg refused or threw, with the coded
 *  reason; "omitted" — the goal leg's decided no-write, with its
 *  coded reason; "direct" — the legacy direct store, kept during
 *  migration for entries not yet on the leg. */
export type OptionsCanonicalLegStatus = "wired" | "failed" | "omitted" | "direct";

export interface OptionsCanonicalLegReport {
  status: OptionsCanonicalLegStatus;
  reason?: string;
}

/**
 * Write one options run record through the engine's tenant-aware
 * leg. The record maps onto the leg's input through the one
 * normalization; the leg's store call writes through the
 * orchestrator door into the report-owning tenant's Orchestrator
 * DO (the same seam the generate stage uses). Never throws: a
 * refusal or a throw records "failed" with its coded reason, and
 * the caller (the persist stage) completes the run regardless.
 */
export async function recordUnifiedOptionsRunThroughLeg(
  leg: CanonicalReportStoreSeam,
  record: UnifiedOptionsRunRecord,
): Promise<{
  reportId: string | null;
  created: boolean;
  status: "wired" | "failed";
  reason?: string;
}> {
  const input = unifiedOptionsRunRecordToStoreInput(record);
  try {
    const stored = await leg.store(input);
    if (!stored) {
      structuredLog.warn("optionsCanonicalLeg.store_refused", {
        message: `[optionsCanonicalLeg] canonical leg refused the write for run ${input.runId}`,
        runId: input.runId,
        reason: OPTIONS_CANONICAL_LEG_REASONS.storeRefused,
      });
      return {
        reportId: null,
        created: false,
        status: "failed",
        reason: OPTIONS_CANONICAL_LEG_REASONS.storeRefused,
      };
    }
    return { reportId: stored.reportId, created: stored.created, status: "wired" };
  } catch (err) {
    structuredLog.warn("optionsCanonicalLeg.store_threw", {
      message: `[optionsCanonicalLeg] canonical leg threw for run ${input.runId}: ${err instanceof Error ? err.message : String(err)}`,
      runId: input.runId,
      reason: OPTIONS_CANONICAL_LEG_REASONS.storeThrew,
      error: err instanceof Error ? err.message : String(err),
    });
    return {
      reportId: null,
      created: false,
      status: "failed",
      reason: OPTIONS_CANONICAL_LEG_REASONS.storeThrew,
    };
  }
}

/**
 * The manual entry's leg (#4060): the workflow-residency
 * construction, verbatim — the same seam
 * generateStepDepsForWorkflow builds (owner = the configured
 * service identity as the bound fallback; the run's owner rides
 * the store input and wins). The manual entry runs the pipeline
 * inside the Orchestrator DO; the door is the one transport for
 * its canonical write — the route no longer writes mas_reports
 * directly. The same seam instance serves the persist stage and
 * the shapeReport re-record, so the row has one transport.
 */
export function createManualOptionsCanonicalLeg(env: Env): CanonicalReportStoreSeam {
  return createTenantAwareCanonicalReportStore({
    ownerLogin: getServiceUserLogin(env) ?? undefined,
    record: (input) => {
      const door = actorGateway.stub<PipelineGenerateReportDoor>(
        env.ORCHESTRATOR_AGENT,
        SHARED_ORCHESTRATOR_INSTANCE,
      );
      return door.recordPipelineGenerateReport(input);
    },
  });
}
