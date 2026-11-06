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
 * S1 scope was the two index targets for kind "report" only.
 * S2 adds the third target, `r2-body`: the canonical body put
 * the WithR2 store seam used to perform inline
 * (storeReportAtGenerationWithR2: put reports/<reportId>.json
 * through the BlobStore port BEFORE the row insert, a failed
 * put falling back to the exact inline row shape, recorded).
 * The seam now requests that target from the stage and awaits
 * its settle handle pre-insert — the row's shape depends on
 * the outcome, so this leg is NOT fire-and-forget at the seam
 * (the #2347 contract: the put precedes the insert and a row
 * never claims a body it does not have).
 *
 * S3 adds the union's second member, kind "corpus": the
 * knowledge corpus's AI Search items leg (#3345) publishes
 * through the same stage. The stage's corpus executor is the
 * EXISTING hook indexCorpusDocInAiSearch — composed, never
 * reimplemented — so the flag gate
 * (AI_SEARCH_CORPUS_INDEXING_ENABLED) and the never-throws
 * discipline stay inside the hook, exactly where they are
 * observably. The corpus call sites (the upload route in
 * routes/knowledgeCorpus.ts, the sync backfill leg in
 * corpusAiSearchIndex.ts) now consume a stage outcome and
 * render it in the corpus state vocabulary
 * (indexed | not-configured | failed). A corpus document's
 * only publish leg is ai-search; its default target set is
 * ["ai-search"], and the report-only targets settle
 * `not_attempted` for a corpus document (no corpus executor
 * exists for them, and none is invoked).
 *
 * The corpus's R2 write is deliberately NOT a stage target.
 * putKnowledgeDoc (src/services/knowledgeCorpus.ts) is the
 * corpus document STORE's own put: it computes the document's
 * content-hash identity from the bytes being written, stores
 * them under knowledge/<category>/<sha256>, and records the
 * metadata — the document does not exist before the write,
 * and the write may fail its caller (KnowledgeCorpusError,
 * mapped to an honest 400 by the route). That is the store
 * operation the stage's contract ("publish an ALREADY-STORED
 * document") starts after — the corpus analogue of the
 * mas_reports INSERT, not of the r2-body leg, which publishes
 * a stored report's body bytes to a second home. No second
 * publish-style write exists in the corpus flow (the sync's
 * integrity and backfill legs read only), so nothing else
 * migrates. discoveryReportPublish remains out of scope (it
 * generates its artifacts; it does not publish a stored
 * document).
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
 * - r2-body (S2): the stage precomputes configured-ness via
 *   the BlobStore port factory (createBlobStore) — no bucket
 *   bound -> `not_configured`, the put executor never invoked
 *   (an unbound bucket was never a failure at the seam: the
 *   row simply stores inline, code STORED). Attempted put ok
 *   -> `published`; put throw/rejection -> `failed` carrying
 *   the error's message in `error` (the BlobStore put
 *   produces no stable code; the seam's recorded-fallback
 *   log line quotes the message, exactly as its inline catch
 *   did). The put itself is the seam's exact pre-stage put:
 *   key reportBodyR2Key(documentId) (defined below — its one
 *   home, moved here from the seam, which re-exports it),
 *   the document's body string verbatim, contentType
 *   "application/json", through the ONE BlobStore port.
 * - ai-search for kind "corpus" (S3): the hook owns its
 *   enablement gate AND its rendered state vocabulary, so the
 *   mapping runs off the hook's own `state`, 1:1 without
 *   loss — hook ok ("indexed") -> `published`; hook state
 *   "not-configured" -> `not_configured`, carrying the code
 *   verbatim ("disabled" when the flag is off,
 *   "not_configured" when the namespace binding is absent);
 *   hook state "failed" -> `failed`, carrying the executor's
 *   stable code AND its error message verbatim
 *   ("invalid_input", "upload_failed", ...); a rejecting
 *   hook -> `failed` with code "upload_failed" (defensive:
 *   the hook never throws by contract).
 *
 * Target selection: publishDocument runs the two index
 * targets by default for a report (the S1 behaviour every
 * existing caller relies on); for a corpus document the
 * default is ["ai-search"], its only leg. A caller requests
 * a different set via PublishOptions.targets — the WithR2
 * seam requests ["r2-body"] alone for its pre-insert phase,
 * because the index legs must not fire before the row exists
 * (their outcomes record onto the row) and the body leg must
 * not wait for them. Handles always come back in canonical
 * order: r2-body, vectorize, ai-search.
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
import {
  indexCorpusDocInAiSearch,
  type CorpusAiSearchIndexEnv,
} from "./corpusAiSearchIndex";
import type { KnowledgeDocMeta } from "./knowledgeCorpus";
import { createBlobStore } from "./blobStoreR2Adapter";
import type { BlobStore } from "./blobStorePorts";

/** The env the stage reads: the union of every leg's env subset. */
export type PublishEnv = IndexEnv &
  ReportAiSearchIndexEnv &
  CorpusAiSearchIndexEnv;

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
  /**
   * The body string (JSON for most sources; may be "" for
   * R2 rows on the index legs). For the r2-body target the
   * seam passes it pre-insert: it is the put payload, i.e.
   * the exact string the row would otherwise store inline.
   */
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

/**
 * A stored corpus document to publish, in the stage's own
 * shape. The document's identity is its bucket key
 * (knowledge/<category>/<sha256>) — the manifest key whose
 * tail is the content hash — carried as `documentId` and as
 * meta.r2Key. `meta` + `bytes` are exactly the inputs the
 * corpus hook has always taken: the hook derives the index
 * text and provenance metadata from them.
 */
export interface CorpusPublishDocument {
  kind: "corpus";
  /** The corpus bucket key (knowledge/<category>/<sha256>). */
  documentId: string;
  /** The stored document's metadata record. */
  meta: KnowledgeDocMeta;
  /** The served bytes the index text is derived from. */
  bytes: Uint8Array;
}

/** The stage's document union: reports (S1/S2) and corpus documents (S3). */
export type PublishDocumentInput = ReportPublishDocument | CorpusPublishDocument;

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
  /**
   * The caught error's message, when a failed executor
   * produced no stable code (the r2-body leg: the BlobStore
   * put's rejection). The caller's fallback log line quotes
   * it — the same text the seam's inline catch logged.
   */
  error?: string;
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
  /**
   * The corpus ai-search executor: the EXISTING #3345 hook,
   * composed as-is (flag gate, text derivation, never-throws
   * all stay inside it). Injectable so pins can observe the
   * (meta, bytes) inputs and the outcome mapping without a
   * namespace double.
   */
  indexCorpusDocInAiSearch?: typeof indexCorpusDocInAiSearch;
  /**
   * The r2-body put, against the stage-resolved BlobStore.
   * The default performs the seam's exact pre-stage put
   * (contentType "application/json"); injectable so pins can
   * observe the (store, key, body) triple and inject faults
   * without a bucket double.
   */
  putReportBody?: (
    store: BlobStore,
    key: string,
    body: string,
  ) => Promise<void>;
}

/** Options for one publishDocument call. */
export interface PublishOptions {
  /**
   * The targets to run, in any order (handles come back in
   * canonical order). Default: for a report, the two index
   * targets (["vectorize", "ai-search"]) — the S1 behaviour;
   * for a corpus document, ["ai-search"] — its only leg.
   */
  targets?: readonly PublishTargetId[];
}

/**
 * Issue #338: the R2 object key for a report's canonical
 * body, per the accepted design — `reports/<reportId>.json`
 * in the REPORTS_BUCKET bucket (the `screener` bucket
 * provisioned for #605). Content-addressed by report id;
 * bodies are immutable (regeneration = a new report id).
 * Issue #3527 S2: the definition's one home is the publish
 * stage (the key is the published body's address);
 * scheduledReports.ts re-exports it for its existing
 * importers.
 */
export function reportBodyR2Key(reportId: string): string {
  return `reports/${reportId}.json`;
}

async function putReportBodyViaStore(
  store: BlobStore,
  key: string,
  body: string,
): Promise<void> {
  await store.put(key, body, { contentType: "application/json" });
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

function settleCorpusAiSearchTarget(
  env: PublishEnv | undefined,
  doc: CorpusPublishDocument,
  run: NonNullable<PublishDeps["indexCorpusDocInAiSearch"]>,
): Promise<PublishTargetOutcome> {
  return (async (): Promise<PublishTargetOutcome> => {
    try {
      const outcome = await run(env, { meta: doc.meta, bytes: doc.bytes });
      if (outcome.ok) return { target: "ai-search", status: "published" };
      if (outcome.state === "not-configured") {
        // The hook's not-configured state arises exactly when
        // it produced a code ("disabled" flag-off or the
        // executor's "not_configured"); carry it verbatim.
        return {
          target: "ai-search",
          status: "not_configured",
          code: outcome.code,
        };
      }
      return {
        target: "ai-search",
        status: "failed",
        // The hook sets a stable code on every failed outcome;
        // the fallback names the same token its own catch
        // records, so a code-less failure can never reach a
        // caller as a bare failure.
        code: outcome.code ?? "upload_failed",
        ...(outcome.error ? { error: outcome.error } : {}),
      };
    } catch {
      // The hook never throws by contract; a throwing double
      // or a future regression lands here as the same
      // `failed` the hook's own catch would have recorded.
      return { target: "ai-search", status: "failed", code: "upload_failed" };
    }
  })();
}

function settleR2BodyTarget(
  env: PublishEnv | undefined,
  doc: ReportPublishDocument,
  run: NonNullable<PublishDeps["putReportBody"]>,
): Promise<PublishTargetOutcome> {
  // Configured-ness is precomputed exactly as the seam did:
  // createBlobStore returns null when REPORTS_BUCKET is
  // unbound, and the seam's unbound path was a plain inline
  // store, never a failure — so the put executor is never
  // invoked and the outcome is not_configured.
  const store = createBlobStore(env);
  if (!store) {
    return Promise.resolve({ target: "r2-body", status: "not_configured" });
  }
  const key = reportBodyR2Key(doc.documentId);
  return (async (): Promise<PublishTargetOutcome> => {
    try {
      await run(store, key, doc.body);
      return { target: "r2-body", status: "published" };
    } catch (err) {
      // The put produces no stable code; the outcome carries
      // the error's message so the seam's recorded-fallback
      // log line quotes it verbatim, as its inline catch did.
      return {
        target: "r2-body",
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }
  })();
}

/**
 * Publish one stored document to the requested targets
 * (default: the two report index legs, or the corpus
 * document's ai-search leg). Returns synchronously; every
 * promise it hands out resolves (never rejects) with the
 * target's declared outcome.
 */
export function publishDocument(
  env: PublishEnv | undefined,
  doc: PublishDocumentInput,
  deps: PublishDeps = {},
  options: PublishOptions = {},
): PublishHandle {
  const runVectorize = deps.indexCanonicalReport ?? indexCanonicalReport;
  const runAiSearch =
    deps.indexCanonicalReportInAiSearch ?? indexCanonicalReportInAiSearch;
  const runCorpusIndex =
    deps.indexCorpusDocInAiSearch ?? indexCorpusDocInAiSearch;
  const runPutBody = deps.putReportBody ?? putReportBodyViaStore;
  const requested: readonly PublishTargetId[] =
    options.targets ??
    (doc.kind === "corpus" ? ["ai-search"] : ["vectorize", "ai-search"]);
  const targets: PublishTargetHandle[] = [];
  if (requested.includes("r2-body")) {
    targets.push({
      target: "r2-body",
      // A corpus document has no r2-body leg (its R2 write is
      // the store's own put — see the module header): the
      // target is honestly not attempted, never invoked.
      settled:
        doc.kind === "report"
          ? settleR2BodyTarget(env, doc, runPutBody)
          : Promise.resolve({ target: "r2-body", status: "not_attempted" }),
    });
  }
  if (requested.includes("vectorize")) {
    targets.push({
      target: "vectorize",
      // Corpus documents are not Vectorize-indexed (their
      // discovery path is the AI Search items leg): not
      // attempted, executor never invoked.
      settled:
        doc.kind === "report"
          ? settleVectorizeTarget(env, doc, runVectorize)
          : Promise.resolve({ target: "vectorize", status: "not_attempted" }),
    });
  }
  if (requested.includes("ai-search")) {
    targets.push({
      target: "ai-search",
      settled:
        doc.kind === "corpus"
          ? settleCorpusAiSearchTarget(env, doc, runCorpusIndex)
          : settleAiSearchTarget(env, doc, runAiSearch),
    });
  }
  const settled: Promise<PublishOutcome> = Promise.all(
    targets.map((t) => t.settled),
  ).then((outcomes) => ({
    kind: doc.kind,
    documentId: doc.documentId,
    targets: outcomes,
  }));
  return { targets, settled };
}
