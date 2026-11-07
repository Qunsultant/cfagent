/**
 * Issue #3345 — corpus indexing into the Cloudflare AI Search
 * instance, through the namespace binding's items API: the corpus
 * half of the #1169 bridge (the S4-5 design, pulled forward by the
 * 2026-11-05 probe finding).
 *
 * Why this exists: the instance's R2 source indexes the WHOLE
 * `screener` bucket — the curated corpus under `knowledge/` shares
 * it with the data platform's captured market data, and the owner
 * confirmed the dashboard offers no prefix/path control to scope
 * the source. So corpus documents take the same door reports use
 * (#2246): the items API over the private namespace binding, via
 * the ONE upload executor (runAiSearchIndexUpload in
 * src/agents/aiSearchPaths.ts) — this module is the corpus hook
 * beside src/services/reportAiSearchIndex.ts, not a second
 * uploader.
 *
 * Contract (mirroring the report hook's discipline):
 * - Best-effort, ALWAYS: any failure is recorded (console.warn with
 *   the stable event code `ai_search_corpus_index_failed` plus the
 *   outcome code and a truncated hash prefix — never document
 *   content, never credentials) and NEVER fails the corpus write
 *   or the sync. These functions never throw.
 * - The document id is `corpus:<bucketKey>` (the helpers live in
 *   knowledgeCorpus.ts): re-indexing a document re-uploads the
 *   SAME id (the executor upserts by id), so a changed document
 *   (new hash -> new key -> new id) replaces its item and an
 *   unchanged one is a same-id overwrite — idempotent by doc id +
 *   content hash.
 * - Metadata carries the provenance the retrieval side renders:
 *   kind "corpus", the bucket key, the SHA-256 of the served
 *   bytes, storedAt (the document's ingested-at), plus the title,
 *   category and source URL the shared chunk mapping reads.
 * - The indexed text is derived from the SAME bytes the app
 *   serves (hash-verified before indexing on the sync path): the
 *   title/source header plus the document's text — HTML stripped
 *   to text for text/html, plain text as-is. Non-text bytes (the
 *   OCC PDF) contribute their header lines only: there is no PDF
 *   text extractor in this repo, and uploading lossy-decoded
 *   binary would index garbage, not the document.
 * - Flag-gated by AI_SEARCH_CORPUS_INDEXING_ENABLED (absence =
 *   OFF, deliberately not in wrangler.jsonc, mirroring the report
 *   flag's original posture): flag off or binding absent, the
 *   corpus operation still succeeds and the recorded state is
 *   honestly "not-configured".
 * - Corpus items are PLATFORM knowledge: metadata kind "corpus"
 *   carries no ownerLogin, and the agent's report discipline
 *   (aiSearchPaths.ts) never withholds them — they are visible to
 *   every login, unlike kind "report" items.
 *
 * Issue #3527 S3: this hook is now the publish stage's corpus
 * executor. publishDocument (src/services/documentPublish.ts)
 * composes it for kind "corpus" documents, and the two call
 * sites that used to invoke the hook directly — the upload
 * route and this module's backfill leg below — consume the
 * stage's outcome, rendered back into this module's state
 * vocabulary via corpusIndexingStateForPublishOutcome. The
 * hook itself is unchanged: the flag gate, the text
 * derivation, and the never-throws discipline stay here. The
 * corpus R2 write stays in the document store (putKnowledgeDoc
 * IS the store's put — it creates the document); the stage
 * publishes the already-stored document, which is this leg.
 */

import {
  parseKnowledgeBucketKey,
  sha256Hex,
  corpusIndexDocumentId,
  type KnowledgeDocMeta,
  type SeedManifestEntry,
} from "./knowledgeCorpus";
import { r2KeyForStorageKey } from "./reportBlobStore";
import type { BlobStore } from "./blobStorePorts";
import {
  isAiSearchCorpusIndexingEnabled,
  runAiSearchIndexUpload,
  type AiSearchIndexDeps,
  type AiSearchIndexErrorToken,
} from "../agents/aiSearchPaths";
import {
  publishDocument,
  type PublishTargetOutcome,
} from "./documentPublish";
import { AgentErrorCode } from "../aspects/errorCodes";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/corpusAiSearchIndex",
});

/** Stable log event code for a failed/degraded corpus indexing leg. */
export const AI_SEARCH_CORPUS_INDEX_FAILED = "ai_search_corpus_index_failed";

/** The env subset the corpus bridge reads (flag + namespace door). */
export interface CorpusAiSearchIndexEnv {
  AI_SEARCH?: AiSearchNamespace;
  AI_SEARCH_INSTANCE?: string;
  AI_SEARCH_CORPUS_INDEXING_ENABLED?: string;
}

/** The per-item indexing state the sync response and Corpus tab render. */
export type CorpusIndexingState = "indexed" | "not-configured" | "failed";

/**
 * The hook's outcome: the executor's outcome when the leg ran,
 * plus the rendered indexing state; a `disabled` outcome when it
 * did not (flag off) — disabled is a silent no-op at the call site,
 * recorded nowhere, exactly like the report hook's.
 */
export interface CorpusAiSearchIndexOutcome {
  ok: boolean;
  state: CorpusIndexingState;
  code?: AiSearchIndexErrorToken | "disabled";
  errorToken?: AgentErrorCode;
  error?: string;
  correlationId: string;
}

function stateForOutcome(ok: boolean, code?: string): CorpusIndexingState {
  if (ok) return "indexed";
  if (code === "not_configured" || code === "disabled") return "not-configured";
  return "failed";
}

/**
 * Issue #3527 S3: render a publish-stage ai-search outcome in
 * this module's state vocabulary — the mapping the corpus
 * call sites (upload route, backfill leg) apply to the stage
 * outcome they now consume. It is the exact inverse of the
 * stage's corpus mapping (which runs off the hook's own
 * state): published is the hook's "indexed", not_configured
 * its "not-configured", and failed its "failed". A
 * not_attempted stage outcome cannot arise for the corpus
 * ai-search target (requesting the target IS the attempt —
 * the hook owns the gate); it renders "failed" defensively,
 * never a fabricated success.
 */
export function corpusIndexingStateForPublishOutcome(
  outcome: PublishTargetOutcome
): CorpusIndexingState {
  switch (outcome.status) {
    case "published":
      return "indexed";
    case "not_configured":
      return "not-configured";
    default:
      return "failed";
  }
}

/**
 * Derive the indexed text for one corpus document from the bytes
 * the app serves: a title/source/category header, plus the
 * document's own text where the bytes honestly carry text
 * (text/* and JSON content types; HTML stripped to its text).
 * Non-text bytes contribute the header only — see the module
 * header for why no binary is decoded.
 */
export function deriveCorpusIndexText(
  meta: Pick<KnowledgeDocMeta, "title" | "sourceUrl" | "category" | "contentType">,
  bytes: Uint8Array
): string {
  const header = [
    meta.title,
    `Source: ${meta.sourceUrl}`,
    `Category: ${meta.category}`,
  ].join("\n");
  const contentType = (meta.contentType || "").toLowerCase();
  let body = "";
  if (contentType.startsWith("text/") || contentType === "application/json") {
    const decoded = new TextDecoder("utf-8").decode(bytes);
    body = contentType.includes("html") ? htmlToText(decoded) : decoded.trim();
  }
  return body ? `${header}\n\n${body}` : header;
}

const HTML_ENTITIES: Record<string, string> = {
  nbsp: " ",
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  "#39": "'",
};

/** Strip HTML to its text: script/style bodies are not document text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    // Single-pass entity decoding: a source "&amp;lt;" is the literal
    // text "&lt;", never a "<" — decoding must not feed itself.
    .replace(
      /&(nbsp|amp|lt|gt|quot|apos|#39);/gi,
      (match, name: string) => HTML_ENTITIES[name.toLowerCase()] ?? match
    )
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Index one stored corpus document into the AI Search instance.
 * Never throws; inert (state "not-configured", code "disabled")
 * unless AI_SEARCH_CORPUS_INDEXING_ENABLED is on. `deps` is the
 * executor's injection seam (tests substitute the upload).
 */
export async function indexCorpusDocInAiSearch(
  env: CorpusAiSearchIndexEnv | undefined,
  doc: { meta: KnowledgeDocMeta; bytes: Uint8Array },
  deps: AiSearchIndexDeps = {}
): Promise<CorpusAiSearchIndexOutcome> {
  const correlationId = crypto.randomUUID();
  const shaPrefix = doc?.meta?.contentHash?.slice(0, 12) ?? "?";
  try {
    if (!env || !isAiSearchCorpusIndexingEnabled(env)) {
      return { ok: false, code: "disabled", state: "not-configured", correlationId };
    }
    const documentId = corpusIndexDocumentId(doc.meta.r2Key);
    if (!documentId) {
      const error = `Corpus document key "${doc.meta.r2Key}" is not a servable corpus key; no index identity can be derived.`;
      structuredLog.warn("indexCorpusDocInAiSearch.invalid_input", {
        message: `[corpusAiSearchIndex] ${AI_SEARCH_CORPUS_INDEX_FAILED} shaPrefix=${shaPrefix} code=invalid_input: ${error}`,
        eventCode: AI_SEARCH_CORPUS_INDEX_FAILED,
        shaPrefix,
        code: "invalid_input",
        error,
      });
      return {
        ok: false,
        code: "invalid_input",
        state: "failed",
        errorToken: AgentErrorCode.UNKNOWN_AGENT_ERROR,
        correlationId,
        error,
      };
    }
    const outcome = await runAiSearchIndexUpload(
      env,
      {
        id: documentId,
        content: deriveCorpusIndexText(doc.meta, doc.bytes),
        metadata: {
          kind: "corpus",
          key: doc.meta.r2Key,
          sha256: doc.meta.contentHash,
          storedAt: doc.meta.ingestedAt,
          title: doc.meta.title,
          category: doc.meta.category,
          sourceUrl: doc.meta.sourceUrl,
        },
      },
      deps
    );
    if (!outcome.ok) {
      structuredLog.warn("indexCorpusDocInAiSearch.upload_failed", {
        message: `[corpusAiSearchIndex] ${AI_SEARCH_CORPUS_INDEX_FAILED} shaPrefix=${shaPrefix} code=${outcome.code}: ${outcome.error ?? ""}`,
        eventCode: AI_SEARCH_CORPUS_INDEX_FAILED,
        shaPrefix,
        code: outcome.code,
        error: outcome.error ?? "",
      });
    }
    return {
      ...outcome,
      state: stateForOutcome(outcome.ok, outcome.code),
      correlationId: outcome.correlationId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    structuredLog.warn("indexCorpusDocInAiSearch.upload_threw", {
      message: `[corpusAiSearchIndex] ${AI_SEARCH_CORPUS_INDEX_FAILED} shaPrefix=${shaPrefix} code=upload_failed: ${message}`,
      eventCode: AI_SEARCH_CORPUS_INDEX_FAILED,
      shaPrefix,
      code: "upload_failed",
      error: message,
    });
    return {
      ok: false,
      code: "upload_failed",
      state: "failed",
      errorToken: AgentErrorCode.TOOL_EXECUTION_FAILED,
      correlationId,
      error: message,
    };
  }
}

/** One corpus item's indexing state, as the sync response reports it. */
export interface CorpusIndexItemState {
  /** The corpus bucket key (knowledge/<category>/<sha256>). */
  bucketKey: string;
  /** The items-API document id the item is (or would be) stored under. */
  docId: string;
  /** The document title, when a manifest entry or record names it. */
  title?: string;
  /** SHA-256 of the served bytes (the document's identity). */
  sha256: string;
  state: CorpusIndexingState;
  /**
   * Present on failed items: "missing" (no record or no object),
   * "mismatched" (bytes fail the recorded hash), "bucket-unavailable"
   * (no bucket binding to read from), "invalid-key", "read-failed",
   * or the upload executor's outcome code.
   */
  reason?: string;
}

export interface CorpusIndexBackfillOutcome {
  items: CorpusIndexItemState[];
  indexed: number;
  notConfigured: number;
  failed: number;
  /** Present ONLY when the corpus could not even be enumerated. */
  reason?: string;
}

/** Minimal DO-record-store shape (the corpus module's BlobStorage get). */
export interface CorpusIndexRecordStore {
  get<T>(key: string): Promise<T | undefined>;
}

export interface CorpusIndexBackfillDeps {
  manifest: readonly SeedManifestEntry[];
  recordStore: CorpusIndexRecordStore;
  bucket?: BlobStore | null;
}

/**
 * Backfill: index the existing canonical corpus — the seed-manifest
 * documents UNION the knowledge/ objects R2 lists (a listed item
 * with a DO record is corpus whether or not the manifest names
 * it). An item is uploaded only when its record AND object exist
 * and the object's bytes hash-match the record (the corpus
 * module's own scheme, same as the integrity leg): anything else
 * is reported failed with its reason, never uploaded, never
 * fabricated. Never throws.
 */
export async function runCorpusAiSearchIndexBackfill(
  env: CorpusAiSearchIndexEnv | undefined,
  deps: CorpusIndexBackfillDeps
): Promise<CorpusIndexBackfillOutcome> {
  const candidates = new Map<string, { category: string; sha256: string; title?: string }>();
  for (const entry of deps.manifest) {
    if (!entry.sha256) continue;
    const bucketKey = r2KeyForStorageKey(`knowledge:${entry.category}:${entry.sha256}`);
    candidates.set(bucketKey, {
      category: entry.category,
      sha256: entry.sha256,
      title: entry.title,
    });
  }
  const bucket = deps.bucket ?? null;
  if (bucket) {
    try {
      let cursor: string | undefined;
      do {
        const page = await bucket.list({ prefix: "knowledge/", cursor });
        for (const key of page.keys) {
          const parsed = parseKnowledgeBucketKey(key);
          if (!parsed) continue;
          if (!candidates.has(key)) {
            candidates.set(key, { category: parsed.category, sha256: parsed.sha256 });
          }
        }
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      structuredLog.warn("runCorpusAiSearchIndexBackfill.list_failed", {
        message: `[corpusAiSearchIndex] ${AI_SEARCH_CORPUS_INDEX_FAILED} leg=backfill stage=list: ${message}`,
        eventCode: AI_SEARCH_CORPUS_INDEX_FAILED,
        leg: "backfill",
        stage: "list",
        error: message,
      });
      return {
        items: [],
        indexed: 0,
        notConfigured: 0,
        failed: 0,
        reason: `Corpus index backfill could not list the bucket: ${message}`,
      };
    }
  }

  const items: CorpusIndexItemState[] = [];
  for (const bucketKey of [...candidates.keys()].sort()) {
    const candidate = candidates.get(bucketKey)!;
    const documentId = corpusIndexDocumentId(bucketKey);
    const base: Omit<CorpusIndexItemState, "state"> = {
      bucketKey,
      docId: documentId ?? `corpus:${bucketKey}`,
      ...(candidate.title ? { title: candidate.title } : {}),
      sha256: candidate.sha256,
    };
    if (!documentId) {
      items.push({ ...base, state: "failed", reason: "invalid-key" });
      continue;
    }
    if (!bucket) {
      items.push({ ...base, state: "failed", reason: "bucket-unavailable" });
      continue;
    }
    let record: KnowledgeDocMeta | undefined;
    let bytes: Uint8Array | undefined;
    try {
      record = await deps.recordStore.get<KnowledgeDocMeta>(
        `knowledge:${candidate.category}:${candidate.sha256}`
      );
      const obj = await bucket.get(bucketKey);
      bytes = obj?.bytes;
    } catch {
      items.push({ ...base, state: "failed", reason: "read-failed" });
      continue;
    }
    if (!record || !bytes) {
      items.push({ ...base, state: "failed", reason: "missing" });
      continue;
    }
    if ((await sha256Hex(bytes)) !== record.contentHash) {
      items.push({ ...base, state: "failed", reason: "mismatched" });
      continue;
    }
    // Issue #3527 S3: the per-item upload goes through the
    // publish stage (kind "corpus"); the stage composes the
    // hook above, and the item renders the stage outcome in
    // this module's vocabulary — the same state, the same
    // failure reason (the executor's code, verbatim), the
    // same counts the direct hook call produced.
    const publish = publishDocument(env, {
      kind: "corpus",
      documentId: record.r2Key,
      meta: record,
      bytes,
    });
    const aiSearchHandle = publish.targets.find((t) => t.target === "ai-search");
    const targetOutcome = aiSearchHandle ? await aiSearchHandle.settled : undefined;
    items.push({
      ...base,
      title: record.title,
      state: targetOutcome
        ? corpusIndexingStateForPublishOutcome(targetOutcome)
        : "failed",
      ...(targetOutcome?.status === "failed"
        ? { reason: targetOutcome.code ?? "upload_failed" }
        : {}),
    });
  }
  return {
    items,
    indexed: items.filter((i) => i.state === "indexed").length,
    notConfigured: items.filter((i) => i.state === "not-configured").length,
    failed: items.filter((i) => i.state === "failed").length,
  };
}
