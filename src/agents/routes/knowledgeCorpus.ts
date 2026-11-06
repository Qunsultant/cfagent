/**
 * Issue #1169 (S1): knowledge-corpus admin/API upload route (approved
 * gate G4 — API upload first; repo-sync deferred to a later slice).
 *
 *   POST /knowledge/corpus   (externally /api/knowledge/corpus)
 *   JSON body: { title, category, sourceUrl, contentType?, fileName?,
 *                contentBase64 }
 *
 * The body carries base64 (not multipart) mirroring the repo's
 * DO-storage precedent; admin uploads are infrequent and small
 * (seed documents are KBs to low MBs — see
 * docs/knowledge-corpus-seed-manifest.json).
 *
 * Responses:
 * - 201 + full metadata + idempotent:false on a fresh ingest.
 * - 200 + original metadata + idempotent:true when identical bytes
 *   were already stored (hash-idempotent, first title wins).
 * - 401 (shared unauthenticatedResponse) when the x-user-login
 *   header is absent — server.ts sets it from the verified session
 *   and strips it for anonymous traffic (routeIdentity.ts).
 * - 400 on malformed JSON, wrong field types, invalid category,
 *   empty title/bytes, non-http(s) source URL, undecodable base64.
 * - 500 only on an unexpected failure; validation and bucket-binding
 *   failures are honest 400s via KnowledgeCorpusError.
 *
 * FOUR path conditions live in this module (the inventory scanner
 * pins all four): GET /knowledge/file (S2, flag-gated — see below),
 * GET /knowledge/integrity (S4-4, audit read, NOT flag-gated),
 * POST /knowledge/corpus (S1), and POST /knowledge/corpus-sync
 * (S4-4, weekly scheduled sync).
 * Non-matching paths/methods return null so routeRequest falls
 * through to the next handler.
 *
 * S2 serving route (flag-gated): GET /knowledge/file?key=<bucket key>
 * streams bytes through getKnowledgeDoc (hash-verified) the way
 * GET /screener/report.pdf streams reports today. When
 * KNOWLEDGE_SERVING_ENABLED is off, the GET block returns null —
 * exactly today's behavior (no such route). The POST upload route
 * is unaffected by the flag.
 *
 * #1168 note: knowledge/ keys are corpus, not reports — they carry
 * no mas_reports row by design and are excluded from the #1168
 * orphan sweep (see knowledgeCorpus.ts header).
 *
 * #3345 (corpus items-API bridge): the POST upload branch also
 * fires the corpus indexing hook (corpusAiSearchIndex.ts) after a
 * successful write and reports its honest state as
 * `indexing.state` in the response; the corpus-sync branch runs
 * the bridge backfill leg, so the sync response carries per-item
 * indexing state under `corpusIndex`. Both are additive response
 * fields — no existing field changes meaning. The hook and the
 * leg are flag-gated (AI_SEARCH_CORPUS_INDEXING_ENABLED) and
 * best-effort: neither can fail the write or the sync.
 *
 * #3527 S3: both firings now go through the publish stage
 * (publishDocument, kind "corpus") — the upload branch directly,
 * the backfill leg inside corpusAiSearchIndex.ts — with the
 * stage composing the #3345 hook as its corpus executor. The
 * response shapes above are unchanged.
 */

import { unauthenticatedResponse } from "./routeIdentity";
import { base64ToBytes } from "../../services/reportBlobStore";
import { createBlobStore } from "../../services/blobStoreR2Adapter";
import {
  runCorpusIntegrityCheck,
  runCorpusSync,
  runCanonicalIndexBackfillAll,
  shouldFireCorpusSyncTick,
  CORPUS_SYNC_LAST_RUN_KEY,
} from "../../services/corpusSync";
import {
  corpusIndexingStateForPublishOutcome,
  runCorpusAiSearchIndexBackfill,
} from "../../services/corpusAiSearchIndex";
import { publishDocument } from "../../services/documentPublish";
import {
  settingReadFromSql,
  settingWriteFromSql,
} from "../../services/screeningFlags";
import type { SqlStorage } from "../../orm";
// Issue #1169 (S4-4): the seed manifest is a checked-in repo file;
// JSON imports are the established idiom (cf.
// researchEvaluationDatasets.ts importing evaluations/*/manifest.json).
// Entries are mapped to SeedManifestEntry below; the manifest itself
// is never rewritten by this route.
import seedManifest from "../../../docs/knowledge-corpus-seed-manifest.json";
import {
  putKnowledgeDoc,
  getKnowledgeDoc,
  isKnowledgeServingEnabled,
  parseKnowledgeBucketKey,
  KnowledgeCorpusError,
  type KnowledgeCategory,
} from "../../services/knowledgeCorpus";
// Issue #1169 (S2, cross-cutting: externalized messages): every
// NEW serving-route message comes from the aspects catalog —
// never an inline literal. The shared 401 body is the one
// exception, deliberately: it belongs to unauthenticatedResponse()
// (shared by every route) and S2 must not fork it.
import {
  KNOWLEDGE_ERROR_CATALOG,
  KnowledgeErrorCode,
} from "../../aspects/errorCodes";

interface BlobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

export interface KnowledgeCorpusRouteContext {
  env: {
    REPORTS_BUCKET?: R2Bucket;
    KNOWLEDGE_SERVING_ENABLED?: string;
    // Issue #1169 S4-4: AI + Vectorize join the env (type-only
    // widening, cf. the reports route's S4-1 widening) so the
    // corpus-sync branch can run the index backfill; the
    // orchestrator mount already passes the full env.
    AI?: any;
    VECTOR_MEMORY?: any;
    // Issue #3345: the AI Search namespace door + the corpus
    // indexing flag join the env (type-only widening, same idiom)
    // so the upload branch can fire the corpus indexing hook and
    // the corpus-sync branch can run the bridge backfill leg.
    AI_SEARCH?: AiSearchNamespace;
    AI_SEARCH_INSTANCE?: string;
    AI_SEARCH_CORPUS_INDEXING_ENABLED?: string;
  };
  storage: BlobStorage;
  userLogin: string;
  /**
   * Report store (the orchestrator mount passes
   * this.ctx.storage.sql). Optional so older callers keep working;
   * the corpus-sync branch skips honestly when it is absent.
   */
  sql?: SqlStorage;
}

/** Seed-manifest entries, mapped to the corpus module's entry shape. */
const SEED_MANIFEST_ENTRIES = (
  seedManifest as unknown as {
    entries?: Array<Record<string, unknown>>;
  }
).entries?.map((e) => ({
  title: typeof e.title === "string" ? e.title : "",
  category: typeof e.category === "string" ? e.category : "",
  sha256: typeof e.sha256 === "string" ? e.sha256 : null,
  fetchStatus: typeof e.fetchStatus === "string" ? e.fetchStatus : undefined,
})) ?? [];

function badRequest(message: string): Response {
  return Response.json({ success: false, error: message }, { status: 400 });
}

export async function handleKnowledgeCorpusRoutes(
  request: Request,
  url: URL,
  path: string,
  sessionId: string,
  ctx: KnowledgeCorpusRouteContext
): Promise<Response | null> {
  // Issue #1169 (S2, flag-gated): authenticated corpus-file serving.
  // Flag-OFF returns null here — fall-through, exactly today's
  // behavior (no such route exists). Flag-ON: session gate (shared
  // 401), bucket-key parsing (400 on malformed/non-corpus/missing
  // key), hash-verified bytes via getKnowledgeDoc (404 when absent
  // or tampered — a hash mismatch is never served, only refused).
  if (path.endsWith("/knowledge/file") && request.method === "GET") {
    if (!isKnowledgeServingEnabled(ctx.env)) return null;
    // Cross-cutting (S2): structured access/denial logs via the
    // repo's console-stream idiom (loggingAspect.ts). Logged:
    // status, reason code, category, truncated hash prefix, byte
    // count. NEVER logged: the login, the full bucket key, bytes,
    // or any credential/token value. Denial reasons are categories
    // ("missing"/"malformed"), never the submitted key value.
    try {
      if (!ctx.userLogin) {
        // No catalog code here: the 401 body is the SHARED
        // unauthenticatedResponse(), not an S2 catalog entry.
        console.warn(
          `[knowledgeServing] denied GET /knowledge/file status=401 reason=unauthenticated`
        );
        return unauthenticatedResponse();
      }
      const key = url.searchParams.get("key");
      if (!key) {
        console.warn(
          `[knowledgeServing] denied GET /knowledge/file status=400 code=${KnowledgeErrorCode.SERVING_KEY_REQUIRED} reason=missing`
        );
        return badRequest(KNOWLEDGE_ERROR_CATALOG[KnowledgeErrorCode.SERVING_KEY_REQUIRED].defaultMessage);
      }
      const parsed = parseKnowledgeBucketKey(key);
      if (!parsed) {
        console.warn(
          `[knowledgeServing] denied GET /knowledge/file status=400 code=${KnowledgeErrorCode.SERVING_KEY_INVALID} reason=malformed`
        );
        return badRequest(KNOWLEDGE_ERROR_CATALOG[KnowledgeErrorCode.SERVING_KEY_INVALID].defaultMessage);
      }
      const doc = await getKnowledgeDoc(
        ctx.env,
        ctx.storage,
        ctx.userLogin,
        `knowledge:${parsed.category}:${parsed.sha256}`
      );
      if (!doc) {
        console.warn(
          `[knowledgeServing] denied GET /knowledge/file status=404 code=${KnowledgeErrorCode.SERVING_NOT_FOUND} category=${parsed.category} shaPrefix=${parsed.sha256.slice(0, 12)}`
        );
        return Response.json(
          { success: false, error: KNOWLEDGE_ERROR_CATALOG[KnowledgeErrorCode.SERVING_NOT_FOUND].defaultMessage },
          { status: 404 }
        );
      }
      console.info(
        `[knowledgeServing] served GET /knowledge/file status=200 category=${parsed.category} shaPrefix=${parsed.sha256.slice(0, 12)} bytes=${doc.bytes.length}`
      );
      return new Response(doc.bytes as unknown as BodyInit, {
        headers: {
          "Content-Type": doc.meta.contentType,
          "Content-Disposition": `attachment; filename="${doc.meta.fileName}"`,
          "Content-Length": String(doc.bytes.length),
        },
      });
    } catch (err) {
      // NOTE: this differs deliberately from the POST block's
      // KnowledgeCorpusError -> 400 mapping below it. getKnowledgeDoc
      // throws KnowledgeCorpusError in exactly two cases: a missing
      // login (unreachable here — the route gates login first) and
      // an unbound REPORTS_BUCKET (server misconfiguration). Any
      // KnowledgeCorpusError reaching THIS catch is therefore a
      // server error, and 400 would mislabel it: exact 500 semantics.
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[knowledgeServing] failed GET /knowledge/file status=500 code=${KnowledgeErrorCode.SERVING_FAILED}: ${message}`
      );
      return Response.json(
        { success: false, error: KNOWLEDGE_ERROR_CATALOG[KnowledgeErrorCode.SERVING_FAILED].defaultMessage },
        { status: 500 }
      );
    }
  }
  // Issue #1169 (S4-4): session-gated integrity read. NOT
  // flag-gated: integrity is an audit read, not serving, so
  // KNOWLEDGE_SERVING_ENABLED must not gate it. Runs the integrity
  // leg live (read-only) and returns its native JSON shape with 200
  // even when the check could not run — ok:false + reason IS the
  // result, never a fabricated pass.
  if (path.endsWith("/knowledge/integrity") && request.method === "GET") {
    if (!ctx.userLogin) return unauthenticatedResponse();
    try {
      const report = await runCorpusIntegrityCheck({
        manifest: SEED_MANIFEST_ENTRIES,
        recordStore: ctx.storage,
        bucket: createBlobStore(ctx.env),
      });
      console.info(
        `[knowledgeCorpus] integrity GET ok=${report.ok} missing=${report.missing.length} mismatched=${report.mismatched.length} extra=${report.extra.length}`
      );
      return Response.json(report);
    } catch (err) {
      console.error("[knowledgeCorpus] integrity GET failed:", err);
      return Response.json(
        { success: false, error: "Failed to run corpus integrity check." },
        { status: 500 }
      );
    }
  }
  if (path.endsWith("/knowledge/corpus") && request.method === "POST") {
    try {
      if (!ctx.userLogin) return unauthenticatedResponse();
      let body: Record<string, unknown>;
      try {
        body = (await request.json()) as Record<string, unknown>;
      } catch {
        return badRequest("Request body must be valid JSON.");
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return badRequest("Request body must be a JSON object.");
      }
      const { title, category, sourceUrl, contentType, fileName, contentBase64 } = body;
      if (typeof title !== "string" || title.trim().length === 0) {
        return badRequest("Field 'title' must be a non-empty string.");
      }
      if (typeof category !== "string") {
        return badRequest("Field 'category' must be a string.");
      }
      if (typeof sourceUrl !== "string" || sourceUrl.trim().length === 0) {
        return badRequest("Field 'sourceUrl' must be a non-empty string.");
      }
      if (typeof contentBase64 !== "string" || contentBase64.length === 0) {
        return badRequest("Field 'contentBase64' must be a non-empty base64 string.");
      }
      if (contentType !== undefined && typeof contentType !== "string") {
        return badRequest("Field 'contentType' must be a string when present.");
      }
      if (fileName !== undefined && typeof fileName !== "string") {
        return badRequest("Field 'fileName' must be a string when present.");
      }
      let bytes: Uint8Array;
      try {
        bytes = base64ToBytes(contentBase64);
      } catch {
        return badRequest("Field 'contentBase64' is not valid base64.");
      }
      const result = await putKnowledgeDoc(ctx.env, ctx.storage, ctx.userLogin, {
        title,
        category: category as KnowledgeCategory,
        sourceUrl,
        bytes,
        contentType,
        fileName,
      });
      // Issue #3345: the corpus indexing hook fires on every
      // successful write (fresh or hash-idempotent replay — the
      // replay re-uploads the same document id, self-healing an
      // index that missed the first write). Best-effort by
      // contract: the hook never throws, and its honest state
      // (indexed / not-configured / failed) rides the response.
      // Issue #3527 S3: the route now fires the leg through the
      // publish stage (publishDocument, kind "corpus") — the
      // stage composes the same hook as its corpus executor,
      // and the response renders the stage outcome in the
      // corpus state vocabulary, unchanged.
      const publish = publishDocument(ctx.env, {
        kind: "corpus",
        documentId: result.meta.r2Key,
        meta: result.meta,
        bytes,
      });
      const aiSearchHandle = publish.targets.find((t) => t.target === "ai-search");
      const aiSearchOutcome = aiSearchHandle ? await aiSearchHandle.settled : undefined;
      return Response.json(
        {
          success: true,
          ...result.meta,
          idempotent: result.idempotent,
          indexing: {
            state: aiSearchOutcome
              ? corpusIndexingStateForPublishOutcome(aiSearchOutcome)
              : "failed",
          },
        },
        { status: result.idempotent ? 200 : 201 }
      );
    } catch (err) {
      if (err instanceof KnowledgeCorpusError) {
        return badRequest(err.message);
      }
      console.error("[knowledgeCorpus] Upload failed:", err);
      return Response.json(
        { success: false, error: "Failed to ingest knowledge document." },
        { status: 500 }
      );
    }
  }
  // Issue #1169 (S4-4): weekly corpus sync, dispatched from
  // server.ts scheduled() on the existing */30 tick (no new cron
  // trigger — the Workers Free ceiling, same constraint as
  // #354/#705/#754). Session-gated like every other branch (the
  // dispatch carries the service identity via x-user-login).
  // Fire/no-fire is decided by the weekly guard + the durable
  // mas_settings marker, written ONLY on a completed run
  // (integrity executed) so a run that could not check retries on
  // the next tick instead of advancing the marker.
  if (path.endsWith("/knowledge/corpus-sync") && request.method === "POST") {
    if (!ctx.userLogin) return unauthenticatedResponse();
    const sql = ctx.sql;
    if (!sql) {
      return Response.json({
        success: true,
        skipped: true,
        reason: "report-store-unavailable",
      });
    }
    const readSetting = settingReadFromSql(sql);
    const decision = shouldFireCorpusSyncTick(
      new Date(),
      readSetting(CORPUS_SYNC_LAST_RUN_KEY)
    );
    if (!decision.fire) {
      return Response.json({
        success: true,
        skipped: true,
        reason: decision.reason,
        lastFiredAt: decision.lastFiredAt,
      });
    }
    const result = await runCorpusSync({
      manifest: SEED_MANIFEST_ENTRIES,
      recordStore: ctx.storage,
      bucket: createBlobStore(ctx.env),
      backfill: () => runCanonicalIndexBackfillAll(ctx.env, sql),
      // Issue #3345: sync also backfills the corpus items-API
      // bridge — per-item indexing state rides the sync result
      // (and therefore the Corpus tab, which renders sync results).
      corpusIndex: () =>
        runCorpusAiSearchIndexBackfill(ctx.env, {
          manifest: SEED_MANIFEST_ENTRIES,
          recordStore: ctx.storage,
          bucket: createBlobStore(ctx.env),
        }),
    });
    if (result.completed) {
      settingWriteFromSql(sql)(CORPUS_SYNC_LAST_RUN_KEY, result.ranAt);
    }
    return Response.json({ success: true, ...result });
  }
  return null;
}
