/**
 * Issue #2435 (#1976 step 5d) — the shared AuditLog port
 * implementation over an injected backend seam. Both
 * production-shaped adapters run through here, so the DO
 * adapter and the in-memory adapter differ ONLY in the
 * backend handles:
 *
 *  - sendAppend speaks ONE audit-append operation (the
 *    SessionStore DO op on the DO adapter; the in-memory
 *    op mirror on the in-memory adapter) — chaining,
 *    rotation and the cap live behind that op, server-side
 *    in the DO's case, exactly as they did before this
 *    slice (Q-1: the mechanism does not move);
 *  - listEntries returns the raw entries under the audit
 *    prefix in key order (archive segments first, then the
 *    live key), or null when the read failed.
 *
 * The reply mapping is the #1760 client's, unchanged: a
 * missing/error reply is AUDIT_WRITE_FAILED data, a
 * storeFull reply is AUDIT_STORE_FULL data, a reply without
 * a chained event is AUDIT_WRITE_FAILED data — failure is
 * always data on this path, never a thrown exception into
 * recordAuditEvent's caller. list() is the mirror image: a
 * failed read throws rather than returning partial evidence,
 * and corrupt bytes throw the corrupt error rather than
 * being skipped or overwritten.
 *
 * #CDO-mha7
 */
import type { StoreReply } from "./durableKv";
import type {
  AuditResult,
  CreateIaaaAuditEventInput,
  IaaaAuditEvent,
} from "../security/iaaaAudit";
import {
  IAAA_AUDIT_DEFAULT_LIVE_MAX,
  IAAA_AUDIT_DEFAULT_MAX_ARCHIVE_SEGMENTS,
  IAAA_AUDIT_DEFAULT_SEGMENT_SIZE,
  IAAA_AUDIT_LOG_KEY,
  type AuditLogPort,
  type AuditLogPortOptions,
} from "./auditLogPorts";

/** The backend seam the shared implementation runs over. */
export interface AuditLogBackend {
  /**
   * False when no backend is bound (no DO namespace): appends
   * fail visible as AUDIT_WRITE_FAILED data and list() reads
   * empty — the wired store's no-backend contract, preserved.
   */
  configured: boolean;
  /** Speak one audit-append operation; null = no reply. */
  sendAppend: (
    payload: Record<string, unknown>,
  ) => Promise<StoreReply | null>;
  /** Raw entries under the audit prefix, key order; null = read failed. */
  listEntries: () => Promise<Array<{ key: string; value: string }> | null>;
}

function corruptError(): Error {
  return new Error(
    "iaaa audit log is corrupt (not a JSON array); refusing to overwrite audit evidence",
  );
}

/** The AuditLog port over an injected backend (see header). */
export function createAuditLogStore(
  backend: AuditLogBackend,
  options: AuditLogPortOptions = {},
): AuditLogPort {
  const liveMax = options.liveMax ?? IAAA_AUDIT_DEFAULT_LIVE_MAX;
  const segmentSize = options.segmentSize ?? IAAA_AUDIT_DEFAULT_SEGMENT_SIZE;
  const maxArchiveSegments =
    options.maxArchiveSegments ?? IAAA_AUDIT_DEFAULT_MAX_ARCHIVE_SEGMENTS;

  return {
    async append(): Promise<void> {
      throw new Error(
        "atomic audit store: append through recordAuditEvent (appendAtomic), not append(); " +
          "a caller-chained event cannot be stored verbatim on this backend",
      );
    },

    async appendAtomic(
      input: CreateIaaaAuditEventInput,
    ): Promise<AuditResult> {
      if (!backend.configured) {
        return {
          ok: false,
          code: "AUDIT_WRITE_FAILED",
          error: "audit event could not be recorded: no audit backend is configured",
        };
      }
      const reply = await backend.sendAppend({
        op: "audit-append",
        ns: "sessions",
        key: IAAA_AUDIT_LOG_KEY,
        value: JSON.stringify(input),
        liveMax,
        segmentSize,
        maxArchiveSegments,
      });
      if (!reply || reply.error) {
        return {
          ok: false,
          code: "AUDIT_WRITE_FAILED",
          error: "audit event could not be recorded; the action must not be reported as audited",
        };
      }
      if (reply.storeFull === true) {
        return {
          ok: false,
          code: "AUDIT_STORE_FULL",
          error:
            "audit store is at its enforced capacity cap; the event was not recorded and no evidence was deleted",
        };
      }
      const event = reply.event as IaaaAuditEvent | undefined;
      if (!event || typeof event.eventHash !== "string") {
        return {
          ok: false,
          code: "AUDIT_WRITE_FAILED",
          error: "audit event could not be recorded; the action must not be reported as audited",
        };
      }
      return { ok: true, event };
    },

    async list(): Promise<IaaaAuditEvent[]> {
      if (!backend.configured) return [];
      const entries = await backend.listEntries();
      if (entries === null) {
        throw new Error(
          "iaaa audit log could not be read; refusing to return partial evidence",
        );
      }
      // Entries arrive sorted by key: archive segments first
      // ("archive:" < "events"), then the live key — chain order.
      const events: IaaaAuditEvent[] = [];
      for (const entry of entries) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(entry.value);
        } catch {
          throw corruptError();
        }
        if (!Array.isArray(parsed)) throw corruptError();
        for (const event of parsed as IaaaAuditEvent[]) {
          events.push({ ...event });
        }
      }
      return events;
    },
  };
}
