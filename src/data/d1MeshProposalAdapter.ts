/**
 * Issue #2460 (Agent Mesh S19, #2225 G13c) — D1 adapter for the
 * mesh proposal store (R2). The ONLY module that may import
 * drizzle-orm for proposal records, and the only module (with
 * the in-memory test double) that knows the
 * agent_mesh_proposals column names.
 *
 * Every public method is a single statement, so it is atomic on
 * D1 without a transaction. save is an upsert on the id primary
 * key: the pipeline is the only writer and drives every
 * transition explicitly.
 */
import { asc, eq } from "drizzle-orm";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { agentMeshProposals } from "./drizzleSchema";
import {
  MESH_PROPOSAL_OPEN_STATES,
  type MeshProposalBarVerdict,
  type MeshProposalEvidenceRef,
  type MeshProposalRecord,
  type MeshProposalState,
  type MeshProposalStore,
} from "./meshProposalPorts";
import {
  MIGRATION_0025_AGENT_MESH_PROPOSALS,
  applyMigrations,
} from "./migrationRunner";

export type D1MeshProposalDb = ReturnType<typeof createD1MeshProposalDb>;

export function createD1MeshProposalDb(d1: unknown) {
  return createDrizzleD1Db(d1 as never, { schema: { agentMeshProposals } });
}

/** Create agent_mesh_proposals if absent (idempotent; safe to call per request). */
export async function ensureMeshProposalSchema(db: D1MeshProposalDb): Promise<void> {
  await applyMigrations(db, [MIGRATION_0025_AGENT_MESH_PROPOSALS]);
}

function parseEvidenceRefs(json: string | null): MeshProposalEvidenceRef[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as MeshProposalEvidenceRef[]) : [];
  } catch {
    return [];
  }
}

function parseBarVerdict(json: string | null): MeshProposalBarVerdict | undefined {
  if (!json) return undefined;
  try {
    const parsed = JSON.parse(json) as MeshProposalBarVerdict;
    return parsed && typeof parsed.passes === "boolean" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toRecord(row: typeof agentMeshProposals.$inferSelect): MeshProposalRecord {
  return {
    id: row.id,
    signalKey: row.signalKey,
    title: row.title,
    problem: row.problem,
    proposedChange: row.proposedChange,
    expectedEffect: row.expectedEffect,
    falsificationCriterion: row.falsificationCriterion,
    evidenceRefs: parseEvidenceRefs(row.evidenceRefsJson),
    state: row.state as MeshProposalState,
    barVerdict: parseBarVerdict(row.barVerdictJson),
    filedIssueNumber: row.filedIssueNumber ?? undefined,
    filedIssueUrl: row.filedIssueUrl ?? undefined,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toRow(record: MeshProposalRecord): typeof agentMeshProposals.$inferInsert {
  return {
    id: record.id,
    signalKey: record.signalKey,
    title: record.title,
    problem: record.problem,
    proposedChange: record.proposedChange,
    expectedEffect: record.expectedEffect,
    falsificationCriterion: record.falsificationCriterion,
    evidenceRefsJson: JSON.stringify(record.evidenceRefs),
    state: record.state,
    barVerdictJson: record.barVerdict ? JSON.stringify(record.barVerdict) : null,
    filedIssueNumber: record.filedIssueNumber ?? null,
    filedIssueUrl: record.filedIssueUrl ?? null,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
  };
}

export class D1MeshProposalAdapter implements MeshProposalStore {
  constructor(private readonly db: D1MeshProposalDb) {}

  async save(record: MeshProposalRecord): Promise<MeshProposalRecord> {
    const row = toRow(record);
    await this.db
      .insert(agentMeshProposals)
      .values(row)
      .onConflictDoUpdate({ target: agentMeshProposals.id, set: row });
    return record;
  }

  async get(id: string): Promise<MeshProposalRecord | null> {
    const rows = await this.db
      .select()
      .from(agentMeshProposals)
      .where(eq(agentMeshProposals.id, id))
      .limit(1);
    return rows.length > 0 ? toRecord(rows[0]) : null;
  }

  async list(state?: MeshProposalState): Promise<MeshProposalRecord[]> {
    const base = this.db.select().from(agentMeshProposals);
    const rows = state
      ? await base
          .where(eq(agentMeshProposals.state, state))
          .orderBy(asc(agentMeshProposals.createdAtMs))
      : await base.orderBy(asc(agentMeshProposals.createdAtMs));
    return rows.map(toRecord);
  }

  async openForSignal(signalKey: string): Promise<MeshProposalRecord | null> {
    const rows = await this.db
      .select()
      .from(agentMeshProposals)
      .where(eq(agentMeshProposals.signalKey, signalKey))
      .orderBy(asc(agentMeshProposals.createdAtMs));
    const open = rows
      .map(toRecord)
      .filter((r) =>
        (MESH_PROPOSAL_OPEN_STATES as readonly string[]).includes(r.state),
      );
    return open.length > 0 ? open[0] : null;
  }
}
