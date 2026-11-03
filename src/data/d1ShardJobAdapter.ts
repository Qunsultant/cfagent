/**
 * Issue #1676 ([AGENTIC] Slice 2, shard jobs projection) — D1
 * adapter (R2). The ONLY module that may import drizzle-orm
 * for shard jobs, and the only module (with the in-memory test
 * double) that knows the agent_shard_jobs column names.
 *
 * Atomicity note (carried from slices 0/1): every public
 * method here is a single statement, so it is atomic on D1
 * without a transaction. recordJob is ON CONFLICT DO NOTHING
 * on the (tenant, chain, job, version) primary key, so a
 * replayed version is a no-op even under at-least-once
 * delivery.
 */
import { and, asc, count, desc, eq, lt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { agentShardJobs } from "./drizzleSchema";
import type { ShardJobRow, ShardJobStore, ShardJobStatus } from "./shardJobPorts";
import type {
  RetentionPurgeStore,
  ShardJobKey,
} from "./retentionPorts";
import {
  MIGRATION_0003_AGENT_SHARD_JOBS,
  MIGRATION_0038_AGENT_SHARD_JOBS_WORKFLOW_RUN_ID,
  applyMigrations,
} from "./migrationRunner";

export type D1ShardJobDb = ReturnType<typeof createD1ShardJobDb>;

export function createD1ShardJobDb(d1: unknown) {
  return drizzle(d1 as never, { schema: { agentShardJobs } });
}

/** Create agent_shard_jobs if absent (idempotent; safe to call per request). */
export async function ensureShardJobSchema(db: D1ShardJobDb): Promise<void> {
  await applyMigrations(db, [
    MIGRATION_0003_AGENT_SHARD_JOBS,
    MIGRATION_0038_AGENT_SHARD_JOBS_WORKFLOW_RUN_ID,
  ]);
}

function toRow(record: typeof agentShardJobs.$inferSelect): ShardJobRow {
  return {
    tenantId: record.tenantId,
    workspaceId: record.workspaceId,
    chainId: record.chainId,
    jobKey: record.jobKey,
    version: record.version,
    status: record.status as ShardJobStatus,
    stage: record.stage,
    capabilityId: record.capabilityId,
    detail: record.detail,
    resultJson: record.resultJson,
    createdAtMs: record.createdAtMs,
    updatedAtMs: record.updatedAtMs,
    provenanceWriter: record.provenanceWriter,
    provenanceSourceDo: record.provenanceSourceDo,
    provenanceSourceVersion: record.provenanceSourceVersion,
    workflowRunId: record.workflowRunId ?? undefined,
  };
}

/** Latest row per job, newest first, then job key ascending. */
function latestPerJob(rows: ShardJobRow[]): ShardJobRow[] {
  const byKey = new Map<string, ShardJobRow>();
  for (const row of rows) {
    const current = byKey.get(row.jobKey);
    if (!current || row.version > current.version) {
      byKey.set(row.jobKey, row);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => b.updatedAtMs - a.updatedAtMs || a.jobKey.localeCompare(b.jobKey),
  );
}

/**
 * Issue #1701 (slice 6): the purge surface. Every method is
 * tenant-scoped and touches agent_shard_jobs only — the one
 * declared-BOUNDED AgentDB table. Deletes are one single
 * statement per row (atomic on D1 without a transaction);
 * batching is enforced by the runner's per-round limit, not
 * by statement batching.
 */
export class D1ShardJobAdapter
  implements ShardJobStore, RetentionPurgeStore
{
  constructor(readonly db: D1ShardJobDb) {}

  async recordJob(row: ShardJobRow): Promise<void> {
    await this.db
      .insert(agentShardJobs)
      .values({
        tenantId: row.tenantId,
        workspaceId: row.workspaceId,
        chainId: row.chainId,
        jobKey: row.jobKey,
        version: row.version,
        status: row.status,
        stage: row.stage,
        capabilityId: row.capabilityId,
        detail: row.detail,
        resultJson: row.resultJson,
        createdAtMs: row.createdAtMs,
        updatedAtMs: row.updatedAtMs,
        provenanceWriter: row.provenanceWriter,
        provenanceSourceDo: row.provenanceSourceDo,
        provenanceSourceVersion: row.provenanceSourceVersion,
        workflowRunId: row.workflowRunId ?? null,
      })
      .onConflictDoNothing();
  }

  async latestJob(
    tenantId: string,
    chainId: string,
    jobKey: string,
  ): Promise<ShardJobRow | null> {
    const rows = await this.db
      .select()
      .from(agentShardJobs)
      .where(
        and(
          eq(agentShardJobs.tenantId, tenantId),
          eq(agentShardJobs.chainId, chainId),
          eq(agentShardJobs.jobKey, jobKey),
        ),
      )
      .orderBy(desc(agentShardJobs.version))
      .limit(1);
    return rows.length === 0 ? null : toRow(rows[0]);
  }

  async listJobsForChain(
    tenantId: string,
    chainId: string,
  ): Promise<ShardJobRow[]> {
    const rows = await this.db
      .select()
      .from(agentShardJobs)
      .where(
        and(
          eq(agentShardJobs.tenantId, tenantId),
          eq(agentShardJobs.chainId, chainId),
        ),
      );
    return latestPerJob(rows.map(toRow));
  }

  async listJobsByStatus(
    tenantId: string,
    status: ShardJobStatus,
  ): Promise<ShardJobRow[]> {
    // The query over-fetches by design: a job whose latest row
    // moved past this status must not appear, so filter to
    // latest-per-job first, then to the requested status.
    const allForTenant = await this.db
      .select()
      .from(agentShardJobs)
      .where(eq(agentShardJobs.tenantId, tenantId));
    return latestPerJob(allForTenant.map(toRow)).filter(
      (row) => row.status === status,
    );
  }

  async listAgedShardJobKeys(
    tenantId: string,
    cutoffMs: number,
    limit: number,
  ): Promise<ShardJobKey[]> {
    const rows = await this.db
      .select({
        chainId: agentShardJobs.chainId,
        jobKey: agentShardJobs.jobKey,
        version: agentShardJobs.version,
      })
      .from(agentShardJobs)
      .where(
        and(
          eq(agentShardJobs.tenantId, tenantId),
          lt(agentShardJobs.createdAtMs, cutoffMs),
        ),
      )
      .orderBy(
        asc(agentShardJobs.createdAtMs),
        asc(agentShardJobs.chainId),
        asc(agentShardJobs.jobKey),
        asc(agentShardJobs.version),
      )
      .limit(limit);
    return rows;
  }

  async listOldestShardJobKeys(
    tenantId: string,
    limit: number,
  ): Promise<ShardJobKey[]> {
    const rows = await this.db
      .select({
        chainId: agentShardJobs.chainId,
        jobKey: agentShardJobs.jobKey,
        version: agentShardJobs.version,
      })
      .from(agentShardJobs)
      .where(eq(agentShardJobs.tenantId, tenantId))
      .orderBy(
        asc(agentShardJobs.createdAtMs),
        asc(agentShardJobs.chainId),
        asc(agentShardJobs.jobKey),
        asc(agentShardJobs.version),
      )
      .limit(limit);
    return rows;
  }

  async countShardJobs(tenantId: string): Promise<number> {
    const rows = await this.db
      .select({ n: count() })
      .from(agentShardJobs)
      .where(eq(agentShardJobs.tenantId, tenantId));
    return rows.length === 0 ? 0 : rows[0].n;
  }

  async deleteShardJobs(
    tenantId: string,
    keys: ShardJobKey[],
  ): Promise<void> {
    for (const key of keys) {
      await this.db
        .delete(agentShardJobs)
        .where(
          and(
            eq(agentShardJobs.tenantId, tenantId),
            eq(agentShardJobs.chainId, key.chainId),
            eq(agentShardJobs.jobKey, key.jobKey),
            eq(agentShardJobs.version, key.version),
          ),
        );
    }
  }
}
