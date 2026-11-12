/**
 * Issue #4262 (S1) — the one run ledger's kind classifier.
 *
 * Pure by construction: a recorded run in, a kind out. No store, no fetch,
 * no clock — the same shape as `consolidatedScheduling.ts`, so the client,
 * the tests and any future server read all classify identically.
 *
 * The rule table and the filter vocabulary live in `src/config/runLedgerModes.ts`
 * (configuration); this module only applies them.
 */
import {
  RUN_LEDGER_ALL_FILTER,
  RUN_LEDGER_KIND_RULES,
  type RunLedgerFilter,
  type RunLedgerKind,
  type RunLedgerKindRule,
} from "../config/runLedgerModes";

/** The fields classification reads — never the whole record. */
export interface RunKindCandidate {
  operation?: string | null;
  system?: string | null;
  jobId?: string | null;
}

function matches(rule: RunLedgerKindRule, run: RunKindCandidate): boolean {
  const operation = typeof run.operation === "string" ? run.operation.trim().toLowerCase() : "";
  const system = typeof run.system === "string" ? run.system.trim().toLowerCase() : "";
  if (rule.systems?.some((s) => s.toLowerCase() === system)) return true;
  if (!operation) return false;
  if (rule.operationEquals?.includes(operation)) return true;
  return Boolean(rule.operationPrefixes?.some((prefix) => operation.startsWith(prefix.toLowerCase())));
}

/**
 * Classify one run. The first matching rule wins; nothing matches → "other"
 * (a run is never dropped and never guessed into a family).
 */
export function classifyRunKind(
  run: RunKindCandidate,
  rules: readonly RunLedgerKindRule[] = RUN_LEDGER_KIND_RULES,
): RunLedgerKind {
  for (const rule of rules) {
    if (matches(rule, run)) return rule.kind;
  }
  return "other";
}

/** Count runs per kind, for the filter buttons' badges. */
export function countRunsByKind<T extends RunKindCandidate>(
  runs: readonly T[],
  rules: readonly RunLedgerKindRule[] = RUN_LEDGER_KIND_RULES,
): Record<RunLedgerKind, number> {
  const counts = {
    stock: 0,
    strategy: 0,
    options: 0,
    goal: 0,
    reports: 0,
    workflow: 0,
    pipeline: 0,
    ops: 0,
    other: 0,
  } as Record<RunLedgerKind, number>;
  for (const run of runs) counts[classifyRunKind(run, rules)] += 1;
  return counts;
}

/**
 * Apply one filter. "all" returns the input unchanged (the same rows, not a
 * copy), so "All shows everything" is true by construction.
 */
export function filterRunsByKind<T extends RunKindCandidate>(
  runs: readonly T[],
  filter: RunLedgerFilter,
  rules: readonly RunLedgerKindRule[] = RUN_LEDGER_KIND_RULES,
): T[] {
  if (filter === RUN_LEDGER_ALL_FILTER) return runs.slice();
  return runs.filter((run) => classifyRunKind(run, rules) === filter);
}
