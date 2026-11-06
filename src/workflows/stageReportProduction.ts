/**
 * Issue #2869 (G8) — the stage consumer as the production
 * PDF path.
 *
 * Before G8, consumeAnalysisDone had no production caller
 * and production PDF generation was in-process
 * runReportPipeline inside generateRunPdf (audit F2).
 * Since G8, generateRunPdf delegates here: the helper
 * persists the run's analysis to a per-run key FIRST
 * (persist-then-publish ordering, stageMessage contract),
 * builds a real analysis-done message referencing that
 * key, and consumes it — the PDF leg runs through the
 * consumer, from persisted data only, never a live run.
 *
 * What this wiring is, precisely:
 *  - SYNC + workflow-child + regeneration runs only:
 *    every path that goes through ScreenerAgent
 *    .generateRunPdf (persistRun, regenerateLatestReport
 *    #1278). The chain tabular legs went through the
 *    tabular-aware consumer (stageTabularConsumer,
 *    slice 3); the monolithic tabular XLSX/CSV legs stay
 *    in the one generation module — this helper's
 *    consumer is PDF-only by contract (its generate is
 *    runReportPipeline).
 *  - NOT queue transport: the message is built and
 *    consumed in-process here. Publishing analysis-done
 *    to Queues/mas_async_jobs and consuming it from a
 *    queue executor is the remaining #2869 step, filed
 *    on #2869 — not claimed done by this module.
 *
 * Durable claims: the stage-claims store is SQL-backed
 * (src/data/stageClaimsStore.ts) when sql is supplied —
 * the production agent always has ctx.storage.sql — and
 * falls back to an in-memory set only for contexts
 * without SQL (tests). Claims release on generation
 * failure (consumer contract), so a failed attempt never
 * blocks #1278 regeneration.
 *
 * Suppressed-redelivery guard: the helper pre-checks the
 * claim BEFORE persisting the analysis. Without it, a
 * redelivery would overwrite the persisted analysis with
 * a fresh result that has no pdf fields, destroying the
 * previous generation's record. On suppression the
 * helper copy-backs the previous generation's pdf fields
 * onto the fresh result instead, so the canonical row
 * still carries the existing pdfKey.
 *
 * Failure discipline (same as the generation module):
 * this helper never throws. A consumer throw, a
 * dead-letter, or a missing timestamp is recorded on
 * the run (pdfStatus failed + coded pdfError) and
 * returned — persistRun must never fail the run on an
 * artifact failure.
 */
import { codedMessage } from "../outcomes/outcomeAspects";
import { createSqlStageClaimStore } from "../data/stageClaimsStore";
import type { SqlStorage } from "../data/repositoryPorts";
import {
  consumeAnalysisDone,
  type PersistedAnalysis,
  type StageClaimStore,
} from "./stageReportConsumer";
import { stageIdempotencyKey, stageMessage } from "./stageMessage";
// Re-exported from the pure-data runtime ids (see the note there):
// stageQueueTransport needs only the key, not this module. The
// local import serves this file's own internal use.
import { stageAnalysisKey } from "./stageRuntimeIds";
export { STAGE_ANALYSIS_KEY_PREFIX, stageAnalysisKey } from "./stageRuntimeIds";

/**
 * The run shape the PDF leg needs. Structural on purpose:
 * importing ScreenerRunResult here would couple this
 * workflow module to the agent class; the agent passes
 * its result straight through (same object, same fields).
 */
export interface StagePdfRun {
  timestamp: string;
  allStocks: unknown[];
  pdfKey?: string;
  pdfStatus?: string;
  pdfError?: string;
}

export interface StagePdfBlobStore {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
}

export type StagePdfGenerate = (input: {
  result: PersistedAnalysis;
  runId: string;
  userLogin: string;
  partial: boolean;
}) => Promise<unknown>;

export type StagePdfOutcomeStatus =
  | "generated"
  | "duplicate-suppressed"
  | "dead-lettered"
  | "failed";

export interface StagePdfOutcome {
  status: StagePdfOutcomeStatus;
  reason?: string;
}

function copyPdfFields(target: StagePdfRun, source: unknown): void {
  if (!source || typeof source !== "object") return;
  const s = source as Partial<StagePdfRun>;
  if (typeof s.pdfKey === "string") target.pdfKey = s.pdfKey;
  if (typeof s.pdfStatus === "string") target.pdfStatus = s.pdfStatus;
  if (typeof s.pdfError === "string") target.pdfError = s.pdfError;
  else delete target.pdfError;
}

function inMemoryStageClaimStore(): StageClaimStore {
  const seen = new Set<string>();
  return {
    has: (key) => seen.has(key),
    add: (key) => {
      seen.add(key);
    },
    delete: (key) => {
      seen.delete(key);
    },
  };
}

/**
 * Issue #2869 slice 1 — the shared consume of one analysis-done
 * message, used by BOTH the in-process PDF leg below and the
 * queue executor (ScreenerAgent.consumeQueuedAnalysisDone).
 * One helper, not two consume paths: claims (SQL-backed when
 * sql is supplied, in-memory only for contexts without SQL),
 * persisted-analysis read by artifact key, the one generation
 * module's PDF leg as the default generate, and a logged
 * dead-letter. It does NOT re-put the generated analysis:
 * the caller owns copy-back (the in-process leg copies pdf
 * fields onto its live result; the queue leg re-puts the
 * generated persisted object). A missing persisted analysis
 * throws from consumeAnalysisDone — the queue caller retries
 * it to the DLQ; the in-process caller records it as a
 * failed leg. Never a second consumer, never a second claim
 * store, never a live re-fetch.
 */
export async function consumeAnalysisDoneMessage(args: {
  env: unknown;
  storage: StagePdfBlobStore;
  sql?: SqlStorage;
  claims?: StageClaimStore;
  message: import("./stageMessage").StageMessage;
  userLogin: string;
  attempt?: number;
  generate?: StagePdfGenerate;
}): Promise<import("./stageReportConsumer").StageConsumeResult> {
  const { env, storage, message, userLogin } = args;
  const claims: StageClaimStore =
    args.claims ??
    (args.sql
      ? createSqlStageClaimStore(() => args.sql as SqlStorage)
      : inMemoryStageClaimStore());
  const generate: StagePdfGenerate =
    args.generate ??
    (async (input) => {
      const { generateStockReportArtifacts } = await import(
        "../services/stockReportArtifacts"
      );
      return generateStockReportArtifacts({
        env: env as never,
        storage: storage as never,
        result: input.result as never,
        userLogin: input.userLogin,
        formats: ["pdf"],
      });
    });
  return consumeAnalysisDone({
    message,
    attempt: args.attempt ?? 1,
    claims,
    readPersisted: async (key) => (await storage.get(key)) as PersistedAnalysis | null,
    generate,
    deadLetter: async ({ reason }) => {
      console.warn("[stageReportProduction] stage message dead-lettered:", reason);
    },
  });
}

export async function generateRunPdfViaStageConsumer(args: {
  env: unknown;
  storage: StagePdfBlobStore;
  sql?: SqlStorage;
  result: StagePdfRun;
  userLogin: string;
  /** Test seam only; production always uses the real PDF leg. */
  generatePdf?: StagePdfGenerate;
}): Promise<StagePdfOutcome> {
  const { env, storage, result, userLogin } = args;
  const fail = (reason: string): StagePdfOutcome => {
    result.pdfStatus = "failed";
    result.pdfError = codedMessage("FAILURE_REPORT_PDF_GENERATION", reason);
    console.error("[stageReportProduction] PDF leg failed:", result.pdfError);
    return { status: "failed", reason };
  };
  try {
    if (!result.timestamp?.trim()) {
      return fail("run has no timestamp; cannot address its persisted analysis");
    }
    const runId = `screener:${result.timestamp}`;
    const analysisKey = stageAnalysisKey(result.timestamp);
    const claims: StageClaimStore = args.sql
      ? createSqlStageClaimStore(() => args.sql as SqlStorage)
      : inMemoryStageClaimStore();
    const idempotencyKey = stageIdempotencyKey(runId, "analysis-done");
    // Suppressed redelivery: never clobber the persisted
    // analysis; copy-back the previous generation instead.
    if (claims.has(idempotencyKey)) {
      copyPdfFields(result, await storage.get(analysisKey));
      return { status: "duplicate-suppressed" };
    }
    // Persist first, publish (consume) second.
    await storage.put(analysisKey, result);
    const message = stageMessage({
      runId,
      stageId: "analysis-done",
      artifactKeys: [analysisKey],
      userLogin,
    });
    // Capture the persisted object the consumer hands to
    // generate: the module mutates THAT object, and a
    // store re-read would return the pre-generation value
    // (real DO storage deserializes a fresh copy).
    let generatedPersisted: PersistedAnalysis | undefined;
    const generate: StagePdfGenerate = async (input) => {
      generatedPersisted = input.result;
      if (args.generatePdf) return args.generatePdf(input);
      const { generateStockReportArtifacts } = await import(
        "../services/stockReportArtifacts"
      );
      return generateStockReportArtifacts({
        env: env as never,
        storage: storage as never,
        result: input.result as never,
        userLogin: input.userLogin,
        formats: ["pdf"],
      });
    };
    const outcome = await consumeAnalysisDoneMessage({
      env,
      storage,
      claims,
      message,
      userLogin,
      generate,
    });
    if (outcome.status === "duplicate-suppressed") {
      // Raced claim between the pre-check and consume:
      // same copy-back, no regeneration, no clobber.
      copyPdfFields(result, await storage.get(analysisKey));
      return { status: "duplicate-suppressed" };
    }
    if (outcome.status === "dead-lettered") {
      return fail(outcome.reason ?? "stage message dead-lettered");
    }
    // Generated: copy the module's pdf fields from the
    // mutated persisted object back onto the caller's
    // result, and re-put so the analysis key holds the
    // run WITH its pdf fields (what replay reads).
    copyPdfFields(result, generatedPersisted);
    await storage.put(analysisKey, generatedPersisted ?? result);
    return { status: "generated" };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err));
  }
}
