/**
 * Issue #5058 (AG-4) — the LLM judge's quality scores get a consumer.
 *
 * Every chat turn is scored (`LLMJudge.evaluate`) and the score landed only
 * in the `response.evaluated` audit event and a best-effort VectorMemory
 * row: nothing read past scores, so the evaluation loop was audit-only.
 *
 * This module closes the loop through the store that already has a reader —
 * `mas_learnings`, whose active rows the weekly reflection job reads and
 * turns into findings and review candidates:
 *
 *  - a turn scored below `JUDGE_LEARNING_THRESHOLD` becomes a learning in
 *    domain `judge`, carrying the agent, the issues, and the request id;
 *  - `summarizeJudgeScoreLearnings` aggregates the recent judge learnings
 *    (count, mean, agents) and `buildJudgeScoreFinding` turns a repeat
 *    pattern into a reflection finding;
 *  - `reflection.ts` emits that finding, so repeated low scores reach the
 *    human review queue instead of dying in a log line.
 *
 * Every threshold is externalized (`JUDGE_LEARNING_THRESHOLD`,
 * `JUDGE_LEARNING_MIN_COUNT`, `JUDGE_LEARNING_ENABLED`) with the defaults
 * below. The write is best-effort at the call site: a learning-write failure
 * must never fail the chat turn it evaluates.
 */
import type { Env } from "../types";
import { getActiveLearnings, recordLearning, type Learning } from "./learnings";

/** The domain judge-score learnings live in. */
export const JUDGE_SCORE_DOMAIN = "judge";

export interface JudgeScoreFeedbackPolicy {
  enabled: boolean;
  /** Score (0–100) strictly below this records a learning. */
  threshold: number;
  /** Low-score learnings in the window that make a reflection finding. */
  minCount: number;
  /** How many days back the aggregate looks. */
  windowDays: number;
}

export const JUDGE_SCORE_FEEDBACK_DEFAULTS: JudgeScoreFeedbackPolicy = {
  enabled: true,
  threshold: 60,
  minCount: 3,
  windowDays: 7,
};

export const JUDGE_SCORE_FEEDBACK_ENV = {
  enabled: "JUDGE_LEARNING_ENABLED",
  threshold: "JUDGE_LEARNING_THRESHOLD",
  minCount: "JUDGE_LEARNING_MIN_COUNT",
  windowDays: "JUDGE_LEARNING_WINDOW_DAYS",
} as const;

function resolveInt(raw: string | undefined, fallback: number): number {
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

/** Resolve the feedback policy from the deployment env (AOP). */
export function resolveJudgeScoreFeedbackPolicy(
  env: Env | undefined | null,
): JudgeScoreFeedbackPolicy {
  return {
    enabled: resolveBool(
      env?.[JUDGE_SCORE_FEEDBACK_ENV.enabled],
      JUDGE_SCORE_FEEDBACK_DEFAULTS.enabled,
    ),
    threshold: resolveInt(
      env?.[JUDGE_SCORE_FEEDBACK_ENV.threshold],
      JUDGE_SCORE_FEEDBACK_DEFAULTS.threshold,
    ),
    minCount: resolveInt(
      env?.[JUDGE_SCORE_FEEDBACK_ENV.minCount],
      JUDGE_SCORE_FEEDBACK_DEFAULTS.minCount,
    ),
    windowDays: resolveInt(
      env?.[JUDGE_SCORE_FEEDBACK_ENV.windowDays],
      JUDGE_SCORE_FEEDBACK_DEFAULTS.windowDays,
    ),
  };
}

export interface JudgeScoreInput {
  score: number;
  grounded: boolean;
  safe: boolean;
  issues: readonly string[];
  agent: string;
  requestId: string;
  now?: () => Date;
}

/** The learning a scored turn produces, or null when it is not a low score. */
export function judgeScoreLearning(
  input: JudgeScoreInput,
  policy: JudgeScoreFeedbackPolicy,
): { domain: string; observation: string; evidenceRefs: string[]; confidence: number } | null {
  if (!policy.enabled) return null;
  if (!Number.isFinite(input.score) || input.score >= policy.threshold) return null;
  const issues = input.issues.length > 0 ? input.issues.join("; ") : "none reported";
  return {
    domain: JUDGE_SCORE_DOMAIN,
    observation:
      `Judge scored a ${input.agent} turn ${Math.round(input.score)}/100 (below the ${policy.threshold} threshold); ` +
      `grounded=${input.grounded}, safe=${input.safe}, issues: ${issues}.`,
    evidenceRefs: [`chat:${input.requestId}`],
    // A low score is weak evidence on its own: one turn is a sample, the
    // repeat pattern is what the aggregate acts on.
    confidence: Math.max(0.1, Math.min(1, input.score / 100)),
  };
}

/**
 * Record the low-score learning, once per request. Returns the new learning
 * id, or null when nothing was recorded (not a low score, disabled, or an
 * identical request already recorded). Never throws: the caller is a chat
 * turn's finish hook.
 */
export function recordJudgeScoreLearning(
  sql: any,
  input: JudgeScoreInput,
  policy: JudgeScoreFeedbackPolicy,
): string | null {
  try {
    const candidate = judgeScoreLearning(input, policy);
    if (!candidate) return null;
    const existing = getActiveLearnings(sql, JUDGE_SCORE_DOMAIN);
    const ref = candidate.evidenceRefs[0];
    if (existing.some((l) => l.evidenceRefs.includes(ref))) return null;
    return recordLearning(sql, {
      ...candidate,
      // The judge is an automated reflection instrument; the store's source
      // vocabulary has no dedicated value and adding one would change every
      // reader's filter for no gain.
      source: "reflection",
    });
  } catch {
    return null;
  }
}

export interface JudgeScoreSummary {
  /** Low-score learnings inside the window. */
  count: number;
  /** Distinct agents the low scores came from, sorted. */
  agents: string[];
  /** Mean score parsed from the observations, or null when none parse. */
  meanScore: number | null;
}

const SCORE_PATTERN = /scored an? ([a-z-]+) turn (\d+)\/100/;

/** Aggregate the recent judge-score learnings. Pure read + arithmetic. */
export function summarizeJudgeScoreLearnings(
  sql: any,
  options: { windowDays: number; now?: () => Date },
): JudgeScoreSummary {
  const learnings: Learning[] = getActiveLearnings(sql, JUDGE_SCORE_DOMAIN);
  const nowMs = (options.now ?? (() => new Date()))().getTime();
  const cutoff = nowMs - options.windowDays * 86_400_000;
  const agents = new Set<string>();
  const scores: number[] = [];
  let count = 0;
  for (const learning of learnings) {
    if (new Date(learning.createdAt).getTime() < cutoff) continue;
    count += 1;
    const match = SCORE_PATTERN.exec(learning.observation);
    if (match) {
      agents.add(match[1]);
      scores.push(Number.parseInt(match[2], 10));
    }
  }
  return {
    count,
    agents: [...agents].sort(),
    meanScore:
      scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : null,
  };
}

/**
 * Turn a repeat pattern into a reflection finding, or null when the pattern
 * is not there yet (one bad turn is a sample, not a trend).
 */
export function buildJudgeScoreFinding(
  summary: JudgeScoreSummary,
  policy: JudgeScoreFeedbackPolicy,
): { domain: string; observation: string; evidenceRefs: string[]; confidence: number; proposedAdjustment: string } | null {
  if (!policy.enabled) return null;
  if (summary.count < policy.minCount) return null;
  const agentList = summary.agents.length > 0 ? summary.agents.join(", ") : "unspecified agents";
  return {
    domain: JUDGE_SCORE_DOMAIN,
    observation:
      `${summary.count} turn(s) scored below ${policy.threshold}/100 in the last ${policy.windowDays} day(s) ` +
      `(agents: ${agentList}; mean score ${summary.meanScore ?? "n/a"}). ` +
      `The judge's scores were audit-only before #5058; this is the trend consumer.`,
    evidenceRefs: [`mas_learnings:${JUDGE_SCORE_DOMAIN}`],
    confidence: 0.7,
    proposedAdjustment:
      "Review the flagged turns' prompts and tool routing for the named agents; the score is evidence, not a routing input — the change still goes through review.",
  };
}
