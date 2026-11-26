/**
 * Issue #3534 (Pipeline J1), ORM conformance #3548 — the D1
 * implementation of the EXISTING job-run-record port
 * (src/data/jobRunRecordPorts.ts, #2964/#3121): same port,
 * same table, same record shape — the workflow-hosted
 * residency, beside the DO-SQLite adapter's agent-hosted one.
 * Pipeline runs executing inside a workflow have no host
 * Durable Object to borrow SQLite from; this adapter lets
 * them record through the one run-record machinery instead of
 * inventing a second store. Built on the foundation's drizzle
 * D1 pattern: the table is the foundation's (declared in
 * src/data/drizzleSchema.ts; DDL authority migration 0047 in
 * src/data/migrationRunner.ts), the schema is ensured through
 * the versioned migration runner, and all query-builder
 * sites live inside src/data/.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, desc, eq, isNull, notInArray } from "drizzle-orm";
import { jobRunRecords } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0047_JOB_RUN_RECORDS,
  MIGRATION_0072_JOB_RUN_RECORDS_RUN_KIND,
  MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX,
  MIGRATION_0076_JOB_RUN_DEFINITION_VERSION,
  MIGRATION_0081_JOB_RUN_RECORDS_PROJECTION,
  MIGRATION_0084_JOB_RUN_RECORDS_BINDING,
  MIGRATION_0086_JOB_RUN_RECORDS_OUTCOME_FACTS,
  MIGRATION_0091_JOB_RUN_RECORD_PROVENANCE,
  MIGRATION_0093_JOB_RUN_RECORD_IDENTITIES,
  type MigrationDb,
} from "./migrationRunner";
import {
  JOB_RUN_RECORDS_PER_JOB_CAP,
  type JobRunRecord,
} from "./jobRunRecordPorts";
import { normalizeJobRunRecord } from "../services/jobRunRecords";
import type { JobOutcomeInput, JobOutcomeRow } from "./jobOutcomePorts";

/** Drizzle D1 database object carrying the run-record schema. */
export type JobRunRecordDb = DrizzleD1Database<{
  jobRunRecords: typeof jobRunRecords;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1JobRunRecordDb(d1: D1Database): JobRunRecordDb {
  return createDrizzleD1Db(d1, { schema: { jobRunRecords } });
}

/** Idempotent schema-ensure: applies migrations 0047 + 0072 + 0073 + 0076 + 0081 + 0084 if unapplied. */
/** Idempotent schema-ensure: applies migrations 0047 + 0072 + 0073 + 0076 + 0081 + 0086 + 0091 + 0093 if unapplied. */
export async function ensureJobRunRecordsSchema(db: JobRunRecordDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0047_JOB_RUN_RECORDS,
    MIGRATION_0072_JOB_RUN_RECORDS_RUN_KIND,
    MIGRATION_0073_JOB_RUN_RECORDS_RECENT_IDX,
    MIGRATION_0076_JOB_RUN_DEFINITION_VERSION,
    MIGRATION_0081_JOB_RUN_RECORDS_PROJECTION,
    MIGRATION_0084_JOB_RUN_RECORDS_BINDING,
    MIGRATION_0086_JOB_RUN_RECORDS_OUTCOME_FACTS,
    MIGRATION_0091_JOB_RUN_RECORD_PROVENANCE,
    MIGRATION_0093_JOB_RUN_RECORD_IDENTITIES,
  ]);
}

type JobRunRecordRow = typeof jobRunRecords.$inferSelect;

function rowToRecord(row: JobRunRecordRow): JobRunRecord {
  let artifactRefs: string[] | undefined;
  if (row.artifactRefsJson != null) {
    try {
      const parsed: unknown = JSON.parse(row.artifactRefsJson);
      artifactRefs = Array.isArray(parsed) ? parsed.map(String) : undefined;
    } catch {
      artifactRefs = undefined;
    }
  }
  // Issue #6006 — the folded outcome facts read back through the
  // same shape: a malformed delivery-states JSON reads as absent,
  // never as a guessed map.
  let deliveryStates: Record<string, string> | undefined;
  if (row.deliveryStatesJson != null) {
    try {
      const parsed: unknown = JSON.parse(row.deliveryStatesJson);
      deliveryStates =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, string>)
          : undefined;
    } catch {
      deliveryStates = undefined;
    }
  }
  return normalizeJobRunRecord({
    system: row.system as JobRunRecord["system"],
    jobId: row.jobId,
    operation: row.operation,
    started: row.started,
    finished: row.finished,
    outcome: row.outcome as JobRunRecord["outcome"],
    triggeredBy: row.triggeredBy as JobRunRecord["triggeredBy"],
    ...(row.triggerText != null
      ? { trigger: row.triggerText as JobRunRecord["trigger"] }
      : {}),
    ...(row.scheduleId != null ? { scheduleId: row.scheduleId } : {}),
    ...(row.asyncJobId != null ? { asyncJobId: row.asyncJobId } : {}),
    ...(row.workflowId != null ? { workflowId: row.workflowId } : {}),
    // Issue #4767 — a row stored before the kind columns existed
    // reads back normalized (kind "original", origin null) by
    // normalizeJobRunRecord; the spread passes the stored values
    // through when present.
    ...(row.kind != null ? { kind: row.kind as JobRunRecord["kind"] } : {}),
    ...(row.originRunId != null ? { originRunId: row.originRunId } : {}),
    ...(row.definitionVersion != null
      ? { definitionVersion: row.definitionVersion }
      : {}),
    // Issue #6557 — the #3655 provenance fields (migration 0091). Absent
    // is omitted, like every nullable column above; a consumer treats
    // absent via `?? null`, never an invented value.
    ...(row.brokerId != null ? { brokerId: row.brokerId } : {}),
    ...(row.dataProviderId != null ? { dataProviderId: row.dataProviderId } : {}),
    ...(row.mode != null ? { mode: row.mode as JobRunRecord["mode"] } : {}),
    ...(row.modeSource != null
      ? { modeSource: row.modeSource as JobRunRecord["modeSource"] }
      : {}),
    // Issue #5102 (F5 of #5094) — a row stored before migration
    // 0084 carries none of the four binding columns; the spread
    // passes the stored values through when present and the
    // normalizer fills explicit nulls otherwise.
    ...(row.accountType != null ? { accountType: row.accountType } : {}),
    ...(row.accountId != null ? { accountId: row.accountId } : {}),
    ...(row.bindingScope != null ? { bindingScope: row.bindingScope } : {}),
    ...(row.bindingSource != null ? { bindingSource: row.bindingSource } : {}),
    // Issue #6101 — the owning tenant plus the identity columns
    // (migration 0093). Absent is omitted, like every nullable
    // column above; a consumer treats absent via `?? null`, never
    // an invented value. (tenantId was never read back before —
    // the projector stamped it and no reader needed it; the D1
    // writer stamps it now, so the read-back carries it.)
    ...(row.tenantId != null ? { tenantId: row.tenantId } : {}),
    ...(row.platformId != null ? { platformId: row.platformId } : {}),
    ...(row.userId != null ? { userId: row.userId } : {}),
    ...(row.sessionId != null ? { sessionId: row.sessionId } : {}),
    ...(row.correlationId != null ? { correlationId: row.correlationId } : {}),
    ...(row.traceId != null ? { traceId: row.traceId } : {}),
    ...(row.errorText != null ? { error: row.errorText } : {}),
    ...(row.detail != null ? { detail: row.detail } : {}),
    ...(row.descriptor != null ? { descriptor: row.descriptor } : {}),
    ...(artifactRefs !== undefined ? { artifactRefs } : {}),
    // Issue #6006 — the outcome facts (migration 0086). Absent is
    // omitted, like every other nullable column above — a read-back
    // record carries undefined for a fact the row never folded;
    // consumers treat absent via `?? null`, never an invented fact.
    // Pre-fold rows carry none.
    ...(row.codedError != null ? { codedError: row.codedError } : {}),
    ...(row.origin != null ? { origin: row.origin } : {}),
    ...(row.scanned != null ? { scanned: row.scanned } : {}),
    ...(row.matched != null ? { matched: row.matched } : {}),
    ...(deliveryStates !== undefined ? { deliveryStates } : {}),
    ...(row.pdfKey != null ? { pdfKey: row.pdfKey } : {}),
    ...(row.xlsxKey != null ? { xlsxKey: row.xlsxKey } : {}),
    ...(row.csvKey != null ? { csvKey: row.csvKey } : {}),
    ...(row.reportUrl != null ? { reportUrl: row.reportUrl } : {}),
  });
}

/**
 * Issue #6006 — the outcome-fact columns of one JobRunRecord, as
 * D1 insert values. One definition for record() and the projected
 * upsert, so the fold can never drift between the two writers.
 * Absent facts write NULL, never an invented value.
 */
function outcomeFactColumns(record: JobRunRecord) {
  return {
    codedError: record.codedError ?? null,
    origin: record.origin ?? null,
    scanned: record.scanned ?? null,
    matched: record.matched ?? null,
    deliveryStatesJson:
      record.deliveryStates !== undefined && record.deliveryStates !== null
        ? JSON.stringify(record.deliveryStates)
        : null,
    pdfKey: record.pdfKey ?? null,
    xlsxKey: record.xlsxKey ?? null,
    csvKey: record.csvKey ?? null,
    reportUrl: record.reportUrl ?? null,
  };
}

/**
 * Issue #6006 — the D1 job run record one mas_job_outcomes row
 * folds into when its run has no D1 row (the create leg). The
 * outcome id IS the jobId (the row stays addressable by the run
 * it records); started == finished == the outcome's createdAt
 * (one timestamp, never an invented interval). Status maps onto
 * the D1 three-valued outcome: completed → success, failed →
 * failure, partial → success with the partial coverage noted in
 * the descriptor — a partial run is a completed run with partial
 * coverage, never a failure. The outcome's trigger is both the
 * dispatch mode (triggeredBy) and the ledger trigger.
 */
export function jobOutcomeFoldRecord(outcome: JobOutcomeRow): JobRunRecord {
  const partial = outcome.status === "partial";
  const descriptor = partial
    ? outcome.scanned != null || outcome.matched != null
      ? `Partial coverage — scanned ${outcome.scanned ?? "?"}, matched ${outcome.matched ?? "?"}`
      : "Partial coverage"
    : undefined;
  return {
    system: "job-outcome",
    jobId: outcome.id,
    operation: outcome.kind,
    started: outcome.createdAt,
    finished: outcome.createdAt,
    outcome: outcome.status === "failed" ? "failure" : "success",
    triggeredBy: outcome.trigger,
    trigger: outcome.trigger,
    ...(outcome.status === "failed" && outcome.codedError != null
      ? { error: outcome.codedError }
      : {}),
    ...(descriptor !== undefined ? { descriptor } : {}),
    codedError: outcome.codedError ?? null,
    origin: outcome.origin,
    scanned: outcome.scanned ?? null,
    matched: outcome.matched ?? null,
    deliveryStates: outcome.deliveryStates ?? null,
    pdfKey: outcome.pdfKey ?? null,
    xlsxKey: outcome.xlsxKey ?? null,
    csvKey: outcome.csvKey ?? null,
    reportUrl: outcome.reportUrl ?? null,
  };
}

/** Issue #6006 — do a stored record's outcome facts already equal one outcome row's? Key-order-insensitive for delivery states. */
export function sameOutcomeFacts(record: JobRunRecord, outcome: JobOutcomeRow): boolean {
  const statesEqual = (a: Record<string, string> | null | undefined, b: Record<string, string> | null | undefined): boolean => {
    const an = a ?? null;
    const bn = b ?? null;
    if (an === null || bn === null) return an === bn;
    const ak = Object.keys(an).sort();
    const bk = Object.keys(bn).sort();
    return ak.length === bk.length && ak.every((k, i) => k === bk[i] && an[k] === bn[k]);
  };
  return (
    (record.codedError ?? null) === (outcome.codedError ?? null) &&
    (record.origin ?? null) === (outcome.origin ?? null) &&
    (record.scanned ?? null) === (outcome.scanned ?? null) &&
    (record.matched ?? null) === (outcome.matched ?? null) &&
    statesEqual(record.deliveryStates, outcome.deliveryStates) &&
    (record.pdfKey ?? null) === (outcome.pdfKey ?? null) &&
    (record.xlsxKey ?? null) === (outcome.xlsxKey ?? null) &&
    (record.csvKey ?? null) === (outcome.csvKey ?? null) &&
    (record.reportUrl ?? null) === (outcome.reportUrl ?? null)
  );
}

/** The D1 job-run-record store (async surface over the sync-shaped port via promises). */
export class D1JobRunRecordStore {
  private ensured: Promise<void> | null = null;

  constructor(private readonly db: JobRunRecordDb) {}

  private ensure(): Promise<void> {
    if (!this.ensured) {
      this.ensured = ensureJobRunRecordsSchema(this.db).then(() => undefined);
    }
    return this.ensured;
  }

  async record(record: JobRunRecord): Promise<void> {
    await this.ensure();
    await this.db.insert(jobRunRecords).values({
      system: record.system,
      jobId: record.jobId,
      operation: record.operation,
      started: record.started,
      finished: record.finished,
      outcome: record.outcome,
      triggeredBy: record.triggeredBy,
      triggerText: record.trigger ?? null,
      scheduleId: record.scheduleId ?? null,
      asyncJobId: record.asyncJobId ?? null,
      workflowId: record.workflowId ?? null,
      kind: record.kind ?? null,
      originRunId: record.originRunId ?? null,
      definitionVersion: record.definitionVersion ?? null,
      // Issue #6557 — the four #3655 provenance fields, so a D1-recorded
      // run agrees with a DO-recorded one; null when the dispatch named
      // none (the explicit null, never an inferred value).
      brokerId: record.brokerId ?? null,
      dataProviderId: record.dataProviderId ?? null,
      mode: record.mode ?? null,
      modeSource: record.modeSource ?? null,
      // Issue #6101 — the owning tenant (Q7): the D1 writer stamps
      // it now that the projector no longer does. Null when the call
      // site carried none (an unstamped run), never an invented value.
      tenantId: record.tenantId ?? null,
      // Issue #6101 — the identity columns (migration 0093): the
      // FK-spine columns for platform/user/session plus the plain
      // correlation/trace columns. Absent identities write NULL,
      // never an invented value.
      platformId: record.platformId ?? null,
      userId: record.userId ?? null,
      sessionId: record.sessionId ?? null,
      correlationId: record.correlationId ?? null,
      traceId: record.traceId ?? null,
      // Issue #5102 (F5 of #5094) — the binding tuple, stamped
      // on new rows; null on rows whose call site carried none.
      accountType: record.accountType ?? null,
      accountId: record.accountId ?? null,
      bindingScope: record.bindingScope ?? null,
      bindingSource: record.bindingSource ?? null,
      errorText: record.error ?? null,
      detail: record.detail ?? null,
      descriptor: record.descriptor ?? null,
      artifactRefsJson: record.artifactRefs !== undefined ? JSON.stringify(record.artifactRefs) : null,
      // Issue #6006 — the outcome facts ride the record verbatim.
      ...outcomeFactColumns(record),
    })
    // Issue #6101 (Q2) — retry-safe by key: the unique index on
    // (job_id, started, finished) is the derived identity, and a
    // retry of the same identity is a no-op. The first write wins;
    // a second attempt never duplicates and never throws. The
    // projector's null-upgrade path (recordProjectedJobRunRecord)
    // dies with the projector — there is no DO twin left to
    // upgrade, and no writer upgrades an existing row.
    .onConflictDoNothing({
      target: [
        jobRunRecords.jobId,
        jobRunRecords.started,
        jobRunRecords.finished,
      ],
    });
    // Prune to the per-job cap: keep the newest rows by the
    // history ordering, delete the rest (the DO adapter's
    // NOT IN discipline, expressed through the query builder).
    await this.pruneToCap(record.jobId);
  }

  
  /** Shared per-job cap prune (record + the projection upsert). */
  private async pruneToCap(jobId: string): Promise<void> {
    const keep = await this.db
      .select({ id: jobRunRecords.id })
      .from(jobRunRecords)
      .where(eq(jobRunRecords.jobId, jobId))
      .orderBy(desc(jobRunRecords.started), desc(jobRunRecords.id))
      .limit(JOB_RUN_RECORDS_PER_JOB_CAP);
    const keepIds = keep.map((r) => r.id);
    if (keepIds.length > 0) {
      await this.db
        .delete(jobRunRecords)
        .where(and(eq(jobRunRecords.jobId, jobId), notInArray(jobRunRecords.id, keepIds)));
    }
  }

  async listByJob(jobId: string, limit = 50): Promise<JobRunRecord[]> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(jobRunRecords)
      .where(eq(jobRunRecords.jobId, jobId))
      .orderBy(desc(jobRunRecords.started), desc(jobRunRecords.id))
      .limit(Math.max(1, limit));
    return rows.map(rowToRecord);
  }

  async latestByJob(jobId: string): Promise<JobRunRecord | undefined> {
    return (await this.listByJob(jobId, 1))[0];
  }

  async listRecent(limit = 50): Promise<JobRunRecord[]> {
    await this.ensure();
    const rows = await this.db
      .select()
      .from(jobRunRecords)
      .orderBy(desc(jobRunRecords.started), desc(jobRunRecords.id))
      .limit(Math.max(1, limit));
    return rows.map(rowToRecord);
  }

  /**
   * Issue #6006 — find the D1 row for one outcome by EXACT linkage
   * (the #4259 rule): workflowId == outcome id first (the persist
   * stage stamps workflowId = the producing run's id), else
   * asyncJobId == outcome id. scheduleId NEVER matches on its own
   * (it names a schedule, not a run); no timestamp guess, no
   * heuristic. Returns the raw row (for the update) + the record.
   */
  private async findByLinkage(
    outcomeId: string,
  ): Promise<{ row: JobRunRecordRow; record: JobRunRecord } | undefined> {
    const byWorkflow = await this.db
      .select()
      .from(jobRunRecords)
      .where(eq(jobRunRecords.workflowId, outcomeId))
      .orderBy(desc(jobRunRecords.started), desc(jobRunRecords.id))
      .limit(1);
    if (byWorkflow.length > 0) {
      return { row: byWorkflow[0], record: rowToRecord(byWorkflow[0]) };
    }
    const byAsyncJob = await this.db
      .select()
      .from(jobRunRecords)
      .where(eq(jobRunRecords.asyncJobId, outcomeId))
      .orderBy(desc(jobRunRecords.started), desc(jobRunRecords.id))
      .limit(1);
    if (byAsyncJob.length > 0) {
      return { row: byAsyncJob[0], record: rowToRecord(byAsyncJob[0]) };
    }
    return undefined;
  }

  /** Issue #6006 — the fold row already created for one outcome id. */
  private async findFoldRow(
    outcomeId: string,
  ): Promise<{ row: JobRunRecordRow; record: JobRunRecord } | undefined> {
    const rows = await this.db
      .select()
      .from(jobRunRecords)
      .where(
        and(
          eq(jobRunRecords.jobId, outcomeId),
          eq(jobRunRecords.system, "job-outcome"),
        ),
      )
      .orderBy(desc(jobRunRecords.started), desc(jobRunRecords.id))
      .limit(1);
    if (rows.length === 0) return undefined;
    return { row: rows[0], record: rowToRecord(rows[0]) };
  }

  /**
   * Issue #6006 — fold one mas_job_outcomes row into the one run
   * source (attach-or-create). Attach: the run already has a D1
   * row (exact linkage) — fill its outcome-fact columns; the
   * engine row's own fields stay authoritative (the #6099
   * discipline: errorText is filled only when null and the outcome
   * failed with a coded error, never overwritten). Create: no D1
   * row exists for the run (the twin-less kinds) — insert the
   * outcome as its own `job-outcome` row (jobId IS the outcome id).
   * A re-fold of identical facts is a no-op (landed false), so a
   * replay or a queue redelivery never duplicates. A create that
   * loses a race to an identical insert falls back to attach.
   * Returns whether the write landed, whether it created a row,
   * and the record as it now reads.
   */
  async attachOutcomeFacts(
    input: { outcome: JobOutcomeRow; tenantId: string },
    nowMs: number,
  ): Promise<{ landed: boolean; created: boolean; record: JobRunRecord }> {
    await this.ensure();
    const { outcome, tenantId } = input;
    const facts = outcomeFactColumns(jobOutcomeFoldRecord(outcome));
    const errorFill: { errorText?: string } =
      outcome.status === "failed" && outcome.codedError != null
        ? { errorText: outcome.codedError }
        : {};
    const attach = async (found: {
      row: JobRunRecordRow;
      record: JobRunRecord;
    }): Promise<{ landed: boolean; created: boolean; record: JobRunRecord }> => {
      const needsErrorFill = found.record.error == null && errorFill.errorText !== undefined;
      if (sameOutcomeFacts(found.record, outcome) && !needsErrorFill) {
        return { landed: false, created: false, record: found.record };
      }
      // Issue #6099 discipline — the engine row's own fields stay
      // authoritative: the codedError fills errorText only when the
      // row has none. Spreading errorFill unconditionally would
      // overwrite an engine error with the outcome's code.
      await this.db
        .update(jobRunRecords)
        .set({ ...facts, ...(needsErrorFill ? errorFill : {}) })
        .where(eq(jobRunRecords.id, found.row.id));
      const reread = await this.db
        .select()
        .from(jobRunRecords)
        .where(eq(jobRunRecords.id, found.row.id))
        .limit(1);
      return {
        landed: true,
        created: false,
        record: reread.length > 0 ? rowToRecord(reread[0]) : found.record,
      };
    };
    const linked = await this.findByLinkage(outcome.id);
    if (linked) return attach(linked);
    const foldRow = await this.findFoldRow(outcome.id);
    if (foldRow) return attach(foldRow);
    const record = jobOutcomeFoldRecord(outcome);
    try {
      await this.db.insert(jobRunRecords).values({
        system: record.system,
        jobId: record.jobId,
        operation: record.operation,
        started: record.started,
        finished: record.finished,
        outcome: record.outcome,
        triggeredBy: record.triggeredBy,
        triggerText: record.trigger ?? null,
        scheduleId: record.scheduleId ?? null,
        asyncJobId: record.asyncJobId ?? null,
        workflowId: record.workflowId ?? null,
        kind: record.kind ?? null,
        originRunId: record.originRunId ?? null,
        definitionVersion: record.definitionVersion ?? null,
        errorText: record.error ?? null,
        detail: record.detail ?? null,
        descriptor: record.descriptor ?? null,
        artifactRefsJson:
          record.artifactRefs !== undefined ? JSON.stringify(record.artifactRefs) : null,
        ...facts,
        tenantId,
        projectedAtMs: nowMs,
      });
    } catch {
      // Lost a race to an identical insert (or a replay): fall back
      // to attach — the row exists now, and the attach is idempotent.
      const raced = await this.findFoldRow(outcome.id);
      if (raced) return attach(raced);
      throw new Error(
        `[d1JobRunRecord] outcome fold insert failed for ${outcome.id} and no fold row exists`,
      );
    }
    await this.pruneToCap(record.jobId);
    const created = await this.findFoldRow(outcome.id);
    return {
      landed: true,
      created: true,
      record: created ? created.record : record,
    };
  }

  /**
   * Issue #6101 — fold one job-outcome INPUT directly onto D1: the
   * direct replacement for the DO `recordJobOutcome` + projector
   * hook pair (no DO row, no projection). The DO upsert-merge rules
   * (the JobOutcomeStore contract) are preserved against the D1
   * facts: defined input fields win, undefined never wipes an
   * existing value, delivery states merge key-wise, and a
   * completed/partial re-record without a coded error clears a
   * stale one. The merged row then folds through
   * attachOutcomeFacts (attach-or-create, idempotent on re-fold).
   */
  async foldJobOutcome(
    input: JobOutcomeInput,
    tenantId: string,
    nowMs: number,
  ): Promise<{ landed: boolean; created: boolean; record: JobRunRecord }> {
    await this.ensure();
    const now = new Date().toISOString();
    const prev = (await this.findByLinkage(input.id)) ?? (await this.findFoldRow(input.id));
    const prevFacts = prev?.record;
    const outcome: JobOutcomeRow = {
      id: input.id,
      kind: input.kind,
      trigger: input.trigger,
      status: input.status,
      scanned: input.scanned ?? prevFacts?.scanned ?? null,
      matched: input.matched ?? prevFacts?.matched ?? null,
      codedError:
        input.codedError ??
        (input.status === "completed" || input.status === "partial"
          ? null
          : prevFacts?.codedError ?? null),
      reportUrl: input.reportUrl ?? prevFacts?.reportUrl ?? null,
      pdfKey: input.pdfKey ?? prevFacts?.pdfKey ?? null,
      xlsxKey: input.xlsxKey ?? prevFacts?.xlsxKey ?? null,
      csvKey: input.csvKey ?? prevFacts?.csvKey ?? null,
      deliveryStates: { ...(prevFacts?.deliveryStates ?? {}), ...(input.deliveryStates ?? {}) },
      origin: input.origin,
      createdAt: input.createdAt ?? now,
    };
    return this.attachOutcomeFacts({ outcome, tenantId }, nowMs);
  }
}

/**
 * Note on surfaces: the port (JobRunRecordStore) is synchronous
 * because DO SQLite is synchronous, so this async D1 class does
 * not pretend to implement it directly. The pipeline engine
 * consumes run records through the async seam in
 * src/services/jobPipelineEngine.ts (JobRunRecorder), which this
 * class satisfies structurally — one record shape, one table,
 * two residencies.
 */
