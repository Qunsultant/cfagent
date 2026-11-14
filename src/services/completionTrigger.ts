/**
 * Issue #4425 (ONC RCA N11) — completion-triggered scheduling.
 *
 * A schedule could only fire on cron/interval or by hand: there was no binding
 * anywhere that said "when job X (or stage S) completes in state Z, run job Y
 * (or its stage T)". The RCA's gap was precise — `createJobPipelineEventsHandler`
 * existed but was never instantiated, so even the completion *record* never
 * reached the host.
 *
 * The binding lives on the TARGET job's own raw config, under
 * `completionTrigger`. That is the engine's existing configuration store
 * (`defineJob`/`configureJob` persist rawConfig), so a binding is durable and
 * settable through the same path every other job setting uses — no second
 * table, and no parallel schedule model (the one-solution rule).
 *
 * Everything in this module is deterministic and pure: parse, then match. The
 * dispatch (which job to run, and whether to scope it to a stage) happens on
 * the host, in scheduledTasksCompletion.ts.
 */
function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}

/** The raw-config key a target job carries its binding under. */
export const COMPLETION_TRIGGER_KEY = "completionTrigger";

/** The completion states a binding may name. "any" fires on every terminal state. */
export const COMPLETION_TRIGGER_STATES = ["completed", "failed", "cancelled", "any"] as const;
export type CompletionTriggerState = (typeof COMPLETION_TRIGGER_STATES)[number];

/** A parsed, valid binding: source identity + the state to fire on + target scope. */
export interface CompletionTriggerBinding {
  /** The source job to watch; null when the binding is stage-scoped only. */
  sourceJobId: string | null;
  /** The source stage to watch; null when the binding is job-scoped. */
  sourceStage: string | null;
  /** The terminal state that fires the target; "any" fires on all of them. */
  state: CompletionTriggerState;
  /** The target's node path (a sub-tree), when the binding names one. */
  targetStage: string | null;
}

/** One terminal event, as the consumer sees it. */
export interface CompletionEvent {
  jobId: string;
  runId?: string | null;
  /** completed | failed | cancelled — the event's terminal verb. */
  state: string;
  /** The stage that ended, when the event is stage-scoped; null/absent otherwise. */
  stage?: string | null;
}

export interface ParsedCompletionTrigger {
  binding: CompletionTriggerBinding | null;
  /** Why a present binding was rejected. Null with a null binding = not configured. */
  error: string | null;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Parse the binding off a target job's raw config. A malformed binding is
 * REPORTED (error), never silently ignored: a schedule that looks chained and
 * never fires is exactly the silent failure this issue exists to end.
 */
export function parseCompletionTrigger(rawConfig: unknown): ParsedCompletionTrigger {
  const config = asObject(rawConfig);
  const raw = config?.[COMPLETION_TRIGGER_KEY];
  if (raw === undefined || raw === null) return { binding: null, error: null };
  const trigger = asObject(raw);
  if (!trigger) {
    return { binding: null, error: `${COMPLETION_TRIGGER_KEY} must be an object.` };
  }
  const source = asObject(trigger.source) ?? {};
  const sourceJobId = nonEmpty(source.jobId);
  const sourceStage = nonEmpty(source.stage);
  if (!sourceJobId && !sourceStage) {
    return {
      binding: null,
      error: `${COMPLETION_TRIGGER_KEY}.source must name a jobId, a stage, or both.`,
    };
  }
  // Default "completed": a binding that exists but names no state means the
  // success case, which is the chain the owner asked for. Documented, not a
  // silent guess at something else.
  const rawState = trigger.state === undefined || trigger.state === null ? "completed" : trigger.state;
  const state = nonEmpty(rawState);
  if (!state || !COMPLETION_TRIGGER_STATES.includes(state as CompletionTriggerState)) {
    return {
      binding: null,
      error: `${COMPLETION_TRIGGER_KEY}.state must be one of ${COMPLETION_TRIGGER_STATES.join(", ")} (got ${JSON.stringify(rawState)}).`,
    };
  }
  return {
    binding: {
      sourceJobId,
      sourceStage,
      state: state as CompletionTriggerState,
      targetStage: nonEmpty(trigger.targetStage),
    },
    error: null,
  };
}

/**
 * Does one terminal event fire this binding?
 *
 * - the state must match, unless the binding says "any";
 * - a named source job must be the event's job;
 * - a named source stage must be the event's stage. A job-level event carries
 *   no stage, so a stage-scoped binding does NOT fire from it — matching a
 *   stage we cannot see would be a guess (the honest-empty rule).
 */
export function completionMatchesTrigger(
  binding: CompletionTriggerBinding,
  event: CompletionEvent,
): boolean {
  if (binding.state !== "any" && binding.state !== event.state) return false;
  if (binding.sourceJobId && binding.sourceJobId !== event.jobId) return false;
  if (binding.sourceStage) {
    const stage = str(event.stage ?? null);
    if (!stage || stage !== binding.sourceStage) return false;
  }
  return true;
}
