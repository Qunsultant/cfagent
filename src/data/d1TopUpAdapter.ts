/**
 * Issue #3262 — Drizzle D1 adapter for the top-up draft port.
 * This module is the ONLY place top-up-draft code touches a store
 * client: all SQL-adjacent code (the Drizzle query builder) lives
 * here, behind the port interface. Every operation is a single
 * statement, which is atomic on any store (same rule as the other D1
 * adapters; see migrationRunner.ts).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import { agentTopUpDrafts } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0048_TOP_UP_DRAFTS,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertTopUpDraftStatus,
  assertTopUpRail,
  TopUpClaimRefusedError,
  type TopUpDraft,
  type TopUpDraftStore,
} from "./topUpPorts";

/** Drizzle D1 database object carrying the top-up draft schema. */
export type TopUpDraftDb = DrizzleD1Database<{
  agentTopUpDrafts: typeof agentTopUpDrafts;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1TopUpDb(d1: D1Database): TopUpDraftDb {
  return drizzle(d1, {
    schema: {
      agentTopUpDrafts,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0048 if unapplied. No
 * seeding: a draft exists only after a real mint — an empty draft
 * store is the correct initial state.
 */
export async function ensureTopUpSchema(db: TopUpDraftDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0048_TOP_UP_DRAFTS]);
}

function toDraft(row: typeof agentTopUpDrafts.$inferSelect): TopUpDraft {
  return {
    id: row.id,
    userLogin: row.userLogin,
    tenantId: row.tenantId,
    email: row.email,
    amountUSD: row.amountUSD,
    rail: assertTopUpRail(row.rail),
    status: assertTopUpDraftStatus(row.status),
    createdAtMs: row.createdAtMs,
    creditedAtMs: row.creditedAtMs,
    paymentIntentId: row.paymentIntentId,
    checkoutSessionId: row.checkoutSessionId,
    challengeNonce: row.challengeNonce,
  };
}

/** Top-up drafts over D1 via Drizzle. */
export class D1TopUpAdapter implements TopUpDraftStore {
  constructor(readonly db: TopUpDraftDb) {}

  async createDraft(draft: TopUpDraft): Promise<TopUpDraft> {
    await this.db.insert(agentTopUpDrafts).values({
      id: draft.id,
      userLogin: draft.userLogin,
      tenantId: draft.tenantId,
      email: draft.email,
      amountUSD: draft.amountUSD,
      rail: draft.rail,
      status: draft.status,
      createdAtMs: draft.createdAtMs,
      creditedAtMs: draft.creditedAtMs,
      paymentIntentId: draft.paymentIntentId,
      checkoutSessionId: draft.checkoutSessionId,
      challengeNonce: draft.challengeNonce,
    });
    return { ...draft };
  }

  async getDraft(id: string): Promise<TopUpDraft | null> {
    const rows = await this.db
      .select()
      .from(agentTopUpDrafts)
      .where(eq(agentTopUpDrafts.id, id))
      .limit(1);
    return rows.length > 0 ? toDraft(rows[0]) : null;
  }

  /**
   * Claim-before-credit (#3572): a single conditional UPDATE
   * (minted → crediting) with RETURNING, so the transition is atomic
   * on the store — an empty result means another confirmer already
   * claimed it (or it was never minted), and the caller refuses 409
   * instead of crediting again.
   */
  async claimForCredit(id: string): Promise<TopUpDraft> {
    const rows = await this.db
      .update(agentTopUpDrafts)
      .set({ status: "crediting" })
      .where(and(eq(agentTopUpDrafts.id, id), eq(agentTopUpDrafts.status, "minted")))
      .returning();
    if (rows.length === 0) {
      const existing = await this.getDraft(id);
      if (!existing) throw new Error(`Unknown top-up draft ${id}.`);
      throw new TopUpClaimRefusedError(id, existing.status, "claim");
    }
    return toDraft(rows[0]);
  }

  /** Release a claim (crediting → minted); same conditional mechanism. */
  async releaseClaim(id: string): Promise<TopUpDraft> {
    const rows = await this.db
      .update(agentTopUpDrafts)
      .set({ status: "minted" })
      .where(and(eq(agentTopUpDrafts.id, id), eq(agentTopUpDrafts.status, "crediting")))
      .returning();
    if (rows.length === 0) {
      const existing = await this.getDraft(id);
      if (!existing) throw new Error(`Unknown top-up draft ${id}.`);
      throw new TopUpClaimRefusedError(id, existing.status, "release");
    }
    return toDraft(rows[0]);
  }

  async markCredited(
    id: string,
    update: { creditedAtMs: number; paymentIntentId: string | null; checkoutSessionId: string | null },
  ): Promise<TopUpDraft> {
    const rows = await this.db
      .update(agentTopUpDrafts)
      .set({
        status: "credited",
        creditedAtMs: update.creditedAtMs,
        paymentIntentId: update.paymentIntentId,
        checkoutSessionId: update.checkoutSessionId,
      })
      .where(and(eq(agentTopUpDrafts.id, id), eq(agentTopUpDrafts.status, "crediting")))
      .returning();
    if (rows.length === 0) {
      const existing = await this.getDraft(id);
      if (!existing) throw new Error(`Unknown top-up draft ${id}.`);
      if (existing.status === "credited") throw new Error(`Top-up ${id} is already credited.`);
      throw new Error(`Top-up ${id} is not crediting.`);
    }
    return toDraft(rows[0]);
  }

  async listByUser(userLogin: string): Promise<TopUpDraft[]> {
    const rows = await this.db
      .select()
      .from(agentTopUpDrafts)
      .where(eq(agentTopUpDrafts.userLogin, userLogin))
      .orderBy(asc(agentTopUpDrafts.createdAtMs));
    return rows.map(toDraft);
  }
}
