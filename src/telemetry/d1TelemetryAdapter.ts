/**
 * Issue #1742 ([AGENTIC] RSI telemetry & calibration engine in
 * D1) — Drizzle D1 adapter for the telemetry ports (R1/R2).
 * This module is the ONLY place telemetry code touches a store
 * client: all query-builder code lives here, behind the port
 * interfaces.
 *
 * Transactions: every operation is one statement per row (one
 * check-then-insert, one SELECT, one full-row update), which
 * is atomic on any store — the same reasoning as the
 * slice-0/1/1740 adapters. Cross-store consistency is the R5
 * story (idempotent writes), not a distributed transaction.
 * Timestamps are adapter-internal (realization inputs carry
 * evaluatedAtMs; createdAtMs is stamped here). Booleans cross
 * the boundary as INTEGER 0/1 (portable subset).
 * Metrics aggregate in the adapter over plain SELECT rows
 * (the shared aggregateMetrics helper): realizations accrue
 * at evaluation pace (capped due-runs), not per request, so
 * an O(rows) read is bounded; pushing aggregation to SQL is
 * a named follow-up if volume ever grows.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "../data/d1QueryLogger";
import { and, eq, gte, inArray, lt } from "drizzle-orm";
import {
  agentCalibrationDecisions,
  agentThesisRealizations,
} from "../data/drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "../data/migrationRunner";
import {
  aggregateMetrics,
  type CalibrationDecisionRow,
  type CalibrationDecisionStatus,
  type MetricDimension,
  type MetricSlice,
  type MetricWindow,
  type TelemetryStore,
  type ThesisDirection,
  type ThesisRealizationInput,
  type ThesisRealizationRow,
} from "./telemetryPorts";

/** Drizzle D1 database object carrying the telemetry schema. */
export type TelemetryDb = DrizzleD1Database<{
  agentThesisRealizations: typeof agentThesisRealizations;
  agentCalibrationDecisions: typeof agentCalibrationDecisions;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1TelemetryDb(d1: D1Database): TelemetryDb {
  return createDrizzleD1Db(d1, {
    schema: { agentThesisRealizations, agentCalibrationDecisions },
  });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureTelemetrySchema(db: TelemetryDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

type RealizationDbRow = typeof agentThesisRealizations.$inferSelect;
type DecisionDbRow = typeof agentCalibrationDecisions.$inferSelect;

function toRealizationRow(db: RealizationDbRow): ThesisRealizationRow {
  return {
    tenantId: db.tenantId,
    outcomeId: db.outcomeId,
    thesis: db.thesis,
    agentKey: db.agentKey,
    structure: db.structure,
    regime: db.regime,
    symbol: db.symbol,
    runId: db.runId,
    reportId: db.reportId,
    chainId: db.chainId,
    predictedDirection: db.predictedDirection as ThesisDirection,
    realizedDirection: db.realizedDirection as ThesisDirection,
    directionCorrect: db.directionCorrect === 1,
    falsified: db.falsified === 1,
    invalidated: db.invalidated === 1,
    pnlEstimatePerUnit: db.pnlEstimatePerUnit,
    rMultiple: db.rMultiple,
    evaluatedAtMs: db.evaluatedAtMs,
    createdAtMs: db.createdAtMs,
  };
}

function toDecisionRow(db: DecisionDbRow): CalibrationDecisionRow {
  return {
    id: db.id,
    tenantId: db.tenantId,
    actorKey: db.actorKey,
    promptKey: db.promptKey,
    dimension: db.dimension as MetricDimension,
    sliceKey: db.sliceKey,
    snapshot: JSON.parse(db.snapshotJson) as CalibrationDecisionRow["snapshot"],
    falsifyingOutcomeIds: JSON.parse(db.falsifyingOutcomeIdsJson) as string[],
    calibrationNote: db.calibrationNote,
    proposedBy: db.proposedBy,
    proposedAtMs: db.proposedAtMs,
    status: db.status as CalibrationDecisionStatus,
    decidedBy: db.decidedBy,
    decidedAtMs: db.decidedAtMs,
    appliedBy: db.appliedBy,
    appliedAtMs: db.appliedAtMs,
    priorNote: db.priorNote,
    supersededBy: db.supersededBy,
    expiredBy: db.expiredBy,
    expiredAtMs: db.expiredAtMs,
    createdAtMs: db.createdAtMs,
    updatedAtMs: db.updatedAtMs,
  };
}

export class D1TelemetryAdapter implements TelemetryStore {
  constructor(readonly db: TelemetryDb) {}

  async recordRealizations(
    rows: ThesisRealizationInput[],
  ): Promise<{ recorded: number; duplicates: number }> {
    if (rows.length === 0) return { recorded: 0, duplicates: 0 };
    const tenantId = rows[0].tenantId;
    const outcomeIds = rows.map((r) => r.outcomeId);
    const existing = await this.db
      .select({ outcomeId: agentThesisRealizations.outcomeId })
      .from(agentThesisRealizations)
      .where(
        and(
          eq(agentThesisRealizations.tenantId, tenantId),
          inArray(agentThesisRealizations.outcomeId, outcomeIds),
        ),
      );
    const seen = new Set(existing.map((r) => r.outcomeId));
    let recorded = 0;
    let duplicates = 0;
    const nowMs = Date.now();
    for (const row of rows) {
      if (seen.has(row.outcomeId)) {
        duplicates += 1;
        continue;
      }
      seen.add(row.outcomeId);
      await this.db.insert(agentThesisRealizations).values({
        tenantId: row.tenantId,
        outcomeId: row.outcomeId,
        thesis: row.thesis,
        agentKey: row.agentKey,
        structure: row.structure,
        regime: row.regime,
        symbol: row.symbol,
        runId: row.runId,
        reportId: row.reportId ?? null,
        chainId: row.chainId ?? null,
        predictedDirection: row.predictedDirection,
        realizedDirection: row.realizedDirection,
        directionCorrect: row.directionCorrect ? 1 : 0,
        falsified: row.falsified ? 1 : 0,
        invalidated: row.invalidated ? 1 : 0,
        pnlEstimatePerUnit: row.pnlEstimatePerUnit ?? null,
        rMultiple: row.rMultiple ?? null,
        evaluatedAtMs: row.evaluatedAtMs,
        createdAtMs: nowMs,
      });
      recorded += 1;
    }
    return { recorded, duplicates };
  }

  async queryRealizations(
    tenantId: string,
    filters?: MetricWindow & { thesis?: string; agentKey?: string },
  ): Promise<ThesisRealizationRow[]> {
    const conditions = [eq(agentThesisRealizations.tenantId, tenantId)];
    if (filters?.thesis !== undefined) {
      conditions.push(eq(agentThesisRealizations.thesis, filters.thesis));
    }
    if (filters?.agentKey !== undefined) {
      conditions.push(eq(agentThesisRealizations.agentKey, filters.agentKey));
    }
    if (filters?.fromMs !== undefined) {
      conditions.push(gte(agentThesisRealizations.evaluatedAtMs, filters.fromMs));
    }
    if (filters?.toMs !== undefined) {
      conditions.push(lt(agentThesisRealizations.evaluatedAtMs, filters.toMs));
    }
    const dbRows = await this.db
      .select()
      .from(agentThesisRealizations)
      .where(and(...conditions));
    return dbRows.map(toRealizationRow);
  }

  async metrics(
    tenantId: string,
    dimension: MetricDimension,
    opts?: MetricWindow,
  ): Promise<MetricSlice[]> {
    const rows = await this.queryRealizations(tenantId, opts);
    return aggregateMetrics(rows, dimension, opts);
  }

  async recordDecision(row: CalibrationDecisionRow): Promise<void> {
    await this.db.insert(agentCalibrationDecisions).values({
      id: row.id,
      tenantId: row.tenantId,
      actorKey: row.actorKey,
      promptKey: row.promptKey,
      dimension: row.dimension,
      sliceKey: row.sliceKey,
      snapshotJson: JSON.stringify(row.snapshot),
      falsifyingOutcomeIdsJson: JSON.stringify(row.falsifyingOutcomeIds),
      calibrationNote: row.calibrationNote,
      proposedBy: row.proposedBy,
      proposedAtMs: row.proposedAtMs,
      status: row.status,
      decidedBy: row.decidedBy ?? null,
      decidedAtMs: row.decidedAtMs ?? null,
      appliedBy: row.appliedBy ?? null,
      appliedAtMs: row.appliedAtMs ?? null,
      priorNote: row.priorNote ?? null,
      supersededBy: row.supersededBy ?? null,
      expiredBy: row.expiredBy ?? null,
      expiredAtMs: row.expiredAtMs ?? null,
      createdAtMs: row.createdAtMs,
      updatedAtMs: row.updatedAtMs,
    });
  }

  async getDecision(tenantId: string, id: string): Promise<CalibrationDecisionRow | null> {
    const dbRows = await this.db
      .select()
      .from(agentCalibrationDecisions)
      .where(
        and(
          eq(agentCalibrationDecisions.tenantId, tenantId),
          eq(agentCalibrationDecisions.id, id),
        ),
      );
    return dbRows.length > 0 ? toDecisionRow(dbRows[0]) : null;
  }

  async updateDecision(row: CalibrationDecisionRow): Promise<void> {
    await this.db
      .update(agentCalibrationDecisions)
      .set({
        status: row.status,
        decidedBy: row.decidedBy ?? null,
        decidedAtMs: row.decidedAtMs ?? null,
        appliedBy: row.appliedBy ?? null,
        appliedAtMs: row.appliedAtMs ?? null,
        priorNote: row.priorNote ?? null,
        supersededBy: row.supersededBy ?? null,
        expiredBy: row.expiredBy ?? null,
        expiredAtMs: row.expiredAtMs ?? null,
        updatedAtMs: row.updatedAtMs,
      })
      .where(
        and(
          eq(agentCalibrationDecisions.tenantId, row.tenantId),
          eq(agentCalibrationDecisions.id, row.id),
        ),
      );
  }

  async listDecisions(
    tenantId: string,
    filters?: {
      status?: CalibrationDecisionStatus;
      actorKey?: string;
      promptKey?: string;
    },
  ): Promise<CalibrationDecisionRow[]> {
    const conditions = [eq(agentCalibrationDecisions.tenantId, tenantId)];
    if (filters?.status !== undefined) {
      conditions.push(eq(agentCalibrationDecisions.status, filters.status));
    }
    if (filters?.actorKey !== undefined) {
      conditions.push(eq(agentCalibrationDecisions.actorKey, filters.actorKey));
    }
    if (filters?.promptKey !== undefined) {
      conditions.push(eq(agentCalibrationDecisions.promptKey, filters.promptKey));
    }
    const dbRows = await this.db
      .select()
      .from(agentCalibrationDecisions)
      .where(and(...conditions));
    return dbRows.map(toDecisionRow);
  }
}
