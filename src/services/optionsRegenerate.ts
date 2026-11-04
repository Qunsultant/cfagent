/**
 * Issue #2603 (options programme slice 6) — regenerate an options run.
 *
 * What regenerate IS: a NEW run of the SAME request, rebuilt from the
 * stored run record. It never overwrites the original — the new run is
 * recorded under its own generation id by the unified path, and the
 * original canonical row is left exactly as stored.
 *
 * What regenerate does when the stored record is incomplete: it REFUSES
 * with the missing field names. It never guesses a symbol, a thesis or a
 * strategy scope from a neighbouring run — a regenerated report that
 * silently differs from the original request is worse than a refusal.
 *
 * What it does NOT do: it does not re-select strategies, re-filter by
 * thesis, change report content or delivery (slice 4 / 6d own those);
 * and it does not read the request from the client — only the stored
 * record names what to re-run.
 */

/** Aliases of the stored fields this rebuild reads, in the order they matter. */
export const REGENERATE_REQUIRED_FIELDS = ["symbol or symbols"] as const;

/** The unified actions a regenerate may re-run (the read-only report actions). */
const REGENERATE_ACTIONS = new Set([
  "screen",
  "strategies",
  "best_trade",
  "opportunities",
  "compare",
]);

export interface OptionsRegeneratePlan {
  ok: true;
  /** The request to execute — the same request the original run made. */
  request: Record<string, unknown>;
  /** The stored row this regenerate came from (provenance; never overwritten). */
  regeneratedFrom: string;
}

export interface OptionsRegenerateRefusal {
  ok: false;
  /** The stored fields a re-run needs that the record does not carry. */
  missing: string[];
  /** A business-readable sentence naming what is missing. */
  reason: string;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function strArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value.filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  return out.length > 0 ? out : undefined;
}

/**
 * Rebuild the original request from a stored canonical options body.
 * Pure: no clock, no provider, no store — `nowIso` is passed in so the
 * provenance stamp is testable.
 */
export function rebuildOptionsRegenerateRequest(input: {
  /** The stored canonical row id (the original run — never written to). */
  reportId: string;
  /** The stored canonical body (parsed). */
  body: unknown;
  /** The owner the row belongs to. */
  userLogin: string;
  /** Stamp for the provenance field. */
  nowIso: string;
}): OptionsRegeneratePlan | OptionsRegenerateRefusal {
  const body =
    input.body && typeof input.body === "object" && !Array.isArray(input.body)
      ? (input.body as Record<string, unknown>)
      : null;
  if (!body) {
    return {
      ok: false,
      missing: ["stored run body"],
      reason:
        "This run's stored record is unreadable, so there is nothing to re-run. Start a new screen instead.",
    };
  }
  const symbols = strArray(body.symbols);
  const symbol = str(body.symbol);
  if (!symbols && !symbol) {
    return {
      ok: false,
      missing: [...REGENERATE_REQUIRED_FIELDS],
      reason:
        "This run's stored record names no symbol, so it cannot be re-run as the same request. Start a new screen instead.",
    };
  }

  const action = str(body.action);
  const request: Record<string, unknown> = {
    action: action && REGENERATE_ACTIONS.has(action) ? action : "opportunities",
    ...(symbol ? { symbol } : {}),
    ...(symbols ? { symbols } : {}),
    // Strategy scope is re-run as recorded; the deterministic default
    // (thesis) applies only when the record carries none.
    strategyMode: str(body.strategyMode) ?? "thesis",
    ...(str(body.thesis) ? { thesis: str(body.thesis) } : {}),
    ...(str(body.targetDate) ? { targetDate: str(body.targetDate) } : {}),
    ...(str(body.riskProfile) ? { riskProfile: str(body.riskProfile) } : {}),
    ...(strArray(body.allowedStrategiesResolved)
      ? { allowedStrategies: strArray(body.allowedStrategiesResolved) }
      : strArray(body.allowedStrategies)
        ? { allowedStrategies: strArray(body.allowedStrategies) }
        : {}),
    ...(typeof body.farDated === "boolean" ? { farDated: body.farDated } : {}),
    ...(num(body.candidateLimit) !== undefined ? { limit: num(body.candidateLimit) } : {}),
    ...(num(body.maxPlannedLoss) !== undefined ? { maxPlannedLoss: num(body.maxPlannedLoss) } : {}),
    ...(num(body.minRewardRisk) !== undefined ? { minRewardRisk: num(body.minRewardRisk) } : {}),
    // Provenance: the new run says which stored run it came from, so the
    // two are distinguishable on the record (the original is untouched).
    regeneratedFrom: input.reportId,
    regeneratedAt: input.nowIso,
    regeneratedBy: input.userLogin,
  };

  return { ok: true, request, regeneratedFrom: input.reportId };
}
