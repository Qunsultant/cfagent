/**
 * Issue #1777 (Adapter S3, program #1717) — the Cloudflare R2
 * implementation of the BlobStore port (`blobStorePorts.ts`).
 *
 * This is the ONLY module in the repo that calls R2 APIs
 * (`put` / `get` / `delete` / `list` on `REPORTS_BUCKET`). Every other
 * module reaches blob storage through the `BlobStore` interface;
 * application code must not import this module's R2 calls, only the
 * port and this factory.
 *
 * Generalised from `reportBlobStore.ts`'s put/get mechanics: writes
 * carry httpMetadata contentType + customMetadata, reads return
 * bytes + contentType + customMetadata, a missing object reads as
 * null, and listing maps R2's paginated objects to key pages.
 */

import type {
  BlobListOptions,
  BlobListPage,
  BlobObject,
  BlobPutOptions,
  BlobStore,
} from "./blobStorePorts";

/** The env half the adapter needs — the R2 binding, nothing else. */
export interface BlobStoreEnv {
  REPORTS_BUCKET?: R2Bucket;
}

class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async put(key: string, value: Uint8Array | string, options?: BlobPutOptions): Promise<void> {
    await this.bucket.put(key, value, {
      httpMetadata: options?.contentType ? { contentType: options.contentType } : undefined,
      customMetadata: options?.customMetadata,
    });
  }

  async get(key: string): Promise<BlobObject | null> {
    const obj = await this.bucket.get(key);
    if (!obj) return null;
    // Real R2ObjectBody carries arrayBuffer(); text-only doubles
    // (e.g. the #338 S2 fake bucket) carry text() instead — read
    // bytes through whichever the object offers, same content.
    const bytes =
      typeof (obj as { arrayBuffer?: unknown }).arrayBuffer === "function"
        ? new Uint8Array(await obj.arrayBuffer())
        : new TextEncoder().encode(await obj.text());
    return {
      bytes,
      contentType: obj.httpMetadata?.contentType,
      customMetadata: obj.customMetadata,
    };
  }

  async delete(key: string): Promise<void> {
    await this.bucket.delete(key);
  }

  async list(options?: BlobListOptions): Promise<BlobListPage> {
    const page = await this.bucket.list({
      prefix: options?.prefix,
      cursor: options?.cursor,
      limit: options?.limit,
    });
    return {
      keys: page.objects.map((o) => o.key),
      truncated: page.truncated,
      // R2Objects only carries cursor on the truncated variant.
      cursor: (page as { cursor?: string }).cursor,
    };
  }
}

/**
 * Build the BlobStore for an env, or null when `REPORTS_BUCKET` is
 * unbound. Callers keep their existing unbound contract on null
 * (throw / inline fallback / resolve-null / legacy DO storage) —
 * the port never invents a store when the binding is absent.
 */
export function createBlobStore(env: BlobStoreEnv | undefined | null): BlobStore | null {
  const bucket = env?.REPORTS_BUCKET;
  if (!bucket) return null;
  return new R2BlobStore(bucket);
}
