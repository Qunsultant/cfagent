/**
 * Issue #2183 — Drizzle D1 adapter for the audit-policy port.
 * This module is the ONLY place audit-policy code touches a
 * store client: all SQL-adjacent code (the Drizzle query
 * builder) lives here, behind the port interface (ADR 0002 R2).
 *
 * Transactions: every operation is a single statement (one
 * INSERT, one SELECT, one DELETE), which is atomic on any
 * store. No multi-statement transaction is used here, for the
 * reason recorded in migrationRunner.ts. Chain append is
 * read-head-then-insert: two racing appends for one tenant may
 * compute the same sequence, and the loser's INSERT then fails
 * on the id primary key — that failure surfaces to the caller
 * (best-effort in the gate helper, never fatal to the action)
 * and verification flags any resulting gap. A crash between the
 * head read and the insert leaves no row at all, which is a
 * sequence gap the verifier reports, never a silent pass.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, asc, desc, eq, lt } from "drizzle-orm";
import {
  agentAuditChain,
  agentAuditPolicyActions,
  agentAuditPolicySettings,
} from "./drizzleSchema";
import {
  applyMigrations,
  MIGRATION_0016_AUDIT_POLICY,
  type MigrationDb,
} from "./migrationRunner";
import {
  AUDIT_CHAIN_GENESIS_PREV_HASH,
  AUDIT_POLICY_BLOCKING_ACTIONS,
  AUDIT_POLICY_DEFAULT_MODE,
  AUDIT_POLICY_NON_BLOCKING_ACTIONS,
  AUDIT_POLICY_PROPOSED_RETENTION_DAYS,
  AUDIT_POLICY_SETTING_ENFORCEMENT_MODE,
  AUDIT_POLICY_SETTING_RETENTION_DAYS,
  auditChainEntryHash,
  auditPayloadHash,
  type AuditChainEntry,
  type AuditChainEntryInput,
  type AuditPolicyActionRow,
  type AuditPolicyPort,
  type AuditPolicySettingRow,
} from "./auditPolicyPorts";

/** Drizzle D1 database object carrying the audit-policy schema. */
export type AuditPolicyDb = DrizzleD1Database<{
  agentAuditPolicyActions: typeof agentAuditPolicyActions;
  agentAuditPolicySettings: typeof agentAuditPolicySettings;
  agentAuditChain: typeof agentAuditChain;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1AuditPolicyDb(d1: D1Database): AuditPolicyDb {
  return createDrizzleD1Db(d1, {
    schema: {
      agentAuditPolicyActions,
      agentAuditPolicySettings,
      agentAuditChain,
    },
  });
}

/**
 * Idempotent schema-ensure: applies migration 0016 if unapplied,
 * then seeds the PROPOSED operator data (INSERT OR IGNORE —
 * re-seeding is a no-op, so an operator edit is never
 * overwritten by a later ensure). Enforcement seeds to
 * audit-only; nothing here enables blocking.
 */
export async function ensureAuditPolicySchema(db: AuditPolicyDb): Promise<number[]> {
  const applied = await applyMigrations(db as unknown as MigrationDb, [
    MIGRATION_0016_AUDIT_POLICY,
  ]);
  const now = Date.now();
  for (const action of AUDIT_POLICY_BLOCKING_ACTIONS) {
    await db
      .insert(agentAuditPolicyActions)
      .values({ action, blockOnAuditFailure: 1, updatedAtMs: now })
      .onConflictDoNothing();
  }
  for (const action of AUDIT_POLICY_NON_BLOCKING_ACTIONS) {
    await db
      .insert(agentAuditPolicyActions)
      .values({ action, blockOnAuditFailure: 0, updatedAtMs: now })
      .onConflictDoNothing();
  }
  await db
    .insert(agentAuditPolicySettings)
    .values({
      key: AUDIT_POLICY_SETTING_ENFORCEMENT_MODE,
      value: AUDIT_POLICY_DEFAULT_MODE,
      updatedAtMs: now,
    })
    .onConflictDoNothing();
  await db
    .insert(agentAuditPolicySettings)
    .values({
      key: AUDIT_POLICY_SETTING_RETENTION_DAYS,
      value: String(AUDIT_POLICY_PROPOSED_RETENTION_DAYS),
      updatedAtMs: now,
    })
    .onConflictDoNothing();
  return applied;
}

function toActionRow(
  raw: typeof agentAuditPolicyActions.$inferSelect,
): AuditPolicyActionRow {
  return {
    action: raw.action,
    blockOnAuditFailure: raw.blockOnAuditFailure === 1,
    updatedAtMs: raw.updatedAtMs,
  };
}

function toSettingRow(
  raw: typeof agentAuditPolicySettings.$inferSelect,
): AuditPolicySettingRow {
  return { key: raw.key, value: raw.value, updatedAtMs: raw.updatedAtMs };
}

function toChainEntry(raw: typeof agentAuditChain.$inferSelect): AuditChainEntry {
  return {
    id: raw.id,
    tenantId: raw.tenantId,
    sequence: raw.sequence,
    action: raw.action,
    payloadHash: raw.payloadHash,
    prevHash: raw.prevHash,
    entryHash: raw.entryHash,
    createdAtMs: raw.createdAtMs,
  };
}

/**
 * #6112 — the bounded retry budget for a chain append that loses
 * the sequence race: one try + two retries, never unbounded. The
 * budget mirrors the recorded D1 retry budget
 * (`DEFAULT_D1_RETRY_POLICY.maxAttempts` in d1RetryPolicy.ts),
 * but the retry itself is deliberately NOT `withD1Retry`: that
 * policy never retries constraint violations, and this retry is
 * not a replay of the same insert — it re-reads the head and
 * computes a fresh sequence, so the conflict that failed attempt
 * N cannot fail attempt N+1 the same way. A retry needs no
 * backoff delay: the winner's row is already committed by the
 * time the loser's insert fails, so an immediate re-read sees it.
 */
const AUDIT_CHAIN_APPEND_MAX_ATTEMPTS = 3;

/**
 * True when the failure is the chain id's primary-key conflict
 * (`agent_audit_chain.id` = `tenant:sequence`): either the
 * SQLite constraint error code (SQLITE_CONSTRAINT_PRIMARYKEY,
 * 1555) or the constraint message. Any other failure (a missing
 * table, a validation error, a transport fault) is not a
 * sequence race and must never be retried here.
 */
function isAuditChainUniqueConflict(error: unknown): boolean {
  if (error instanceof Error) {
    const code = (error as { errcode?: unknown }).errcode;
    if (code === 1555) return true;
    if (/UNIQUE constraint|PRIMARY KEY/i.test(error.message)) return true;
  }
  return false;
}

export class D1AuditPolicyAdapter implements AuditPolicyPort {
  constructor(private readonly db: AuditPolicyDb) {}

  /**
   * Per-tenant append queue (#6112) — the same serialization as
   * the in-memory adapter: within one isolate, a tenant's
   * appends run one at a time so a head read always sees the
   * previous append. The bounded retry below covers the races
   * the queue cannot see: a second isolate, or a fresh adapter
   * instance, writing the same tenant at the same moment.
   */
  private chainQueue = new Map<string, Promise<unknown>>();

  async listActionPolicies(): Promise<AuditPolicyActionRow[]> {
    const rows = await this.db
      .select()
      .from(agentAuditPolicyActions)
      .orderBy(asc(agentAuditPolicyActions.action));
    return rows.map(toActionRow);
  }

  async getActionPolicy(action: string): Promise<AuditPolicyActionRow | null> {
    const rows = await this.db
      .select()
      .from(agentAuditPolicyActions)
      .where(eq(agentAuditPolicyActions.action, action))
      .limit(1);
    return rows.length > 0 ? toActionRow(rows[0]) : null;
  }

  async setActionPolicy(
    action: string,
    blockOnAuditFailure: boolean,
  ): Promise<AuditPolicyActionRow> {
    const row: AuditPolicyActionRow = {
      action,
      blockOnAuditFailure,
      updatedAtMs: Date.now(),
    };
    await this.db
      .insert(agentAuditPolicyActions)
      .values({
        action: row.action,
        blockOnAuditFailure: row.blockOnAuditFailure ? 1 : 0,
        updatedAtMs: row.updatedAtMs,
      })
      .onConflictDoUpdate({
        target: agentAuditPolicyActions.action,
        set: {
          blockOnAuditFailure: row.blockOnAuditFailure ? 1 : 0,
          updatedAtMs: row.updatedAtMs,
        },
      });
    return row;
  }

  async getSetting(key: string): Promise<AuditPolicySettingRow | null> {
    const rows = await this.db
      .select()
      .from(agentAuditPolicySettings)
      .where(eq(agentAuditPolicySettings.key, key))
      .limit(1);
    return rows.length > 0 ? toSettingRow(rows[0]) : null;
  }

  async setSetting(key: string, value: string): Promise<AuditPolicySettingRow> {
    const row: AuditPolicySettingRow = { key, value, updatedAtMs: Date.now() };
    await this.db
      .insert(agentAuditPolicySettings)
      .values(row)
      .onConflictDoUpdate({
        target: agentAuditPolicySettings.key,
        set: { value: row.value, updatedAtMs: row.updatedAtMs },
      });
    return row;
  }

  async getChainHead(tenantId: string): Promise<AuditChainEntry | null> {
    const rows = await this.db
      .select()
      .from(agentAuditChain)
      .where(eq(agentAuditChain.tenantId, tenantId))
      .orderBy(desc(agentAuditChain.sequence))
      .limit(1);
    return rows.length > 0 ? toChainEntry(rows[0]) : null;
  }

  async listChainEntries(tenantId: string): Promise<AuditChainEntry[]> {
    const rows = await this.db
      .select()
      .from(agentAuditChain)
      .where(eq(agentAuditChain.tenantId, tenantId))
      .orderBy(asc(agentAuditChain.sequence));
    return rows.map(toChainEntry);
  }

  async appendChainEntry(input: AuditChainEntryInput): Promise<AuditChainEntry> {
    const tail = this.chainQueue.get(input.tenantId) ?? Promise.resolve();
    const next = tail.then(() => this.appendChainEntryWithRetry(input));
    this.chainQueue.set(input.tenantId, next.catch(() => {}));
    return next;
  }

  /**
   * One append attempt, retried only on the id's primary-key
   * conflict. Each attempt re-reads the head, so a retry computes
   * the sequence the winner just took + 1 and re-hashes against
   * the winner's entry hash — the chain stays consecutive and
   * hash-linked. After the budget exhausts the original conflict
   * surfaces (never wrapped), and the caller names it.
   */
  private async appendChainEntryWithRetry(
    input: AuditChainEntryInput,
  ): Promise<AuditChainEntry> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.appendChainEntryOnce(input);
      } catch (error) {
        if (
          attempt >= AUDIT_CHAIN_APPEND_MAX_ATTEMPTS ||
          !isAuditChainUniqueConflict(error)
        ) {
          throw error;
        }
      }
    }
  }

  private async appendChainEntryOnce(
    input: AuditChainEntryInput,
  ): Promise<AuditChainEntry> {
    const head = await this.getChainHead(input.tenantId);
    const sequence = (head?.sequence ?? 0) + 1;
    const createdAtMs = input.createdAtMs ?? Date.now();
    const payloadHash = await auditPayloadHash(input.payload);
    const prevHash = head?.entryHash ?? AUDIT_CHAIN_GENESIS_PREV_HASH;
    const entryHash = await auditChainEntryHash(
      prevHash,
      payloadHash,
      input.action,
      createdAtMs,
    );
    const entry: AuditChainEntry = {
      id: `${input.tenantId}:${sequence}`,
      tenantId: input.tenantId,
      sequence,
      action: input.action,
      payloadHash,
      prevHash,
      entryHash,
      createdAtMs,
    };
    await this.db.insert(agentAuditChain).values(entry);
    return entry;
  }

  async listAgedChainEntries(
    tenantId: string,
    cutoffMs: number,
    limit: number,
  ): Promise<AuditChainEntry[]> {
    const rows = await this.db
      .select()
      .from(agentAuditChain)
      .where(
        and(
          eq(agentAuditChain.tenantId, tenantId),
          lt(agentAuditChain.createdAtMs, cutoffMs),
        ),
      )
      .orderBy(asc(agentAuditChain.createdAtMs))
      .limit(Math.max(0, limit));
    return rows.map(toChainEntry);
  }

  async deleteChainEntries(tenantId: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      await this.db
        .delete(agentAuditChain)
        .where(
          and(eq(agentAuditChain.id, id), eq(agentAuditChain.tenantId, tenantId)),
        );
    }
  }
}
