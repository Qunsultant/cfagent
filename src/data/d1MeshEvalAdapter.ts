/**
 * Issue #2439 (Agent Mesh S18, #2225 G13b) — D1 adapter for the
 * mesh eval result store (R2). The ONLY module that may import
 * drizzle-orm for eval results, and the only module (with the
 * in-memory test double) that knows the agent_mesh_eval_results
 * column names.
 *
 * Every public method is a single statement, so it is atomic on
 * D1 without a transaction. record is ON CONFLICT DO NOTHING on
 * the (run_id, task_id) primary key: a replayed recording of the
 * same run converges, and the first record wins.
 */
import { asc, desc, eq } from "drizzle-orm";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { agentMeshEvalResults } from "./drizzleSchema";
import type {
  MeshEvalFactValue,
  MeshEvalResultStore,
  MeshEvalTaskResult,
} from "./meshEvalPorts";
import {
  MIGRATION_0024_AGENT_MESH_EVAL_RESULTS,
  applyMigrations,
} from "./migrationRunner";

export type D1MeshEvalDb = ReturnType<typeof createD1MeshEvalDb>;

export function createD1MeshEvalDb(d1: unknown) {
  return createDrizzleD1Db(d1 as never, { schema: { agentMeshEvalResults } });
}

/** Create agent_mesh_eval_results if absent (idempotent; safe to call per request). */
export async function ensureMeshEvalSchema(db: D1MeshEvalDb): Promise<void> {
  await applyMigrations(db, [MIGRATION_0024_AGENT_MESH_EVAL_RESULTS]);
}

function parseFacts(json: string | null): Record<string, MeshEvalFactValue> {
  if (!json) return {};
  try {
    const parsed = JSON.parse(json) as Record<string, MeshEvalFactValue>;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function parseStringArray(json: string | null): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

function toResult(record: typeof agentMeshEvalResults.$inferSelect): MeshEvalTaskResult {
  return {
    runId: record.runId,
    taskId: record.taskId,
    door: record.door,
    className: record.className,
    seq: record.seq,
    passed: record.passed === 1,
    outcome: record.outcome as MeshEvalTaskResult["outcome"],
    ...(record.refusalCode ? { refusalCode: record.refusalCode } : {}),
    failures: parseStringArray(record.failuresJson),
    ...(record.traceId ? { traceId: record.traceId } : {}),
    ...(record.traceHopKindsJson
      ? { traceHopKinds: parseStringArray(record.traceHopKindsJson) }
      : {}),
    ...(record.traceComplete === null || record.traceComplete === undefined
      ? {}
      : { traceComplete: record.traceComplete === 1 }),
    facts: parseFacts(record.factsJson),
    startedAtMs: record.startedAtMs,
    durationMs: record.durationMs,
  };
}

export class D1MeshEvalAdapter implements MeshEvalResultStore {
  constructor(readonly db: D1MeshEvalDb) {}

  async record(result: MeshEvalTaskResult): Promise<void> {
    await this.db
      .insert(agentMeshEvalResults)
      .values({
        runId: result.runId,
        taskId: result.taskId,
        door: result.door,
        className: result.className,
        seq: result.seq,
        passed: result.passed ? 1 : 0,
        outcome: result.outcome,
        refusalCode: result.refusalCode ?? null,
        failuresJson: JSON.stringify(result.failures),
        traceId: result.traceId ?? null,
        traceHopKindsJson: result.traceHopKinds ? JSON.stringify(result.traceHopKinds) : null,
        traceComplete:
          result.traceComplete === undefined ? null : result.traceComplete ? 1 : 0,
        factsJson: JSON.stringify(result.facts),
        startedAtMs: result.startedAtMs,
        durationMs: result.durationMs,
      })
      .onConflictDoNothing();
  }

  async resultsForRun(runId: string): Promise<MeshEvalTaskResult[]> {
    const rows = await this.db
      .select()
      .from(agentMeshEvalResults)
      .where(eq(agentMeshEvalResults.runId, runId))
      .orderBy(asc(agentMeshEvalResults.seq));
    return rows.map(toResult);
  }

  async resultsForTask(taskId: string): Promise<MeshEvalTaskResult[]> {
    const rows = await this.db
      .select()
      .from(agentMeshEvalResults)
      .where(eq(agentMeshEvalResults.taskId, taskId))
      .orderBy(asc(agentMeshEvalResults.startedAtMs), asc(agentMeshEvalResults.seq));
    return rows.map(toResult);
  }

  async latestForTask(taskId: string): Promise<MeshEvalTaskResult | null> {
    const rows = await this.db
      .select()
      .from(agentMeshEvalResults)
      .where(eq(agentMeshEvalResults.taskId, taskId))
      .orderBy(desc(agentMeshEvalResults.startedAtMs), desc(agentMeshEvalResults.seq))
      .limit(1);
    return rows.length > 0 ? toResult(rows[0]) : null;
  }
}
