/**
 * Issue #2435 (#1976 step 5d, ADR 0022 D-I.5 / D-F.3 as scoped
 * by Q-1) — the IAAA audit log family port: the `AuditStore`
 * contract, carried into the data layer in src/data/ shape.
 * The contract's semantics are UNCHANGED from its #945/#1760
 * definition (it lived in src/security/iaaaAudit.ts until this
 * slice; that module now re-exports it — the pure model,
 * validation and failure policy do NOT move).
 *
 * FLAG (Q-2(b), #1169 semantics): `AUDIT_PORTS_ENABLED` —
 * "1"/"true"/"on" (trimmed, case-insensitive) = ON; absence
 * or any other value = OFF. The var is deliberately NOT in
 * wrangler.jsonc; rollback is unsetting it. Flag selection
 * lives in the façade (security/iaaaAuditStore.ts's
 * createWiredAuditStore), which delegates to this family's
 * composition root (createAuditPorts.ts) only when the flag
 * is on. Flag-off composition is today's atomic client in
 * iaaaAuditStore.ts, byte-identical; flag-on composition is
 * the adapters in this family over the SAME SessionStore DO
 * and the SAME kv_store table — the flag switches the
 * serving code path only. No data migration, no dual-write,
 * no change to any stored key or value shape: bytes written
 * before this slice (including pre-#1760 legacy-shape
 * segments) read and verify identically in both flag states
 * (pinned by the conformance suite's cross-composition rows).
 *
 * THE MECHANISM DOES NOT MOVE (Q-1): the DO adapter's append
 * remains the SessionStore `audit-append` op — one DO request
 * reads the tail, chains the event, rotates, and writes back,
 * serialized by the DO runtime. D-F.3's append-substrate
 * replacement (an append-only table behind a single-writer
 * port) is a separate, later decision, deferred by Q-1 —
 * named here so this slice is not read as its quiet burial;
 * it is NOT built here.
 *
 * APPEND ATOMICITY IS THE CONTRACT'S CENTRE: one backend
 * operation chains and stores; a caller-chained event can
 * never be stored verbatim (the atomic backend's `append()`
 * throws by design). recordAuditEvent prefers `appendAtomic`
 * whenever the backend exposes it.
 *
 * CAP SEMANTICS ARE CONTRACT (capacity, NOT retention): the
 * live key holds at most liveMax events (default 2000); when
 * it overflows, the oldest segmentSize events (default 2000)
 * rotate into the next archive segment key, oldest first,
 * chain order preserved; at most maxArchiveSegments segments
 * (default 10) exist, so the store caps at
 * liveMax + maxArchiveSegments * segmentSize (default
 * 22,000) events. A caller may request SMALLER caps only —
 * the DO clamps larger requests to these hard ceilings.
 * Reaching the cap refuses the append as AUDIT_STORE_FULL
 * data; NO audit event is ever deleted for age (Q-4), and
 * the cap-refusal is the designed end-state until the Q7
 * retention answer lands elsewhere.
 *
 * CORRUPTION IS LOUD: a live or archive value that is not a
 * JSON array fails the append/read, and the corrupt bytes
 * are left untouched — never overwritten with a fresh log.
 *
 * list() IS AN ADMIN/INTEGRITY READ: it returns the full
 * chain (archive segments in key order, then the live key)
 * so chain verification stays meaningful. It must NOT become
 * a per-request audit path; new consumers append through
 * recordAuditEvent and never list-and-filter per request.
 *
 * FAILURE VISIBILITY (§3.8): appendAtomic returns
 * AUDIT_WRITE_FAILED / AUDIT_STORE_FULL as DATA (AuditResult),
 * never as a thrown exception into the caller; the failure
 * policy itself (classifyAuditFailure / isAuditedSuccess)
 * stays in the pure model, security/iaaaAudit.ts.
 *
 * TRANSACTION HONESTY (ADR D-C / §7): the one operation that
 * claims atomicity — the DO's audit-append — IS atomic (one
 * serialized DO request). Nothing else here claims more: the
 * in-memory adapter serializes its appends through a promise
 * chain precisely so it does not claim a weaker store has
 * the DO's input gate.
 *
 * #CDO-mha7
 */
import type {
  AuditResult,
  CreateIaaaAuditEventInput,
  IaaaAuditEvent,
} from "../security/iaaaAudit";

/** Q-2(b) flag name for this family. */
export const AUDIT_PORTS_FLAG = "AUDIT_PORTS_ENABLED";

/**
 * #1169 flag semantics: "1"/"true"/"on" (trimmed,
 * case-insensitive) = ON; absence = OFF; NOT in wrangler.
 */
export function isAuditPortsEnabled(
  env?: { AUDIT_PORTS_ENABLED?: string } | null,
): boolean {
  const v = env?.AUDIT_PORTS_ENABLED;
  if (typeof v !== "string") return false;
  const norm = v.trim().toLowerCase();
  return norm === "1" || norm === "true" || norm === "on";
}

/** Prefix for every IAAA audit key in the SessionStore DO. */
export const IAAA_AUDIT_KEY_PREFIX = "iaaa-audit:";

/** The live log key holding the JSON array of newest audit events. */
export const IAAA_AUDIT_LOG_KEY = `${IAAA_AUDIT_KEY_PREFIX}events`;

/** Prefix for rotated archive segment keys (`iaaa-audit:archive:NNNNNN`). */
export const IAAA_AUDIT_ARCHIVE_KEY_PREFIX = `${IAAA_AUDIT_KEY_PREFIX}archive:`;

/** Hard ceilings: live key size, segment size, archive segment count. */
export const IAAA_AUDIT_DEFAULT_LIVE_MAX = 2000;
export const IAAA_AUDIT_DEFAULT_SEGMENT_SIZE = 2000;
export const IAAA_AUDIT_DEFAULT_MAX_ARCHIVE_SEGMENTS = 10;

/** Options for composing an audit log store over a backend. */
export interface AuditLogPortOptions {
  liveMax?: number;
  segmentSize?: number;
  maxArchiveSegments?: number;
  /** DO instance name; one instance holds every bucket. */
  instanceName?: string;
}

/**
 * Append-only: deliberately no update, delete, or remove operation.
 *
 * #1760 — transactional append: a backend that can chain and store
 * an event atomically exposes `appendAtomic`, and recordAuditEvent
 * prefers it over the list-then-link-then-append path. The legacy
 * path (list + append) stays for backends without an atomic op
 * (the in-memory store, the Kv store), but it is NOT safe under
 * concurrency: two parallel recordAuditEvent calls can read the
 * same tail and fork the chain or lose an event. Production wiring
 * (createWiredAuditStore) is atomic; an atomic backend's append()
 * throws, because storing a caller-chained event verbatim would
 * bypass the atomic chaining — append through recordAuditEvent.
 */
export interface AuditStore {
  append(event: IaaaAuditEvent): Promise<void>;
  list(): Promise<IaaaAuditEvent[]>;
  /**
   * Atomically chain (assign id, previousEventHash, eventHash) and
   * store one validated event input. The whole step is one backend
   * operation on atomic backends (one SessionStore DO request), so
   * parallel appends cannot interleave between the tail read and
   * the write. Absent on legacy backends.
   */
  appendAtomic?(input: CreateIaaaAuditEventInput): Promise<AuditResult>;
}

/**
 * The AuditLog family port (issue #2435): the AuditStore
 * contract under its family name. Adapters in this family
 * implement this port; consumers keep programming to the
 * contract's long-standing shape.
 */
export type AuditLogPort = AuditStore;
