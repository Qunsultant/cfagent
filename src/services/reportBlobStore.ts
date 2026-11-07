/**
 * Report PDF blob storage (issue #605, part of #415).
 *
 * PDF blobs move from base64-in-DO-storage to R2. The migration is designed
 * to be safe to merge BEFORE the bucket exists:
 *
 * - When `env.REPORTS_BUCKET` is bound, blobs go to R2 (under the
 *   bucket layout from `r2KeyForStorageKey`: stocks/ + options/
 *   prefixes) and DO storage keeps only a small metadata pointer
 *   `{ r2Key, fileName, storedAt }`.
 * - When the binding is absent (pre-migration), blobs stay in DO storage as
 *   base64, exactly as before.
 * - Reads try R2 first (via the metadata pointer), then fall back to the
 *   legacy base64 blob — so PDFs stored before the migration stay readable.
 *
 * The PDF is always a delivery artifact rendered from the canonical stored
 * copy in mas_reports (#308 model) — never a second copy of the report.
 *
 * Issue #1777 (Adapter S3): the R2 access here goes through the one
 * BlobStore port (`blobStorePorts.ts` / `blobStoreR2Adapter.ts`) —
 * this module keeps its public surface and its legacy DO-storage
 * fallback exactly, only the access path moves behind the port.
 */

import { createBlobStore } from "./blobStoreR2Adapter";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/reportBlobStore",
});

interface BlobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

interface ReportPdfMeta {
  fileName: string;
  storedAt: string;
  /** Present when the blob lives in R2. Absent for legacy DO-storage blobs. */
  r2Key?: string;
  /** Legacy pre-#605 blobs only. */
  base64?: string;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * Issue #605: the R2 bucket layout (bucket `screener`, provisioned by
 * the owner) groups blobs by family — DO storage keys are namespaced
 * `screener:` / `options:`, and the bucket key is the matching folder
 * prefix with the remaining key segments as the path:
 * `screener:pdf:<id>` → `stocks/pdf/<id>`, `options:latest.pdf` →
 * `options/latest.pdf`. Keys outside those families pass through
 * unchanged.
 */
export function r2KeyForStorageKey(key: string): string {
  if (key.startsWith("screener:")) {
    return `stocks/${key.slice("screener:".length).replaceAll(":", "/")}`;
  }
  if (key.startsWith("options:")) {
    return `options/${key.slice("options:".length).replaceAll(":", "/")}`;
  }
  // Issue #1335: goal-screen artifacts live under goals/, mirroring
  // the stocks/ + options/ families above.
  if (key.startsWith("goal_screen:")) {
    return `goals/${key.slice("goal_screen:".length).replaceAll(":", "/")}`;
  }
  // Issue #1169 (S1): knowledge-corpus artifacts live under knowledge/,
  // mirroring the families above. The `knowledge:` namespace is the
  // declared key family for the corpus (approved gate G3); corpus keys
  // are never report keys, so they never collide with the stocks/ +
  // options/ + goals/ families.
  if (key.startsWith("knowledge:")) {
    return `knowledge/${key.slice("knowledge:".length).replaceAll(":", "/")}`;
  }
  return key;
}

export async function putReportPdf(
  env: { REPORTS_BUCKET?: R2Bucket },
  storage: BlobStorage,
  key: string,
  fileName: string,
  bytes: Uint8Array,
  contentType = "application/pdf"
): Promise<void> {
  const store = createBlobStore(env);
  if (store) {
    const r2Key = r2KeyForStorageKey(key);
    await store.put(r2Key, bytes, {
      contentType,
      customMetadata: { fileName },
    });
    const meta: ReportPdfMeta = {
      fileName,
      r2Key,
      storedAt: new Date().toISOString(),
    };
    await storage.put(key, meta);
  } else {
    // Pre-migration: keep the legacy DO-storage blob.
    const meta: ReportPdfMeta = {
      fileName,
      base64: bytesToBase64(bytes),
      storedAt: new Date().toISOString(),
    };
    await storage.put(key, meta);
  }
}

export async function getReportPdf(
  env: { REPORTS_BUCKET?: R2Bucket },
  storage: BlobStorage,
  key: string
): Promise<{ bytes: Uint8Array; fileName: string } | null> {
  const meta = await storage.get<ReportPdfMeta>(key).catch(() => undefined);
  if (!meta) {
    const store = createBlobStore(env);
    if (store) {
      try {
        const obj = await store.get(r2KeyForStorageKey(key));
        if (obj) {
          const fileName = obj.customMetadata?.fileName || `${key.split(":").pop() || "report"}.pdf`;
          return { bytes: obj.bytes, fileName };
        }
      } catch (err) {
        structuredLog.warn("report_blob.direct_r2_read_failed", {
          message: "[reportBlobStore] Direct R2 read failed",
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return null;
  }
  const store = createBlobStore(env);
  if (store && meta.r2Key) {
    try {
      const obj = await store.get(meta.r2Key);
      if (!obj) return null;
      return { bytes: obj.bytes, fileName: meta.fileName };
    } catch (err) {
      structuredLog.warn("report_blob.r2_read_failed", {
        message: "[reportBlobStore] R2 read failed, trying legacy",
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (meta.base64) {
    const bytes = base64ToBytes(meta.base64);
    if (store) {
      // Issue #605 lazy migration: a legacy DO blob read while the
      // bucket is bound is copied to R2 and its DO record rewritten
      // as a pointer, so existing PDFs migrate on first serve and DO
      // storage stops holding PDF bytes. Best-effort — the read
      // itself never fails because a migration write did.
      try {
        const r2Key = r2KeyForStorageKey(key);
        await store.put(r2Key, bytes, {
          contentType: "application/pdf",
          customMetadata: { fileName: meta.fileName },
        });
        const pointer: ReportPdfMeta = {
          fileName: meta.fileName,
          r2Key,
          storedAt: new Date().toISOString(),
        };
        await storage.put(key, pointer);
      } catch (err) {
        structuredLog.warn("report_blob.lazy_r2_migration_failed", {
          message: "[reportBlobStore] Lazy R2 migration failed",
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { bytes, fileName: meta.fileName };
  }
  return null;
}
