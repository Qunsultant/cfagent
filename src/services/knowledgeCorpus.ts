/**
 * Knowledge-corpus storage (issue #1169, S1).
 *
 * Corpus documents live in the SAME `screener` R2 bucket as reports
 * (REPORTS_BUCKET binding) — no second bucket, no new storage stack.
 * The key family is the declared `knowledge:` namespace in
 * r2KeyForStorageKey (reportBlobStore.ts, approved gate G3):
 *   storage key `knowledge:<category>:<sha256>` →
 *   bucket key  `knowledge/<category>/<sha256>`.
 *
 * Metadata on every document (all five required fields, typed):
 * title, category, source URL, ingested-at, content hash (SHA-256 hex
 * of the stored bytes). The DO-storage record holds only the metadata
 * pointer, never the bytes — the same shape as putReportPdf.
 *
 * Honesty rules (live-data only):
 * - Writes are hash-idempotent: the key derives from the content hash,
 *   so a second put of identical bytes is a no-op returning the
 *   original metadata (first title wins).
 * - Reads are hash-verified: bytes whose recomputed hash differs from
 *   the recorded hash are never served (null + warning).
 * - No bucket binding means honest failure (throw), never a silent
 *   DO-storage fallback: corpus bytes belong in R2 or nowhere.
 * - Access is session-gated at the call site: every function requires
 *   a non-empty ownerLogin (the verified session login the route
 *   layer passes through). The corpus is organization knowledge, so
 *   the gate is authentication, not per-tenant partitioning — keys
 *   are not namespaced by login.
 *
 * #1168 EXCLUSION (recorded here per #1169's Requirements; #1168
 * itself stays open and unsolved, its cross-instance key-collection
 * design question is CTO's): knowledge/ keys are corpus, not reports.
 * They deliberately have NO mas_reports row, so the #1168 orphan sweep
 * (which collects bucket objects with no mas_reports row pointing at
 * them) must exclude the knowledge/ prefix. Excluding them is not a
 * loophole — it is the definition: a sweep for orphaned REPORTS must
 * not delete the corpus.
 *
 * Out of scope for S1 (later slices): the serving route (S2), the
 * index (S2), fallback removal (S3), consumers + UI (S4), corpus
 * listing (S4 — DO storage here has get/put only, no key listing).
 *
 * S2 ADDENDUM (issue #1169, flag-gated): the serving helpers below
 * (flag reader, bucket-key parsing, served-file links, seed
 * verification) live here so the serving route, the search mapping,
 * and MAS provenance share ONE implementation. They change nothing
 * about storage: flag-OFF, every caller behaves exactly as before.
 */

import { r2KeyForStorageKey } from "./reportBlobStore";
import { createBlobStore } from "./blobStoreR2Adapter";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/knowledgeCorpus",
});

export type KnowledgeCategory =
  | "sec_filing"
  | "broker_rules"
  | "options_disclosure"
  | "market_education";

export const KNOWLEDGE_CATEGORIES: readonly KnowledgeCategory[] = [
  "sec_filing",
  "broker_rules",
  "options_disclosure",
  "market_education",
];

export interface KnowledgeDocMeta {
  title: string;
  category: KnowledgeCategory;
  sourceUrl: string;
  ingestedAt: string;
  /** SHA-256 hex of the stored bytes. */
  contentHash: string;
  r2Key: string;
  fileName: string;
  contentType: string;
}

export class KnowledgeCorpusError extends Error {}

interface BlobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

type CorpusEnv = { REPORTS_BUCKET?: R2Bucket };

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Copy into a fresh ArrayBuffer-backed view: subtle.digest's
  // BufferSource requires ArrayBufferView<ArrayBuffer>, and a caller's
  // Uint8Array may be backed by a SharedArrayBuffer-like buffer.
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new Uint8Array(bytes));
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function knowledgeStorageKey(category: KnowledgeCategory, contentHash: string): string {
  return `knowledge:${category}:${contentHash}`;
}

function isKnowledgeCategory(value: unknown): value is KnowledgeCategory {
  return (
    typeof value === "string" &&
    (KNOWLEDGE_CATEGORIES as readonly string[]).includes(value)
  );
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export interface PutKnowledgeDocInput {
  title: string;
  category: KnowledgeCategory;
  sourceUrl: string;
  bytes: Uint8Array;
  contentType?: string;
  fileName?: string;
}

export interface PutKnowledgeDocResult {
  meta: KnowledgeDocMeta;
  /** True when identical bytes were already stored (no rewrite). */
  idempotent: boolean;
}

export async function putKnowledgeDoc(
  env: CorpusEnv,
  storage: BlobStorage,
  ownerLogin: string,
  input: PutKnowledgeDocInput
): Promise<PutKnowledgeDocResult> {
  if (!ownerLogin) {
    throw new KnowledgeCorpusError(
      "Unauthorized: corpus ingestion requires an authenticated session."
    );
  }
  if (typeof input.title !== "string" || input.title.trim().length === 0) {
    throw new KnowledgeCorpusError("Corpus document title must be a non-empty string.");
  }
  if (!isKnowledgeCategory(input.category)) {
    throw new KnowledgeCorpusError(
      `Corpus document category must be one of ${KNOWLEDGE_CATEGORIES.join(", ")}.`
    );
  }
  if (!isHttpUrl(input.sourceUrl)) {
    throw new KnowledgeCorpusError("Corpus document sourceUrl must be an http(s) URL.");
  }
  if (!(input.bytes instanceof Uint8Array) || input.bytes.length === 0) {
    throw new KnowledgeCorpusError("Corpus document bytes must be non-empty.");
  }
  const contentHash = await sha256Hex(input.bytes);
  const key = knowledgeStorageKey(input.category, contentHash);
  const existing = await storage.get<KnowledgeDocMeta>(key).catch(() => undefined);
  if (existing && existing.contentHash === contentHash) {
    return { meta: existing, idempotent: true };
  }
  const store = createBlobStore(env);
  if (!store) {
    throw new KnowledgeCorpusError(
      "REPORTS_BUCKET is not bound; corpus ingestion requires the screener bucket."
    );
  }
  const contentType = input.contentType || "application/octet-stream";
  const fileName = input.fileName || `${input.category}-${contentHash.slice(0, 12)}`;
  const r2Key = r2KeyForStorageKey(key);
  await store.put(r2Key, input.bytes, {
    contentType,
    customMetadata: {
      fileName,
      title: input.title,
      category: input.category,
      sourceUrl: input.sourceUrl,
      contentHash,
    },
  });
  const meta: KnowledgeDocMeta = {
    title: input.title,
    category: input.category,
    sourceUrl: input.sourceUrl,
    ingestedAt: new Date().toISOString(),
    contentHash,
    r2Key,
    fileName,
    contentType,
  };
  await storage.put(key, meta);
  return { meta, idempotent: false };
}

/**
 * Issue #1169 (S2, flag-gated): the serving flag.
 *
 * Mirrors the IAAA_WIRING_ENABLED idiom in src/types.ts exactly: the
 * var is a plain string, "1"/"true"/"on" (case-insensitive, trimmed)
 * means ON, and ABSENCE means OFF. The var is deliberately NOT added
 * to wrangler.jsonc — S2 ships default-off, and enablement is a
 * config change only (set the var, redeploy), never a code change.
 * Rollback is unsetting it (or setting "0") and redeploying.
 */
export function isKnowledgeServingEnabled(
  env?: { KNOWLEDGE_SERVING_ENABLED?: string } | null
): boolean {
  const v = env?.KNOWLEDGE_SERVING_ENABLED;
  if (typeof v !== "string") return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

/**
 * Issue #1169 (S2): bucket key -> storage coordinates, or null.
 * Only keys of the exact shape knowledge/<category>/<sha256-hex>
 * are servable; anything else (report keys, malformed keys) is not
 * a corpus document and must never produce a served-file link.
 */
export function parseKnowledgeBucketKey(
  bucketKey: unknown
): { category: KnowledgeCategory; sha256: string } | null {
  if (typeof bucketKey !== "string") return null;
  const m = /^knowledge\/([^/]+)\/([0-9a-f]{64})$/.exec(bucketKey);
  if (!m) return null;
  const [, category, sha256] = m;
  if (!isKnowledgeCategory(category)) return null;
  return { category, sha256 };
}

/**
 * Issue #1169 (S2): the authenticated serving-route link for a
 * corpus bucket key, or undefined when the key is not servable.
 * The route itself (GET /knowledge/file) enforces the session gate
 * and hash-verifies bytes before streaming — a link is a promise
 * the route keeps, never public bucket access.
 */
export function servedFileLinkFor(bucketKey: unknown): string | undefined {
  const parsed = parseKnowledgeBucketKey(bucketKey);
  if (!parsed || typeof bucketKey !== "string") return undefined;
  return `/api/knowledge/file?key=${encodeURIComponent(bucketKey)}`;
}

/**
 * Issue #3345: the AI Search document-id prefix for corpus items
 * uploaded through the namespace binding's items API (the corpus
 * bridge in src/services/corpusAiSearchIndex.ts, reusing the #2246
 * upload executor). The document id is `corpus:<bucketKey>` — the
 * bucket key rides inside the id so the serving-side mapping can
 * recover the servable key (and its served-file link) from an
 * index chunk without inventing provenance. The report leg's
 * prefix (`report:` in aiSearchPaths.ts) is the sibling convention.
 */
export const AI_SEARCH_CORPUS_DOCUMENT_PREFIX = "corpus:";

/**
 * Issue #3345: the items-API document id for a corpus bucket key,
 * or null when the key is not a servable corpus key (only real
 * corpus documents get index identities).
 */
export function corpusIndexDocumentId(bucketKey: unknown): string | null {
  if (!parseKnowledgeBucketKey(bucketKey) || typeof bucketKey !== "string") return null;
  return `${AI_SEARCH_CORPUS_DOCUMENT_PREFIX}${bucketKey}`;
}

/**
 * Issue #3345: recover the servable bucket key from an index item
 * key carrying a corpus document id, or null when the key is not a
 * corpus document id (or its remainder is not a servable corpus
 * key). Callers fall back to the raw key — never a guessed key.
 */
export function corpusBucketKeyFromIndexKey(key: unknown): string | null {
  if (typeof key !== "string") return null;
  if (!key.startsWith(AI_SEARCH_CORPUS_DOCUMENT_PREFIX)) return null;
  const remainder = key.slice(AI_SEARCH_CORPUS_DOCUMENT_PREFIX.length);
  return parseKnowledgeBucketKey(remainder) ? remainder : null;
}

/**
 * Issue #1169 (S2): attach corpus provenance to one raw upstream
 * search chunk (MAS path). Index-returned chunks are, by definition,
 * indexed; a served-file link is attached ONLY when the chunk's key
 * is a servable corpus key (a link to anything else would 404, which
 * is a worse lie than no link). Non-object chunks pass through
 * untouched. Report chunks are never passed through here — callers
 * attach provenance to index chunks only.
 */
export function attachCorpusProvenance(chunk: unknown): unknown {
  if (typeof chunk !== "object" || chunk === null || Array.isArray(chunk)) return chunk;
  const record = chunk as Record<string, unknown>;
  const rawKey = typeof record.key === "string" ? record.key : undefined;
  // Issue #3345: an items-API corpus chunk carries the corpus
  // document id (`corpus:<bucketKey>`) as its key; resolve it to
  // the servable bucket key so provenance renders exactly as it
  // does for an R2-source corpus chunk.
  const bucketKey = rawKey
    ? (corpusBucketKeyFromIndexKey(rawKey) ?? rawKey)
    : undefined;
  const servedFileLink = bucketKey ? servedFileLinkFor(bucketKey) : undefined;
  return {
    ...record,
    ...(bucketKey ? { bucketKey } : {}),
    ...(servedFileLink ? { servedFileLink } : {}),
    indexingState: "indexed",
  };
}

export interface SeedManifestEntry {
  title: string;
  category: string;
  sha256: string | null;
  fetchStatus?: string;
}

export interface SeedVerificationResult {
  title: string;
  category: string;
  expectedSha256: string | null;
  storedHash?: string;
  status: "match" | "mismatch" | "missing" | "skipped-not-seeded";
}

export interface SeedVerificationReport {
  results: SeedVerificationResult[];
  /** True when every non-skipped entry matches. */
  allMatch: boolean;
  /**
   * ALWAYS false: stored-in-R2 is not indexed. Index confirmation
   * requires the Step 0 live probe (owner dashboard + probe gate) —
   * no code path may report a seeded document as indexed until a
   * probe proves it. This field exists so no caller can mistake a
   * storage check for an index check.
   */
  indexConfirmed: false;
  indexNote: string;
}

/**
 * Issue #1169 (S2, Step 4): hash-check stored corpus documents
 * against the seed manifest (docs/knowledge-corpus-seed-manifest.json).
 * `stored` maps storage keys (knowledge:<category>:<sha256>) to their
 * recorded content hashes. Entries with no hash or a non-"verified"
 * fetchStatus (e.g. the NVIDIA 10-K, blocked-by-source-bot-gate) are
 * SKIPPED, never reported missing — they are not seeded by automation,
 * and reporting them missing would demand an automated fetch the
 * manifest forbids. This verifies STORAGE only; see indexConfirmed.
 */
export function verifySeedManifest(
  entries: readonly SeedManifestEntry[],
  stored: ReadonlyMap<string, { contentHash: string }>
): SeedVerificationReport {
  // Cross-cutting (S2): seeding hash-check pass/fail is logged via
  // the repo's console-stream idiom (loggingAspect.ts). Logged per
  // entry: manifest title (a public document label, never PII),
  // category, status, truncated hash prefix. NEVER logged: bytes,
  // full hashes, credentials, or tokens. A mismatch/missing is a
  // WARN (actionable failure); match/skipped is INFO.
  const results: SeedVerificationResult[] = entries.map((entry) => {
    const shaPrefix = entry.sha256 ? entry.sha256.slice(0, 12) : "none";
    if (entry.sha256 === null || (entry.fetchStatus !== undefined && entry.fetchStatus !== "verified")) {
      structuredLog.info("knowledgeCorpus.seed_hash_check_skipped", {
        message: `[knowledgeSeed] hash-check title="${entry.title}" category=${entry.category} status=skipped-not-seeded shaPrefix=${shaPrefix}`,
        title: entry.title,
        category: entry.category,
        status: "skipped-not-seeded",
        shaPrefix,
      });
      return {
        title: entry.title,
        category: entry.category,
        expectedSha256: entry.sha256,
        status: "skipped-not-seeded",
      };
    }
    const record = stored.get(`knowledge:${entry.category}:${entry.sha256}`);
    if (!record) {
      structuredLog.warn("knowledgeCorpus.seed_hash_check_missing", {
        message: `[knowledgeSeed] hash-check title="${entry.title}" category=${entry.category} status=missing shaPrefix=${shaPrefix}`,
        title: entry.title,
        category: entry.category,
        status: "missing",
        shaPrefix,
      });
      return {
        title: entry.title,
        category: entry.category,
        expectedSha256: entry.sha256,
        status: "missing",
      };
    }
    const status = record.contentHash === entry.sha256 ? "match" : "mismatch";
    if (status === "match") {
      structuredLog.info("knowledgeCorpus.seed_hash_check_match", {
        message: `[knowledgeSeed] hash-check title="${entry.title}" category=${entry.category} status=match shaPrefix=${shaPrefix}`,
        title: entry.title,
        category: entry.category,
        status: "match",
        shaPrefix,
      });
    } else {
      structuredLog.warn("knowledgeCorpus.seed_hash_check_mismatch", {
        message: `[knowledgeSeed] hash-check title="${entry.title}" category=${entry.category} status=mismatch shaPrefix=${shaPrefix}`,
        title: entry.title,
        category: entry.category,
        status: "mismatch",
        shaPrefix,
      });
    }
    return {
      title: entry.title,
      category: entry.category,
      expectedSha256: entry.sha256,
      storedHash: record.contentHash,
      status,
    };
  });
  const counts = results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>
  );
  const allMatch = results
    .filter((r) => r.status !== "skipped-not-seeded")
    .every((r) => r.status === "match");
  structuredLog.info("knowledgeCorpus.seed_hash_check_summary", {
    message: `[knowledgeSeed] summary match=${counts.match ?? 0} mismatch=${counts.mismatch ?? 0} missing=${counts.missing ?? 0} skipped-not-seeded=${counts["skipped-not-seeded"] ?? 0} allMatch=${allMatch}`,
    match: counts.match ?? 0,
    mismatch: counts.mismatch ?? 0,
    missing: counts.missing ?? 0,
    skippedNotSeeded: counts["skipped-not-seeded"] ?? 0,
    allMatch,
  });
  return {
    results,
    allMatch,
    indexConfirmed: false,
    indexNote:
      "Stored-in-R2 is not indexed: live-index confirmation requires the Step 0 probe (owner dashboard + live probe gate).",
  };
}

export async function getKnowledgeDoc(
  env: CorpusEnv,
  storage: BlobStorage,
  ownerLogin: string,
  key: string
): Promise<{ bytes: Uint8Array; meta: KnowledgeDocMeta } | null> {
  if (!ownerLogin) {
    throw new KnowledgeCorpusError(
      "Unauthorized: corpus reads require an authenticated session."
    );
  }
  const meta = await storage.get<KnowledgeDocMeta>(key).catch(() => undefined);
  if (!meta) return null;
  const store = createBlobStore(env);
  if (!store) {
    throw new KnowledgeCorpusError(
      "REPORTS_BUCKET is not bound; corpus bytes are unreachable without the screener bucket."
    );
  }
  let obj: { bytes: Uint8Array } | null;
  try {
    obj = await store.get(meta.r2Key);
  } catch (err) {
    structuredLog.warn("knowledgeCorpus.r2_read_failed", {
      message: `[knowledgeCorpus] R2 read failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!obj) return null;
  const bytes = obj.bytes;
  if ((await sha256Hex(bytes)) !== meta.contentHash) {
    structuredLog.warn("knowledgeCorpus.hash_mismatch_refused", {
      message: `[knowledgeCorpus] Hash mismatch for ${meta.r2Key}: stored bytes do not match recorded contentHash; refusing to serve.`,
      r2Key: meta.r2Key,
    });
    return null;
  }
  return { bytes, meta };
}
