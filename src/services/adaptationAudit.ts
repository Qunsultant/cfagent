/**
 * Issue #755 (P2-4.2): adaptation budgets + audit trail for autonomous
 * changes — the substrate Phase 4 bounded adaptation (#754) runs on.
 *
 * #232's constraint — "audit everything: every self-modification logged
 * with before/after and rationale" — has a store here, and bounded
 * adaptation is bounded in aggregate, not just per-step: budgets cap
 * how many adaptations a subject may take per period and how far it
 * may cumulatively drift, enforced BEFORE application. A blocked
 * attempt is itself audited and consumes no budget.
 *
 * The audit table is append-only: this module exports no update or
 * delete path for audit rows (pinned by test). Adapters apply changes
 * exclusively through `applyAdaptation`, which evaluates the budget,
 * runs the caller's apply callback only when allowed, and writes the
 * audit record either way — there is no supported apply-without-audit
 * path.
 *
 * Issue #2357 (#1976 step 4b, ADR 0022 D-I step 4): persistence
 * sits behind the adaptation audit port (src/data/
 * adaptationAuditPorts.ts; DO adapter in
 * doSqliteAdaptationAuditAdapter.ts, composed by
 * createStrategyClusterPorts.ts) and the budget/kill-switch
 * settings READS sit behind the step-3a read-only settings port
 * (settingsReadPorts.ts, gate G-7 — reads only; no writer is
 * rewired). The budget policy and the applyAdaptation seam stay
 * here, unchanged.
 */

import { DoSqliteAdaptationAuditStore } from "../data/doSqliteAdaptationAuditAdapter";
import { DoSqliteSettingsReadAdapter } from "../data/doSqliteOrmAdapters";
import { DEFAULT_ADAPTATION_BUDGET } from "../data/adaptationAuditPorts";
import type {
  AdaptationAuditSqlExecutor,
  AdaptationAuditStore,
  AdaptationBudget,
  AdaptationRecord,
} from "../data/adaptationAuditPorts";
import type { SettingsReadPort } from "../data/settingsReadPorts";
import type { SqlStorage } from "../data/repositoryPorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/adaptationAudit",
});

export { DEFAULT_ADAPTATION_BUDGET };
export type {
  AdaptationAuditRow,
  AdaptationBudget,
  AdaptationRecord,
} from "../data/adaptationAuditPorts";

const SETTING_KEYS = {
  maxPerPeriod: "adaptation.maxPerPeriod",
  periodDays: "adaptation.periodDays",
  maxCumulativeDrift: "adaptation.maxCumulativeDrift",
} as const;

function auditStore(sql: AdaptationAuditSqlExecutor): AdaptationAuditStore {
  return new DoSqliteAdaptationAuditStore(sql);
}

function settingsRead(sql: AdaptationAuditSqlExecutor): SettingsReadPort {
  return new DoSqliteSettingsReadAdapter(sql as SqlStorage);
}

export function ensureAdaptationAuditTable(sql: any): void {
  auditStore(sql).ensureTable();
}

/**
 * Budget configuration: mas_settings overrides over code defaults.
 * Settings are a tuning convenience, never a failure mode — any read
 * problem falls back to the defaults.
 */
export function getAdaptationBudget(sql: any): AdaptationBudget {
  const budget = { ...DEFAULT_ADAPTATION_BUDGET };
  try {
    const read = settingsRead(sql);
    for (const field of Object.keys(SETTING_KEYS) as Array<keyof AdaptationBudget>) {
      const value = read.get(SETTING_KEYS[field]);
      if (value !== null) {
        const v = Number(value);
        if (Number.isFinite(v) && v > 0) budget[field] = v;
      }
    }
  } catch {
    /* defaults stand */
  }
  return budget;
}

/** Append an applied adaptation to the audit trail. */
export function recordAdaptation(sql: any, rec: AdaptationRecord, now: Date = new Date()): string {
  return auditStore(sql).insert(rec, "applied", null, now);
}

/** Append a blocked attempt to the audit trail (audited, never counted). */
export function recordBlockedAdaptation(
  sql: any,
  rec: AdaptationRecord,
  blockReason: string,
  now: Date = new Date()
): string {
  return auditStore(sql).insert(rec, "blocked", blockReason, now);
}

/** Full audit history for a subject (or all subjects), newest first. */
export function listAdaptationAudit(
  sql: any,
  subject?: string,
  limit = 100
): import("../data/adaptationAuditPorts").AdaptationAuditRow[] {
  return auditStore(sql).list(subject, limit);
}

/** Applied-adaptation usage for a subject inside the budget window. */
export function adaptationUsage(
  sql: any,
  subject: string,
  now: Date = new Date(),
  budget: AdaptationBudget = getAdaptationBudget(sql)
): { count: number; cumulativeDrift: number } {
  const since = new Date(now.getTime() - budget.periodDays * 86_400_000).toISOString();
  const rows = listAdaptationAudit(sql, subject, 500).filter(
    (r) => r.status === "applied" && r.createdAt >= since
  );
  return {
    count: rows.length,
    cumulativeDrift: rows.reduce((sum, r) => sum + Math.abs(r.delta ?? 0), 0),
  };
}

/** mas_settings key for the global adaptation kill switch (#756). */
export const ADAPTATION_KILL_SWITCH_KEY = "adaptation.killSwitch";

/**
 * Issue #756's switch, read by every adaptation entry point: when
 * `adaptation.killSwitch` is "on" (also "1"/"true"), all autonomous
 * adaptation halts. Fail-closed with a log: if the settings read itself
 * fails, adaptation halts rather than proceeding unverified — a safety
 * switch that cannot be read is treated as thrown, never silently
 * ignored.
 */
export function isAdaptationHalted(sql: any): boolean {
  try {
    const value = settingsRead(sql).get(ADAPTATION_KILL_SWITCH_KEY);
    if (value === null) return false;
    const v = String(value).trim().toLowerCase();
    return v === "on" || v === "1" || v === "true";
  } catch (err) {
    structuredLog.error("adaptation.kill_switch_read_failed", {
      message: "[Adaptation] Kill-switch read failed; halting adaptation (fail-closed)",
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

export interface BudgetVerdict {
  allowed: boolean;
  reason?: string;
  usage: { count: number; cumulativeDrift: number };
  budget: AdaptationBudget;
}

/** Enforce per-period count and cumulative-drift budgets for a subject. */
export function evaluateAdaptationBudget(
  sql: any,
  subject: string,
  proposedDelta: number | null,
  now: Date = new Date()
): BudgetVerdict {
  const budget = getAdaptationBudget(sql);
  const usage = adaptationUsage(sql, subject, now, budget);
  if (usage.count >= budget.maxPerPeriod) {
    return {
      allowed: false,
      reason:
        `per-period adaptation count exhausted for ${subject}: ` +
        `${usage.count}/${budget.maxPerPeriod} in ${budget.periodDays}d`,
      usage,
      budget,
    };
  }
  const driftAfter = usage.cumulativeDrift + Math.abs(proposedDelta ?? 0);
  if (driftAfter > budget.maxCumulativeDrift) {
    return {
      allowed: false,
      reason:
        `cumulative drift cap would be exceeded for ${subject}: ` +
        `${usage.cumulativeDrift.toFixed(3)} + ${Math.abs(proposedDelta ?? 0).toFixed(3)} > ${budget.maxCumulativeDrift} in ${budget.periodDays}d`,
      usage,
      budget,
    };
  }
  return { allowed: true, usage, budget };
}

/**
 * The enforcement seam every adapter goes through: evaluate the budget;
 * when blocked, audit the attempt and do not apply; when allowed, run
 * `apply` exactly once and audit the applied record. If `apply` throws,
 * nothing is audited as applied — the caller sees the throw.
 */
export function applyAdaptation(
  sql: any,
  rec: AdaptationRecord,
  apply: () => void,
  now: Date = new Date(),
  opts: { enforceBudgets?: boolean } = {}
): { applied: boolean; reason?: string } {
  // Budgets bound AUTONOMOUS adaptation (the #754 self-service loop).
  // Human-gated staged promotions (#760) pass enforceBudgets: false —
  // their bound is the #759 gate + stages + automatic rollback — but
  // they are still audited here, and the kill switch is still
  // enforced by the caller before the seam is reached. Default true:
  // every pre-#760 caller keeps the original enforcement.
  if (opts.enforceBudgets !== false) {
    const verdict = evaluateAdaptationBudget(sql, rec.subject, rec.delta, now);
    if (!verdict.allowed) {
      recordBlockedAdaptation(sql, rec, verdict.reason!, now);
      structuredLog.error("adaptation.blocked", {
        message: `[Adaptation] Blocked adaptation for ${rec.subject}: ${verdict.reason}`,
        subject: rec.subject,
        reason: verdict.reason,
      });
      return { applied: false, reason: verdict.reason };
    }
  }
  apply();
  recordAdaptation(sql, rec, now);
  return { applied: true };
}
