/**
 * Issue #2428 (Agent Mesh S17, #2225 G13a) — D1 adapter for
 * the mesh trace hop store (R2). The ONLY module that may
 * import drizzle-orm for trace hops, and the only module
 * (with the in-memory test double) that knows the
 * agent_mesh_trace_hops column names.
 *
 * Every public method is a single statement, so it is atomic
 * on D1 without a transaction. record is ON CONFLICT DO
 * NOTHING on the (trace_id, span_id) primary key: a durable
 * step replay re-recording its deterministic span is a no-op,
 * and the first record wins.
 */
import { asc, eq } from "drizzle-orm";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { agentMeshTraceHops } from "./drizzleSchema";
import type { MeshTraceHop, MeshTraceStore } from "./meshTracePorts";
import {
  MIGRATION_0023_AGENT_MESH_TRACE_HOPS,
  applyMigrations,
} from "./migrationRunner";

export type D1MeshTraceDb = ReturnType<typeof createD1MeshTraceDb>;

export function createD1MeshTraceDb(d1: unknown) {
  return createDrizzleD1Db(d1 as never, { schema: { agentMeshTraceHops } });
}

/** Create agent_mesh_trace_hops if absent (idempotent; safe to call per request). */
export async function ensureMeshTraceSchema(db: D1MeshTraceDb): Promise<void> {
  await applyMigrations(db, [MIGRATION_0023_AGENT_MESH_TRACE_HOPS]);
}

function toHop(record: typeof agentMeshTraceHops.$inferSelect): MeshTraceHop {
  return {
    traceId: record.traceId,
    spanId: record.spanId,
    ...(record.parentSpanId ? { parentSpanId: record.parentSpanId } : {}),
    kind: record.kind as MeshTraceHop["kind"],
    operation: record.operation,
    timestampMs: record.timestampMs,
    tenantId: record.tenantId,
    ...(record.caller ? { caller: record.caller } : {}),
    ...(record.agentName ? { agent: record.agentName } : {}),
    ...(record.jobId ? { jobId: record.jobId } : {}),
    ...(record.note ? { note: record.note } : {}),
  };
}

export class D1MeshTraceAdapter implements MeshTraceStore {
  constructor(readonly db: D1MeshTraceDb) {}

  async record(hop: MeshTraceHop): Promise<void> {
    await this.db
      .insert(agentMeshTraceHops)
      .values({
        traceId: hop.traceId,
        spanId: hop.spanId,
        parentSpanId: hop.parentSpanId ?? null,
        kind: hop.kind,
        operation: hop.operation,
        timestampMs: hop.timestampMs,
        tenantId: hop.tenantId ?? null,
        caller: hop.caller ?? null,
        agentName: hop.agent ?? null,
        jobId: hop.jobId ?? null,
        note: hop.note ?? null,
      })
      .onConflictDoNothing();
  }

  async hopsFor(traceId: string): Promise<MeshTraceHop[]> {
    const rows = await this.db
      .select()
      .from(agentMeshTraceHops)
      .where(eq(agentMeshTraceHops.traceId, traceId))
      .orderBy(asc(agentMeshTraceHops.timestampMs));
    return rows.map(toHop);
  }
}
