/**
 * Issue #4116 — the shared run-ledger projector: the ONE D1 writer
 * for run ledgers. All three carriers (queues, ORM, sweep) call
 * this same function, so the ruling's "applied identically in all
 * three writers" is literal, not a convention.
 *
 * - Reports reuse the versioned agent_reports table (read-before-
 *   write: skip when the latest version is already current, else
 *   record version+1). LWW = latest version wins.
 * - Async jobs use the adapter's conditional upsert (replay no-op,
 *   stale never overwrites newer, newer lands).
 * - Both stamp the twin link when it resolves exactly (§3 of the
 *   design doc); ambiguous or absent links stay null.
 *
 * The projector never throws for a missing store — a null adapter
 * resolves to {projected:false, skipped:"unbound"}. A store
 * failure propagates to the caller: best-effort callers catch it
 * (postRunLedgerBestEffort), the sweep records it in its report.
 */
import { d1JobRunRecordId } from "../services/jobRunRecordReads";
import type { JobRunRecord } from "../services/jobRunRecords";
import { capText } from "./auditReportProjection";
import type { CanonicalReportRow } from "./auditReportPorts";
import type {
  AsyncJobProjectionInput,
  JobRunRecordLister,
  ProjectRunLedgerResult,
  ReportProjectionInput,
  RunLedgerProjector,
} from "./runLedgerPorts";

export type { AsyncJobProjectionInput, ReportProjectionInput };

export interface RunLedgerProjectorDeps {
  /** The versioned report writer (D1AuditReportAdapter). */
  reportStore: {
    recordReport(row: CanonicalReportRow): Promise<void>;
    latestReport(tenantId: string, reportId: string): Promise<CanonicalReportRow | null>;
  };
  /** The async-job writer (D1RunLedgerAdapter). */
  asyncJobStore: {
    recordAsyncJob(row: AsyncJobProjectionInput, nowMs: number): Promise<boolean>;
  };
  /** The D1 job-record reader for twin-link resolution. */
  jobRecordStore: JobRunRecordLister;
}

const GENERATE_PREFIX = "pipeline-generate:";

/** The job id a generation id names, or null when it names none. */
export function jobIdForGenerationId(generationId: string | null): string | null {
  if (!generationId) return null;
  if (generationId.startsWith(GENERATE_PREFIX)) {
    const rest = generationId.slice(GENERATE_PREFIX.length);
    const sep = rest.indexOf(":");
    if (sep <= 0) return null;
    return rest.slice(0, sep);
  }
  return generationId;
}

/**
 * Resolve the twin link for one projected row: the D1 job run record
 * whose job id the generation id names AND whose [started, finished]
 * window contains the row's created time — and only when exactly one
 * candidate matches. Zero or multiple candidates → null (the twin
 * survives honestly; never a heuristic merge, never a guess).
 */
export function resolveLinkedJobRunId(
  generationId: string | null,
  createdAtMs: number,
  records: JobRunRecord[],
): string | null {
  const jobId = jobIdForGenerationId(generationId);
  if (!jobId || !Number.isFinite(createdAtMs)) return null;
  const inWindow = records.filter((r) => {
    if (r.jobId !== jobId) return false;
    const startedMs = Date.parse(r.started);
    const finishedMs = Date.parse(r.finished);
    return (
      Number.isFinite(startedMs) &&
      Number.isFinite(finishedMs) &&
      createdAtMs >= startedMs &&
      createdAtMs <= finishedMs
    );
  });
  if (inWindow.length !== 1) return null;
  return d1JobRunRecordId(inWindow[0]);
}

export function createRunLedgerProjector(deps: RunLedgerProjectorDeps): RunLedgerProjector {
  async function resolveReportLink(
    input: ReportProjectionInput,
  ): Promise<string | null> {
    const jobId = jobIdForGenerationId(input.generationId);
    if (!jobId) return null;
    const records = await deps.jobRecordStore.listByJob(jobId, 50);
    return resolveLinkedJobRunId(input.generationId, input.createdAtMs, records);
  }

  return {
    async projectReport(
      input: ReportProjectionInput,
      nowMs: number,
    ): Promise<ProjectRunLedgerResult> {
      const linkedJobRunId = await resolveReportLink(input);
      const latest = await deps.reportStore.latestReport(input.tenantId, input.reportId);
      if (latest && latest.updatedAtMs >= input.updatedAtMs) {
        // Backfill: a row projected before migration 0060 carries
        // a null owner, and a row projected before its job-run
        // twin landed carries a null link. A re-projection that
        // now knows the owner (or the link) lands it as a new
        // version instead of skipping as already-current — null
        // upgrades to a value only, never the reverse, so a
        // replay of identical data still skips.
        const ownerUpgrade = latest.userLogin == null && input.userLogin != null;
        const linkUpgrade = latest.linkedJobRunId == null && linkedJobRunId != null;
        if (!ownerUpgrade && !linkUpgrade) {
          return {
            projected: false,
            skipped: "already-current",
            linkedJobRunId: latest.linkedJobRunId ?? null,
          };
        }
      }
      await deps.reportStore.recordReport({
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        reportId: input.reportId,
        runId: input.runId,
        generationId: input.generationId,
        title: input.title,
        source: input.source,
        summary: input.summary,
        body: capText(input.body),
        createdAtMs: input.createdAtMs,
        updatedAtMs: input.updatedAtMs,
        version: latest ? latest.version + 1 : 1,
        provenanceWriter: "run-ledger-projector",
        provenanceSourceDo: "Orchestrator",
        provenanceSourceVersion: "1",
        linkedJobRunId,
        userLogin: input.userLogin,
        bodyR2Key: input.bodyR2Key,
      });
      return { projected: true, linkedJobRunId };
    },

    async projectAsyncJob(
      input: AsyncJobProjectionInput,
      nowMs: number,
    ): Promise<ProjectRunLedgerResult> {
      const written = await deps.asyncJobStore.recordAsyncJob(input, nowMs);
      return written
        ? { projected: true, linkedJobRunId: null }
        : { projected: false, skipped: "already-current", linkedJobRunId: null };
    },
  };
}
