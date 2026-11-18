/**
 * Issue #2435 (#1976 step 5d) — the shared AuditLog port
 * implementation over an injected backend seam. Both
 * production-shaped adapters run through here, so the DO
 * adapter and the in-memory adapter differ ONLY in the
 * backend handles:
 *
 * #5084 (observability S5) — this module is the SINGLE
 * production client implementation of the SessionStore DO's
 * `audit-append` op. The security layer's createAtomicAuditStore
 * (src/security/iaaaAuditStore.ts) is a thin adapter over it, so
 * both AUDIT_PORTS_ENABLED states serve this one
 * implementation. The DO-side handler of the op lives in
 * src/security/sessionStore.ts (the server end of the same op,
 * not a second client); the in-memory adapter's op mirror
 * (src/data/inMemoryAuditLogAdapter.ts) is a test double of the
 * DO op, not a production store. See
 * docs/architecture/security/audit-canonical-store-5084.md.
 *
 *  - sendAppend speaks ONE audit-append operation (the
 *    SessionStore DO op on the DO adapter; the in-memory
 *    op mirror on the in-memory adapter) — chaining and the
 *    cap live behind that op, server-side in the DO's case,
 *    exactly as they did before this slice; #3251 (O1) adds
 *    the substrate: the payload carries `substrate: "table"`
 *    on the flag-ON composition (the append-only table) and
 *    omits it on the segment substrate, where rotation still
 *    lives behind the op;
 *  - listEntries returns the raw entries in chain order: on
 *    the table substrate one entry per event (keys under the
 *    `iaaa-audit:table:` prefix, value = one event JSON); on
 *    the segment substrate one entry per JSON array (archive
 *    segments first, then the live key), or null when the
 *    read failed. list() dispatches on the key prefix, so the
 *    two shapes share one read path.
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
  IAAA_AUDIT_TABLE_KEY_PREFIX,
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
  // #3251 (O1) — the substrate rides the append payload: the
  // DO defaults to segments when it is absent, so the flag-OFF
  // client (which never sends it) is byte-identical.
  const substrate = options.substrate ?? "segments";

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
        substrate,
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
      // Entries arrive in chain order. A table entry (key under
      // the `iaaa-audit:table:` prefix) holds ONE event JSON; a
      // segment entry holds a JSON array (archive segments
      // first, then the live key). The key — not the value
      // shape — decides, so a bare event object stored under a
      // segment key is still corrupt, exactly as before.
      const events: IaaaAuditEvent[] = [];
      for (const entry of entries) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(entry.value);
        } catch {
          throw corruptError();
        }
        if (entry.key.startsWith(IAAA_AUDIT_TABLE_KEY_PREFIX)) {
          if (
            typeof parsed !== "object" ||
            parsed === null ||
            typeof (parsed as { eventHash?: unknown }).eventHash !== "string"
          ) {
            throw corruptError();
          }
          events.push({ ...(parsed as IaaaAuditEvent) });
          continue;
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
