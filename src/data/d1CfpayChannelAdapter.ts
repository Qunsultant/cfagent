/**
 * Issue #2945 — Drizzle D1 adapter for the cfpay channel draft port.
 * This module is the ONLY place channel-draft code touches a store
 * client: all SQL-adjacent code (the Drizzle query builder) lives
 * here, behind the port interface. Every operation is a single
 * statement, which is atomic on any store (same rule as the other D1
 * adapters; see migrationRunner.ts).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq } from "drizzle-orm";
import { agentCfpayChannelPurchases } from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0037_CFPAY_CHANNEL,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertChannelDraftStatus,
  type ChannelDraft,
  type ChannelDraftStore,
} from "./cfpayChannelPorts";
import { assertPriceFamily } from "./priceCataloguePorts";

/** Drizzle D1 database object carrying the channel draft schema. */
export type ChannelDraftDb = DrizzleD1Database<{
  agentCfpayChannelPurchases: typeof agentCfpayChannelPurchases;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ChannelDb(d1: D1Database): ChannelDraftDb {
  return drizzle(d1, {
    schema: {
      agentCfpayChannelPurchases,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0037 if unapplied. No
 * seeding: a draft exists only after a real mint — an empty draft
 * store is the correct initial state.
 */
export async function ensureChannelSchema(db: ChannelDraftDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [MIGRATION_0037_CFPAY_CHANNEL]);
}

function toDraft(row: typeof agentCfpayChannelPurchases.$inferSelect): ChannelDraft {
  return {
    id: row.id,
    userLogin: row.userLogin,
    tenantId: row.tenantId,
    email: row.email,
    family: assertPriceFamily(row.family),
    expectedPriceUSD: row.expectedPriceUSD,
    status: assertChannelDraftStatus(row.status),
    createdAtMs: row.createdAtMs,
    fulfilledAtMs: row.fulfilledAtMs,
    paymentIntentId: row.paymentIntentId,
    fulfilSkippedReason: row.fulfilSkippedReason,
  };
}

/** Channel drafts over D1 via Drizzle. */
export class D1ChannelDraftAdapter implements ChannelDraftStore {
  constructor(readonly db: ChannelDraftDb) {}

  async createDraft(draft: ChannelDraft): Promise<ChannelDraft> {
    await this.db.insert(agentCfpayChannelPurchases).values({
      id: draft.id,
      userLogin: draft.userLogin,
      tenantId: draft.tenantId,
      email: draft.email,
      family: draft.family,
      expectedPriceUSD: draft.expectedPriceUSD,
      status: draft.status,
      createdAtMs: draft.createdAtMs,
      fulfilledAtMs: draft.fulfilledAtMs,
      paymentIntentId: draft.paymentIntentId,
      fulfilSkippedReason: draft.fulfilSkippedReason,
    });
    return { ...draft };
  }

  async getDraft(id: string): Promise<ChannelDraft | null> {
    const rows = await this.db
      .select()
      .from(agentCfpayChannelPurchases)
      .where(eq(agentCfpayChannelPurchases.id, id))
      .limit(1);
    return rows.length > 0 ? toDraft(rows[0]) : null;
  }

  async markFulfilled(
    id: string,
    update: { fulfilledAtMs: number; paymentIntentId: string | null; fulfilSkippedReason: string | null },
  ): Promise<ChannelDraft> {
    const existing = await this.getDraft(id);
    if (!existing) throw new Error(`Unknown channel draft ${id}.`);
    await this.db
      .update(agentCfpayChannelPurchases)
      .set({
        status: "fulfilled",
        fulfilledAtMs: update.fulfilledAtMs,
        paymentIntentId: update.paymentIntentId,
        fulfilSkippedReason: update.fulfilSkippedReason,
      })
      .where(eq(agentCfpayChannelPurchases.id, id));
    const next = await this.getDraft(id);
    if (!next) throw new Error(`Unknown channel draft ${id}.`);
    return next;
  }

  async listFulfilled(): Promise<ChannelDraft[]> {
    const rows = await this.db
      .select()
      .from(agentCfpayChannelPurchases)
      .where(eq(agentCfpayChannelPurchases.status, "fulfilled"))
      .orderBy(asc(agentCfpayChannelPurchases.createdAtMs));
    return rows.map(toDraft);
  }

  async listByUser(userLogin: string): Promise<ChannelDraft[]> {
    const rows = await this.db
      .select()
      .from(agentCfpayChannelPurchases)
      .where(eq(agentCfpayChannelPurchases.userLogin, userLogin))
      .orderBy(asc(agentCfpayChannelPurchases.createdAtMs));
    return rows.map(toDraft);
  }
}
