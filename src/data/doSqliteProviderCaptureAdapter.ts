/**
 * Issue #2303 (#1976 step 1) — the DO-SQLite implementation of
 * the provider-capture port: the #1116 platform's original
 * capture store (E1, issue #1133, + E7 #1248), moved into the
 * data layer. The record flows live ONCE in
 * providerCapturePorts.ts (recordCaptureWithStore et al.) over
 * this module's row surface; this module owns the
 * `mas_data_captures` table, its row mapping, and the sync read
 * functions the legacy surface exposes.
 *
 * src/trading/dataProviders/captureStore.ts is now a re-export
 * shim over this module (+ the port module), so every existing
 * import path and call signature is preserved. The class at
 * the bottom exposes the same store behind the async
 * ProviderCaptureStore port; the D1 adapter is the production
 * implementation when AGENT_DB is bound (the step-1 audit's
 * residency ruling).
 *
 * Retention: every row carries a retention classification from
 * day one (assessment-01 §8.1 classes; default "retained-365d").
 * Enforcement scheduling is a later slice's concern.
 */
import type { SqlStorage } from "../orm";
import { doIndexSql, doTableSql } from "./schemaComponent/doCatalogue";
import type {
  DataProviderCapability,
  DataProviderId,
} from "../trading";
import type {
  FetchFailureKind,
  FetchOutcomeRecorder,
} from "../trading";
import {
  DATA_CAPTURE_TABLE,
  canonicalJson,
  createFetchOutcomeRecorderWithStore,
  getCaptureBlob,
  recordCaptureWithStore,
  recordFetchFailureWithStore,
  type CaptureBlobDeps,
  type CaptureRowStore,
  type DataCaptureRecord,
  type ProviderCaptureStore,
  type RecordCaptureInput,
  type RecordFetchFailureInput,
} from "./providerCapturePorts";
import { remainderAlterSql } from "./schemaComponent/remainderCatalogue";

export function ensureCaptureTable(sql: SqlStorage): void {
  sql.exec(doTableSql("mas_data_captures"));
  // Pre-E7 tables lack the failure columns: add them in place (the
  // E5 ensure-column idiom from the config store). Existing rows
  // read back with NULL kind/message — they predate fetch-outcome
  // recording and claim none.
  const captureColumns = Array.from(
    sql.exec(`PRAGMA table_info(${DATA_CAPTURE_TABLE})`)
  ) as any[];
  if (!captureColumns.some((c) => c.name === "failure_kind")) {
    sql.exec(remainderAlterSql("mas_data_captures", "failure_kind"));
  }
  if (!captureColumns.some((c) => c.name === "failure_message")) {
    sql.exec(remainderAlterSql("mas_data_captures", "failure_message"));
  }
  sql.exec(
    doIndexSql("idx_mas_data_captures_run")
  );
  sql.exec(
    doIndexSql("idx_mas_data_captures_provider")
  );
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

function recordFromRow(r: any): DataCaptureRecord {
  return {
    id: r.id,
    providerId: r.provider_id,
    capability: r.capability,
    requestParams: parseParams(r.request_params_json),
    runId: r.run_id,
    tenantId: r.tenant_id,
    userLogin: r.user_login ?? null,
    fetchedAt: r.fetched_at,
    status: r.status,
    rawKind: r.raw_kind ?? null,
    rawBlobRef: r.raw_blob_ref ?? null,
    rawByteSize: r.raw_byte_size == null ? null : Number(r.raw_byte_size),
    rawSha256: r.raw_sha256 ?? null,
    normalizedDigest: r.normalized_digest ?? null,
    retentionClass: r.retention_class,
    failureError: r.failure_error ?? null,
    failureKind:
      typeof r.failure_kind === "string"
        ? (r.failure_kind as FetchFailureKind)
        : null,
    failureMessage: r.failure_message ?? null,
    createdAt: r.created_at,
  };
}

function insertCaptureRow(sql: SqlStorage, record: DataCaptureRecord): void {
  ensureCaptureTable(sql);
  sql.exec(
    `INSERT INTO ${DATA_CAPTURE_TABLE}
     (id, provider_id, capability, request_params_json, run_id, tenant_id, user_login, fetched_at, status, raw_kind, raw_blob_ref, raw_byte_size, raw_sha256, normalized_digest, retention_class, failure_error, failure_kind, failure_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    record.id,
    record.providerId,
    record.capability,
    canonicalJson(record.requestParams),
    record.runId,
    record.tenantId,
    record.userLogin,
    record.fetchedAt,
    record.status,
    record.rawKind,
    record.rawBlobRef,
    record.rawByteSize,
    record.rawSha256,
    record.normalizedDigest,
    record.retentionClass,
    record.failureError,
    record.failureKind,
    record.failureMessage,
    record.createdAt
  );
}

/** The DO row surface the shared record flows run over. */
export function doCaptureRowStore(sql: SqlStorage): CaptureRowStore {
  return {
    insertRow: (record) => insertCaptureRow(sql, record),
    getById: (tenantId, id) => getCaptureById(sql, tenantId, id),
  };
}

/**
 * Record one capture. NEVER throws (the port module's failure
 * semantics): on success returns the stored record; on a write
 * failure returns the failure-marker record.
 */
export async function recordCapture(
  sql: SqlStorage,
  blobDeps: CaptureBlobDeps,
  input: RecordCaptureInput
): Promise<DataCaptureRecord> {
  return recordCaptureWithStore(doCaptureRowStore(sql), blobDeps, input);
}

/**
 * Record one failed fetch. NEVER throws: on success returns the
 * stored record; on a write failure logs and returns the
 * unpersisted record. The stored message is scrubbed at the
 * storage boundary by the shared flow.
 */
export async function recordFetchFailure(
  sql: SqlStorage,
  input: RecordFetchFailureInput
): Promise<DataCaptureRecord> {
  return recordFetchFailureWithStore(doCaptureRowStore(sql), input);
}

/**
 * The capture store as the FetchOutcomeRecorder port's adapter:
 * recordFailure writes the fetch_failed row; recordSuccess
 * writes nothing (see createFetchOutcomeRecorderWithStore).
 */
export function createCaptureFetchOutcomeRecorder(
  sql: SqlStorage
): FetchOutcomeRecorder {
  return createFetchOutcomeRecorderWithStore(doCaptureRowStore(sql));
}

/* ------------------------------------------------------------------ */
/* Read-back — every query is tenant-scoped.                           */
/* ------------------------------------------------------------------ */

export function getCaptureById(
  sql: SqlStorage,
  tenantId: string,
  id: string
): DataCaptureRecord | null {
  ensureCaptureTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${DATA_CAPTURE_TABLE} WHERE tenant_id = ? AND id = ?`,
      tenantId,
      id
    )
  ) as any[];
  return rows.length > 0 ? recordFromRow(rows[0]) : null;
}

function listCapturesWhere(
  sql: SqlStorage,
  tenantId: string,
  column: "run_id" | "provider_id" | "capability" | "status",
  value: string
): DataCaptureRecord[] {
  ensureCaptureTable(sql);
  const rows = Array.from(
    sql.exec(
      `SELECT * FROM ${DATA_CAPTURE_TABLE} WHERE tenant_id = ? AND ${column} = ? ORDER BY fetched_at ASC`,
      tenantId,
      value
    )
  ) as any[];
  return rows.map(recordFromRow);
}

/** Exactly the captures one run produced (including any failure markers). */
export function listCapturesByRun(
  sql: SqlStorage,
  tenantId: string,
  runId: string
): DataCaptureRecord[] {
  return listCapturesWhere(sql, tenantId, "run_id", runId);
}

export function listCapturesByProvider(
  sql: SqlStorage,
  tenantId: string,
  providerId: DataProviderId
): DataCaptureRecord[] {
  return listCapturesWhere(sql, tenantId, "provider_id", providerId);
}

export function listCapturesByCapability(
  sql: SqlStorage,
  tenantId: string,
  capability: DataProviderCapability
): DataCaptureRecord[] {
  return listCapturesWhere(sql, tenantId, "capability", capability);
}

/** The visible gaps in the audit trail: captures whose write failed. */
export function listCaptureFailures(
  sql: SqlStorage,
  tenantId: string
): DataCaptureRecord[] {
  return listCapturesWhere(sql, tenantId, "status", "capture_failed");
}

/** E7 (#1248): the recorded fetch failures — fetches that threw. */
export function listFetchFailures(
  sql: SqlStorage,
  tenantId: string
): DataCaptureRecord[] {
  return listCapturesWhere(sql, tenantId, "status", "fetch_failed");
}

/**
 * Read one capture back in full: its metadata plus the raw
 * payload byte-for-byte. rawBytes is null when the capture
 * stored no payload (no_payload / capture_failed) or its blob
 * is missing.
 */
export async function readCaptureRaw(
  sql: SqlStorage,
  blobDeps: CaptureBlobDeps,
  tenantId: string,
  id: string
): Promise<{ record: DataCaptureRecord; rawBytes: Uint8Array | null } | null> {
  const record = getCaptureById(sql, tenantId, id);
  if (!record) return null;
  if (!record.rawBlobRef) return { record, rawBytes: null };
  const rawBytes = await getCaptureBlob(
    blobDeps.env,
    blobDeps.storage,
    record.rawBlobRef
  );
  return { record, rawBytes };
}

/* ------------------------------------------------------------------ */
/* The async port over the sync store                                  */
/* ------------------------------------------------------------------ */

/** The DO-SQLite capture store behind the async ProviderCaptureStore port. */
export class DoSqliteProviderCaptureAdapter implements ProviderCaptureStore {
  constructor(private readonly sql: SqlStorage) {}

  async recordCapture(
    blobDeps: CaptureBlobDeps,
    input: RecordCaptureInput
  ): Promise<DataCaptureRecord> {
    return recordCapture(this.sql, blobDeps, input);
  }
  async recordFetchFailure(
    input: RecordFetchFailureInput
  ): Promise<DataCaptureRecord> {
    return recordFetchFailure(this.sql, input);
  }
  createFetchOutcomeRecorder(): FetchOutcomeRecorder {
    return createCaptureFetchOutcomeRecorder(this.sql);
  }
  async getCaptureById(
    tenantId: string,
    id: string
  ): Promise<DataCaptureRecord | null> {
    return getCaptureById(this.sql, tenantId, id);
  }
  async listCapturesByRun(
    tenantId: string,
    runId: string
  ): Promise<DataCaptureRecord[]> {
    return listCapturesByRun(this.sql, tenantId, runId);
  }
  async listCapturesByProvider(
    tenantId: string,
    providerId: DataProviderId
  ): Promise<DataCaptureRecord[]> {
    return listCapturesByProvider(this.sql, tenantId, providerId);
  }
  async listCapturesByCapability(
    tenantId: string,
    capability: DataProviderCapability
  ): Promise<DataCaptureRecord[]> {
    return listCapturesByCapability(this.sql, tenantId, capability);
  }
  async listCaptureFailures(tenantId: string): Promise<DataCaptureRecord[]> {
    return listCaptureFailures(this.sql, tenantId);
  }
  async listFetchFailures(tenantId: string): Promise<DataCaptureRecord[]> {
    return listFetchFailures(this.sql, tenantId);
  }
  async readCaptureRaw(
    blobDeps: CaptureBlobDeps,
    tenantId: string,
    id: string
  ): Promise<{ record: DataCaptureRecord; rawBytes: Uint8Array | null } | null> {
    return readCaptureRaw(this.sql, blobDeps, tenantId, id);
  }
}
