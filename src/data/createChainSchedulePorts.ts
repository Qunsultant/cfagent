/**
 * Issue #1651 ([AGENTIC] Slice 1) — composition root for the
 * chain/schedule ports (R1). This is the ONLY module that maps a
 * Worker binding to a port implementation: domain code imports
 * this helper and the port types, never a store client.
 *
 * Absence of the binding is a normal, non-error state:
 * `createChainScheduleAdapter` returns null and callers keep
 * their legacy behavior (the DO transition already committed;
 * projection is best-effort). A projection failure never throws
 * to the transition caller — it is logged and reported, and the
 * operator reconciles it through the admin-gated route.
 */
import {
  createD1ChainScheduleDb,
  D1ChainScheduleAdapter,
  ensureChainScheduleSchema,
} from "./d1ChainScheduleAdapter";
import { recordAuditEventBestEffort } from "./createAuditReportPorts";
import type {
  ChainRow,
  ChainScheduleStore,
  ScheduleRow,
} from "./chainSchedulePorts";
import {
  projectTransition,
  type ChainScheduleTransition,
  type DoScheduleRecord,
  type ProjectTransitionResult,
} from "./chainScheduleProjection";

import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Build the chain/schedule adapter from Worker env, or null if unbound. */
export function createChainScheduleAdapter(env: {
  AGENT_DB?: unknown;
}): D1ChainScheduleAdapter | null {
  if (!env.AGENT_DB) return null;
  return new D1ChainScheduleAdapter(
    createD1ChainScheduleDb(env.AGENT_DB as D1Database),
  );
}

export interface ProjectAfterTransitionInput {
  tenantId: string;
  workspaceId: string;
  record: DoScheduleRecord;
  transition: ChainScheduleTransition;
  nowMs: number;
}

/**
 * Best-effort projection after a DO transition has committed.
 * Never throws: unbound env is a no-op, and a store failure is
 * logged and reported for later reconciliation.
 */
export async function projectAfterTransition(
  env: { AGENT_DB?: unknown; OBSERVABILITY?: unknown },
  input: ProjectAfterTransitionInput,
): Promise<ProjectTransitionResult> {
  // #3515 S3 batch 7 — env-constructed sink (#5587): the projection
  // failure event reaches the Analytics Engine dataset, not just console.
  const sink = createObservabilitySink(env);
  const structuredLog = createStructuredLogger(sink, {
    component: "data/createChainSchedulePorts",
  });
  try {
    const adapter = createChainScheduleAdapter(env);
    if (!adapter) {
      return { projected: false, skipped: true };
    }
    await ensureChainScheduleSchema(adapter.db);
    const result = await projectTransition({
      store: adapter,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      record: input.record,
      transition: input.transition,
      nowMs: input.nowMs,
      sink,
    });
    // Issue #1688 (slice 3, R5): a projected transition also
    // writes one audit event per subject (chain + schedule).
    // Best-effort and never blocking: the audit helper never
    // throws, and skipped replays write no audit event (no
    // new occurrence happened). Reconcile writes are audited
    // separately at their invocation point, not here.
    if (result.projected && !result.skipped) {
      const detailJson = JSON.stringify({
        transition: input.transition,
        status: input.record.status,
      });
      for (const subjectType of ["chain", "schedule"] as const) {
        await recordAuditEventBestEffort(env, {
          tenantId: input.tenantId,
          workspaceId: input.workspaceId,
          chainId: input.record.id,
          eventKind: input.transition,
          subjectType,
          subjectId: input.record.id,
          actor: "system",
          detailJson,
          occurredAtMs: input.nowMs,
          provenanceWriter: "scheduled-agent:projectAfterTransition",
          provenanceSourceDo: "ScheduledAgent",
          provenanceSourceVersion: "1",
        }, input.nowMs);
      }
    }
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    structuredLog.error("createChainSchedulePorts.projection_failed", {
      message:
        "[data-foundation] Chain/schedule projection failed; transition already committed, reconcile later:",
      error: message,
      tenantId: input.tenantId,
      workspaceId: input.workspaceId,
      recordId: input.record.id,
      transition: input.transition,
    });
    return { projected: false, error: message };
  }
}

/** Tenant-scoped latest-row read from the projection only. */
export async function readChainStatus(
  env: { AGENT_DB?: unknown },
  tenantId: string,
  chainId: string,
): Promise<{ chain: ChainRow | null; schedule: ScheduleRow | null } | null> {
  const adapter = createChainScheduleAdapter(env);
  if (!adapter) return null;
  await ensureChainScheduleSchema(adapter.db);
  const [chain, schedule] = await Promise.all([
    adapter.latestChain(tenantId, chainId),
    adapter.latestSchedule(tenantId, chainId),
  ]);
  return { chain, schedule };
}

export type { ChainScheduleStore };
