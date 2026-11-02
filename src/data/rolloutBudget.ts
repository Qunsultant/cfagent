/**
 * Issue #2753 (Platform Phase 7, program #2468) — resource budget.
 *
 * The resource budget for the mainnet gate (program amendment: a
 * resource budget + risk register at the mainnet gate) as pure
 * derivation. Budgets are operator-settable data; actuals are
 * caller-supplied measurements (e.g. the #1819 rows-read lens).
 * This module performs no measurement itself and sets no budget:
 * an empty budget or an empty actual is UNEVALUATED, never "within"
 * by default — an unevaluated budget must not read as headroom.
 *
 * Metric names follow the amendment's resource lens (rows read per
 * day; cost per run). Additional metrics can be added as fields
 * without changing the evaluation rule: null ⇒ unevaluated, else a
 * numeric comparison (actual <= budget ⇒ within, else over).
 * Negative inputs are caller error, documented not specially
 * handled: they flow through the comparison.
 * Pure derivation — zero reads, zero writes, zero activation.
 */

export type BudgetVerdict = "within" | "over" | "unevaluated";

/** One metric: null budget or null actual is unevaluated, never within. */
export function evaluateBudget(
  budget: number | null | undefined,
  actual: number | null | undefined,
): BudgetVerdict {
  if (budget === null || budget === undefined || actual === null || actual === undefined) {
    return "unevaluated";
  }
  return actual <= budget ? "within" : "over";
}

export interface ProductBudgetRecord {
  product: string;
  budget: {
    rowsReadPerDay: number | null;
    costPerRun: number | null;
  };
  actual: {
    rowsReadPerDay: number | null;
    costPerRun: number | null;
  };
}

export interface ProductBudgetResult {
  rowsReadPerDay: BudgetVerdict;
  costPerRun: BudgetVerdict;
}

/** Per-metric verdicts for one product's budget record. */
export function evaluateProductBudget(
  record: ProductBudgetRecord,
): ProductBudgetResult {
  return {
    rowsReadPerDay: evaluateBudget(record.budget.rowsReadPerDay, record.actual.rowsReadPerDay),
    costPerRun: evaluateBudget(record.budget.costPerRun, record.actual.costPerRun),
  };
}
