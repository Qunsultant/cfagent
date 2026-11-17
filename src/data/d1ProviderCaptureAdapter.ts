/**
 * Issue #2303 (#1976 step 1) — Drizzle D1 adapter for the
 * provider-capture port (the step-1 audit's residency ruling:
 * captures are D1 — see providerCapturePorts.ts). All
 * SQL-adjacent code for the family lives here, behind the port
 * interface.
 *
 * The record flows (recordCapture / recordFetchFailure, with
 * their never-throws failure semantics) live ONCE in
 * providerCapturePorts.ts and run over this adapter's row
 * store, so the D1, in-memory and DO-SQLite adapters cannot
 * drift on the semantics that matter. Reads are tenant-scoped
 * exactly as the legacy store's are.
 */
import { type DrizzleD1Database } from "drizzle-orm/d1";
import { createDrizzleD1Db } from "./d1QueryLogger";
import { and, asc, eq } from "drizzle-orm";
import { agentDataCaptures } from "./drizzleSchema";
import {
  ALL_MIGRATIONS,
  applyMigrations,
  type MigrationDb,
} from "./migrationRunner";
import type {
  DataProviderCapability,
  DataProviderId,
} from "../trading";
import type { FetchOutcomeRecorder } from "../trading";
import {
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

/** Drizzle D1 database object carrying the capture schema. */
export type ProviderCaptureDb = DrizzleD1Database<{
  agentDataCaptures: typeof agentDataCaptures;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1ProviderCaptureDb(d1: D1Database): ProviderCaptureDb {
  return createDrizzleD1Db(d1, { schema: { agentDataCaptures } });
}

/** Idempotent schema-ensure: applies pending migrations, if any. */
export async function ensureProviderCaptureSchema(
  db: ProviderCaptureDb,
): Promise<number[]> {
  return applyMigrations(db as unknown as MigrationDb, ALL_MIGRATIONS);
}

type CaptureRow = typeof agentDataCaptures.$inferSelect;

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

function toRecord(raw: CaptureRow): DataCaptureRecord {
  return {
    id: raw.id,
    providerId: raw.providerId as DataProviderId,
    capability: raw.capability as DataProviderCapability,
    requestParams: parseParams(raw.requestParamsJson),
    runId: raw.runId,
    tenantId: raw.tenantId,
    userLogin: raw.userLogin ?? null,
    fetchedAt: raw.fetchedAt,
    status: raw.status as DataCaptureRecord["status"],
    rawKind: (raw.rawKind as DataCaptureRecord["rawKind"]) ?? null,
    rawBlobRef: raw.rawBlobRef ?? null,
    rawByteSize: raw.rawByteSize == null ? null : Number(raw.rawByteSize),
    rawSha256: raw.rawSha256 ?? null,
    normalizedDigest: raw.normalizedDigest ?? null,
    retentionClass: raw.retentionClass as DataCaptureRecord["retentionClass"],
    failureError: raw.failureError ?? null,
    failureKind:
      (raw.failureKind as DataCaptureRecord["failureKind"]) ?? null,
    failureMessage: raw.failureMessage ?? null,
    createdAt: raw.createdAt,
  };
}

/** Capture store over D1 via Drizzle. */
export class D1ProviderCaptureAdapter implements ProviderCaptureStore {
  constructor(readonly db: ProviderCaptureDb) {}

  /** The row surface the shared record flows run over. */
  private rows(): CaptureRowStore {
    return {
      insertRow: async (record) => {
        await this.db.insert(agentDataCaptures).values({
          id: record.id,
          providerId: record.providerId,
          capability: record.capability,
          requestParamsJson: canonicalJson(record.requestParams),
          runId: record.runId,
          tenantId: record.tenantId,
          userLogin: record.userLogin,
          fetchedAt: record.fetchedAt,
          status: record.status,
          rawKind: record.rawKind,
          rawBlobRef: record.rawBlobRef,
          rawByteSize: record.rawByteSize,
          rawSha256: record.rawSha256,
          normalizedDigest: record.normalizedDigest,
          retentionClass: record.retentionClass,
          failureError: record.failureError,
          failureKind: record.failureKind,
          failureMessage: record.failureMessage,
          createdAt: record.createdAt,
        });
      },
      getById: async (tenantId, id) => this.getCaptureById(tenantId, id),
    };
  }

  async recordCapture(
    blobDeps: CaptureBlobDeps,
    input: RecordCaptureInput,
  ): Promise<DataCaptureRecord> {
    return recordCaptureWithStore(this.rows(), blobDeps, input);
  }

  async recordFetchFailure(
    input: RecordFetchFailureInput,
  ): Promise<DataCaptureRecord> {
    return recordFetchFailureWithStore(this.rows(), input);
  }

  createFetchOutcomeRecorder(): FetchOutcomeRecorder {
    return createFetchOutcomeRecorderWithStore(this.rows());
  }

  async getCaptureById(
    tenantId: string,
    id: string,
  ): Promise<DataCaptureRecord | null> {
    const rows = await this.db
      .select()
      .from(agentDataCaptures)
      .where(
        and(
          eq(agentDataCaptures.tenantId, tenantId),
          eq(agentDataCaptures.id, id),
        ),
      )
      .limit(1);
    return rows.length > 0 ? toRecord(rows[0]) : null;
  }

  private async listWhere(
    tenantId: string,
    column: "runId" | "providerId" | "capability" | "status",
    value: string,
  ): Promise<DataCaptureRecord[]> {
    const field = {
      runId: agentDataCaptures.runId,
      providerId: agentDataCaptures.providerId,
      capability: agentDataCaptures.capability,
      status: agentDataCaptures.status,
    }[column];
    const rows = await this.db
      .select()
      .from(agentDataCaptures)
      .where(
        and(eq(agentDataCaptures.tenantId, tenantId), eq(field, value)),
      )
      .orderBy(asc(agentDataCaptures.fetchedAt));
    return rows.map(toRecord);
  }

  async listCapturesByRun(
    tenantId: string,
    runId: string,
  ): Promise<DataCaptureRecord[]> {
    return this.listWhere(tenantId, "runId", runId);
  }

  async listCapturesByProvider(
    tenantId: string,
    providerId: DataProviderId,
  ): Promise<DataCaptureRecord[]> {
    return this.listWhere(tenantId, "providerId", providerId);
  }

  async listCapturesByCapability(
    tenantId: string,
    capability: DataProviderCapability,
  ): Promise<DataCaptureRecord[]> {
    return this.listWhere(tenantId, "capability", capability);
  }

  async listCaptureFailures(tenantId: string): Promise<DataCaptureRecord[]> {
    return this.listWhere(tenantId, "status", "capture_failed");
  }

  async listFetchFailures(tenantId: string): Promise<DataCaptureRecord[]> {
    return this.listWhere(tenantId, "status", "fetch_failed");
  }

  async readCaptureRaw(
    blobDeps: CaptureBlobDeps,
    tenantId: string,
    id: string,
  ): Promise<{ record: DataCaptureRecord; rawBytes: Uint8Array | null } | null> {
    const record = await this.getCaptureById(tenantId, id);
    if (!record) return null;
    if (!record.rawBlobRef) return { record, rawBytes: null };
    const rawBytes = await getCaptureBlob(
      blobDeps.env,
      blobDeps.storage,
      record.rawBlobRef,
    );
    return { record, rawBytes };
  }
}
