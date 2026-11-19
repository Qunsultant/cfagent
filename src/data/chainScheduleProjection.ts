/**
 * Issue #1651 ([AGENTIC] Slice 1) — projection writers and
 * reconciliation for chains + schedules (R5).
 *
 * This module is pure port-level logic: it builds rows and
 * drives the store interface, and knows nothing about any store
 * implementation. The durable object is authoritative; this
 * module only mirrors DO state that the caller has ALREADY
 * persisted. Callers must save DO state first, then call
 * `projectTransition` — never the reverse.
 *
 * Failure contract (R5): a projection failure never fails the
 * execution transition. `projectTransition` catches the failure,
 * logs it, and reports projected:false; the transition itself
 * already committed in the DO. `reconcileChainSchedules`
 * re-projects DO state when the projection is missing or older,
 * and reports per-record errors instead of throwing.
 *
 * Versioning: each projected transition writes a new version
 * row (previous latest version + 1, starting at 1). Replaying
 * an already-projected transition is a no-op: when the latest
 * projected status already equals the DO status, no row is
 * written, so at-least-once delivery is safe even though the
 * version counter is read-then-write (a lost race only writes
 * a duplicate status row at a higher version, never a wrong
 * status — the latest row still matches DO state).
 *
 * Identity honesty: the pure compilers (`compileGoal` /
 * `compileChain`) produce no persisted identity, so no chain row
 * is written at compile time. The chain row is created at the
 * first persisted transition — synthesize — with chainId equal
 * to the synthesized record id, and approve/kill advance it.
 * The schedule row shares that id (scheduleId = chainId).
 */
import type {
  ChainRow,
  ChainScheduleStatus,
  ChainScheduleStore,
  ScheduleRow,
} from "./chainSchedulePorts";

import { createStructuredLogger } from "../observability/structuredLogger";
import {
  ConsoleObservabilitySink,
  type ObservabilitySink,
} from "../observability/observabilityPorts";

/** Structural subset of a persisted synthesized record. */
export interface DoScheduleRecord {
  id: string;
  goal: string;
  kind: "recurring" | "one-shot";
  steps: Array<{ capabilityId: string; stage: string }>;
  cron: string | null;
  status: ChainScheduleStatus;
  createdAt: string;
}

export type ChainScheduleTransition = "synthesize" | "approve" | "kill";

export interface ProjectionRowOptions {
  tenantId: string;
  workspaceId: string;
  version: number;
  nowMs: number;
  writer: string;
}

const SOURCE_DO = "ScheduledAgent";
const SOURCE_VERSION = "1";

function stepsJson(record: DoScheduleRecord): string {
  return JSON.stringify(
    record.steps.map((s) => ({ capabilityId: s.capabilityId, stage: s.stage })),
  );
}

function createdAtMs(record: DoScheduleRecord): number {
  const parsed = Date.parse(record.createdAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function chainRowFromRecord(
  record: DoScheduleRecord,
  opts: ProjectionRowOptions,
): ChainRow {
  return {
    tenantId: opts.tenantId,
    workspaceId: opts.workspaceId,
    chainId: record.id,
    version: opts.version,
    status: record.status,
    goal: record.goal,
    stepsJson: stepsJson(record),
    createdAtMs: createdAtMs(record),
    updatedAtMs: opts.nowMs,
    provenanceWriter: opts.writer,
    provenanceSourceDo: SOURCE_DO,
    provenanceSourceVersion: SOURCE_VERSION,
  };
}

export function scheduleRowFromRecord(
  record: DoScheduleRecord,
  opts: ProjectionRowOptions,
): ScheduleRow {
  return {
    tenantId: opts.tenantId,
    workspaceId: opts.workspaceId,
    scheduleId: record.id,
    chainId: record.id,
    version: opts.version,
    status: record.status,
    kind: record.kind,
    cron: record.cron,
    createdAtMs: createdAtMs(record),
    updatedAtMs: opts.nowMs,
    provenanceWriter: opts.writer,
    provenanceSourceDo: SOURCE_DO,
    provenanceSourceVersion: SOURCE_VERSION,
  };
}

function writerFor(transition: ChainScheduleTransition): string {
  switch (transition) {
    case "synthesize":
      return "scheduled-agent:synthesizeSchedule";
    case "approve":
      return "scheduled-agent:approveSynthesizedSchedule";
    case "kill":
      return "scheduled-agent:killSynthesizedSchedule";
  }
}

export interface ProjectTransitionInput {
  store: ChainScheduleStore;
  tenantId: string;
  workspaceId: string;
  record: DoScheduleRecord;
  transition: ChainScheduleTransition;
  nowMs: number;
  /**
   * #3515 S3 batch 7 — optional observability sink (d1QueryLogger
   * precedent): the composition root passes the env-constructed sink
   * when it holds env; without one the event goes to the structured
   * console fallback (never a `{}` sink, #5587).
   */
  sink?: ObservabilitySink;
}

export interface ProjectTransitionResult {
  projected: boolean;
  skipped?: boolean;
  error?: string;
}

/**
 * Project one already-persisted DO transition. Never throws:
 * on failure it logs and reports projected:false, and the
 * caller (whose DO write already committed) reconciles later.
 */
export async function projectTransition(
  input: ProjectTransitionInput,
): Promise<ProjectTransitionResult> {
  // #3515 S3 batch 7 — logger over the injected sink (the composition
  // root passes the env-constructed sink), else the structured console
  // fallback (never a `{}` sink, #5587).
  const structuredLog = createStructuredLogger(
    input.sink ?? new ConsoleObservabilitySink(),
    { component: "data/chainScheduleProjection" },
  );
  try {
    const latestChain = await input.store.latestChain(
      input.tenantId,
      input.record.id,
    );
    const latestSchedule = await input.store.latestSchedule(
      input.tenantId,
      input.record.id,
    );
    if (
      latestChain?.status === input.record.status &&
      latestSchedule?.status === input.record.status
    ) {
      return { projected: true, skipped: true };
    }
    const chainVersion = (latestChain?.version ?? 0) + 1;
    const scheduleVersion = (latestSchedule?.version ?? 0) + 1;
    const writer = writerFor(input.transition);
    await input.store.recordChain(
      chainRowFromRecord(input.record, {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        version: chainVersion,
        nowMs: input.nowMs,
        writer,
      }),
    );
    await input.store.recordSchedule(
      scheduleRowFromRecord(input.record, {
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        version: scheduleVersion,
        nowMs: input.nowMs,
        writer,
      }),
    );
    return { projected: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    structuredLog.error("chainScheduleProjection.projection_failed", {
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

export interface ReconcileInput {
  store: ChainScheduleStore;
  tenantId: string;
  workspaceId: string;
  nowMs: number;
  /** Current DO records, in DO order; DO state wins on conflict. */
  records: DoScheduleRecord[];
}

export interface ReconcileReport {
  checked: number;
  reconciled: number;
  alreadyCurrent: number;
  errors: string[];
}

/**
 * Re-project every DO record whose projection is missing or
 * whose latest status differs from DO state. A record that
 * already matches is left untouched. Per-record failures are
 * collected, never thrown, so one bad record cannot block the
 * rest. Invocation: a deliberate operator/maintenance step
 * (ScheduledAgent.reconcileChainScheduleProjection and its
 * admin-gated route) — never boot logic, never auto-run on
 * deploy or tick. R5 justification: reconciliation is a repair
 * pass over already-persisted state, not a firing path, so
 * running it on a schedule would silently rewrite query state
 * outside any operator decision; the operator invokes it after
 * a recorded projection failure, and its report says exactly
 * what changed.
 */
export async function reconcileChainSchedules(
  input: ReconcileInput,
): Promise<ReconcileReport> {
  const report: ReconcileReport = {
    checked: 0,
    reconciled: 0,
    alreadyCurrent: 0,
    errors: [],
  };
  for (const record of input.records) {
    report.checked += 1;
    try {
      const latestChain = await input.store.latestChain(
        input.tenantId,
        record.id,
      );
      const latestSchedule = await input.store.latestSchedule(
        input.tenantId,
        record.id,
      );
      if (
        latestChain?.status === record.status &&
        latestSchedule?.status === record.status
      ) {
        report.alreadyCurrent += 1;
        continue;
      }
      const result = await projectTransition({
        store: input.store,
        tenantId: input.tenantId,
        workspaceId: input.workspaceId,
        record,
        transition:
          record.status === "killed"
            ? "kill"
            : record.status === "approved"
              ? "approve"
              : "synthesize",
        nowMs: input.nowMs,
      });
      if (result.projected) {
        report.reconciled += 1;
      } else {
        report.errors.push(`${record.id}: ${result.error ?? "unknown"}`);
      }
    } catch (err) {
      report.errors.push(
        `${record.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return report;
}
