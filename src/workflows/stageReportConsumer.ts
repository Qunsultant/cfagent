/**
 * Issue #2869 (under #2764) — the report generator consumer:
 * the subscriber of the analysis-done message.
 *
 * Contract, enforced by construction (not by convention):
 * the consumer receives ONLY a stage message plus injected
 * functions. It reads the persisted analysis through
 * readPersisted (canonical store, by artifact key) and hands
 * that persisted result to generate (production wiring
 * since G8 #2869: stageReportProduction
 * .generateRunPdfViaStageConsumer, whose generate fn is
 * the one generation module's PDF leg — itself
 * unifiedReportPipeline.runReportPipeline — with input
 * `result` the persisted result, never a live run).
 * There is NO fetch, provider, or quote input anywhere in
 * this module: report generation from persisted data only
 * is a property of the signature, so a live re-fetch cannot
 * be smuggled in without changing the signature. The
 * consumer never re-runs analysis or ranking: if the
 * persisted analysis lacks the full set (allStocks), it
 * fails loudly instead of regenerating it.
 *
 * Exactly-once effect: the consumer claims the message's
 * idempotencyKey before generating; a redelivery for an
 * already-claimed key returns duplicate-suppressed without
 * regenerating. Release-on-failure (G8 #2869): when
 * generation itself throws, the claim is released (when
 * the store supports delete) — a failed generation has
 * no effect to deduplicate, so a retry, including #1278
 * regeneration of a run whose PDF failed, must be
 * allowed to generate. A successful generation never
 * releases: its output is never regenerated. Poison: a
 * message that fails validation (wrong stage, missing
 * runId/artifact keys) is dead-lettered immediately —
 * attempt count is irrelevant, a poison message never
 * becomes valid by retrying.
 * Budget: past maxAttempts, a well-formed but failing
 * message is dead-lettered (pipelinePolicy budgets govern
 * the queue/workflow retry layer; the caller passes the
 * attempt count and the budget it enforces).
 *
 * Partial persisted analysis is NOT a failure: when the
 * persisted result carries a partial qualification, the
 * report is generated with that marking carried through
 * (partial: true on the generated input), so a partial
 * report never presents as complete.
 */

import {
  isAnalysisDoneMessage,
  type StageMessage,
} from "./stageMessage";

export type StageConsumeStatus =
  | "generated"
  | "duplicate-suppressed"
  | "dead-lettered";

export interface StageConsumeResult {
  status: StageConsumeStatus;
  /** Present on generated: the report output the generate fn returned. */
  output?: unknown;
  /** Present on dead-lettered: why, loudly. */
  reason?: string;
}

export interface StageClaimStore {
  has(key: string): boolean;
  add(key: string): void;
  /**
   * Optional: release a claim. Used ONLY when generation
   * itself throws (release-on-failure). Absent = release
   * is a no-op and a failed attempt keeps its claim.
   */
  delete?(key: string): void;
}

export interface PersistedAnalysis {
  allStocks: unknown[];
  opportunities?: unknown[];
  partial?: unknown;
  [key: string]: unknown;
}

/**
 * Consume one analysis-done message into a report, from
 * persisted data only. Loud failure, never silent drop:
 * poison and over-budget messages are dead-lettered with a
 * reason (and the injected deadLetter fn, when supplied,
 * is invoked); a missing persisted analysis throws (the
 * caller must handle it — the consumer never fabricates
 * analysis to cover a missing store read).
 */
export async function consumeAnalysisDone(args: {
  message: StageMessage;
  attempt?: number;
  maxAttempts?: number;
  claims?: StageClaimStore;
  readPersisted: (artifactKey: string) => Promise<PersistedAnalysis | null>;
  generate: (input: {
    result: PersistedAnalysis;
    runId: string;
    userLogin: string;
    partial: boolean;
  }) => Promise<unknown>;
  deadLetter?: (info: { message: StageMessage; reason: string }) => Promise<void> | void;
}): Promise<StageConsumeResult> {
  const { message } = args;
  const attempt = args.attempt ?? 1;
  const maxAttempts = args.maxAttempts ?? 3;
  const deadLetter = async (reason: string): Promise<StageConsumeResult> => {
    if (args.deadLetter) await args.deadLetter({ message, reason });
    return { status: "dead-lettered", reason };
  };
  // Poison: wrong stage, or no reference to persisted output.
  if (!isAnalysisDoneMessage(message)) {
    return deadLetter(`poison message: stage "${message.stageId}" is not analysis-done; refusing without retry.`);
  }
  if (!message.runId?.trim() || !message.artifactKeys || message.artifactKeys.length === 0) {
    return deadLetter("poison message: runId or artifactKeys missing; refusing without retry.");
  }
  // Budget: past it, dead-letter rather than retry forever.
  if (attempt > maxAttempts) {
    return deadLetter(`retry budget exhausted: attempt ${attempt} exceeds maxAttempts ${maxAttempts}.`);
  }
  // Exactly-once effect: redelivery of a claimed key suppresses.
  const claims = args.claims;
  if (claims) {
    if (claims.has(message.idempotencyKey)) {
      return { status: "duplicate-suppressed" };
    }
    claims.add(message.idempotencyKey);
  }
  const persisted = await args.readPersisted(message.artifactKeys[0]);
  if (!persisted || !Array.isArray(persisted.allStocks)) {
    throw new Error(
      `report consumer refused: persisted analysis for run ${message.runId} is missing or has no full set (allStocks) — refusing to regenerate analysis inside report generation.`,
    );
  }
  let output: unknown;
  try {
    output = await args.generate({
      result: persisted,
      runId: message.runId,
      userLogin: message.userLogin,
      partial: persisted.partial !== undefined && persisted.partial !== null,
    });
  } catch (err) {
    // Release-on-failure (G8 #2869): a failed generation
    // produced no effect, so the claim must not block a
    // retry. The throw still propagates — the caller
    // records the failure; it is never swallowed here.
    claims?.delete?.(message.idempotencyKey);
    throw err;
  }
  return { status: "generated", output };
}
