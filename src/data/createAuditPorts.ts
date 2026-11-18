/**
 * Issue #2435 (#1976 step 5d) — composition root for the
 * IAAA audit log family. This is the ONLY module that maps a
 * host's storage handles to the family's production
 * implementation: consumers import this helper and the port
 * types, never a funnel client for this family's keys.
 *
 * The root is the family's funnel composition site: it builds
 * the audit-append sender via createStoreSender and the
 * listing seam via listStoreEntries, both over the SAME
 * SessionStore instance the flag-off factory uses. Flag
 * selection lives in the façade (security/iaaaAuditStore.ts's
 * createWiredAuditStore), which calls this root only when
 * AUDIT_PORTS_ENABLED is on (isAuditPortsEnabled in
 * auditLogPorts.ts, #1169 semantics).
 *
 * This module is SERVER-ONLY in effect (it wires the DO
 * adapter); client-reachable modules must import the port
 * TYPES from auditLogPorts.ts (type-only), never this root.
 *
 * #CDO-mha7
 */
import {
  createStoreSender,
  type DoNamespaceLike,
} from "./durableKv";
import type { Env } from "../types";
import {
  IAAA_AUDIT_LOG_KEY,
  type AuditLogPort,
  type AuditLogPortOptions,
} from "./auditLogPorts";
import type { AuditLogBackend } from "./auditLogStoreImpl";
import { DoAuditLogAdapter } from "./doAuditLogAdapter";
import { InMemoryAuditLogAdapter } from "./inMemoryAuditLogAdapter";

export type { AuditLogPort };
export { isAuditPortsEnabled } from "./auditLogPorts";

function doBackend(
  namespace: DoNamespaceLike | null | undefined,
  options: AuditLogPortOptions,
): AuditLogBackend {
  const instanceName = options.instanceName ?? "kv";
  // One sender for every audit op (append, list, migrate): the
  // funnel composition sites are census-pinned
  // (tests/global_dd_census_2356.test.ts), so the list seam
  // rides the same createStoreSender the append already uses
  // instead of composing a second entry point. The DO's
  // `audit-list` op selects the substrate server-side (table
  // rows while the table holds any, else the segment entries),
  // so this seam needs no substrate of its own.
  const send = createStoreSender(namespace, "sessions", instanceName);
  return {
    configured: Boolean(namespace),
    sendAppend: send,
    listEntries: async () => {
      const reply = await send({
        op: "audit-list",
        ns: "sessions",
        key: IAAA_AUDIT_LOG_KEY,
      });
      return Array.isArray(reply?.entries) ? reply.entries : null;
    },
  };
}

/**
 * #3251 (O1) — the flag-ON composition speaks the append-only
 * table substrate: the options the root passes to the DO
 * adapter carry `substrate: "table"`, so the shared
 * implementation's append payloads select the table branch
 * of the DO's `audit-append` op. A caller-supplied substrate
 * is never honoured here — the flag, not the caller, picks
 * the substrate.
 */
function tableOptions(options: AuditLogPortOptions): AuditLogPortOptions {
  return { ...options, substrate: "table" };
}

/** Compose the family over an env's SessionStore binding. */
export function createAuditPorts(
  env: Env,
  options: AuditLogPortOptions = {},
): AuditLogPort {
  const namespace = env.SESSION_STORE as unknown as
    | DoNamespaceLike
    | undefined;
  return new DoAuditLogAdapter(doBackend(namespace, options), tableOptions(options));
}

/** Compose the family over a DO namespace directly (test seams / fakes). */
export function createAuditPortsFromNamespace(
  namespace: DoNamespaceLike | null | undefined,
  options: AuditLogPortOptions = {},
): AuditLogPort {
  return new DoAuditLogAdapter(doBackend(namespace, options), tableOptions(options));
}

/** Compose the in-memory family (conformance / test doubles). */
export function createInMemoryAuditPorts(
  options: AuditLogPortOptions = {},
): AuditLogPort {
  return new InMemoryAuditLogAdapter(options);
}
