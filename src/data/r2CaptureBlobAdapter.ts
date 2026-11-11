/**
 * Issue #3941 (sub of #3550) — feed parity: an R2-backed
 * CaptureBlobStorage for the workflow residency.
 *
 * The workflow residency has no Durable Object storage, so it
 * cannot use the host's DO-shaped metadata store — but it DOES
 * have the REPORTS_BUCKET R2 binding (the same BlobStore port
 * the raw capture bytes ride). This adapter stores the capture
 * metadata as JSON objects in that bucket, under the
 * `data-capture-meta/` prefix — never under the bare blob ref,
 * because the raw bytes themselves live under the bare key
 * (putCaptureBlob) and the same key must never hold both.
 *
 * Returns null when REPORTS_BUCKET is unbound: the factory
 * refuses by name in that case — never a silent fallback to
 * an uncaptured fetch.
 */
import { createBlobStore } from "../services/blobStoreR2Adapter";
import type { CaptureBlobEnv, CaptureBlobStorage } from "./providerCapturePorts";

/** Prefix for capture-metadata objects — disjoint from raw blob refs. */
const CAPTURE_META_PREFIX = "data-capture-meta/";

export function createR2CaptureBlobStorage(
  env: CaptureBlobEnv | undefined | null,
): CaptureBlobStorage | null {
  const store = createBlobStore(env);
  if (!store) return null;
  return {
    async get<T>(key: string): Promise<T | undefined> {
      const obj = await store.get(`${CAPTURE_META_PREFIX}${key}`);
      if (!obj) return undefined;
      try {
        return JSON.parse(new TextDecoder().decode(obj.bytes)) as T;
      } catch {
        return undefined;
      }
    },
    async put(key: string, value: unknown): Promise<void> {
      await store.put(`${CAPTURE_META_PREFIX}${key}`, JSON.stringify(value), {
        contentType: "application/json",
      });
    },
  };
}
