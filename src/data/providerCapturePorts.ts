/**
 * Issue #2303 (#1976 step 1, ADR 0022 D-0/D-I step 1) —
 * provider-capture port for the #1116 data-provider platform:
 * every retrieval routed through the platform leaves a capture
 * (what the provider returned, what the platform normalized it
 * to, which run fetched it, under which tenant scope).
 *
 * RESIDENCY (the step-1 audit, recorded on #2303): the D-0
 * matrix left captures a judgement call ruled by read locality.
 * The audit found the family's durable reader is a CROSS-RUN
 * aggregation (provider health, providerHealth.ts) whose scope
 * exceeds the writing instance — writers and the health reader
 * run in different DOs today, so the health view is silently a
 * per-instance fragment — while no write consumes DO
 * serialization (single-row appends; the blob rides the
 * storage-agnostic blob seam). Ruling: **D1** (migration 0019,
 * agent_data_captures), per D-0's deciding factor. Adapters:
 * d1ProviderCaptureAdapter.ts (production),
 * inMemoryProviderCaptureAdapter.ts (test double),
 * doSqliteProviderCaptureAdapter.ts (the legacy DO store
 * behind the same port).
 *
 * This module carries the record types, the shared mechanics
 * (canonical JSON + hashing, the blob seam, run-context
 * resolution), the record flows (recordCapture /
 * recordFetchFailure — written ONCE here over a minimal row
 * store so the never-throws failure semantics cannot drift
 * between adapters), and the port interface. The types moved
 * here from src/trading/dataProviders/captureStore.ts, which
 * is now a re-export shim over the DO adapter.
 *
 * FAILURE SEMANTICS (epic Requirement 3, E1 #1133):
 * recordCapture NEVER throws: a failed capture write leaves
 * the fetch result untouched, logs a structured error, and
 * records a failure marker row (status "capture_failed") that
 * the store's queries return alongside successful captures —
 * the audit trail shows its own gaps. If even the marker
 * cannot be written, the failure is logged and an unpersisted
 * marker record is returned. recordFetchFailure extends the
 * same invariant to the fetch-failure dimension (E7, #1248).
 *
 * RAW FIDELITY: the capture stores the parsed JSON object
 * exactly as the provider seam produced it (byte-for-byte at
 * the JSON level) — see the `rawKind` vocabulary below; a
 * literal wire-body capture is deliberately absent from the
 * vocabulary rather than claimed.
 */
import type {
  DataProviderCapability,
  DataProviderId,
  DataRunContext,
} from "../trading";
import {
  scrubFailureMessage,
  type FetchFailureKind,
  type FetchOutcomeMeta,
  type FetchOutcomeRecorder,
} from "../trading";
import { createBlobStore } from "../services/blobStoreR2Adapter";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "data/providerCapturePorts",
});

export const DATA_CAPTURE_TABLE = "mas_data_captures";

/** Retention classifications — assessment-01 §8.1 target principles. */
export type DataCaptureRetentionClass =
  | "ephemeral"
  | "retained-30d"
  | "retained-365d"
  | "permanent-audit";

export const DEFAULT_CAPTURE_RETENTION_CLASS: DataCaptureRetentionClass =
  "retained-365d";

/**
 * Which seam supplied the raw payload: "provider-response" =
 * the provider's pre-normalization response payload;
 * "provider-result" = the deepest object the seam exposes, the
 * wrapped implementation's result.
 */
export type DataCaptureRawKind = "provider-response" | "provider-result";

/**
 * captured       — raw payload stored, metadata complete.
 * capture_failed — the capture WRITE failed; the fetch succeeded.
 * no_payload     — the fetch completed with no payload to store;
 *                  an audit row exists, no raw is fabricated.
 * fetch_failed   — E7 (#1248): the FETCH itself failed (threw);
 *                  the row carries the classified kind + a
 *                  scrubbed, bounded message, and no payload.
 */
export type DataCaptureStatus =
  | "captured"
  | "capture_failed"
  | "no_payload"
  | "fetch_failed";

export interface DataCaptureRecord {
  id: string;
  providerId: DataProviderId;
  capability: DataProviderCapability;
  /** The caller's request parameters, in canonical (normalized) form. */
  requestParams: Record<string, unknown>;
  runId: string;
  tenantId: string;
  userLogin: string | null;
  fetchedAt: string;
  status: DataCaptureStatus;
  rawKind: DataCaptureRawKind | null;
  /** Blob-seam key of the stored raw payload; null when nothing is stored. */
  rawBlobRef: string | null;
  rawByteSize: number | null;
  rawSha256: string | null;
  /** SHA-256 of the canonical JSON of the normalized result the caller received. */
  normalizedDigest: string | null;
  retentionClass: DataCaptureRetentionClass;
  failureError: string | null;
  /** E7: the classified fetch-failure kind — set only on fetch_failed rows. */
  failureKind: FetchFailureKind | null;
  /** E7: the fetch failure's message after scrubbing (≤200 chars) — fetch_failed rows only. */
  failureMessage: string | null;
  createdAt: string;
}

/** The blob seam's storage half — the same shape reportBlobStore consumes. */
export interface CaptureBlobStorage {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/** The blob seam's env half — R2 when the #605 bucket is bound. */
export interface CaptureBlobEnv {
  REPORTS_BUCKET?: R2Bucket;
}

export interface CaptureBlobDeps {
  storage: CaptureBlobStorage;
  env: CaptureBlobEnv;
}

export interface RecordCaptureInput {
  providerId: DataProviderId;
  capability: DataProviderCapability;
  /** The caller's request parameters (normalized to canonical JSON for storage). */
  requestParams: unknown;
  runId: string;
  tenantId: string;
  userLogin?: string | null;
  /**
   * The raw payload object as received at the seam. A string payload is
   * stored as its exact bytes (the future wire-body path); anything
   * else is serialized with JSON.stringify, preserving the received
   * key order. Omit for a completed fetch that produced no payload
   * (recorded as status "no_payload").
   */
  rawPayload?: unknown;
  /** Required in spirit when rawPayload is present; defaults to "provider-result". */
  rawKind?: DataCaptureRawKind;
  /** The normalized result the caller received; its canonical digest is stored. */
  normalizedResult?: unknown;
  retentionClass?: DataCaptureRetentionClass;
  /** Fetch timestamp override (tests / backfill); defaults to now. */
  fetchedAt?: string;
}

export interface RecordFetchFailureInput {
  providerId: DataProviderId;
  capability: DataProviderCapability;
  /** The caller's request parameters (normalized to canonical JSON for storage). */
  requestParams: unknown;
  runId: string;
  tenantId: string;
  userLogin?: string | null;
  /** The classified failure kind (fetchOutcome.ts's Strategy). */
  kind: FetchFailureKind;
  /** The failure's raw message — scrubbed + bounded HERE, at the storage boundary. */
  message: string;
  retentionClass?: DataCaptureRetentionClass;
  /** Fetch timestamp override (tests / backfill); defaults to now. */
  fetchedAt?: string;
}

/* ------------------------------------------------------------------ */
/* Run-context resolution — no platform fetch is ever unattributable.  */
/* ------------------------------------------------------------------ */

export function generateCollectionRunId(): string {
  return `collection-${crypto.randomUUID()}`;
}

export interface ResolvedRunContext {
  runId: string;
  tenantId: string;
  userLogin: string | null;
}

/**
 * Resolve a caller's optional run context to the concrete
 * attribution every capture carries: a missing runId becomes a
 * generated collection-run id, a missing tenant becomes
 * "default" (the platform's established default scope).
 */
export function resolveRunContext(
  ctx?: DataRunContext | null
): ResolvedRunContext {
  return {
    runId: ctx?.runId ?? generateCollectionRunId(),
    tenantId: ctx?.tenantId ?? "default",
    userLogin: ctx?.userLogin ?? null,
  };
}

/* ------------------------------------------------------------------ */
/* Canonical JSON + hashing                                            */
/* ------------------------------------------------------------------ */

/**
 * Canonical JSON: object keys sorted recursively, so two
 * structurally equal values serialize identically regardless of
 * construction order. This is the NORMALIZED form (digests,
 * stored request params) — never used for raw payloads, which
 * keep their received order.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`)
    .join(",")}}`;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ------------------------------------------------------------------ */
/* Blob seam — mirrors reportBlobStore's mechanics, JSON semantics.    */
/* ------------------------------------------------------------------ */

interface CaptureBlobMeta {
  storedAt: string;
  /** Present when the blob lives in R2. Absent for DO-storage blobs. */
  r2Key?: string;
  /** DO-storage blobs only (pre-#605 binding). */
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

function base64ToBytes(base64: string): Uint8Array {
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function putCaptureBlob(
  env: CaptureBlobEnv,
  storage: CaptureBlobStorage,
  key: string,
  bytes: Uint8Array
): Promise<void> {
  // Issue #1777 (Adapter S3): the R2 access goes through the one
  // BlobStore port; the CaptureBlobStorage metadata shape and both
  // function signatures stay exactly as callers know them.
  const store = createBlobStore(env);
  if (store) {
    await store.put(key, bytes, {
      contentType: "application/json",
      customMetadata: { captureKey: key },
    });
    const meta: CaptureBlobMeta = {
      storedAt: new Date().toISOString(),
      r2Key: key,
    };
    await storage.put(key, meta);
  } else {
    const meta: CaptureBlobMeta = {
      storedAt: new Date().toISOString(),
      base64: bytesToBase64(bytes),
    };
    await storage.put(key, meta);
  }
}

export async function getCaptureBlob(
  env: CaptureBlobEnv,
  storage: CaptureBlobStorage,
  key: string
): Promise<Uint8Array | null> {
  const meta = await storage.get<CaptureBlobMeta>(key).catch(() => undefined);
  if (!meta) {
    // #3941 (feed parity): the raw bytes live in R2 under the bare
    // blob ref in BOTH residencies, while the metadata lives in the
    // residency's own store — so a reader whose metadata store
    // never saw this key (the other residency's write) still finds
    // the bytes through the R2 object itself. Only on a metadata
    // miss; a hit reads exactly as before.
    const store = createBlobStore(env);
    if (!store) return null;
    try {
      const obj = await store.get(key);
      return obj ? obj.bytes : null;
    } catch (err) {
      structuredLog.warn("providerCapturePorts.capture_blob_r2_fallback_read_failed", {
        message: "[dataProviders] capture blob R2 fallback read failed",
        error: err instanceof Error ? err.message : String(err),
        key,
      });
      return null;
    }
  }
  const store = createBlobStore(env);
  if (store && meta.r2Key) {
    try {
      const obj = await store.get(meta.r2Key);
      if (!obj) return null;
      return obj.bytes;
    } catch (err) {
      console.warn("[dataProviders] capture blob R2 read failed:", err);
      return null;
    }
  }
  if (meta.base64) return base64ToBytes(meta.base64);
  return null;
}

/* ------------------------------------------------------------------ */
/* The record flows — written once, over a minimal row store.          */
/* ------------------------------------------------------------------ */

/**
 * The minimal row surface the record flows need. Each adapter
 * implements it over its own store; the flows (and their
 * never-throws failure semantics) exist exactly once, here, so
 * they cannot drift between adapters.
 */
export interface CaptureRowStore {
  insertRow(record: DataCaptureRecord): Promise<void> | void;
  getById(
    tenantId: string,
    id: string
  ): Promise<DataCaptureRecord | null> | DataCaptureRecord | null;
}

function parseParams(text: unknown): Record<string, unknown> {
  if (typeof text !== "string" || text === "") return {};
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Record one capture. NEVER throws (see the header's failure
 * semantics): on success returns the stored record; on a write
 * failure returns the failure-marker record (persisted when the
 * store allows, unpersisted when it does not).
 */
export async function recordCaptureWithStore(
  rows: CaptureRowStore,
  blobDeps: CaptureBlobDeps,
  input: RecordCaptureInput
): Promise<DataCaptureRecord> {
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const base: Omit<DataCaptureRecord, "status" | "rawKind" | "rawBlobRef" | "rawByteSize" | "rawSha256" | "normalizedDigest" | "failureError" | "failureKind" | "failureMessage"> = {
    id: crypto.randomUUID(),
    providerId: input.providerId,
    capability: input.capability,
    requestParams: parseParams(canonicalJson(input.requestParams ?? {})),
    runId: input.runId,
    tenantId: input.tenantId,
    userLogin: input.userLogin ?? null,
    fetchedAt,
    retentionClass: input.retentionClass ?? DEFAULT_CAPTURE_RETENTION_CLASS,
    createdAt: fetchedAt,
  };
  const rawKind: DataCaptureRawKind | null =
    input.rawPayload === undefined
      ? null
      : (input.rawKind ?? "provider-result");
  let rawBytes: Uint8Array | null = null;
  let rawSha256: string | null = null;
  let normalizedDigest: string | null = null;

  try {
    if (input.normalizedResult !== undefined) {
      normalizedDigest = await sha256Hex(canonicalJson(input.normalizedResult));
    }
    if (input.rawPayload === undefined) {
      const record: DataCaptureRecord = {
        ...base,
        status: "no_payload",
        rawKind: null,
        rawBlobRef: null,
        rawByteSize: null,
        rawSha256: null,
        normalizedDigest,
        failureError:
          "Provider returned no payload for this request; no raw response was available at the adapter seam.",
        failureKind: null,
        failureMessage: null,
      };
      await rows.insertRow(record);
      return (await rows.getById(base.tenantId, base.id)) ?? record;
    }
    rawBytes =
      typeof input.rawPayload === "string"
        ? new TextEncoder().encode(input.rawPayload)
        : new TextEncoder().encode(JSON.stringify(input.rawPayload));
    rawSha256 = await sha256Hex(rawBytes);
    const blobRef = `data-capture:${base.tenantId}:${base.id}`;
    await putCaptureBlob(blobDeps.env, blobDeps.storage, blobRef, rawBytes);
    const record: DataCaptureRecord = {
      ...base,
      status: "captured",
      rawKind,
      rawBlobRef: blobRef,
      rawByteSize: rawBytes.byteLength,
      rawSha256,
      normalizedDigest,
      failureError: null,
      failureKind: null,
      failureMessage: null,
    };
    await rows.insertRow(record);
    return (await rows.getById(base.tenantId, base.id)) ?? record;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[dataProviders] capture write failed", {
      captureId: base.id,
      providerId: base.providerId,
      capability: base.capability,
      runId: base.runId,
      tenantId: base.tenantId,
      error: message,
    });
    const marker: DataCaptureRecord = {
      ...base,
      status: "capture_failed",
      rawKind,
      rawBlobRef: null,
      rawByteSize: rawBytes?.byteLength ?? null,
      rawSha256,
      normalizedDigest,
      failureError: message,
      failureKind: null,
      failureMessage: null,
    };
    try {
      await rows.insertRow(marker);
      return (await rows.getById(base.tenantId, base.id)) ?? marker;
    } catch (markerErr) {
      console.error("[dataProviders] capture failure marker write failed", {
        captureId: base.id,
        providerId: base.providerId,
        capability: base.capability,
        runId: base.runId,
        tenantId: base.tenantId,
        error:
          markerErr instanceof Error ? markerErr.message : String(markerErr),
      });
      return marker;
    }
  }
}

/**
 * Record one failed fetch (E7). NEVER throws: on success
 * returns the stored record; on a write failure logs and
 * returns the unpersisted record. The stored message is
 * scrubbed at this boundary (scrubFailureMessage), so no
 * caller can persist credential material by forgetting.
 */
export async function recordFetchFailureWithStore(
  rows: CaptureRowStore,
  input: RecordFetchFailureInput
): Promise<DataCaptureRecord> {
  const fetchedAt = input.fetchedAt ?? new Date().toISOString();
  const record: DataCaptureRecord = {
    id: crypto.randomUUID(),
    providerId: input.providerId,
    capability: input.capability,
    requestParams: parseParams(canonicalJson(input.requestParams ?? {})),
    runId: input.runId,
    tenantId: input.tenantId,
    userLogin: input.userLogin ?? null,
    fetchedAt,
    status: "fetch_failed",
    rawKind: null,
    rawBlobRef: null,
    rawByteSize: 0,
    rawSha256: null,
    normalizedDigest: null,
    retentionClass: input.retentionClass ?? DEFAULT_CAPTURE_RETENTION_CLASS,
    failureError: null,
    failureKind: input.kind,
    failureMessage: scrubFailureMessage(input.message ?? ""),
    createdAt: fetchedAt,
  };
  try {
    await rows.insertRow(record);
    return (await rows.getById(record.tenantId, record.id)) ?? record;
  } catch (err) {
    console.error("[dataProviders] fetch-failure record write failed", {
      captureId: record.id,
      providerId: record.providerId,
      capability: record.capability,
      runId: record.runId,
      tenantId: record.tenantId,
      failureKind: record.failureKind,
      error: err instanceof Error ? err.message : String(err),
    });
    return record;
  }
}

/**
 * The FetchOutcomeRecorder over a row store: recordFailure
 * writes the fetch_failed row; recordSuccess writes NOTHING —
 * on this platform a fetch's success record is the capture row
 * the adapter writes for that same fetch (captured / no_payload,
 * or the capture_failed marker), so writing here too would
 * double-count every success. The recorder never throws.
 */
export function createFetchOutcomeRecorderWithStore(
  rows: CaptureRowStore
): FetchOutcomeRecorder {
  return {
    recordSuccess: async (_meta: FetchOutcomeMeta) => {
      // Attested by the fetch's capture row — see the note above.
    },
    recordFailure: async (meta, failure) => {
      await recordFetchFailureWithStore(rows, {
        providerId: meta.providerId,
        capability: meta.capability,
        requestParams: meta.requestParams ?? {},
        runId: meta.runId,
        tenantId: meta.tenantId,
        userLogin: meta.userLogin ?? null,
        kind: failure.kind,
        message: failure.message,
      });
    },
  };
}

/* ------------------------------------------------------------------ */
/* The port                                                            */
/* ------------------------------------------------------------------ */

/**
 * The capture store surface. Every read is tenant-scoped
 * (assessment-01 §8.1: tenant context at the storage boundary) —
 * a cross-tenant query returns nothing, exactly as if the
 * capture did not exist.
 */
export interface ProviderCaptureStore {
  /** Record one capture (never throws — see the header). */
  recordCapture(
    blobDeps: CaptureBlobDeps,
    input: RecordCaptureInput
  ): Promise<DataCaptureRecord>;
  /** Record one failed fetch (never throws). */
  recordFetchFailure(input: RecordFetchFailureInput): Promise<DataCaptureRecord>;
  /** This store as the FetchOutcomeRecorder port's adapter. */
  createFetchOutcomeRecorder(): FetchOutcomeRecorder;
  getCaptureById(tenantId: string, id: string): Promise<DataCaptureRecord | null>;
  /** Exactly the captures one run produced (including any failure markers). */
  listCapturesByRun(tenantId: string, runId: string): Promise<DataCaptureRecord[]>;
  listCapturesByProvider(
    tenantId: string,
    providerId: DataProviderId
  ): Promise<DataCaptureRecord[]>;
  listCapturesByCapability(
    tenantId: string,
    capability: DataProviderCapability
  ): Promise<DataCaptureRecord[]>;
  /** The visible gaps in the audit trail: captures whose write failed. */
  listCaptureFailures(tenantId: string): Promise<DataCaptureRecord[]>;
  /** The recorded fetch failures — fetches that threw. */
  listFetchFailures(tenantId: string): Promise<DataCaptureRecord[]>;
  /**
   * Read one capture back in full: metadata plus the raw payload
   * byte-for-byte. rawBytes is null when the capture stored no
   * payload (no_payload / capture_failed) or its blob is missing.
   */
  readCaptureRaw(
    blobDeps: CaptureBlobDeps,
    tenantId: string,
    id: string
  ): Promise<{ record: DataCaptureRecord; rawBytes: Uint8Array | null } | null>;
}
