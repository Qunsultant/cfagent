/**
 * Issue #3246 (sub-issue of #3241), slice 3 — Drizzle D1 adapter
 * for the runs-pack ports. This module is the ONLY place
 * runs-pack code touches a store client: all SQL-adjacent code
 * (the Drizzle query builder) lives here, behind the port
 * interfaces. Every operation is a single statement, which is
 * atomic on any store (same rule as the other D1 adapters; see
 * migrationRunner.ts).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, eq, gt, sql } from "drizzle-orm";
import {
  agentRunsPackBalances,
  agentRunsPackDrafts,
  agentRunsPackVersions,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0007_COMMERCIAL_STORE,
  MIGRATION_0008_SUBSCRIPTIONS,
  MIGRATION_0009_JOURNAL,
  MIGRATION_0011_PRICE_CATALOGUE,
  MIGRATION_0012_NATIVE_LEDGER,
  MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
  MIGRATION_0058_PRODUCT_VERSIONS,
  MIGRATION_0063_RUNS_PACKS,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertRunsPackDraftStatus,
  assertRunsPackLogin,
  assertRunsPackRail,
  assertRunsPackRuns,
  assertRunsPackVersionInput,
  RunsPackClaimRefusedError,
  type RunsPackBalancePort,
  type RunsPackConsumption,
  type RunsPackDraft,
  type RunsPackDraftStore,
  type RunsPackVersion,
  type RunsPackVersionStore,
} from "./runsPackPorts";
import { assertApproverId, type PlanPriceApprovalStatus } from "./subscriptionPorts";

/** Drizzle D1 database object carrying the runs-pack schema. */
export type RunsPackDb = DrizzleD1Database<{
  agentRunsPackVersions: typeof agentRunsPackVersions;
  agentRunsPackBalances: typeof agentRunsPackBalances;
  agentRunsPackDrafts: typeof agentRunsPackDrafts;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1RunsPackDb(d1: D1Database): RunsPackDb {
  return drizzle(d1, {
    schema: {
      agentRunsPackVersions,
      agentRunsPackBalances,
      agentRunsPackDrafts,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0063 (the pack
 * versions, balances, and drafts tables) with the prerequisite
 * chain, so a store ensured through this path alone still has
 * the commercial, subscription, and product tables the pack
 * routes read. The 0058 prerequisites (0009 journal, 0011
 * catalogue, 0012 native ledger, 0027 catalogue approval) are
 * required — 0058's catalogue rebuild reads them, and without
 * them this ensure throws on an empty store. applyMigrations
 * sorts by version, so list order does not matter.
 */
export async function ensureRunsPackSchema(db: RunsPackDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0007_COMMERCIAL_STORE,
    MIGRATION_0008_SUBSCRIPTIONS,
    MIGRATION_0011_PRICE_CATALOGUE,
    MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
    MIGRATION_0009_JOURNAL,
    MIGRATION_0012_NATIVE_LEDGER,
    MIGRATION_0058_PRODUCT_VERSIONS,
    MIGRATION_0063_RUNS_PACKS,
  ]);
}

function toVersion(row: typeof agentRunsPackVersions.$inferSelect): RunsPackVersion {
  return {
    id: row.id,
    productId: row.productId,
    version: row.version,
    segment: row.segment,
    runs: row.runs,
    priceUSD: row.priceUSD,
    approvalStatus: row.approvalStatus as PlanPriceApprovalStatus,
    approvedBy: row.approvedBy,
    approvedAtMs: row.approvedAtMs,
    active: row.active === 1,
    effectiveFromMs: row.effectiveFromMs,
    effectiveToMs: row.effectiveToMs,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

/** Runs-pack versions over D1 via Drizzle. */
export class D1RunsPackVersionAdapter implements RunsPackVersionStore {
  constructor(readonly db: RunsPackDb) {}

  async listVersions(productId: string, segment?: string): Promise<RunsPackVersion[]> {
    const rows = segment
      ? await this.db
          .select()
          .from(agentRunsPackVersions)
          .where(
            and(
              eq(agentRunsPackVersions.productId, productId),
              eq(agentRunsPackVersions.segment, segment),
            ),
          )
          .orderBy(
            asc(agentRunsPackVersions.effectiveFromMs),
            asc(agentRunsPackVersions.version),
            asc(agentRunsPackVersions.id),
          )
      : await this.db
          .select()
          .from(agentRunsPackVersions)
          .where(eq(agentRunsPackVersions.productId, productId))
          .orderBy(
            asc(agentRunsPackVersions.effectiveFromMs),
            asc(agentRunsPackVersions.version),
            asc(agentRunsPackVersions.id),
          );
    return rows.map(toVersion);
  }

  async getVersion(id: string): Promise<RunsPackVersion | null> {
    const rows = await this.db
      .select()
      .from(agentRunsPackVersions)
      .where(eq(agentRunsPackVersions.id, id))
      .limit(1);
    return rows.length === 0 ? null : toVersion(rows[0]);
  }

  async createVersion(input: {
    productId: unknown;
    segment?: unknown;
    runs: unknown;
    priceUSD: unknown;
    effectiveFromMs?: unknown;
    effectiveToMs?: unknown;
  }): Promise<RunsPackVersion> {
    const now = Date.now();
    const versioned = assertRunsPackVersionInput(input, now);
    const id = `packver-${crypto.randomUUID().slice(0, 8)}`;
    // A pack version is created PROPOSED — only an operator
    // approval makes its price buyable (the plan-version #3289
    // precedent). The version NUMBER is server-assigned (max
    // existing + 1 for the product+segment).
    const siblings = await this.listVersions(versioned.productId, versioned.segment);
    const version = siblings.reduce((max, s) => Math.max(max, s.version), 0) + 1;
    const record: RunsPackVersion = {
      id,
      productId: versioned.productId,
      version,
      segment: versioned.segment,
      runs: versioned.runs,
      priceUSD: versioned.priceUSD,
      approvalStatus: "proposed",
      approvedBy: null,
      approvedAtMs: null,
      active: true,
      effectiveFromMs: versioned.effectiveFromMs,
      effectiveToMs: versioned.effectiveToMs,
      createdAtMs: now,
      updatedAtMs: now,
    };
    try {
      await this.db.insert(agentRunsPackVersions).values({
        id: record.id,
        productId: record.productId,
        version: record.version,
        segment: record.segment,
        runs: record.runs,
        priceUSD: record.priceUSD,
        approvalStatus: "proposed",
        approvedBy: null,
        approvedAtMs: null,
        active: 1,
        effectiveFromMs: record.effectiveFromMs,
        effectiveToMs: record.effectiveToMs,
        createdAtMs: record.createdAtMs,
        updatedAtMs: record.updatedAtMs,
      });
    } catch {
      const existing = await this.getVersion(id);
      if (existing) throw new Error(`Runs-pack version ${id} already exists.`);
      throw new Error(`Failed to create runs-pack version ${id}.`);
    }
    return record;
  }

  async approveVersion(id: string, approverId: string): Promise<RunsPackVersion> {
    const approver = assertApproverId(approverId);
    const version = await this.getVersion(id);
    if (!version) throw new Error(`No runs-pack version ${id}.`);
    const now = Date.now();
    await this.db
      .update(agentRunsPackVersions)
      .set({ approvalStatus: "approved", approvedBy: approver, approvedAtMs: now, updatedAtMs: now })
      .where(eq(agentRunsPackVersions.id, id));
    return { ...version, approvalStatus: "approved", approvedBy: approver, approvedAtMs: now, updatedAtMs: now };
  }

  async deactivateVersion(id: string): Promise<RunsPackVersion> {
    const version = await this.getVersion(id);
    if (!version) throw new Error(`No runs-pack version ${id}.`);
    const now = Date.now();
    await this.db
      .update(agentRunsPackVersions)
      .set({ active: 0, updatedAtMs: now })
      .where(eq(agentRunsPackVersions.id, id));
    return { ...version, active: false, updatedAtMs: now };
  }
}

/** Runs-pack balances over D1 via Drizzle. */
export class D1RunsPackBalanceAdapter implements RunsPackBalancePort {
  constructor(readonly db: RunsPackDb) {}

  async getBalance(login: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(agentRunsPackBalances)
      .where(eq(agentRunsPackBalances.login, login))
      .limit(1);
    return rows.length === 0 ? 0 : rows[0].runsRemaining;
  }

  async addPackRuns(login: string, runs: number): Promise<number> {
    const validatedLogin = assertRunsPackLogin(login);
    const validatedRuns = assertRunsPackRuns(runs);
    const now = Date.now();
    await this.db
      .insert(agentRunsPackBalances)
      .values({ login: validatedLogin, runsRemaining: validatedRuns, updatedAtMs: now })
      .onConflictDoUpdate({
        target: agentRunsPackBalances.login,
        set: {
          runsRemaining: sql`${agentRunsPackBalances.runsRemaining} + ${validatedRuns}`,
          updatedAtMs: now,
        },
      });
    return this.getBalance(validatedLogin);
  }

  /**
   * Decision-time spend: a single conditional UPDATE (balance >
   * 0) with RETURNING, so the decrement is atomic on the store —
   * an empty result means no pack run was available (or the
   * login has no balance row), and a concurrent double-spend
   * loses the race instead of spending twice (the top-up #3572
   * claim precedent, applied to a counter).
   */
  async consumePackRun(input: { login: string }): Promise<RunsPackConsumption> {
    const login = assertRunsPackLogin(input.login);
    const rows = await this.db
      .update(agentRunsPackBalances)
      .set({
        runsRemaining: sql`${agentRunsPackBalances.runsRemaining} - 1`,
        updatedAtMs: Date.now(),
      })
      .where(and(eq(agentRunsPackBalances.login, login), gt(agentRunsPackBalances.runsRemaining, 0)))
      .returning();
    if (rows.length === 0) {
      return { allowed: false, remaining: await this.getBalance(login) };
    }
    return { allowed: true, remaining: rows[0].runsRemaining };
  }
}

function toDraft(row: typeof agentRunsPackDrafts.$inferSelect): RunsPackDraft {
  return {
    id: row.id,
    userLogin: row.userLogin,
    tenantId: row.tenantId,
    email: row.email,
    versionId: row.versionId,
    productId: row.productId,
    runs: row.runs,
    priceUSD: row.priceUSD,
    rail: assertRunsPackRail(row.rail),
    status: assertRunsPackDraftStatus(row.status),
    createdAtMs: row.createdAtMs,
    creditedAtMs: row.creditedAtMs,
    paymentIntentId: row.paymentIntentId,
    checkoutSessionId: row.checkoutSessionId,
    challengeNonce: row.challengeNonce,
  };
}

/** Runs-pack drafts over D1 via Drizzle. */
export class D1RunsPackDraftAdapter implements RunsPackDraftStore {
  constructor(readonly db: RunsPackDb) {}

  async createDraft(draft: RunsPackDraft): Promise<RunsPackDraft> {
    await this.db.insert(agentRunsPackDrafts).values({
      id: draft.id,
      userLogin: draft.userLogin,
      tenantId: draft.tenantId,
      email: draft.email,
      versionId: draft.versionId,
      productId: draft.productId,
      runs: draft.runs,
      priceUSD: draft.priceUSD,
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

  async getDraft(id: string): Promise<RunsPackDraft | null> {
    const rows = await this.db
      .select()
      .from(agentRunsPackDrafts)
      .where(eq(agentRunsPackDrafts.id, id))
      .limit(1);
    return rows.length > 0 ? toDraft(rows[0]) : null;
  }

  /**
   * Claim-before-credit (the top-up #3572 precedent): a single
   * conditional UPDATE (minted → crediting) with RETURNING, so
   * the transition is atomic — an empty result means another
   * confirmer already claimed it (or it was never minted), and
   * the caller refuses 409 instead of crediting again.
   */
  async claimForCredit(id: string): Promise<RunsPackDraft> {
    const rows = await this.db
      .update(agentRunsPackDrafts)
      .set({ status: "crediting" })
      .where(and(eq(agentRunsPackDrafts.id, id), eq(agentRunsPackDrafts.status, "minted")))
      .returning();
    if (rows.length === 0) {
      const existing = await this.getDraft(id);
      if (!existing) throw new Error(`Unknown runs-pack draft ${id}.`);
      throw new RunsPackClaimRefusedError(id, existing.status, "claim");
    }
    return toDraft(rows[0]);
  }

  /** Release a claim (crediting → minted); same conditional mechanism. */
  async releaseClaim(id: string): Promise<RunsPackDraft> {
    const rows = await this.db
      .update(agentRunsPackDrafts)
      .set({ status: "minted" })
      .where(and(eq(agentRunsPackDrafts.id, id), eq(agentRunsPackDrafts.status, "crediting")))
      .returning();
    if (rows.length === 0) {
      const existing = await this.getDraft(id);
      if (!existing) throw new Error(`Unknown runs-pack draft ${id}.`);
      throw new RunsPackClaimRefusedError(id, existing.status, "release");
    }
    return toDraft(rows[0]);
  }

  async markCredited(
    id: string,
    update: { creditedAtMs: number; paymentIntentId: string | null; checkoutSessionId: string | null },
  ): Promise<RunsPackDraft> {
    const rows = await this.db
      .update(agentRunsPackDrafts)
      .set({
        status: "credited",
        creditedAtMs: update.creditedAtMs,
        paymentIntentId: update.paymentIntentId,
        checkoutSessionId: update.checkoutSessionId,
      })
      .where(and(eq(agentRunsPackDrafts.id, id), eq(agentRunsPackDrafts.status, "crediting")))
      .returning();
    if (rows.length === 0) {
      const existing = await this.getDraft(id);
      if (!existing) throw new Error(`Unknown runs-pack draft ${id}.`);
      if (existing.status === "credited") throw new Error(`Runs pack ${id} is already credited.`);
      throw new Error(`Runs pack ${id} is not crediting.`);
    }
    return toDraft(rows[0]);
  }

  async listByUser(userLogin: string): Promise<RunsPackDraft[]> {
    const rows = await this.db
      .select()
      .from(agentRunsPackDrafts)
      .where(eq(agentRunsPackDrafts.userLogin, userLogin))
      .orderBy(asc(agentRunsPackDrafts.createdAtMs));
    return rows.map(toDraft);
  }
}
