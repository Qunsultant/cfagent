/**
 * Issue #4202 — the chat await budget, in one place.
 *
 * Why this exists: Durable Object duration bills wall-clock time while an
 * object is running or resident and unable to hibernate (the #4202 finding).
 * A chat screen or payment run used to be awaited *inside* the
 * OrchestratorAgent request for up to fifteen minutes — a 2s poll loop, twice
 * over, because the mesh door and the NLQ port each carried their own copy of
 * the same 15-minute literal. A pending request is a resident object, so that
 * window was billed per run, and it dwarfed every other resident source.
 *
 * The rule now: one budget, shared, capped at two minutes, configurable
 * downward only. An operator can make the chat give up sooner; nothing can put
 * the long window back. Longer runs are not lost — the await returns the
 * existing honest "still running" result with the run link, and the run itself
 * continues on its workflow.
 *
 * Choosing the cap: two minutes covers a fast screen end to end. Runs slower
 * than that were already returning the "did not complete within the chat await
 * window" result on the old 15-minute path whenever the workflow outlived it,
 * so the change shortens residency without changing the shape of the result.
 */
export interface ChatAwaitBudgetEnv {
  /**
   * Operator lever, milliseconds. Absent → {@link DEFAULT_CHAT_AWAIT_DEADLINE_MS}.
   * Values below the floor resolve to the floor and values above the ceiling to
   * the ceiling: this knob can only ever shorten the wait.
   */
  CHAT_AWAIT_BUDGET_MS?: unknown;
}

/** Wrangler var name for the operator lever (see {@link ChatAwaitBudgetEnv}). */
export const CHAT_AWAIT_BUDGET_ENV_KEY = "CHAT_AWAIT_BUDGET_MS" as const;

/**
 * How long a chat turn may wait on a workflow before answering "still running".
 * Two minutes: the ceiling, not a starting point.
 */
export const DEFAULT_CHAT_AWAIT_DEADLINE_MS = 120_000;

/** Hard ceiling. Equal to the default by construction — see the module note. */
export const MAX_CHAT_AWAIT_DEADLINE_MS = DEFAULT_CHAT_AWAIT_DEADLINE_MS;

/** Floor, so a typo cannot turn the await into "never wait at all". */
export const MIN_CHAT_AWAIT_DEADLINE_MS = 5_000;

/**
 * Poll cadence for the await loops. Unchanged from the window this replaces —
 * #4202 moves the budget, not the cadence.
 */
export const CHAT_AWAIT_POLL_INTERVAL_MS = 2_000;

/**
 * Resolve the chat await budget (ms) from the operator override.
 *
 * Deliberately total: every input — unset, empty, non-numeric, non-finite,
 * negative, absurdly large — resolves to a value in
 * [{@link MIN_CHAT_AWAIT_DEADLINE_MS}, {@link MAX_CHAT_AWAIT_DEADLINE_MS}], so
 * the loop's bound never depends on a caller remembering to pass one.
 */
export function resolveChatAwaitDeadlineMs(
  env?: ChatAwaitBudgetEnv | null,
): number {
  const raw = env?.[CHAT_AWAIT_BUDGET_ENV_KEY];
  // An empty or whitespace-only value means "unset", not zero: Number("") is 0,
  // and reading a blank var as "wait 0ms" would turn every chat screen into an
  // instant "still running" answer.
  if (typeof raw === "string" && raw.trim() === "") return DEFAULT_CHAT_AWAIT_DEADLINE_MS;
  const value =
    typeof raw === "number" ? raw : raw == null ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_CHAT_AWAIT_DEADLINE_MS;
  return Math.min(MAX_CHAT_AWAIT_DEADLINE_MS, Math.max(MIN_CHAT_AWAIT_DEADLINE_MS, value));
}
