/**
 * Issue #2530 — the non-deterministic screener mode's
 * crossing contract (design option (a), recorded on #2530):
 * the prompt's output is a DATA artifact of screen criteria,
 * and this module is the deterministic gate it must cross
 * before the deterministic pipeline executes anything.
 *
 * Contents:
 *  - ScreenIntentInterpreter: the interpretation PORT the
 *    parent flow depends on (fakeable; the production
 *    implementation over the #1741 gateway port lives in
 *    screenIntentInterpreter.ts). It returns UNKNOWN — the
 *    raw model output. Nothing it returns is trusted.
 *  - validateScreenCriteriaArtifact: the deterministic
 *    validator. Fail-closed, total, and pure: same artifact
 *    in → same verdict out, which is what keeps workflow
 *    replay deterministic (the artifact itself is journaled
 *    by the interpretation step; validation re-runs over the
 *    journaled value).
 *  - ScreenInterpretationAuditRecord: the mas_events record
 *    shape (prompt + artifact + verdict), written through
 *    the orchestrator's workflow-door audit method before
 *    any shard executes.
 *
 * The validator reuses the EXISTING screen contract
 * (parseStockScreenerFilter, the strict zod schema the
 * routes validate with): unknown filter keys refuse, so the
 * model cannot invent filter vocabulary, and no parallel
 * criteria contract is introduced.
 */
import { parseStockScreenerFilter } from "../trading";
import type { StockScreenerFilter } from "../types";

/** The interpretation step's input (the run's own scope — the artifact can never widen it). */
export interface ScreenIntentInterpretationInput {
  /** The run's free-form screening intent (the command's screenIntent). */
  intent: string;
  /** The command's structured filters, when the caller supplied any (the artifact refines them per field). */
  baseFilters?: Record<string, unknown>;
  /** The run's shard universes (fixed by the caller; interpretation cannot change them). */
  shardUniverses: string[];
}

/**
 * The interpretation port. Implementations call a model and
 * return its raw output as unknown. A THROW is an
 * infrastructure failure (the workflow step retries, then
 * the run errors); a returned value — however malformed —
 * is the validator's business, never the caller's.
 */
export interface ScreenIntentInterpreter {
  interpret(input: ScreenIntentInterpretationInput): Promise<unknown>;
}

/** The mas_events record for one ND run's interpretation (prompt + output + verdict). */
export interface ScreenInterpretationAuditRecord {
  jobId: string;
  userLogin: string;
  /** The prompt (the run's screenIntent, as supplied). */
  intent: string;
  /** The raw artifact the interpreter produced (data; recorded verbatim for audit). */
  artifact: unknown;
  /** The deterministic validator's verdict. */
  validation: { ok: boolean; reasons?: string[] };
  /** The filters the run will execute, when validation passed (base merged with artifact). */
  effectiveFilters?: Record<string, unknown>;
}

/** The validator's verdict: validated filters, or the refusal reasons. */
export type ScreenCriteriaVerdict =
  | { ok: true; filters: StockScreenerFilter; rationale?: string }
  | { ok: false; reasons: string[] };

/** Max chars of artifact rationale (audit/read-back data; never executed). */
export const MAX_SCREEN_RATIONALE_CHARS = 500;

/** Paired bound fields the schema admits independently; coherence is the validator's rule. */
const PAIRED_BOUNDS: Array<[string, string]> = [
  ["minPrice", "maxPrice"],
  ["minRsi", "maxRsi"],
  ["minPercentB", "maxPercentB"],
  ["minAtrPct", "maxAtrPct"],
];

function kindOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

/**
 * Validate one raw interpretation artifact. Rules, in order:
 *  1. The artifact must be a plain object — criteria are
 *     DATA; strings/arrays/code-shaped payloads refuse.
 *  2. `filters` must be present as an object and must pass
 *     the existing stock screener filter contract
 *     (parseStockScreenerFilter — strict: unknown keys
 *     refuse).
 *  3. Paired bounds must be coherent (a min may not exceed
 *     its max).
 *  4. `rationale`, when present, must be a string within
 *     the cap.
 * Every applicable reason is collected (the audit record
 * carries them all), never just the first.
 */
export function validateScreenCriteriaArtifact(raw: unknown): ScreenCriteriaVerdict {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      reasons: [
        `interpreted artifact must be an object carrying screen criteria (data only), got ${kindOf(raw)}`,
      ],
    };
  }
  const artifact = raw as Record<string, unknown>;
  const reasons: string[] = [];

  let filters: StockScreenerFilter | undefined;
  const rawFilters = artifact.filters;
  if (!rawFilters || typeof rawFilters !== "object" || Array.isArray(rawFilters)) {
    reasons.push("artifact.filters must be an object of stock screener filter criteria");
  } else {
    const parsed = parseStockScreenerFilter(rawFilters);
    if (!parsed.ok) {
      reasons.push(`artifact.filters failed the stock screener filter contract: ${parsed.error}`);
    } else {
      filters = parsed.value;
      const f = rawFilters as Record<string, unknown>;
      for (const [minKey, maxKey] of PAIRED_BOUNDS) {
        const min = f[minKey];
        const max = f[maxKey];
        if (typeof min === "number" && typeof max === "number" && min > max) {
          reasons.push(`${minKey} (${min}) exceeds ${maxKey} (${max})`);
        }
      }
    }
  }

  let rationale: string | undefined;
  if (artifact.rationale !== undefined) {
    if (typeof artifact.rationale !== "string") {
      reasons.push("artifact.rationale must be a string when present (it is audit data, never executed)");
    } else if (artifact.rationale.length > MAX_SCREEN_RATIONALE_CHARS) {
      reasons.push(
        `artifact.rationale exceeds the ${MAX_SCREEN_RATIONALE_CHARS}-character cap (${artifact.rationale.length} chars)`,
      );
    } else {
      rationale = artifact.rationale;
    }
  }

  if (reasons.length > 0 || !filters) return { ok: false, reasons };
  return { ok: true, filters, ...(rationale !== undefined ? { rationale } : {}) };
}
