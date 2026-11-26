/**
 * Issue #1517 ([AGENTIC] Lane 1, follow-up of #1362) — firing /
 * materialization wiring.
 *
 * This module wires Phase 3 synthesis to Phase 6 governance; it
 * invents NO new predicate, NO new execution, and NO new job model:
 *
 *  - Materialization: an APPROVED recurring synthesized record
 *    becomes a ScheduledAgent DO goals-list entry. Approval alone
 *    still creates nothing (the Phase 3 pin); only the explicit
 *    `ScheduledAgent.materializeSynthesizedSchedule` call does, via
 *    `materializeSynthesizedRecord` here. The entry's id IS the
 *    synthesized record's id, so the firing path can look the record
 *    up by goal id with no second mapping store. Its operation is
 *    `chain.execute` (a ScheduledAgent-owned marker in the
 *    OPERATION_CATALOG, in the same precedent as `social.publish` /
 *    `pipeline:social-daily`: the catalog entry exists so the goal
 *    is a valid goals-list entry, and `onCron` handles it in its own
 *    branch — it is not a generic orchestrator operation, and it is
 *    not a leg an orchestrator plan executes).
 *  - Firing decision: `decideChainFiring` is a thin reason-carrying
 *    wrapper over the Phase 6 contract `shouldFireGoverned` — the
 *    boolean it returns IS that predicate's boolean, never a
 *    re-implementation. Pending, killed, globally-halted, not-due,
 *    and already-consumed records never fire.
 *  - One-shot records have no cron, so they cannot become goals-list
 *    entries; they fire only through the direct
 *    `ScheduledAgent.fireSynthesizedSchedule` path, which uses the
 *    same decision function.
 *  - Execution honesty (lane boundary): a governed-true firing in
 *    this lane creates an orchestrator job descriptor exactly as
 *    every other scheduled goal does in `onCron` — it does NOT
 *    submit the chain as `mas_async_jobs` / #1355 shards and does
 *    NOT claim a chain run completed. Leg execution / shard
 *    submission is the next lane (chain.run executor). Because there
 *    is no run outcome yet, this lane writes NO `mas_adaptation_audit`
 *    row for a successful firing; the shipped #755 path IS used for
 *    blocked attempts (`auditBlockedChainFiring`), where the outcome
 *    ("blocked") is a true statement. A sql-carrying caller supplies
 *    the halt state via `shouldFireGoverned`'s `halted` option (or a
 *    sql for `isGovernedHalted`); the bare ScheduledAgent tick
 *    carries no Orchestrator `mas_settings` sql — its own DO SQLite
 *    is a different database — so a global halt thrown in the
 *    Orchestrator does not automatically stop a bare tick. That
 *    cross-DO halt read is a disclosed follow-up, not faked here by
 *    reading the wrong database.
 */
import { isValidCron, type ScheduledGoal } from "../schedule";
import {
  shouldFireGoverned,
  attributeChainRun,
  versionChain,
  chainRunAuditRecord,
  recordChainRunAudit,
} from "./chainGovernance";
import { recordBlockedAdaptation } from "../services/adaptationAudit";
import type { SynthesizedSchedule } from "./jobSynthesis";
import type { CompiledChain } from "../orchestrate";

/** Marker operation for a materialized chain goal (see header). */
export const CHAIN_EXECUTE_OPERATION = "chain.execute";

/**
 * Materialize an approved recurring record as a goals-list entry.
 * Throws for every other shape: pending and killed records never
 * materialize (the confirmation gate + the kill are terminal), and
 * one-shot records cannot materialize (no cron to schedule on).
 * Pure — the caller owns persistence and duplicate handling.
 */
export function materializeSynthesizedRecord(
  record: SynthesizedSchedule,
): ScheduledGoal {
  if (record.status !== "approved") {
    throw new Error(
      `Cannot materialize synthesized schedule ${record.id}: only approved records materialize (status is "${record.status}").`,
    );
  }
  if (record.kind !== "recurring") {
    throw new Error(
      `Cannot materialize one-shot synthesized schedule ${record.id} as a goals-list entry: one-shot records carry no cron — fire them via fireSynthesizedSchedule.`,
    );
  }
  if (record.cron === null || !isValidCron(record.cron)) {
    throw new Error(
      `Cannot materialize synthesized schedule ${record.id}: recurring record has no valid cron expression.`,
    );
  }
  return {
    id: record.id,
    name: record.goal,
    cron: record.cron,
    operation: CHAIN_EXECUTE_OPERATION,
    budgetCents: record.budgetCents,
    enabled: true,
    // Issue #6503 / #6589 — a materialized goal is a stored goal: the
    // record round-trip stamps the deterministic executionMode default
    // (goalToRecord / recordToGoal), and addGoal stamps it on creation,
    // so materialization stamps it too — the first materialize returns
    // exactly what gets stored, and re-materialization returns the
    // stored goal unchanged. The synthesized record carries no mode
    // (SynthesizedSchedule has no executionMode field), so the
    // deterministic default is the only correct value here.
    executionMode: "deterministic",
    ...(record.timeZone ? { timeZone: record.timeZone } : {}),
  };
}

export interface ChainFiringDecision {
  /** Exactly `shouldFireGoverned(record, now, { halted })`. */
  fire: boolean;
  /** Human-readable reason: "approved and due" when firing, the refusal otherwise. */
  reason: string;
}

/**
 * The firing decision, with a reason. The boolean is delegated, not
 * recomputed: any divergence from `shouldFireGoverned` is a bug,
 * and the pure tests pin that equality case by case.
 */
export function decideChainFiring(
  record: SynthesizedSchedule,
  now: Date,
  opts: { halted?: boolean } = {},
): ChainFiringDecision {
  const fire = shouldFireGoverned(record, now, opts);
  if (fire) return { fire: true, reason: "approved and due" };
  if (opts.halted) return { fire: false, reason: "globally halted" };
  if (record.status === "pending") {
    return { fire: false, reason: "pending (awaiting human approval)" };
  }
  if (record.status === "killed") {
    return { fire: false, reason: "killed" };
  }
  if (record.kind === "one-shot" && record.firedAt !== null) {
    return { fire: false, reason: "already fired" };
  }
  if (record.kind === "recurring" && record.cron === null) {
    return { fire: false, reason: "no cron" };
  }
  return { fire: false, reason: "not due" };
}

/**
 * Write a successful executor run through the shipped #755 audit
 * path (#1523, Lane 2 — closes lane 1's "no audit row for a
 * successful firing" gap, but ONLY when a run actually happened:
 * the caller passes the executor's shard provenance, and the
 * outcome "completed" attests the legs the executor ran, never a
 * descriptor-only firing). Returns the audit row id. Throws if
 * the chain cannot be versioned.
 */
export function auditSuccessfulChainFiring(
  sql: any,
  record: SynthesizedSchedule,
  shardProvenance: string[],
  now: Date = new Date(),
): string {
  const chain: CompiledChain = {
    goal: record.goal,
    steps: record.steps,
    budgetCents: record.budgetCents,
    budgetCapCents: record.budgetCapCents,
    recurrence: record.kind,
    reusesStoredReport: record.reusesStoredReport,
  };
  const version = versionChain(record.id, chain, 1, {
    createdAt: now.toISOString(),
  });
  const attribution = attributeChainRun(version, {
    goal: record.goal,
    shardProvenance,
    outcome: "completed",
    runAt: now.toISOString(),
  });
  return recordChainRunAudit(sql, attribution, now);
}

/**
 * Write a blocked firing attempt through the shipped #755 audit
 * path. The attribution's outcome is "blocked" — a true statement
 * about the attempt, not a claim about a run. Returns the audit row
 * id. Throws if the chain cannot be versioned (synthesis already
 * guarantees shipped/in_flight steps, so this is a bug signal, not
 * a refusal to block: the caller still must not fire).
 */
export function auditBlockedChainFiring(
  sql: any,
  record: SynthesizedSchedule,
  reason: string,
  now: Date = new Date(),
): string {
  const chain: CompiledChain = {
    goal: record.goal,
    steps: record.steps,
    budgetCents: record.budgetCents,
    budgetCapCents: record.budgetCapCents,
    recurrence: record.kind,
    reusesStoredReport: record.reusesStoredReport,
  };
  const version = versionChain(record.id, chain, 1, {
    createdAt: now.toISOString(),
  });
  const attribution = attributeChainRun(version, {
    goal: record.goal,
    shardProvenance: [],
    outcome: "blocked",
    runAt: now.toISOString(),
  });
  return recordBlockedAdaptation(
    sql,
    chainRunAuditRecord(attribution),
    reason,
    now,
  );
}
