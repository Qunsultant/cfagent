/**
 * Issue #3075 (S5 under #3069) - one advice pass per stage.
 *
 * The repo already lists its aspect join points (screenRunAspects,
 * SCREEN_RUN_ASPECTS) and classifies failures once (classifyScreenFailure).
 * What was missing at the stage level is the single place a stage's
 * execution is *wrapped*: timings, outcome, and the coded verdict, applied
 * identically to every stage, so a stage cannot log one way, fail another,
 * and be counted a third.
 *
 * AOP here is composition, not a framework (the repo's idiom): the stage
 * hands its body to withStageAdvice and gets a verdict back. The advice
 * never changes the body's result or swallows its error - it records, then
 * rethrows. Nothing about a run's behaviour depends on the advice.
 */
import { formatStageMessage, type StageMessageCode } from "./stageConfig";

export type StageAdviceOutcome = "ok" | "failed";

export interface StageAdviceEvent {
  readonly stageId: string;
  readonly outcome: StageAdviceOutcome;
  readonly durationMs: number;
  /** Present on failed: the catalogued code describing how it failed. */
  readonly code?: StageMessageCode;
  /** Present on failed: the thrown error's message, narrowed to one line. */
  readonly detail?: string;
}

export interface StageAdviceOptions<T> {
  readonly stageId: string;
  /** Injected so the advice is testable and never reaches for a global logger. */
  readonly log?: (event: StageAdviceEvent) => void;
  readonly now?: () => number;
  /** Maps a thrown error to a code; defaults to the generic persisted-input verdict. */
  readonly classify?: (error: unknown) => StageMessageCode;
  readonly run: () => Promise<T>;
}

/**
 * Run one stage body under the advice pass. Returns the body's result
 * unchanged; on failure emits the coded event, then rethrows the original
 * error so the platform's retry/DLQ behaviour is exactly as before.
 */
export async function withStageAdvice<T>(options: StageAdviceOptions<T>): Promise<T> {
  const now = options.now ?? (() => Date.now());
  const started = now();
  try {
    const result = await options.run();
    options.log?.({ stageId: options.stageId, outcome: "ok", durationMs: now() - started });
    return result;
  } catch (error) {
    const code = (options.classify ?? (() => "STAGE_PERSISTED_MISSING" as const))(error);
    const detail = error instanceof Error ? error.message : String(error);
    options.log?.({
      stageId: options.stageId,
      outcome: "failed",
      durationMs: now() - started,
      code,
      detail,
    });
    throw error;
  }
}

/** One line an operator can paste into an incident, derived from the event. */
export function describeStageAdvice(event: StageAdviceEvent): string {
  const head = `stage ${event.stageId} ${event.outcome} in ${event.durationMs}ms`;
  if (event.outcome === "ok") return head;
  const coded = event.code ? formatStageMessage(event.code, event.detail) : (event.detail ?? "no detail");
  return `${head} - ${coded}`;
}
