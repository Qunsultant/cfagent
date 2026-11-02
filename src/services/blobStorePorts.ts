/**
 * Issue #1777 (Adapter S3, program #1717) — the one BlobStore port.
 *
 * Before S3, four modules touched R2 directly with no shared interface:
 * `reportBlobStore` (report PDFs), `providerCapturePorts` (capture
 * blobs, re-exported by `trading/dataProviders/captureStore`), and
 * inline `REPORTS_BUCKET` put/get/delete in `knowledgeCorpus` and
 * `scheduledReports` — plus post-scan direct reads in
 * `reportAiSearchIndex` / `reportSemanticIndex`, the corpus integrity
 * leg in `corpusSync`, and the retention legs in `routes/schedules`.
 * After S3 every one of those goes through this interface, and the
 * Cloudflare R2 implementation in `blobStoreR2Adapter.ts` is the
 * ONLY module that calls R2 APIs.
 *
 * This file carries types + the interface ONLY — no provider access.
 * The R2 adapter is the Cloudflare implementation behind it; tests
 * use in-memory doubles behind the same interface. Deployment stays
 * on Cloudflare; this is an incremental migration, not a
 * re-platforming. Adapter selection is binding presence at runtime:
 * `createBlobStore` returns null when `REPORTS_BUCKET` is unbound,
 * and each caller keeps its existing unbound contract (corpus
 * throws, canonical reports fall back inline / resolve null, report
 * PDFs and captures fall back to legacy DO storage). No caller
 * contract is removed, so no config switch is needed for this slice:
 * no behavior variant is introduced, only the access path moves.
 */

/** Options for a blob write — the R2 httpMetadata/customMetadata subset. */
export interface BlobPutOptions {
  contentType?: string;
  customMetadata?: Record<string, string>;
}

/** A blob read back through the port. */
export interface BlobObject {
  bytes: Uint8Array;
  contentType?: string;
  customMetadata?: Record<string, string>;
}

/** One page of a key listing. */
export interface BlobListPage {
  keys: string[];
  truncated: boolean;
  cursor?: string;
}

/** Options for a key listing. */
export interface BlobListOptions {
  prefix?: string;
  cursor?: string;
  limit?: number;
}

/**
 * The blob-store port: put / get / delete / list over opaque keys.
 * Keys are bucket keys (e.g. `stocks/pdf/<id>`, `reports/<id>.json`,
 * `knowledge/<category>/<hash>`); key-family mapping stays with the
 * callers (`r2KeyForStorageKey` in `reportBlobStore.ts`).
 */
export interface BlobStore {
  put(key: string, value: Uint8Array | string, options?: BlobPutOptions): Promise<void>;
  get(key: string): Promise<BlobObject | null>;
  delete(key: string): Promise<void>;
  list(options?: BlobListOptions): Promise<BlobListPage>;
}

/** Decode a blob's bytes as UTF-8 text (canonical report bodies). */
export function blobText(obj: BlobObject): string {
  return new TextDecoder().decode(obj.bytes);
}
