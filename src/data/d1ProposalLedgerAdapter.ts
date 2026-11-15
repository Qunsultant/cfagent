/**
 * Issue #2288 (#1976 step 0) — Drizzle D1 adapter for the
 * proposal-ledger port (ADR 0002 R1/R2). All SQL-adjacent code
 * for the family lives here, behind the port interface.
 *
 * Atomicity note: a transition writes two rows (the proposal's
 * new state + the append-only transition row). On D1 those two
 * statements are applied via ONE `batch()` call — the store's
 * atomic primitive (ADR 0022 D-C) — so a transition never lands
 * half-recorded. This adapter talks to the raw D1 client for
 * that batch, because drizzle-orm/d1's own transaction() is
 * sequential BEGIN/COMMIT and not atomic (migrationRunner
 * header); single-row operations use the Drizzle builder.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { asc, desc, eq } from "drizzle-orm";
import {
  agentProposals,
  agentProposalTransitions,
} from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertProposalTransition,
  type ProposalLedgerStore,
  type ProposalRow,
  type ProposalState,
  type ProposalTransitionInput,
  type ProposalTransitionRow,
  type ProposeInput,
} from "./proposalLedgerPorts";
import { DML_CATALOGUE } from "./schemaComponent/dmlCatalogue";
import { executeDml } from "./schemaComponent/dmlExecutor";

/** Drizzle D1 database object carrying the ledger schema. */
export type ProposalLedgerDb = DrizzleD1Database<{
  agentProposals: typeof agentProposals;
  agentProposalTransitions: typeof agentProposalTransitions;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ProposalLedgerDb(d1: D1Database): ProposalLedgerDb {
  return drizzle(d1, {
    schema: { agentProposals, agentProposalTransitions },
  });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureProposalLedgerSchema(
  db: ProposalLedgerDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

function toProposal(raw: typeof agentProposals.$inferSelect): ProposalRow {
  return {
    id: raw.id,
    title: raw.title,
    summary: raw.summary,
    proposerAgent: raw.proposerAgent,
    principal: raw.principal,
    state: raw.state as ProposalState,
    createdAtMs: raw.createdAtMs,
    updatedAtMs: raw.updatedAtMs,
  };
}

function toTransition(
  raw: typeof agentProposalTransitions.$inferSelect,
): ProposalTransitionRow {
  return {
    id: raw.id,
    proposalId: raw.proposalId,
    fromState: (raw.fromState as ProposalState | null) ?? null,
    toState: raw.toState as ProposalState,
    actor: raw.actor,
    gateRef: raw.gateRef,
    createdAtMs: raw.createdAtMs,
  };
}

/** Proposal ledger over D1 via Drizzle (proposal + transition rows land in ONE catalogue batch entry). */
export class D1ProposalLedgerAdapter implements ProposalLedgerStore {
  constructor(readonly db: ProposalLedgerDb) {}

  async propose(input: ProposeInput): Promise<ProposalRow> {
    const existing = await this.getProposal(input.id);
    if (existing) return existing;
    const atMs = input.createdAtMs ?? Date.now();
    // Proposal row + creation transition land in ONE batch.
    await executeDml(DML_CATALOGUE, this.db, "dml.d1.agent_proposals.propose", {
      id: input.id,
      title: input.title,
      summary: input.summary,
      proposerAgent: input.proposerAgent,
      principal: input.principal,
      atMs,
    });
    const created = await this.getProposal(input.id);
    if (!created) throw new Error(`Proposal ${input.id} was not recorded.`);
    return created;
  }

  async transition(
    input: ProposalTransitionInput,
  ): Promise<ProposalTransitionRow> {
    const current = await this.getProposal(input.proposalId);
    if (!current) {
      throw new Error(`Proposal ${input.proposalId} does not exist.`);
    }
    // The shared machine rule runs BEFORE any write: an illegal
    // or ungated transition writes nothing at all.
    assertProposalTransition(
      current.state,
      input.toState,
      input.actor,
      input.gateRef,
    );
    const atMs = input.atMs ?? Date.now();
    const transitionId = `${input.proposalId}:${current.state}->${input.toState}:${atMs}`;
    await executeDml(DML_CATALOGUE, this.db, "dml.d1.agent_proposals.transition", {
      proposalId: input.proposalId,
      fromState: current.state,
      toState: input.toState,
      actor: input.actor,
      gateRef: input.gateRef ?? null,
      atMs,
      transitionId,
    });
    const rows = await this.db
      .select()
      .from(agentProposalTransitions)
      .where(eq(agentProposalTransitions.id, transitionId));
    if (rows.length === 0) {
      throw new Error(`Transition ${transitionId} was not recorded.`);
    }
    return toTransition(rows[0]);
  }

  async getProposal(id: string): Promise<ProposalRow | null> {
    const rows = await this.db
      .select()
      .from(agentProposals)
      .where(eq(agentProposals.id, id));
    return rows.length === 0 ? null : toProposal(rows[0]);
  }

  async listProposals(state?: ProposalState): Promise<ProposalRow[]> {
    const query = this.db.select().from(agentProposals);
    const rows = state
      ? await query
          .where(eq(agentProposals.state, state))
          .orderBy(desc(agentProposals.updatedAtMs), desc(agentProposals.id))
      : await query.orderBy(
          desc(agentProposals.updatedAtMs),
          desc(agentProposals.id),
        );
    return rows.map(toProposal);
  }

  async listTransitions(
    proposalId: string,
  ): Promise<ProposalTransitionRow[]> {
    const rows = await this.db
      .select()
      .from(agentProposalTransitions)
      .where(eq(agentProposalTransitions.proposalId, proposalId))
      .orderBy(
        asc(agentProposalTransitions.createdAtMs),
        asc(agentProposalTransitions.id),
      );
    return rows.map(toTransition);
  }
}
