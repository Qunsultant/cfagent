/**
 * The tenant-aware canonical leg (#3940, #3550 option (a)) — the
 * seam + door + factory, moved here from
 * src/services/generateJobs.ts (issue #4060) so the leg is a LEAF.
 *
 * The leg's only imports are the canonical input/result TYPES
 * (erased at runtime), so importing the leg never drags in the
 * generate job's graph (analyzeJobs → enrichJobs → feedJobs →
 * indexListJob, whose module-scope SECTOR_IDS spread breaks under
 * a mocked trading barrel — tests/market_data_modes_1727.test.ts,
 * #3930). generateJobs.ts re-exports these names, so every
 * existing importer keeps its import path.
 *
 * The canonical report-store seam, host-bound where it fits:
 * a host whose residency owns reports (a tenant's Orchestrator
 * DO) binds storeReportAtGeneration over its sql + index env
 * and names the owning tenant login here. The generate service
 * calls it once per report with the seam's own input shape —
 * the write side of the canonical machinery does not move
 * (one writer, generation-id idempotency, #2345/#2359).
 */
import type {
  CanonicalStoreResult,
  ScheduledReportInput,
} from "./scheduledReports";

/**
 * The canonical report-store seam. Issue #3940 (#3550 option
 * (a)): the tenant-aware leg binds the seam over the
 * ORCHESTRATOR DOOR instead of a sql handle
 * (createTenantAwareCanonicalReportStore, below), so the
 * canonical copy lands in the report-owning tenant's
 * Orchestrator DO in both pipeline residencies — never in
 * the pipeline host's own store, where no Reports view reads.
 */
export interface CanonicalReportStoreSeam {
  /** The report-owning tenant login this seam writes for —
   *  the seam's bound owner: the fallback when a job names
   *  no owner of its own (the leg resolves per job first).
   *  Absent ⇒ the seam names no tenant; the leg resolves
   *  the owner from the job's configured reportOwnerLogin,
   *  else records not_wired with its coded reason. */
  ownerLogin?: string;
  /** storeReportAtGeneration, host-bound. Never throws by contract. */
  store(input: ScheduledReportInput): Promise<CanonicalStoreResult | null>;
}

/**
 * The orchestrator door the tenant-aware leg writes through
 * (#3940): the generate stage never writes mas_reports
 * directly — it calls the report-owning tenant's
 * Orchestrator DO door, which stores through the one seam
 * (storeReportAtGeneration) inside that DO. One method, the
 * same shape as the screener's recordWorkflowScreenReport
 * door (OrchestratorAgent.recordPipelineGenerateReport).
 */
export interface PipelineGenerateReportDoor {
  recordPipelineGenerateReport(
    input: ScheduledReportInput,
  ): Promise<CanonicalStoreResult | null>;
}

/**
 * The tenant-aware canonical leg (#3940, #3550 option (a)):
 * build a seam whose store call writes through the
 * orchestrator door (record) instead of a host-bound sql
 * handle. The owner rides on the store input (the leg
 * resolves it per job — the job's configured
 * reportOwnerLogin first, this seam's bound owner second);
 * ownerLogin here is that bound owner — the residency's
 * fallback for jobs that name no owner of their own
 * (the configured service identity where one exists),
 * absent when the residency configures none.
 */
export function createTenantAwareCanonicalReportStore(args: {
  ownerLogin?: string;
  record: PipelineGenerateReportDoor["recordPipelineGenerateReport"];
}): CanonicalReportStoreSeam {
  return {
    ...(args.ownerLogin !== undefined ? { ownerLogin: args.ownerLogin } : {}),
    store: (input) => args.record(input),
  };
}
