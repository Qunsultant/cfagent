/**
 * Issue #3307 (sub-issue of #3241), slice 1 — Drizzle D1 adapter
 * for the referral-code ports. This module is the ONLY place
 * referral-code code touches a store client: all SQL-adjacent
 * code (the Drizzle query builder) lives here, behind the port
 * interfaces. Every operation is a single statement, which is
 * atomic on any store (same rule as the other D1 adapters; see
 * migrationRunner.ts). The redeem service sequences single
 * statements (replay check, cap increments, redemption row,
 * balance credit) — it does not build a multi-statement
 * transaction.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { and, asc, desc, eq, lt, sql } from "drizzle-orm";
import {
  agentCodeRedemptionCounts,
  agentCodeRedemptions,
  agentCodeRunBalances,
  agentReferralCodeRules,
  agentReferralCodes,
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
  MIGRATION_0066_REFERRAL_CODES,
  type MigrationDb,
} from "./migrationRunner";
import {
  assertCodeRuns,
  assertReferralCodeAttributionMode,
  assertReferralCodeIssuer,
  assertReferralCodeKind,
  assertReferralCodeRuleInput,
  assertReferrerForKind,
  displayPrefixForCodeValue,
  generateCodeValue,
  hashCodeValue,
  type CodeRedemption,
  type CodeRedemptionStore,
  type CodeRunsBalancePort,
  type CodeRunsConsumption,
  type ReferralCode,
  type ReferralCodeKind,
  type ReferralCodeRule,
  type ReferralCodeRuleStore,
  type ReferralCodeStore,
} from "./referralCodePorts";

/** Drizzle D1 database object carrying the referral-code schema. */
export type ReferralCodeDb = DrizzleD1Database<{
  agentReferralCodeRules: typeof agentReferralCodeRules;
  agentReferralCodes: typeof agentReferralCodes;
  agentCodeRedemptions: typeof agentCodeRedemptions;
  agentCodeRedemptionCounts: typeof agentCodeRedemptionCounts;
  agentCodeRunBalances: typeof agentCodeRunBalances;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ReferralCodeDb(d1: D1Database): ReferralCodeDb {
  return drizzle(d1, {
    schema: {
      agentReferralCodeRules,
      agentReferralCodes,
      agentCodeRedemptions,
      agentCodeRedemptionCounts,
      agentCodeRunBalances,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0066 (the five
 * referral-code tables + inactive seed rules) with the
 * prerequisite chain, so a store ensured through this path
 * alone still has the product table the seeds reference. The
 * chain mirrors ensureRunsPackSchema: 0058's catalogue rebuild
 * reads agent_subscription_plans (0008) and the journal /
 * catalogue / ledger tables (0009, 0011, 0012, 0027), and
 * without them this ensure throws on an empty store (verified
 * by tests/referralCodes.test.ts, which applies 0066 alone on
 * a fresh empty DB). applyMigrations sorts by version, so list
 * order does not matter.
 */
export async function ensureReferralCodeSchema(db: ReferralCodeDb): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0007_COMMERCIAL_STORE,
    MIGRATION_0008_SUBSCRIPTIONS,
    MIGRATION_0009_JOURNAL,
    MIGRATION_0011_PRICE_CATALOGUE,
    MIGRATION_0012_NATIVE_LEDGER,
    MIGRATION_0027_PRICE_CATALOGUE_APPROVAL,
    MIGRATION_0058_PRODUCT_VERSIONS,
    MIGRATION_0066_REFERRAL_CODES,
  ]);
}

function toRule(row: typeof agentReferralCodeRules.$inferSelect): ReferralCodeRule {
  return {
    id: row.id,
    productId: row.productId,
    issuer: assertReferralCodeIssuer(row.issuer),
    runsPerCode: row.runsPerCode,
    reusable: row.reusable === 1,
    expiryDays: row.expiryDays,
    attributionMode: assertReferralCodeAttributionMode(row.attributionMode),
    maxRedemptionsPerCode: row.maxRedemptionsPerCode,
    maxRedemptionsPerLogin: row.maxRedemptionsPerLogin,
    globalCap: row.globalCap,
    redemptionCount: row.redemptionCount,
    active: row.active === 1,
    createdAtMs: row.createdAtMs,
    updatedAtMs: row.updatedAtMs,
  };
}

function toCode(row: typeof agentReferralCodes.$inferSelect): ReferralCode {
  return {
    id: row.id,
    codeHash: row.codeHash,
    displayPrefix: row.displayPrefix,
    ruleId: row.ruleId,
    productId: row.productId,
    kind: assertReferralCodeKind(row.kind),
    issuerLogin: row.issuerLogin,
    issuerKind: assertReferralCodeIssuer(row.issuerKind),
    referrerUserId: row.referrerUserId,
    tenantScope: row.tenantScope,
    runs: row.runs,
    reusable: row.reusable === 1,
    expiresAtMs: row.expiresAtMs,
    revokedAtMs: row.revokedAtMs,
    redemptionCount: row.redemptionCount,
    createdAtMs: row.createdAtMs,
  };
}

function toRedemption(row: typeof agentCodeRedemptions.$inferSelect): CodeRedemption {
  return {
    id: row.id,
    codeId: row.codeId,
    redeemerLogin: row.redeemerLogin,
    redeemerTenantId: row.redeemerTenantId,
    productId: row.productId,
    runsGranted: row.runsGranted,
    attributionWritten: row.attributionWritten === 1,
    createdAtMs: row.createdAtMs,
  };
}

/** Referral-code rules over D1 via Drizzle. */
export class D1ReferralCodeRuleAdapter implements ReferralCodeRuleStore {
  constructor(readonly db: ReferralCodeDb) {}

  async getRule(
    productId: string,
    issuer: ReferralCodeRule["issuer"],
  ): Promise<ReferralCodeRule | null> {
    const rows = await this.db
      .select()
      .from(agentReferralCodeRules)
      .where(
        and(
          eq(agentReferralCodeRules.productId, productId),
          eq(agentReferralCodeRules.issuer, issuer),
        ),
      )
      .limit(1);
    return rows.length === 0 ? null : toRule(rows[0]);
  }

  async listRules(productId: string): Promise<ReferralCodeRule[]> {
    const rows = await this.db
      .select()
      .from(agentReferralCodeRules)
      .where(eq(agentReferralCodeRules.productId, productId))
      .orderBy(asc(agentReferralCodeRules.issuer), asc(agentReferralCodeRules.id));
    return rows.map(toRule);
  }

  async upsertRule(input: {
    productId: unknown;
    issuer?: unknown;
    runsPerCode?: unknown;
    reusable?: unknown;
    expiryDays?: unknown;
    attributionMode?: unknown;
    maxRedemptionsPerCode?: unknown;
    maxRedemptionsPerLogin?: unknown;
    globalCap?: unknown;
    active?: unknown;
  }): Promise<ReferralCodeRule> {
    const validated = assertReferralCodeRuleInput(input);
    const now = Date.now();
    const existing = await this.getRule(validated.productId, validated.issuer);
    if (existing) {
      // Rule edits affect only codes issued AFTER the edit:
      // the id, the seed/creation time, and the global
      // redemption count are preserved, never reset.
      await this.db
        .update(agentReferralCodeRules)
        .set({
          runsPerCode: validated.runsPerCode,
          reusable: validated.reusable ? 1 : 0,
          expiryDays: validated.expiryDays,
          attributionMode: validated.attributionMode,
          maxRedemptionsPerCode: validated.maxRedemptionsPerCode,
          maxRedemptionsPerLogin: validated.maxRedemptionsPerLogin,
          globalCap: validated.globalCap,
          active: validated.active ? 1 : 0,
          updatedAtMs: now,
        })
        .where(eq(agentReferralCodeRules.id, existing.id));
      return { ...existing, ...validated, updatedAtMs: now };
    }
    const record: ReferralCodeRule = {
      id: `coderule-${crypto.randomUUID().slice(0, 8)}`,
      ...validated,
      redemptionCount: 0,
      createdAtMs: now,
      updatedAtMs: now,
    };
    await this.db.insert(agentReferralCodeRules).values({
      id: record.id,
      productId: record.productId,
      issuer: record.issuer,
      runsPerCode: record.runsPerCode,
      reusable: record.reusable ? 1 : 0,
      expiryDays: record.expiryDays,
      attributionMode: record.attributionMode,
      maxRedemptionsPerCode: record.maxRedemptionsPerCode,
      maxRedemptionsPerLogin: record.maxRedemptionsPerLogin,
      globalCap: record.globalCap,
      redemptionCount: 0,
      active: record.active ? 1 : 0,
      createdAtMs: record.createdAtMs,
      updatedAtMs: record.updatedAtMs,
    });
    return record;
  }
}

/** Referral codes over D1 via Drizzle. */
export class D1ReferralCodeAdapter implements ReferralCodeStore {
  constructor(readonly db: ReferralCodeDb) {}

  async createCode(input: {
    rule: ReferralCodeRule;
    kind: ReferralCodeKind;
    issuerLogin: string;
    issuerKind: ReferralCodeRule["issuer"];
    referrerUserId: string | null;
    tenantScope: string | null;
    nowMs: number;
  }): Promise<{ code: ReferralCode; plaintext: string }> {
    const referrer = assertReferrerForKind(input.kind, input.referrerUserId);
    if (!input.issuerLogin.trim()) throw new Error("Referral code issuerLogin is required.");
    const expiresAtMs =
      input.rule.expiryDays === null ? null : input.nowMs + input.rule.expiryDays * 86_400_000;
    // A hash collision at 80 bits is a store-corruption signal,
    // not a retryable event — but the unique index makes the
    // retry cheap, so retry a bounded number of times before
    // failing loudly.
    for (let attempt = 0; attempt < 5; attempt++) {
      const plaintext = generateCodeValue();
      const normalized = plaintext.replace(/-/g, "");
      const codeHash = await hashCodeValue(normalized);
      const record: ReferralCode = {
        id: `code-${crypto.randomUUID().slice(0, 8)}`,
        codeHash,
        displayPrefix: displayPrefixForCodeValue(normalized),
        ruleId: input.rule.id,
        productId: input.rule.productId,
        kind: input.kind,
        issuerLogin: input.issuerLogin,
        issuerKind: input.issuerKind,
        referrerUserId: referrer,
        tenantScope: input.tenantScope,
        runs: input.rule.runsPerCode,
        reusable: input.rule.reusable,
        expiresAtMs,
        revokedAtMs: null,
        redemptionCount: 0,
        createdAtMs: input.nowMs,
      };
      try {
        await this.db.insert(agentReferralCodes).values({
          id: record.id,
          codeHash: record.codeHash,
          displayPrefix: record.displayPrefix,
          ruleId: record.ruleId,
          productId: record.productId,
          kind: record.kind,
          issuerLogin: record.issuerLogin,
          issuerKind: record.issuerKind,
          referrerUserId: record.referrerUserId,
          tenantScope: record.tenantScope,
          runs: record.runs,
          reusable: record.reusable ? 1 : 0,
          expiresAtMs: record.expiresAtMs,
          revokedAtMs: record.revokedAtMs,
          redemptionCount: 0,
          createdAtMs: record.createdAtMs,
        });
        return { code: record, plaintext };
      } catch {
        const collision = await this.getCodeByHash(codeHash);
        if (!collision) throw new Error("Failed to issue referral code.");
        // A row already carries this hash — regenerate and retry.
      }
    }
    throw new Error("Failed to issue referral code after 5 attempts.");
  }

  async getCode(id: string): Promise<ReferralCode | null> {
    const rows = await this.db
      .select()
      .from(agentReferralCodes)
      .where(eq(agentReferralCodes.id, id))
      .limit(1);
    return rows.length === 0 ? null : toCode(rows[0]);
  }

  async getCodeByHash(codeHash: string): Promise<ReferralCode | null> {
    const rows = await this.db
      .select()
      .from(agentReferralCodes)
      .where(eq(agentReferralCodes.codeHash, codeHash))
      .limit(1);
    return rows.length === 0 ? null : toCode(rows[0]);
  }

  async listCodes(productId: string): Promise<ReferralCode[]> {
    const rows = await this.db
      .select()
      .from(agentReferralCodes)
      .where(eq(agentReferralCodes.productId, productId))
      .orderBy(desc(agentReferralCodes.createdAtMs), desc(agentReferralCodes.id));
    return rows.map(toCode);
  }

  async listCodesByIssuerLogin(issuerLogin: string): Promise<ReferralCode[]> {
    const rows = await this.db
      .select()
      .from(agentReferralCodes)
      .where(eq(agentReferralCodes.issuerLogin, issuerLogin))
      .orderBy(desc(agentReferralCodes.createdAtMs), desc(agentReferralCodes.id));
    return rows.map(toCode);
  }

  /**
   * Revoke: a single conditional UPDATE (the row must still be
   * unrevoked) with RETURNING, so the transition is atomic —
   * an empty result means another revoker won the race. An
   * already-revoked code returns as-is (idempotent).
   */
  async revokeCode(codeId: string, nowMs: number): Promise<ReferralCode | null> {
    const code = await this.getCode(codeId);
    if (!code) return null;
    if (code.revokedAtMs !== null) return code;
    const rows = await this.db
      .update(agentReferralCodes)
      .set({ revokedAtMs: nowMs })
      .where(
        and(eq(agentReferralCodes.id, codeId), sql`${agentReferralCodes.revokedAtMs} IS NULL`),
      )
      .returning();
    if (rows.length === 0) {
      const reread = await this.getCode(codeId);
      return reread ?? code;
    }
    return toCode(rows[0]);
  }

  private async getPerLoginCount(codeId: string, redeemerLogin: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(agentCodeRedemptionCounts)
      .where(
        and(
          eq(agentCodeRedemptionCounts.codeId, codeId),
          eq(agentCodeRedemptionCounts.redeemerLogin, redeemerLogin),
        ),
      )
      .limit(1);
    return rows.length === 0 ? 0 : rows[0].redemptionCount;
  }

  /**
   * The three conditional increments, in order (per-login,
   * per-code, global). The FIRST failed increment stops the
   * sequence; increments that already landed stand (documented
   * residual — caps err toward refusal, never toward
   * over-grant, and the counts are visible on the code/rule
   * rows for operator reconcile).
   */
  async incrementCapCounts(input: {
    codeId: string;
    redeemerLogin: string;
    ruleId: string;
    maxPerCode: number | null;
    maxPerLogin: number | null;
    globalCap: number | null;
    nowMs: number;
  }): Promise<{ ok: true } | { ok: false; failed: "per_login" | "per_code" | "global" }> {
    // (a) Per-login: conditional upsert (the consumeFreeRun
    // shape) with an applied-check — the count never exceeds
    // the cap, judged inside the statement.
    if (input.maxPerLogin !== null) {
      const before = await this.getPerLoginCount(input.codeId, input.redeemerLogin);
      if (before >= input.maxPerLogin) return { ok: false, failed: "per_login" };
      await this.db
        .insert(agentCodeRedemptionCounts)
        .values({
          codeId: input.codeId,
          redeemerLogin: input.redeemerLogin,
          redemptionCount: 1,
          updatedAtMs: input.nowMs,
        })
        .onConflictDoUpdate({
          target: [agentCodeRedemptionCounts.codeId, agentCodeRedemptionCounts.redeemerLogin],
          set: {
            redemptionCount: sql`${agentCodeRedemptionCounts.redemptionCount} + 1`,
            updatedAtMs: input.nowMs,
          },
          where: sql`${agentCodeRedemptionCounts.redemptionCount} < ${input.maxPerLogin}`,
        });
      const after = await this.getPerLoginCount(input.codeId, input.redeemerLogin);
      if (after !== before + 1) return { ok: false, failed: "per_login" };
    }
    // (b) Per-code: single conditional UPDATE with RETURNING.
    if (input.maxPerCode !== null) {
      const rows = await this.db
        .update(agentReferralCodes)
        .set({ redemptionCount: sql`${agentReferralCodes.redemptionCount} + 1` })
        .where(
          and(
            eq(agentReferralCodes.id, input.codeId),
            lt(agentReferralCodes.redemptionCount, input.maxPerCode),
          ),
        )
        .returning();
      if (rows.length === 0) return { ok: false, failed: "per_code" };
    }
    // (c) Global: single conditional UPDATE on the rule row with RETURNING.
    if (input.globalCap !== null) {
      const rows = await this.db
        .update(agentReferralCodeRules)
        .set({
          redemptionCount: sql`${agentReferralCodeRules.redemptionCount} + 1`,
          updatedAtMs: input.nowMs,
        })
        .where(
          and(
            eq(agentReferralCodeRules.id, input.ruleId),
            lt(agentReferralCodeRules.redemptionCount, input.globalCap),
          ),
        )
        .returning();
      if (rows.length === 0) return { ok: false, failed: "global" };
    }
    return { ok: true };
  }
}

/** Code redemptions over D1 via Drizzle. */
export class D1CodeRedemptionAdapter implements CodeRedemptionStore {
  constructor(readonly db: ReferralCodeDb) {}

  async findRedemption(codeId: string, redeemerLogin: string): Promise<CodeRedemption | null> {
    const rows = await this.db
      .select()
      .from(agentCodeRedemptions)
      .where(
        and(
          eq(agentCodeRedemptions.codeId, codeId),
          eq(agentCodeRedemptions.redeemerLogin, redeemerLogin),
        ),
      )
      .orderBy(desc(agentCodeRedemptions.createdAtMs), desc(agentCodeRedemptions.id))
      .limit(1);
    return rows.length === 0 ? null : toRedemption(rows[0]);
  }

  async recordRedemption(input: {
    codeId: string;
    redeemerLogin: string;
    redeemerTenantId: string;
    productId: string;
    runsGranted: number;
    attributionWritten: boolean;
    nowMs: number;
  }): Promise<CodeRedemption> {
    const record: CodeRedemption = {
      id: `red-${crypto.randomUUID().slice(0, 8)}`,
      codeId: input.codeId,
      redeemerLogin: input.redeemerLogin,
      redeemerTenantId: input.redeemerTenantId,
      productId: input.productId,
      runsGranted: input.runsGranted,
      attributionWritten: input.attributionWritten,
      createdAtMs: input.nowMs,
    };
    await this.db.insert(agentCodeRedemptions).values({
      id: record.id,
      codeId: record.codeId,
      redeemerLogin: record.redeemerLogin,
      redeemerTenantId: record.redeemerTenantId,
      productId: record.productId,
      runsGranted: record.runsGranted,
      attributionWritten: record.attributionWritten ? 1 : 0,
      createdAtMs: record.createdAtMs,
    });
    return record;
  }

  async countRedemptionsByLogin(codeId: string, login: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(agentCodeRedemptions)
      .where(
        and(eq(agentCodeRedemptions.codeId, codeId), eq(agentCodeRedemptions.redeemerLogin, login)),
      );
    return rows.length;
  }

  async listRedemptionsForLogin(login: string): Promise<CodeRedemption[]> {
    const rows = await this.db
      .select()
      .from(agentCodeRedemptions)
      .where(eq(agentCodeRedemptions.redeemerLogin, login))
      .orderBy(desc(agentCodeRedemptions.createdAtMs), desc(agentCodeRedemptions.id));
    return rows.map(toRedemption);
  }
}

/** Code-runs balances over D1 via Drizzle. */
export class D1CodeRunsBalanceAdapter implements CodeRunsBalancePort {
  constructor(readonly db: ReferralCodeDb) {}

  async getBalance(login: string): Promise<number> {
    const rows = await this.db
      .select()
      .from(agentCodeRunBalances)
      .where(eq(agentCodeRunBalances.login, login))
      .limit(1);
    return rows.length === 0 ? 0 : rows[0].runsRemaining;
  }

  async addCodeRuns(login: string, runs: number): Promise<number> {
    if (!login.trim()) throw new Error("Code-runs login must be a non-empty string.");
    const validatedRuns = assertCodeRuns(runs);
    const now = Date.now();
    await this.db
      .insert(agentCodeRunBalances)
      .values({ login: login.trim(), runsRemaining: validatedRuns, updatedAtMs: now })
      .onConflictDoUpdate({
        target: agentCodeRunBalances.login,
        set: {
          runsRemaining: sql`${agentCodeRunBalances.runsRemaining} + ${validatedRuns}`,
          updatedAtMs: now,
        },
      });
    return this.getBalance(login.trim());
  }

  /**
   * Decision-time spend (slice 2's gate step reads this shape):
   * a single conditional UPDATE (balance > 0) with RETURNING,
   * so the decrement is atomic — an empty result means no code
   * run was available, and a concurrent double-spend loses the
   * race instead of spending twice (the consumePackRun shape).
   */
  async consumeCodeRun(input: { login: string }): Promise<CodeRunsConsumption> {
    const login = input.login.trim();
    if (!login) throw new Error("Code-runs login must be a non-empty string.");
    const rows = await this.db
      .update(agentCodeRunBalances)
      .set({
        runsRemaining: sql`${agentCodeRunBalances.runsRemaining} - 1`,
        updatedAtMs: Date.now(),
      })
      .where(
        and(
          eq(agentCodeRunBalances.login, login),
          sql`${agentCodeRunBalances.runsRemaining} > 0`,
        ),
      )
      .returning();
    if (rows.length === 0) {
      return { allowed: false, remaining: await this.getBalance(login) };
    }
    return { allowed: true, remaining: rows[0].runsRemaining };
  }
}
