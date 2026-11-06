/**
 * Issue #3527 S1 — the publish stage, core slice: the report
 * INDEX legs.
 *
 * Publishing a stored document used to be fused into the store
 * seams: `fireFanoutIndexLegs` in src/services/scheduledReports.ts
 * fired the Vectorize leg (indexCanonicalReport) and the AI
 * Search items leg (indexCanonicalReportInAiSearch, #2246)
 * inline, and the seam recorded each leg's settled outcome on
 * the report row. This module is the stage those firings move
 * behind: ONE operation, publishDocument, that composes the
 * EXISTING executors — it reimplements none of them — and
 * returns each target's outcome in a declared vocabulary.
 * Callers keep owning their records: the store seams keep
 * writing `fanout_outcome`, now from the stage's outcomes.
 *
 * S1 scope is the two index targets for kind "report" only.
 * The `r2-body` target lands in S2; the corpus document kind
 * lands in S3 (the union below gains its second member there).
 * discoveryReportPublish is out of scope (it generates its
 * artifacts; it does not publish a stored document).
 *
 * Contract (survey §3.2, with one refinement the code forces):
 * the survey proposed `publishDocument(env, doc) ->
 * Promise<PublishOutcome>`. The store seam records each leg
 * as THAT leg settles (recordFanoutLegOutcome is per-leg), so
 * an aggregate-only promise would delay the Vectorize record
 * until the AI Search leg settles — a timing change disguised
 * as a refactor. publishDocument therefore returns
 * synchronously with a per-target `settled` promise (each
 * never rejects), and `handle.settled` is the survey's
 * aggregate Promise<PublishOutcome>. The stage NEVER throws:
 * a throwing or rejecting executor is a `failed` outcome,
 * never an exception across the boundary.
 *
 * Outcome vocabulary, per target (mapped from the executors'
 * own vocabularies without loss):
 *
 * - vectorize: the stage precomputes attempted-ness exactly
 *   as the seam did — bindings present (AI + VECTOR_MEMORY)
 *   and source not in INDEX_EXCLUDED_SOURCES — because the
 *   executor's boolean conflates not-attempted with failed.
 *   Not attempted -> `not_attempted` (executor never invoked);
 *   executor true -> `published`; false or any throw ->
 *   `failed`.
 * - ai-search: the hook owns its enablement gate. Hook ok ->
 *   `published`; hook code "disabled" (flag off / no id /
 *   excluded source) -> `not_configured`, carrying the code;
 *   any other hook code -> `failed`, carrying the executor's
 *   stable code verbatim (including its own "not_configured"
 *   token, produced when the flag is ON but the namespace
 *   binding is absent); a rejecting hook -> `failed` with
 *   code "upload_failed" (the token the seam's rejection
 *   handler has always recorded).
 */

import {
  indexCanonicalReport,
  INDEX_EXCLUDED_SOURCES,
  type CanonicalReportForIndex,
  type IndexEnv,
} from "./reportSemanticIndex";
import {
  indexCanonicalReportInAiSearch,
  type CanonicalReportForAiSearchIndex,
  type ReportAiSearchIndexEnv,
} from "./reportAiSearchIndex";

/** The env the stage reads: the union of both legs' env subsets. */
export type PublishEnv = IndexEnv & ReportAiSearchIndexEnv;

/**
 * A stored report to publish, in the stage's own shape. The
 * seam translates its two per-leg literals into this one
 * document; the stage translates it back into each executor's
 * exact input shape.
 */
export interface ReportPublishDocument {
  kind: "report";
  /** The mas_reports row id (the executors' `reportId`). */
  documentId: string;
  title: string;
  source: string;
  summary: string;
  /** The stored body string (JSON for most sources; may be "" for R2 rows). */
  body: string;
  /** R2 object key when the body lives in REPORTS_BUCKET. */
  bodyR2Key?: string | null;
  /** The run that produced the report, when the seam has it. */
  runId?: string;
  /** The report owner's login, when the seam has it. */
  ownerLogin?: string;
  /** The row's stored-at timestamp, when the seam has it. */
  storedAt?: string;
}

/** S1: reports only. S3 adds the corpus member to this union. */
export type PublishDocumentInput = ReportPublishDocument;

export type PublishTargetId = "r2-body" | "vectorize" | "ai-search";

export type PublishTargetStatus =
  | "published"
  | "not_attempted"
  | "not_configured"
  | "failed";

/** One target's settled outcome. `code` is the executor's stable code, when it produced one. */
export interface PublishTargetOutcome {
  target: PublishTargetId;
  status: PublishTargetStatus;
  code?: string;
}

/** One target's settle handle: resolves with its outcome, never rejects. */
export interface PublishTargetHandle {
  target: PublishTargetId;
  settled: Promise<PublishTargetOutcome>;
}

/** The aggregate outcome of one publishDocument call. */
export interface PublishOutcome {
  kind: PublishDocumentInput["kind"];
  documentId: string;
  targets: PublishTargetOutcome[];
}

/** What publishDocument returns, synchronously. */
export interface PublishHandle {
  targets: PublishTargetHandle[];
  /** Resolves when every target has settled; never rejects. */
  settled: Promise<PublishOutcome>;
}

/** Injectable executors (tests pin payloads + fault mapping through these). */
export interface PublishDeps {
  indexCanonicalReport?: typeof indexCanonicalReport;
  indexCanonicalReportInAiSearch?: typeof indexCanonicalReportInAiSearch;
}

/**
 * Would the Vectorize leg be ATTEMPTED for this env + source?
 * The one home for the precondition the seam used to compute
 * twice (the fan-out firing and the initial recorded
 * statuses): bindings present and the source not excluded.
 */
export function vectorizeTargetAttempted(
  env: PublishEnv | undefined,
  source: string,
): boolean {
  return (
    !!env?.AI &&
    !!env?.VECTOR_MEMORY &&
    !(INDEX_EXCLUDED_SOURCES as readonly string[]).includes(source)
  );
}

function settleVectorizeTarget(
  env: PublishEnv | undefined,
  doc: ReportPublishDocument,
  run: NonNullable<PublishDeps["indexCanonicalReport"]>,
): Promise<PublishTargetOutcome> {
  if (!vectorizeTargetAttempted(env, doc.source)) {
    return Promise.resolve({ target: "vectorize", status: "not_attempted" });
  }
  const report: CanonicalReportForIndex = {
    reportId: doc.documentId,
    title: doc.title,
    source: doc.source,
    summary: doc.summary,
    body: doc.body,
    bodyR2Key: doc.bodyR2Key ?? null,
  };
  return (async (): Promise<PublishTargetOutcome> => {
    try {
      const ok = await run(env, report);
      return { target: "vectorize", status: ok ? "published" : "failed" };
    } catch {
      // The executor never throws by contract; a throwing
      // double or a future regression lands here as the same
      // `failed` the seam's rejection handler recorded.
      return { target: "vectorize", status: "failed" };
    }
  })();
}

function settleAiSearchTarget(
  env: PublishEnv | undefined,
  doc: ReportPublishDocument,
  run: NonNullable<PublishDeps["indexCanonicalReportInAiSearch"]>,
): Promise<PublishTargetOutcome> {
  const report: CanonicalReportForAiSearchIndex = {
    reportId: doc.documentId,
    title: doc.title,
    source: doc.source,
    summary: doc.summary,
    body: doc.body,
    bodyR2Key: doc.bodyR2Key ?? null,
    runId: doc.runId,
    ownerLogin: doc.ownerLogin,
    storedAt: doc.storedAt,
  };
  return (async (): Promise<PublishTargetOutcome> => {
    try {
      const outcome = await run(env, report);
      if (outcome.ok) return { target: "ai-search", status: "published" };
      if (outcome.code === "disabled") {
        return {
          target: "ai-search",
          status: "not_configured",
          code: "disabled",
        };
      }
      return {
        target: "ai-search",
        status: "failed",
        // The executor sets a stable code on every non-ok
        // outcome; the fallback names the same token the
        // seam's rejection handler records, so a code-less
        // outcome can never reach a record as a bare failure.
        code: outcome.code ?? "upload_failed",
      };
    } catch {
      return { target: "ai-search", status: "failed", code: "upload_failed" };
    }
  })();
}

/**
 * Publish one stored document to the stage's targets. S1:
 * the two report index legs (vectorize, ai-search). Returns
 * synchronously; every promise it hands out resolves (never
 * rejects) with the target's declared outcome.
 */
export function publishDocument(
  env: PublishEnv | undefined,
  doc: PublishDocumentInput,
  deps: PublishDeps = {},
): PublishHandle {
  const runVectorize = deps.indexCanonicalReport ?? indexCanonicalReport;
  const runAiSearch =
    deps.indexCanonicalReportInAiSearch ?? indexCanonicalReportInAiSearch;
  const targets: PublishTargetHandle[] = [
    {
      target: "vectorize",
      settled: settleVectorizeTarget(env, doc, runVectorize),
    },
    {
      target: "ai-search",
      settled: settleAiSearchTarget(env, doc, runAiSearch),
    },
  ];
  const settled: Promise<PublishOutcome> = Promise.all(
    targets.map((t) => t.settled),
  ).then((outcomes) => ({
    kind: doc.kind,
    documentId: doc.documentId,
    targets: outcomes,
  }));
  return { targets, settled };
}
