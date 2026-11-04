/**
 * Issue #3075 (S5 under #3069) - coded stage messages + externalized
 * stage config.
 *
 * Why this exists: the stage contract (#2869) already fails loudly, but
 * its failures are prose - `poison message: ...`, `retry budget
 * exhausted: ...`. Prose is fine for a human reading one log line and
 * useless for anything else: it cannot be counted, alerted on, matched
 * to a remediation, or translated. Message codes are the stable handle;
 * the prose becomes the code's rendering, not the identity.
 *
 * This module is deliberately data only (15-factor: config lives in the
 * environment, code holds defaults, nothing reads the world at import):
 *
 *   - STAGE_MESSAGE_CODES   the closed set of stage-failure codes
 *   - STAGE_MESSAGE_CATALOG code -> human text + remediation + severity
 *   - DEFAULT_STAGE_CONFIG  per-stage budgets, overridable from env
 *
 * Precedence for config is code default < environment (the
 * breakerPorts/pipelinePolicy idiom already used in this repo), and a
 * bad environment value is REFUSED loudly rather than silently ignored:
 * a typo'd attempt budget must not quietly become the default.
 */

/** Every way a stage message can end badly. Closed set, greppable. */
export const STAGE_MESSAGE_CODES = [
  "STAGE_WRONG_TARGET",
  "STAGE_MISSING_ARTIFACT_REF",
  "STAGE_RETRY_EXHAUSTED",
  "STAGE_PERSISTED_MISSING",
  "STAGE_CONFIG_INVALID",
] as const;

export type StageMessageCode = (typeof STAGE_MESSAGE_CODES)[number];

export type StageMessageSeverity = "poison" | "budget" | "data";

export interface StageMessageMetadata {
  /** Always rendered with the code, so logs and UI agree. */
  readonly text: string;
  /** What an operator or agent should do next. */
  readonly remediation: string;
  /** poison = never retry; budget = retried past its allowance; data = the input was incomplete. */
  readonly severity: StageMessageSeverity;
}

export const STAGE_MESSAGE_CATALOG: Record<StageMessageCode, StageMessageMetadata> = {
  STAGE_WRONG_TARGET: {
    text: "poison message - this consumer does not serve that stage; refusing without retry",
    remediation:
      "Fix the producer: a message addressed to the wrong stage is a wiring bug, not a transient failure.",
    severity: "poison",
  },
  STAGE_MISSING_ARTIFACT_REF: {
    text: "poison message - no runId or no artifact key to read the input from",
    remediation:
      "The producer must persist its output before publishing; a message that references nothing can never validate.",
    severity: "poison",
  },
  STAGE_RETRY_EXHAUSTED: {
    text: "retry budget exhausted - the stage exceeded its retry budget",
    remediation:
      "Inspect the stage's failure classification; a retried-out stage either needs its budget raised (workflow.stageConfig) or its bug fixed.",
    severity: "budget",
  },
  STAGE_PERSISTED_MISSING: {
    text: "the referenced persisted input is missing or incomplete",
    remediation:
      "Re-run the producing stage for this run; the report stage refuses to regenerate analysis it did not produce.",
    severity: "data",
  },
  STAGE_CONFIG_INVALID: {
    text: "the stage configuration in the environment is not usable",
    remediation: "Fix the environment value named in the detail; defaults are never silently substituted.",
    severity: "poison",
  },
};

/**
 * Render a code plus its detail as one line. The code always leads, so
 * `grep STAGE_` finds every stage failure and the detail stays free-form.
 */
export function formatStageMessage(code: StageMessageCode, detail?: string): string {
  const { text } = STAGE_MESSAGE_CATALOG[code];
  return detail ? `${code}: ${text} (${detail})` : `${code}: ${text}`;
}

/** Per-stage budget knobs. Keep this small: budgets, not behaviour. */
export interface StageConfig {
  /** Attempts allowed before a well-shaped message is dead-lettered. */
  readonly maxAttempts: number;
  /** Per-stage override of maxAttempts, keyed by runtime stage id. */
  readonly perStageMaxAttempts: Readonly<Record<string, number>>;
}

export const DEFAULT_STAGE_CONFIG: StageConfig = {
  maxAttempts: 3,
  perStageMaxAttempts: {},
};

export type StageConfigEnv = Record<string, string | undefined>;

/**
 * Build the effective stage config from the environment.
 *
 * Accepts:
 *   WORKFLOW_STAGE_MAX_ATTEMPTS            integer >= 1
 *   WORKFLOW_STAGE_MAX_ATTEMPTS__<stageId> integer >= 1 (stage ids uppercased,
 *                                          non-alphanumerics -> underscore)
 *
 * Throws StageConfigError (code STAGE_CONFIG_INVALID) on a value that is
 * not a positive integer - refusing beats guessing when the consequence
 * is a silently different retry budget.
 */
export function resolveStageConfig(env: StageConfigEnv = {}): StageConfig {
  const base = readAttempts(env.WORKFLOW_STAGE_MAX_ATTEMPTS, DEFAULT_STAGE_CONFIG.maxAttempts, "WORKFLOW_STAGE_MAX_ATTEMPTS");
  const perStage: Record<string, number> = { ...DEFAULT_STAGE_CONFIG.perStageMaxAttempts };
  for (const [key, raw] of Object.entries(env)) {
    if (!key.startsWith("WORKFLOW_STAGE_MAX_ATTEMPTS__")) continue;
    const stageKey = key.slice("WORKFLOW_STAGE_MAX_ATTEMPTS__".length);
    if (!stageKey) continue;
    perStage[stageKey.toLowerCase().replace(/_/g, "-")] = readAttempts(raw, base, key);
  }
  return { maxAttempts: base, perStageMaxAttempts: perStage };
}

/** The budget a given stage runs under. Unknown stages take the base. */
export function maxAttemptsForStage(config: StageConfig, stageId: string): number {
  return config.perStageMaxAttempts[stageId] ?? config.maxAttempts;
}

function readAttempts(raw: string | undefined, fallback: number, key: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new StageConfigError(
      formatStageMessage("STAGE_CONFIG_INVALID", `${key}="${raw}" is not a positive integer`),
    );
  }
  return value;
}

/** A refused stage configuration. Carries the code so callers need not parse prose. */
export class StageConfigError extends Error {
  readonly code: StageMessageCode = "STAGE_CONFIG_INVALID";
  constructor(message: string) {
    super(message);
    this.name = "StageConfigError";
  }
}
