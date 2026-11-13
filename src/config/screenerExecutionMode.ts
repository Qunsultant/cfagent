/**
 * Issue #4363 — the screener family's execution-mode default, externalized.
 *
 * The mode axes live in the engine (`JobExecutionMode`); a family's
 * DEFAULT belongs to configuration, never to a literal inside the job
 * builder. This module is that default, plus its one env knob:
 *
 *   SCREENER_DEFAULT_EXECUTION_MODE   JSON, e.g.
 *     {"concurrency":"sequential","pacing":"batch","delivery":"async","shape":"monolith"}
 *
 * A malformed value refuses by name (fail closed): a run never starts on
 * an invented default. `shape` may be omitted — the builder derives it
 * from the shard count, which is a property of the run, not of the family.
 */
import type { JobExecutionMode } from "../data/jobPipelinePorts";
import { assertExecutionModeSupported, resolveExecutionMode } from "../services/jobPipelineConfig";

export const SCREENER_DEFAULT_EXECUTION_MODE_ENV_VAR = "SCREENER_DEFAULT_EXECUTION_MODE";

/** The built-in family default (what every screener run used before this issue). */
export const SCREENER_DEFAULT_EXECUTION_MODE: JobExecutionMode = {
  concurrency: "sequential",
  pacing: "batch",
  delivery: "async",
  shape: "monolith",
};

export interface ScreenerExecutionModeEnv {
  SCREENER_DEFAULT_EXECUTION_MODE?: string;
}

/**
 * The resolved family default: the built-in values, overridden field by
 * field by the env JSON. A malformed value throws with the variable named.
 */
export function resolveScreenerDefaultExecutionMode(
  env: ScreenerExecutionModeEnv = {},
): JobExecutionMode {
  const raw = env[SCREENER_DEFAULT_EXECUTION_MODE_ENV_VAR];
  if (typeof raw !== "string" || raw.trim() === "") return { ...SCREENER_DEFAULT_EXECUTION_MODE };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${SCREENER_DEFAULT_EXECUTION_MODE_ENV_VAR} is not valid JSON — refusing to run with an invented execution-mode default.`,
    );
  }
  const resolved = resolveExecutionMode(parsed);
  assertExecutionModeSupported(resolved);
  return resolved;
}
