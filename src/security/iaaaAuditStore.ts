/**
 * #945 Wiring Phase 2b-part1 — Kv-backed IAAA audit store.
 * #1760 — transactional append + enforced bound (this slice).
 *
 * Two backends live here, and the distinction matters:
 *
 * - `createAtomicAuditStore` (PRODUCTION WIRING): appends go through
 *   the SessionStore DO's `audit-append` op. One DO request reads
 *   the tail, chains the event, rotates, and writes back, and a DO
 *   handles one request at a time — so concurrent appends cannot
 *   lose events or fork the chain. This is what
 *   `createWiredAuditStore` returns, and what recordAuditEvent
 *   uses when the store exposes `appendAtomic`. The live key is
 *   bounded (see the caps below) and the whole store is bounded
 *   by a total cap; reaching the cap fails visible
 *   (AUDIT_STORE_FULL), never by deleting evidence.
 * - `createKvAuditStore` (LEGACY, retained): the original
 *   read-modify-write single-key store. It is kept for backends
 *   without a Durable Object (tests, in-memory Kv) and for reads
 *   of logs written before #1760 — it is NOT production wiring
 *   anymore, and its race (F-18) is still real on this path: two
 *   concurrent appends can lose an event or fork the chain, and
 *   verifyChain() only DETECTS that. Do not wire it into a live
 *   write path. Superseded by createAtomicAuditStore in this file.
 *
 * Bound (capacity, NOT retention): the live key holds at most
 * `liveMax` events (default 2000); when it overflows, the oldest
 * `segmentSize` events rotate into a new archive segment key
 * (`iaaa-audit:archive:NNNNNN`), oldest first, chain order
 * preserved — so `list()` over archives + live still verifies
 * end to end. At most `maxArchiveSegments` archive segments exist
 * (default 10), so the whole store caps at
 * liveMax + maxArchiveSegments * segmentSize events (default
 * 22,000). These numbers bound BYTES/ROWS, not time: no retention
 * period is asserted anywhere here. Retention itself is CARRIED
 * to adoption question Q7 (deciding owner Mubasher, on a CISO +
 * CDO recommendation — #1757 D-3); until Q7 answers, nothing in
 * this module deletes an audit event for age, and hitting the cap
 * fails new appends visibly instead of destroying evidence.
 * Unbounded growth after this bound has a named owner + trigger:
 * owner Mubasher, trigger = the Q7 retention answer, or a
 * production AUDIT_STORE_FULL observation forcing the question
 * early. A caller may request SMALLER caps only; the DO clamps
 * larger requests to its hard ceilings, so no caller can widen
 * or disable its own bound.
 *
 * Reads: `list()` returns the full chain (archives in key order,
 * then live) so chain verification stays meaningful. It is an
 * admin/integrity read, bounded by the total cap — it must NOT
 * become a per-request audit path. New audit consumers append
 * through recordAuditEvent on the wired (atomic) store; they do
 * not list-and-filter the tenant-mixed log per request. The
 * admin overview's existing tenant filter over list() stays an
 * admin-only read (capped at 100 newest by the route builder),
 * not a per-request path.
 *
 * Corruption is loud, never silent: a log or segment value that
 * is not a JSON array fails the append/read, and the corrupt
 * bytes are left untouched for investigation — never overwritten
 * with a fresh log.
 *
 * Events live in the SessionStore Durable Object (the same store
 * as sessions and bindings) under keys prefixed "iaaa-audit:",
 * with NO expiry — audit evidence must outlive any one session.
 * The single log key cannot collide with session keys (bare
 * UUIDs) or binding keys ("iaaa-binding:").
 *
 * #1976 step 5d (#2435): the AuditStore contract and the key/cap
 * constants below are carried as the AuditLog family's port in
 * src/data/auditLogPorts.ts (this module re-exports them, so
 * every existing import keeps working). createWiredAuditStore
 * delegates to the family's composition root
 * (src/data/createAuditPorts.ts) when AUDIT_PORTS_ENABLED is on
 * (#1169 semantics; absence = off; not in wrangler); with the
 * flag off it returns createAtomicAuditStore exactly as before.
 * Both compositions run against the SAME Durable Object and
 * table — the flag switches the serving code path only.
 */

import type { Env } from "../types";
import { createAuditPorts } from "../data/createAuditPorts";
import {
  IAAA_AUDIT_ARCHIVE_KEY_PREFIX,
  IAAA_AUDIT_DEFAULT_LIVE_MAX,
  IAAA_AUDIT_DEFAULT_MAX_ARCHIVE_SEGMENTS,
  IAAA_AUDIT_DEFAULT_SEGMENT_SIZE,
  IAAA_AUDIT_KEY_PREFIX,
  IAAA_AUDIT_LOG_KEY,
  isAuditPortsEnabled,
} from "../data/auditLogPorts";
import type {
  AuditResult,
  AuditStore,
  CreateIaaaAuditEventInput,
  IaaaAuditEvent,
} from "./iaaaAudit";
import type { KvLike } from "./kvResilience";
import {
  createStoreSender,
  listStoreEntries,
  type DoNamespaceLike,
} from "./durableKv";

/**
 * The audit key/cap constants are defined with the AuditLog
 * port (src/data/auditLogPorts.ts, #2435) and re-exported here
 * under their long-standing names.
 */
export {
  IAAA_AUDIT_ARCHIVE_KEY_PREFIX,
  IAAA_AUDIT_DEFAULT_LIVE_MAX,
  IAAA_AUDIT_DEFAULT_MAX_ARCHIVE_SEGMENTS,
  IAAA_AUDIT_DEFAULT_SEGMENT_SIZE,
  IAAA_AUDIT_KEY_PREFIX,
  IAAA_AUDIT_LOG_KEY,
};

export interface AtomicAuditStoreOptions {
  liveMax?: number;
  segmentSize?: number;
  maxArchiveSegments?: number;
  /** DO instance name; one instance holds every bucket. */
  instanceName?: string;
}

function corruptError(): Error {
  return new Error(
    "iaaa audit log is corrupt (not a JSON array); refusing to overwrite audit evidence",
  );
}

async function readLog(kv: KvLike): Promise<IaaaAuditEvent[]> {
  const raw = await kv.get(IAAA_AUDIT_LOG_KEY);
  if (raw === null) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw corruptError();
  }
  if (!Array.isArray(parsed)) throw corruptError();
  return parsed as IaaaAuditEvent[];
}

/**
 * Legacy append-only store (see the header: retained, NOT
 * production wiring).
 *
 * @deprecated superseded by createAtomicAuditStore and the
 * AuditLog port (src/data/auditLogPorts.ts, composed by
 * src/data/createAuditPorts.ts). Retained only for reads of
 * logs written before #1760 and for Kv-backed tests; do not
 * wire it into a live write path.
 */
export function createKvAuditStore(kv: KvLike): AuditStore {
  return {
    async append(event: IaaaAuditEvent): Promise<void> {
      const events = await readLog(kv);
      events.push({ ...event });
      await kv.put(IAAA_AUDIT_LOG_KEY, JSON.stringify(events));
    },
    async list(): Promise<IaaaAuditEvent[]> {
      const events = await readLog(kv);
      return events.map((event) => ({ ...event }));
    },
  };
}

/**
 * Transactional AuditStore over a SessionStore DO namespace. The
 * store speaks the DO's `audit-append` op for writes (atomic
 * chaining + rotation + cap, server-side) and the DO's `list` op
 * for reads (archives in key order, then the live key).
 *
 * append() throws by design: a caller-chained event cannot be
 * stored verbatim without bypassing the atomic chaining. Append
 * through recordAuditEvent, which uses appendAtomic.
 */
export function createAtomicAuditStore(
  namespace: DoNamespaceLike | null | undefined,
  options: AtomicAuditStoreOptions = {},
): AuditStore {
  const send = createStoreSender(
    namespace,
    "sessions",
    options.instanceName ?? "kv",
  );
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
      if (!namespace) {
        return {
          ok: false,
          code: "AUDIT_WRITE_FAILED",
          error: "audit event could not be recorded: no audit backend is configured",
        };
      }
      const reply = await send({
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
      if (!namespace) return [];
      const entries = await listStoreEntries({
        namespace,
        namespaceName: "sessions",
        prefix: IAAA_AUDIT_KEY_PREFIX,
        instanceName: options.instanceName ?? "kv",
      });
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

/**
 * Production audit store: the atomic backend over the SessionStore
 * DO. When the DO namespace is absent, appends fail visible
 * (AUDIT_WRITE_FAILED) instead of vanishing silently, and list()
 * reads empty — the pre-#1760 Kv wiring silently dropped writes
 * in that case, which is exactly the failure mode this slice ends.
 *
 * #1976 step 5d (#2435): when AUDIT_PORTS_ENABLED is on, this
 * factory delegates to the AuditLog family's composition root
 * (src/data/createAuditPorts.ts) — same SessionStore DO, same
 * audit-append op, same stored bytes; the flag switches the
 * serving code path only. Flag off (the default) returns
 * createAtomicAuditStore exactly as before.
 */
export function createWiredAuditStore(env: Env): AuditStore {
  if (isAuditPortsEnabled(env)) {
    return createAuditPorts(env);
  }
  return createAtomicAuditStore(
    env.SESSION_STORE as unknown as DoNamespaceLike | undefined,
  );
}
