/**
 * Issue #2437 — checkpointed audit-chain verification.
 *
 * The mas_events chain is verified on the nightly retention pass (#3156),
 * but two of #2437's Requirements were unmet: the result was never
 * persisted (on success nothing durable recorded that verification ran,
 * at what tail, or how many rows — so "verified OK last night" was
 * indistinguishable from "has not run in a month"), and every run did an
 * unbounded full-table scan (`orm.events.findMany({ orderBy: "rowid ASC" })`
 * + a sync SHA-256 per row).
 *
 * This module closes both: after each verification it persists a checkpoint
 * record (last verified position + outcome) in `mas_settings` — the
 * corpus-sync precedent (`CORPUS_SYNC_LAST_RUN_KEY`) — and the next run
 * reads only the window after the checkpoint tail (`WHERE rowid > ?`),
 * anchoring the walk on the persisted tail hash instead of genesis. The
 * anchor also removes a latent landmine in the full verify: the retention
 * prune deletes the OLDEST rows first, so once the chain's genesis row
 * ages past the 365-day events window the genesis-anchored full verify
 * would false-fail every night; a checkpointed window never needs
 * genesis again.
 *
 * First run (no checkpoint) is one STRICT full verification, genesis-
 * anchored: if the table's genesis row is already pruned, the first run
 * fails loud — the chain's prefix is unverifiable, and the
 * tamper-response runbook review decides. The code never invents a
 * second genesis (auditChain.ts header: a gap is tampering or loss).
 *
 * Failure semantics mirror #3156: a broken window records a loud,
 * blocking `audit.tamper_detected` alert and the checkpoint tail is NOT
 * advanced (the same break is re-diagnosed on the next run until it is
 * reviewed). A settings-write failure propagates — a verification whose
 * result could not be recorded is not a verified chain.
 */
import {
  type DatabaseORM,
} from "../data/ormFacade";
import {
  diagnoseAuditChain,
  diagnoseAuditChainWindow,
  type AuditChainDiagnosis,
  type AuditChainRow,
} from "../security/auditChain";
import {
  recordTamperAlert,
  recordTamperAlertAsync,
  type TamperAlertResult,
} from "./auditTamperAlert";
import type { AsyncEventLogPort } from "../data/asyncEventLogPorts";
import { settingReadFromSql, settingWriteFromSql } from "./screeningFlags";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/auditChainVerification",
});

/** Settings key holding the last verification record (JSON). */
export const AUDIT_CHAIN_LAST_VERIFICATION_KEY = "audit_chain_last_verification";

/** Minimal exec-shaped handle (DO SqlStorage or a test double). */
export type AuditChainSqlExecutor = {
  exec: (q: string, ...a: unknown[]) => Iterable<unknown>;
};

/** How the persisted checkpoint's tail was established. */
export type AuditChainAnchorKind = "genesis" | "checkpoint";

/**
 * The persisted verification record: the last verified position plus the
 * outcome of the latest attempt, so its absence (a stale verifiedAt) is
 * itself observable. `tailRowId` / `tailHash` advance only on a valid
 * verification; on a failed attempt they still name the last GOOD tail.
 * `brokenRowId` names the exact row that broke, where `brokenIndex` is
 * window-relative (index into the rows the diagnosis walked this run).
 * #6102 `chain`: which chain the tail names. A record without it (or
 * with `chain: "do"`) names the frozen DO chain — the D1 verifier
 * treats it as no checkpoint and re-verifies from genesis on the D1
 * chain, so the cutover can never silently verify an empty window.
 */
export interface AuditChainVerificationRecord {
  verifiedAt: string;
  valid: boolean;
  rowsChecked: number;
  tailRowId: number | null;
  tailHash: string | null;
  anchorKind: AuditChainAnchorKind;
  brokenIndex: number | null;
  brokenRowId: number | null;
  reason: string | null;
  chain: "do" | "d1";
}

/**
 * Validated parse of a stored record. A corrupt value is NOT a
 * verification failure — the caller treats it as "no checkpoint" (one
 * full verification, then re-establish). Never throws.
 */
export function parseAuditChainVerificationRecord(
  raw: string | null,
): AuditChainVerificationRecord | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Record<string, unknown>;
    if (typeof v !== "object" || v === null) return null;
    if (typeof v.verifiedAt !== "string") return null;
    if (typeof v.valid !== "boolean") return null;
    if (typeof v.rowsChecked !== "number" || !Number.isFinite(v.rowsChecked)) return null;
    if (v.tailRowId !== null && typeof v.tailRowId !== "number") return null;
    if (v.tailHash !== null && typeof v.tailHash !== "string") return null;
    if (v.anchorKind !== "genesis" && v.anchorKind !== "checkpoint") return null;
    if (v.brokenIndex !== null && typeof v.brokenIndex !== "number") return null;
    if (v.brokenRowId !== null && typeof v.brokenRowId !== "number") return null;
    if (v.reason !== null && typeof v.reason !== "string") return null;
    // #6102: a record without a chain marker predates the D1 cutover
    // (or names the DO chain) — it is not a D1 checkpoint.
    if (v.chain !== "do" && v.chain !== "d1") return null;
    return v as unknown as AuditChainVerificationRecord;
  } catch {
    return null;
  }
}

/** One window row: the chain row plus its SQLite insertion position. */
export interface AuditChainWindowRow extends AuditChainRow {
  rowId: number;
}

const WINDOW_SELECT =
  "SELECT rowid, id, session_id, type, agent, payload, created_at, previous_event_hash, event_hash " +
  "FROM mas_events WHERE rowid > ? ORDER BY rowid ASC";

/**
 * Read the post-checkpoint window, bounded by construction: only rows
 * inserted after the checkpoint tail are read. The rowid bound keeps the
 * read O(new rows), not O(table).
 */
export function readAuditChainWindow(
  sql: AuditChainSqlExecutor,
  afterRowId: number,
): AuditChainWindowRow[] {
  const rows = Array.from(sql.exec(WINDOW_SELECT, afterRowId)) as Array<
    Record<string, unknown>
  >;
  return rows.map((r) => ({
    rowId: typeof r.rowid === "number" ? r.rowid : Number(r.rowid),
    id: String(r.id ?? ""),
    sessionId: String(r.session_id ?? ""),
    type: String(r.type ?? ""),
    agent: String(r.agent ?? ""),
    payload:
      typeof r.payload === "string"
        ? r.payload
        : JSON.stringify(r.payload ?? {}),
    createdAt: String(r.created_at ?? ""),
    previousEventHash: (r.previous_event_hash as string | null) ?? null,
    eventHash: String(r.event_hash ?? ""),
  }));
}

/** The checkpointed result: the #3156 shape plus the persisted record. */
export interface CheckpointedTamperAlertResult extends TamperAlertResult {
  /** The verification record persisted by this run (both outcomes). */
  checkpoint: AuditChainVerificationRecord;
  /** True when only the post-checkpoint window was read. */
  windowed: boolean;
  /** Rows the diagnosis actually walked this run. */
  rowsChecked: number;
}

/**
 * Verify the stored mas_events chain against the persisted checkpoint and,
 * on failure, record the loud alert through the #3156 path. The checkpoint
 * record is written on both outcomes (the tail advances only on valid).
 *
 * A verification READ failure is treated as a break (fail-closed, as in
 * verifyStoredAuditChainAndAlert); if the alert write then also fails, that
 * failure propagates — the caller must surface it, never swallow it. A
 * checkpoint-write failure likewise propagates: a verification whose result
 * could not be recorded is not a verified chain.
 */
export function verifyStoredAuditChainAndAlertCheckpointed(
  sql: AuditChainSqlExecutor,
  orm: DatabaseORM,
): CheckpointedTamperAlertResult {
  const readSetting = settingReadFromSql(sql);
  const writeSetting = settingWriteFromSql(sql);
  const stored = readSetting(AUDIT_CHAIN_LAST_VERIFICATION_KEY);
  let checkpoint = parseAuditChainVerificationRecord(stored);
  if (stored !== null && checkpoint === null) {
    structuredLog.error("auditChainVerification.checkpoint_corrupt", {
      message:
        "[audit-chain-verification] stored checkpoint is corrupt; falling back to a full verification and re-establishing it.",
    });
  }
  const nowIso = new Date().toISOString();

  // Windowed run: read only rows after the checkpoint tail and anchor the
  // walk on the persisted tail hash. An empty window is a valid run that
  // checks zero rows and refreshes verifiedAt; the tail is unchanged.
  if (checkpoint !== null && checkpoint.tailRowId !== null && checkpoint.tailHash !== null) {
    let windowRows: AuditChainWindowRow[];
    try {
      windowRows = readAuditChainWindow(sql, checkpoint.tailRowId);
    } catch (err) {
      return finishAttempt({
        writeSetting,
        nowIso,
        diagnosis: {
          valid: false,
          brokenIndex: null,
          reason: `verification error: ${err instanceof Error ? err.message : String(err)}`,
        },
        rowsChecked: 0,
        tailRowId: checkpoint.tailRowId,
        tailHash: checkpoint.tailHash,
        anchorKind: checkpoint.anchorKind,
        brokenRowId: null,
        orm,
        windowed: true,
      });
    }
    const diagnosis = diagnoseAuditChainWindow(windowRows, checkpoint.tailHash);
    const brokenRowId =
      diagnosis.brokenIndex !== null
        ? windowRows[diagnosis.brokenIndex]?.rowId ?? null
        : null;
    // anchorKind names the tail's provenance: a window that advanced the
    // tail re-anchors it as a checkpoint; an empty or failed window leaves
    // the previous tail (and its provenance) untouched.
    const nextAnchorKind: AuditChainAnchorKind =
      diagnosis.valid && windowRows.length > 0 ? "checkpoint" : checkpoint.anchorKind;
    return finishAttempt({
      writeSetting,
      nowIso,
      diagnosis,
      rowsChecked: diagnosis.valid ? windowRows.length : (diagnosis.brokenIndex ?? 0),
      tailRowId:
        diagnosis.valid && windowRows.length > 0
          ? windowRows[windowRows.length - 1].rowId
          : checkpoint.tailRowId,
      tailHash:
        diagnosis.valid && windowRows.length > 0
          ? windowRows[windowRows.length - 1].eventHash
          : checkpoint.tailHash,
      anchorKind: nextAnchorKind,
      brokenRowId,
      orm,
      windowed: true,
    });
  }

  // No checkpoint: one strict full verification, genesis-anchored, over the
  // same bounded read with a zero bound (the whole surviving table, once).
  // The tail rowid comes from the last row directly — no second query.
  let fullRows: AuditChainWindowRow[];
  let diagnosis: AuditChainDiagnosis;
  try {
    fullRows = readAuditChainWindow(sql, 0);
    diagnosis = diagnoseAuditChain(fullRows);
  } catch (err) {
    diagnosis = {
      valid: false,
      brokenIndex: null,
      reason: `verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
    fullRows = [];
  }
  const lastChained = [...fullRows].reverse().find((r) => r.eventHash);
  return finishAttempt({
    writeSetting,
    nowIso,
    diagnosis,
    rowsChecked: diagnosis.valid ? fullRows.length : (diagnosis.brokenIndex ?? 0),
    tailRowId: diagnosis.valid ? (lastChained?.rowId ?? null) : null,
    tailHash: diagnosis.valid ? (lastChained?.eventHash ?? null) : null,
    anchorKind: "genesis",
    brokenRowId: null,
    orm,
    windowed: false,
  });
}

function finishAttempt(args: {
  writeSetting: (key: string, value: string) => void;
  nowIso: string;
  diagnosis: AuditChainDiagnosis;
  rowsChecked: number;
  tailRowId: number | null;
  tailHash: string | null;
  anchorKind: AuditChainAnchorKind;
  brokenRowId: number | null;
  orm: DatabaseORM;
  windowed: boolean;
}): CheckpointedTamperAlertResult {
  const {
    writeSetting,
    nowIso,
    diagnosis,
    rowsChecked,
    tailRowId,
    tailHash,
    anchorKind,
    brokenRowId,
    orm,
    windowed,
  } = args;
  let alertRecorded = false;
  let alertId: string | undefined;
  if (!diagnosis.valid) {
    const alert = recordTamperAlert(orm.events, {
      chain: "mas_events",
      brokenIndex: diagnosis.brokenIndex,
      reason: diagnosis.reason ?? "chain verification failed",
    });
    alertRecorded = true;
    alertId = alert.id;
  }
  const record: AuditChainVerificationRecord = {
    verifiedAt: nowIso,
    valid: diagnosis.valid,
    rowsChecked,
    tailRowId,
    tailHash,
    anchorKind,
    brokenIndex: diagnosis.brokenIndex,
    brokenRowId,
    reason: diagnosis.reason,
    chain: "do",
  };
  // Deliberately no try/catch: a checkpoint the system could not record
  // is louder as a thrown error than as silence (the retention route
  // answers 503, as for an alert-write failure).
  writeSetting(AUDIT_CHAIN_LAST_VERIFICATION_KEY, JSON.stringify(record));
  return {
    valid: diagnosis.valid,
    brokenIndex: diagnosis.brokenIndex,
    reason: diagnosis.reason,
    alertRecorded,
    ...(alertId ? { alertId } : {}),
    checkpoint: record,
    windowed,
    rowsChecked,
  };
}

/**
 * #6102: async twin of verifyStoredAuditChainAndAlertCheckpointed —
 * the checkpointed verification of the live D1 mas_events chain.
 * The checkpoint record itself still lives in mas_settings (DO), read
 * and written through the injected setting functions; only the chain
 * rows come from D1.
 *
 * Cutover re-anchor: a stored record that names the DO chain
 * (`chain: "do"`, or a pre-#6102 record with no marker at all — the
 * parser returns null for those) is NOT a D1 checkpoint. The run
 * falls through to one strict full verification, genesis-anchored
 * on the D1 chain, and persists a `chain: "d1"` record. A DO tail
 * rowid can never silently window an empty D1 read again.
 */
export async function verifyStoredAuditChainAndAlertCheckpointedD1(
  events: AsyncEventLogPort,
  readSetting: (key: string) => string | null,
  writeSetting: (key: string, value: string) => void,
): Promise<CheckpointedTamperAlertResult> {
  const stored = readSetting(AUDIT_CHAIN_LAST_VERIFICATION_KEY);
  let checkpoint = parseAuditChainVerificationRecord(stored);
  if (stored !== null && checkpoint === null) {
    structuredLog.error("auditChainVerification.checkpoint_corrupt", {
      message:
        "[audit-chain-verification] stored checkpoint is corrupt or names the pre-cutover DO chain; falling back to a full D1 verification and re-establishing it.",
    });
  }
  // A DO-chain checkpoint names a different chain's tail — discard it
  // (the full path below re-anchors on the D1 chain from genesis).
  if (checkpoint !== null && checkpoint.chain !== "d1") {
    structuredLog.error("auditChainVerification.checkpoint_superseded", {
      message:
        "[audit-chain-verification] stored checkpoint names the frozen DO chain; re-verifying the D1 chain from genesis.",
    });
    checkpoint = null;
  }
  const nowIso = new Date().toISOString();

  if (checkpoint !== null && checkpoint.tailRowId !== null && checkpoint.tailHash !== null) {
    let windowRows: AuditChainWindowRow[];
    try {
      // The port names the SQLite position `rowid`; this module's
      // window rows name it `rowId` — map at the boundary.
      windowRows = ((await events.readChainWindow(checkpoint.tailRowId)) as Array<
        AuditChainRow & { rowid: number }
      >).map((r) => ({ ...r, rowId: r.rowid }));
    } catch (err) {
      return finishAttemptAsync({
        writeSetting,
        nowIso,
        diagnosis: {
          valid: false,
          brokenIndex: null,
          reason: `verification error: ${err instanceof Error ? err.message : String(err)}`,
        },
        rowsChecked: 0,
        tailRowId: checkpoint.tailRowId,
        tailHash: checkpoint.tailHash,
        anchorKind: checkpoint.anchorKind,
        brokenRowId: null,
        events,
        windowed: true,
      });
    }
    const diagnosis = diagnoseAuditChainWindow(windowRows, checkpoint.tailHash);
    const brokenRowId =
      diagnosis.brokenIndex !== null
        ? windowRows[diagnosis.brokenIndex]?.rowId ?? null
        : null;
    const nextAnchorKind: AuditChainAnchorKind =
      diagnosis.valid && windowRows.length > 0 ? "checkpoint" : checkpoint.anchorKind;
    return finishAttemptAsync({
      writeSetting,
      nowIso,
      diagnosis,
      rowsChecked: diagnosis.valid ? windowRows.length : (diagnosis.brokenIndex ?? 0),
      tailRowId:
        diagnosis.valid && windowRows.length > 0
          ? windowRows[windowRows.length - 1].rowId
          : checkpoint.tailRowId,
      tailHash:
        diagnosis.valid && windowRows.length > 0
          ? windowRows[windowRows.length - 1].eventHash
          : checkpoint.tailHash,
      anchorKind: nextAnchorKind,
      brokenRowId,
      events,
      windowed: true,
    });
  }

  // No (D1) checkpoint: one strict full verification, genesis-anchored
  // over the whole surviving D1 table, once.
  let fullRows: AuditChainWindowRow[];
  let diagnosis: AuditChainDiagnosis;
  try {
    fullRows = ((await events.readChainWindow(0)) as Array<
      AuditChainRow & { rowid: number }
    >).map((r) => ({ ...r, rowId: r.rowid }));
    diagnosis = diagnoseAuditChain(fullRows);
  } catch (err) {
    diagnosis = {
      valid: false,
      brokenIndex: null,
      reason: `verification error: ${err instanceof Error ? err.message : String(err)}`,
    };
    fullRows = [];
  }
  const lastChained = [...fullRows].reverse().find((r) => r.eventHash);
  return finishAttemptAsync({
    writeSetting,
    nowIso,
    diagnosis,
    rowsChecked: diagnosis.valid ? fullRows.length : (diagnosis.brokenIndex ?? 0),
    tailRowId: diagnosis.valid ? (lastChained?.rowId ?? null) : null,
    tailHash: diagnosis.valid ? (lastChained?.eventHash ?? null) : null,
    anchorKind: "genesis",
    brokenRowId: null,
    events,
    windowed: false,
  });
}

async function finishAttemptAsync(args: {
  writeSetting: (key: string, value: string) => void;
  nowIso: string;
  diagnosis: AuditChainDiagnosis;
  rowsChecked: number;
  tailRowId: number | null;
  tailHash: string | null;
  anchorKind: AuditChainAnchorKind;
  brokenRowId: number | null;
  events: AsyncEventLogPort;
  windowed: boolean;
}): Promise<CheckpointedTamperAlertResult> {
  const {
    writeSetting,
    nowIso,
    diagnosis,
    rowsChecked,
    tailRowId,
    tailHash,
    anchorKind,
    brokenRowId,
    events,
    windowed,
  } = args;
  let alertRecorded = false;
  let alertId: string | undefined;
  if (!diagnosis.valid) {
    const alert = await recordTamperAlertAsync(events, {
      chain: "mas_events",
      brokenIndex: diagnosis.brokenIndex,
      reason: diagnosis.reason ?? "chain verification failed",
    });
    alertRecorded = true;
    alertId = alert.id;
  }
  const record: AuditChainVerificationRecord = {
    verifiedAt: nowIso,
    valid: diagnosis.valid,
    rowsChecked,
    tailRowId,
    tailHash,
    anchorKind,
    brokenIndex: diagnosis.brokenIndex,
    brokenRowId,
    reason: diagnosis.reason,
    chain: "d1",
  };
  // Deliberately no try/catch: a checkpoint the system could not record
  // is louder as a thrown error than as silence (the retention route
  // answers 503, as for an alert-write failure).
  writeSetting(AUDIT_CHAIN_LAST_VERIFICATION_KEY, JSON.stringify(record));
  return {
    valid: diagnosis.valid,
    brokenIndex: diagnosis.brokenIndex,
    reason: diagnosis.reason,
    alertRecorded,
    ...(alertId ? { alertId } : {}),
    checkpoint: record,
    windowed,
    rowsChecked,
  };
}
