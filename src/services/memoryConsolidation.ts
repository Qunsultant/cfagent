/**
 * Issue #5060 (AG-6) — memory consolidation between `mas_memory`,
 * `mas_learnings`, and VectorMemory.
 *
 * Three memories exist side by side: key-value session facts (`mas_memory`,
 * the OrchestratorAgent's DO), learnings (`mas_learnings`, reflection and
 * human corrections), and vector outcomes (Vectorize `vector-memory`). Each
 * was written and read independently, so a fact learned in chat never became
 * a learning and a learning never became a vector chunk.
 *
 * This module is the bridge, with the source of truth stated once:
 *
 *  - **`mas_memory` owns session facts.** Most of it is short-lived context
 *    and is deliberately NOT promoted — promotion is not "copy everything".
 *  - **A durable fact becomes a learning** when its key carries an explicit
 *    durable prefix (`preference:` / `fact:`, configurable) and the fact has
 *    been stable for `minAgeHours` — a fact the user just typed is not yet a
 *    belief. `mas_learnings` is the source of truth for behavioral claims,
 *    and it already has readers (screener, reflection, proposal drafting).
 *  - **A promoted learning is embedded into VectorMemory** so recall can find
 *    it by meaning. Vector memory stays a recall index, never a source of
 *    truth: a vector row without its learning is a stale copy, not evidence.
 *
 * Everything is externalized (AOP): the prefixes, the age floor, the scan
 * bound, the vectorization switch, and a kill switch. The run is idempotent
 * (a fact already promoted is skipped by its `mas_memory:<key>` evidence
 * ref), daily-guarded by a meta learning, and best-effort — a consolidation
 * failure never fails the turn that triggered it.
 */
import type { Env } from "../types";
import { getActiveLearnings, recordLearning } from "./learnings";

/** Domain promoted facts live in. */
export const MEMORY_CONSOLIDATION_DOMAIN = "memory";
/** Domain of the daily-guard marker. */
export const MEMORY_CONSOLIDATION_META_DOMAIN = "memory_consolidation_meta";

export interface MemoryConsolidationPolicy {
  enabled: boolean;
  /** Key prefixes that mark a fact as durable. */
  factPrefixes: readonly string[];
  /** A fact must be at least this old (unchanged) to be promoted. */
  minAgeHours: number;
  /** How many recent facts one run examines. */
  scanLimit: number;
  /** Embed promoted learnings into VectorMemory. */
  vectorize: boolean;
  /** Minimum gap between runs, in hours. */
  intervalHours: number;
}

/** The durable prefixes the promotion rule recognises by default. */
export const MEMORY_CONSOLIDATION_DEFAULT_FACT_PREFIXES = [
  "preference:",
  "fact:",
] as const;

export const MEMORY_CONSOLIDATION_DEFAULTS: MemoryConsolidationPolicy = {
  enabled: true,
  factPrefixes: MEMORY_CONSOLIDATION_DEFAULT_FACT_PREFIXES,
  minAgeHours: 24,
  scanLimit: 50,
  vectorize: true,
  intervalHours: 24,
};

export const MEMORY_CONSOLIDATION_ENV = {
  enabled: "MEMORY_CONSOLIDATION_ENABLED",
  factPrefixes: "MEMORY_CONSOLIDATION_FACT_PREFIXES",
  minAgeHours: "MEMORY_CONSOLIDATION_MIN_AGE_HOURS",
  scanLimit: "MEMORY_CONSOLIDATION_SCAN_LIMIT",
  vectorize: "MEMORY_CONSOLIDATION_VECTORIZE",
  intervalHours: "MEMORY_CONSOLIDATION_INTERVAL_HOURS",
} as const;

function resolvePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  return fallback;
}

function resolveBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return true;
  if (normalized === "false" || normalized === "0") return false;
  return fallback;
}

function resolvePrefixes(raw: string | undefined, fallback: readonly string[]): readonly string[] {
  if (raw === undefined) return fallback;
  const parsed = raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  return parsed.length > 0 ? parsed : fallback;
}

/** Resolve the consolidation policy from the deployment env (AOP). */
export function resolveMemoryConsolidationPolicy(
  env: Env | undefined | null,
): MemoryConsolidationPolicy {
  return {
    enabled: resolveBool(
      env?.[MEMORY_CONSOLIDATION_ENV.enabled],
      MEMORY_CONSOLIDATION_DEFAULTS.enabled,
    ),
    factPrefixes: resolvePrefixes(
      env?.[MEMORY_CONSOLIDATION_ENV.factPrefixes],
      MEMORY_CONSOLIDATION_DEFAULTS.factPrefixes,
    ),
    minAgeHours: resolvePositiveInt(
      env?.[MEMORY_CONSOLIDATION_ENV.minAgeHours],
      MEMORY_CONSOLIDATION_DEFAULTS.minAgeHours,
    ),
    scanLimit: resolvePositiveInt(
      env?.[MEMORY_CONSOLIDATION_ENV.scanLimit],
      MEMORY_CONSOLIDATION_DEFAULTS.scanLimit,
    ),
    vectorize: resolveBool(
      env?.[MEMORY_CONSOLIDATION_ENV.vectorize],
      MEMORY_CONSOLIDATION_DEFAULTS.vectorize,
    ),
    intervalHours: resolvePositiveInt(
      env?.[MEMORY_CONSOLIDATION_ENV.intervalHours],
      MEMORY_CONSOLIDATION_DEFAULTS.intervalHours,
    ),
  };
}

/**
 * Parse a stored timestamp. SQLite's `CURRENT_TIMESTAMP` is UTC but
 * zone-less (`2026-11-18 16:35:13`); `Date.parse` treats that shape as
 * LOCAL time, which makes a just-written row look hours old (or hours in
 * the future, depending on the offset). Normalise it to UTC first.
 */
function parseStoredTimestamp(value: string): number {
  return Date.parse(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
      ? `${value.replace(" ", "T")}Z`
      : value,
  );
}

/** The fact shape `MemoryPort.listRecent` returns. */
export interface ConsolidationFact {
  key: string;
  value: string;
  updatedAt: string;
}

export interface MemoryConsolidationDeps {
  /** The OrchestratorAgent's `mas_memory` port (or a test double). */
  memory: { listRecent(limit: number): ConsolidationFact[] };
  /** The `mas_learnings` store (the learning writes + dedupe reads). */
  sql: any;
  /** Optional VectorMemory seam: summary → void. */
  vectorRemember?: (summary: string) => Promise<void>;
  now?: () => Date;
}

export interface MemoryConsolidationReport {
  examined: number;
  promoted: number;
  skippedExisting: number;
  skippedYoung: number;
  vectorized: number;
  vectorFailed: number;
  skippedReason?: string;
}

/**
 * Daily guard, mirroring the reflection job's weekly guard: a
 * `memory_consolidation_meta` learning newer than `intervalHours` means this
 * period already ran.
 */
export function shouldConsolidate(
  sql: any,
  policy: MemoryConsolidationPolicy,
  now: Date,
): boolean {
  if (!policy.enabled) return false;
  try {
    const meta = getActiveLearnings(sql, MEMORY_CONSOLIDATION_META_DOMAIN);
    if (meta.length === 0) return true;
    const newest = parseStoredTimestamp(meta[0].createdAt);
    return now.getTime() - newest >= policy.intervalHours * 3_600_000;
  } catch {
    // An unreadable guard store must not block consolidation forever; the
    // dedupe rule keeps a re-run idempotent.
    return true;
  }
}

/**
 * Run one consolidation pass. Idempotent per fact (evidence ref
 * `mas_memory:<key>`), and total: every failure is counted, none is thrown.
 */
export async function consolidateMemory(
  deps: MemoryConsolidationDeps,
  policy: MemoryConsolidationPolicy,
): Promise<MemoryConsolidationReport> {
  const report: MemoryConsolidationReport = {
    examined: 0,
    promoted: 0,
    skippedExisting: 0,
    skippedYoung: 0,
    vectorized: 0,
    vectorFailed: 0,
  };
  if (!policy.enabled) {
    report.skippedReason = "disabled";
    return report;
  }

  const now = (deps.now ?? (() => new Date()))();
  let facts: ConsolidationFact[];
  try {
    facts = deps.memory.listRecent(policy.scanLimit);
  } catch {
    report.skippedReason = "memory_unreadable";
    return report;
  }

  let existing: string[] = [];
  try {
    existing = getActiveLearnings(deps.sql, MEMORY_CONSOLIDATION_DOMAIN).flatMap(
      (l) => l.evidenceRefs,
    );
  } catch {
    // Dedupe reads are best-effort: a re-run may duplicate one row, never
    // silently drop a promotion.
  }

  for (const fact of facts) {
    const durable = policy.factPrefixes.some((prefix) => fact.key.startsWith(prefix));
    if (!durable) continue;
    report.examined += 1;
    const ref = `mas_memory:${fact.key}`;
    if (existing.includes(ref)) {
      report.skippedExisting += 1;
      continue;
    }
    const updatedMs = parseStoredTimestamp(fact.updatedAt);
    if (Number.isFinite(updatedMs) && now.getTime() - updatedMs < policy.minAgeHours * 3_600_000) {
      report.skippedYoung += 1;
      continue;
    }

    const observation = `${fact.key} = ${fact.value}`;
    try {
      recordLearning(deps.sql, {
        domain: MEMORY_CONSOLIDATION_DOMAIN,
        observation,
        evidenceRefs: [ref],
        confidence: 0.7,
        source: "reflection",
      });
      report.promoted += 1;
    } catch {
      continue;
    }

    if (policy.vectorize && deps.vectorRemember) {
      try {
        await deps.vectorRemember(observation);
        report.vectorized += 1;
      } catch {
        report.vectorFailed += 1;
      }
    }
  }

  return report;
}

/**
 * Turn-hook entry point: run the consolidation when the daily guard allows
 * it. One call from the orchestrator — the agent class carries the decision
 * to call, not the policy, guard, report and failure logging.
 * Never throws.
 */
export async function runDailyMemoryConsolidation(params: {
  env: Env | undefined | null;
  sql: any;
  memory: { listRecent(limit: number): ConsolidationFact[] };
  vectorRemember?: (summary: string) => Promise<void>;
  now?: () => Date;
}): Promise<MemoryConsolidationReport | null> {
  const policy = resolveMemoryConsolidationPolicy(params.env);
  const now = (params.now ?? (() => new Date()))();
  if (!shouldConsolidate(params.sql, policy, now)) return null;
  const report = await consolidateMemory(
    {
      memory: params.memory,
      sql: params.sql,
      vectorRemember: params.vectorRemember,
      now: () => now,
    },
    policy,
  );
  recordConsolidationRun(params.sql, report);
  return report;
}

/** Record the run so the daily guard sees it. Best-effort. */
export function recordConsolidationRun(
  sql: any,
  report: MemoryConsolidationReport,
): void {
  try {
    recordLearning(sql, {
      domain: MEMORY_CONSOLIDATION_META_DOMAIN,
      observation:
        `Memory consolidation ran: ${report.examined} durable fact(s) examined, ` +
        `${report.promoted} promoted, ${report.skippedExisting} already promoted, ` +
        `${report.skippedYoung} too young, ${report.vectorized} vectorized` +
        (report.vectorFailed > 0 ? `, ${report.vectorFailed} vector write(s) failed` : "") +
        ".",
      confidence: 1,
      source: "reflection",
    });
  } catch {
    // The guard is an optimisation; the dedupe rule is the correctness gate.
  }
}
