/**
 * Issue #1766 (parent #1717, F-38 / F-58) — the pure companions to
 * the SHARED retention registry (src/privacy/privacyDsar.ts):
 * orphan sweep planning, DO SQLite snapshot export manifests,
 * and purge-run audit events.
 *
 * Pure module: no Cloudflare imports, no I/O, no network. The
 * nightly trigger-retention route (src/agents/routes/schedules.ts)
 * and the AgentDB purge route wiring (src/server.ts) consume
 * these; this module decides nothing about live bindings.
 *
 * Scope decisions, recorded not hidden:
 * - Orphan sweep scope is ONLY the canonical report bodies at
 *   `reports/<reportId>.json` in REPORTS_BUCKET, matched
 *   against mas_reports.body_r2_key. Report PDFs (putReportPdf
 *   keys under stocks/ + options/ + goals/ and per-run keys)
 *   and knowledge/ corpus objects are OUT of scope: their
 *   metadata lives in DO storage, which has get/put but no
 *   key listing, so a bucket-side sweep cannot enumerate
 *   their referenced set honestly. The #1168 definition
 *   (a sweep for orphaned REPORTS must exclude knowledge/)
 *   holds by construction here: the sweep lists only the
 *   reports/ prefix, so knowledge/ keys are never candidates.
 * - Snapshot export is a PORTABLE logical dump, not a DO
 *   backup: Cloudflare's PITR already restores a whole DO
 *   SQLite database to any point in the past 30 days
 *   (getCurrentBookmark / getBookmarkForTime /
 *   onNextSessionRestoreBookmark). The R2 snapshot complements
 *   PITR — it is per-table, capped, truncated-flagged, and
 *   survives beyond the 30-day PITR window as a nightly
 *   chain — it does not replace PITR, and the recovery
 *   procedure in docs/architecture/retention/retention-1766.md
 *   says which to reach for first.
 * - The snapshot and sweep ride the existing nightly
 *   0 4 * * * retention pass (same precedent as the #2294
 *   job-outcomes leg): no new cron, no new public route.
 *   Both steps are best-effort and never fail the pass.
 * - Orphan DELETE is fail-closed: the sweep reports by
 *   default and deletes only when the operator sets
 *   RETENTION_ORPHAN_SWEEP_DELETE to exactly "true".
 *   Snapshot export is fail-closed in the other direction:
 *   it runs unless explicitly disabled ("false"), because
 *   a missing backup is the unsafe state.
 * - Purge-run audit: every AgentDB purge run (operator POST
 *   /api/retention/purge) appends a retention.purge IAAA
 *   audit event. An audit-write failure is surfaced as
 *   auditOk:false on the report — the purge result is never
 *   reported as audited when it was not.
 */
import { IAAA_AUDIT_POLICY_VERSION } from "../security/iaaaAudit";
import type { CreateIaaaAuditEventInput } from "../security/iaaaAudit";
import type { RetentionPurgeReport } from "./retentionPorts";

// ---------------------------------------------------------------- Orphan sweep

export interface OrphanSweepInput {
  /** Keys listed from the bucket (any prefix; only reports/ are candidates). */
  bucketKeys: string[];
  /** Referenced keys (mas_reports.body_r2_key values, nulls already filtered). */
  referencedKeys: string[];
}

export interface OrphanSweepPlan {
  /** reports/ objects with no mas_reports row pointing at them. */
  orphans: string[];
  /** Referenced reports/ keys with no bucket object (rows are KEEP — reported, never deleted). */
  danglingRows: string[];
  /** Listed reports/ objects examined. */
  scanned: number;
  /** Listed keys outside reports/ (never candidates, by construction). */
  outOfScope: number;
  /** Objects actually deleted (empty unless the caller deleted the orphans). */
  deleted: string[];
  /** Object keys whose delete failed (empty unless deletion was attempted). */
  deleteFailed: string[];
}

/** The only prefix the sweep ever considers. */
export const ORPHAN_SWEEP_PREFIX = "reports/" as const;

/**
 * Plan the sweep. Pure set difference, scoped to reports/:
 * orphans = listed reports/ keys minus referenced keys;
 * dangling = referenced reports/ keys minus listed keys.
 * The planner deletes nothing; the caller deletes `orphans`
 * only when resolveOrphanSweepDelete says so.
 */
export function planOrphanSweep(input: OrphanSweepInput): OrphanSweepPlan {
  const listed = input.bucketKeys.filter((k) => k.startsWith(ORPHAN_SWEEP_PREFIX));
  const outOfScope = input.bucketKeys.length - listed.length;
  const referenced = new Set(
    input.referencedKeys.filter((k) => k.startsWith(ORPHAN_SWEEP_PREFIX)),
  );
  const listedSet = new Set(listed);
  return {
    orphans: listed.filter((k) => !referenced.has(k)),
    danglingRows: [...referenced].filter((k) => !listedSet.has(k)),
    scanned: listed.length,
    outOfScope,
    deleted: [],
    deleteFailed: [],
  };
}

/** Only the exact string "true" enables orphan deletion. Anything else is report-only. */
export function resolveOrphanSweepDelete(raw: unknown): boolean {
  return raw === "true";
}

// ---------------------------------------------------------------- Snapshot export

/** Cap mirroring the pre-wipe events-export precedent (5000 rows). */
export const SNAPSHOT_ROW_LIMIT = 5000;

/** R2 key for one nightly snapshot object. Date is the UTC calendar date of the export. */
export function snapshotObjectKey(instance: string, exportedAtMs: number): string {
  const date = new Date(exportedAtMs).toISOString().slice(0, 10);
  return `snapshots/${instance}/${date}.json`;
}

export function truncateSnapshotRows<T>(
  rows: T[],
  limit: number,
): { rows: T[]; truncated: boolean } {
  if (rows.length <= limit) return { rows, truncated: false };
  return { rows: rows.slice(0, limit), truncated: true };
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export interface SnapshotTableInput {
  table: string;
  rows: unknown[];
}

export interface SnapshotTableManifest {
  table: string;
  rowCount: number;
  truncated: boolean;
  sha256: string;
  rows: unknown[];
}

export interface SnapshotManifest {
  version: "retention-snapshot-v1-1766";
  instance: string;
  exportedAt: number;
  tables: SnapshotTableManifest[];
  manifestSha256: string;
}

/**
 * Build the snapshot object for one instance: per-table row
 * dumps (capped, truncated-flagged, content-hashed) plus a
 * manifest hash over the per-table hashes, so a corrupted
 * or partial object is detectable. Deterministic for the
 * same inputs: the same rows always hash the same way.
 */
export async function buildSnapshotManifest(input: {
  instance: string;
  exportedAt: number;
  tables: SnapshotTableInput[];
  rowLimit?: number;
}): Promise<SnapshotManifest> {
  const limit = input.rowLimit ?? SNAPSHOT_ROW_LIMIT;
  const tables: SnapshotTableManifest[] = [];
  for (const t of input.tables) {
    const { rows, truncated } = truncateSnapshotRows(t.rows, limit);
    tables.push({
      table: t.table,
      rowCount: rows.length,
      truncated,
      sha256: await sha256Hex(JSON.stringify(rows)),
      rows,
    });
  }
  const manifestSha256 = await sha256Hex(
    tables.map((t) => `${t.table}:${t.sha256}`).join("\n"),
  );
  return {
    version: "retention-snapshot-v1-1766",
    instance: input.instance,
    exportedAt: input.exportedAt,
    tables,
    manifestSha256,
  };
}

/** Snapshot export runs unless explicitly disabled with "false". */
export function resolveSnapshotEnabled(raw: unknown): boolean {
  return raw !== "false";
}

// ---------------------------------------------------------------- Purge-run audit

/**
 * Build the IAAA audit input for one AgentDB purge run, so
 * the run itself is an audit event (F-58: purge reports are
 * not themselves audit events — until this slice). The
 * caller appends via recordAuditEvent and reports ok:false
 * as auditOk:false on the purge report; this builder only
 * shapes the event, it never writes.
 */
export function buildPurgeAuditEventInput(
  report: RetentionPurgeReport,
  input: { actorPrincipalId: string; tenantId: string; nowMs: number },
): CreateIaaaAuditEventInput {
  return {
    timestamp: input.nowMs,
    type: "retention.purge",
    actorPrincipalId: input.actorPrincipalId,
    actorType: "human",
    initiatingPrincipalId: input.actorPrincipalId,
    tenantId: input.tenantId,
    correlationId: `retention-purge-${input.tenantId}-${input.nowMs}`,
    action: "retention.purge",
    decision: "allow",
    policyVersion: IAAA_AUDIT_POLICY_VERSION,
    outcome: report.skipped ? "unknown" : "succeeded",
    resourceId: `${report.table}:${input.tenantId}`,
  };
}
