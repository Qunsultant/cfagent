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
  listStoreEntries,
  type DoNamespaceLike,
} from "./durableKv";
import type { Env } from "../types";
import {
  IAAA_AUDIT_KEY_PREFIX,
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
  return {
    configured: Boolean(namespace),
    sendAppend: createStoreSender(namespace, "sessions", instanceName),
    listEntries: () =>
      listStoreEntries({
        namespace,
        namespaceName: "sessions",
        prefix: IAAA_AUDIT_KEY_PREFIX,
        instanceName,
      }),
  };
}

/** Compose the family over an env's SessionStore binding. */
export function createAuditPorts(
  env: Env,
  options: AuditLogPortOptions = {},
): AuditLogPort {
  const namespace = env.SESSION_STORE as unknown as
    | DoNamespaceLike
    | undefined;
  return new DoAuditLogAdapter(doBackend(namespace, options), options);
}

/** Compose the family over a DO namespace directly (test seams / fakes). */
export function createAuditPortsFromNamespace(
  namespace: DoNamespaceLike | null | undefined,
  options: AuditLogPortOptions = {},
): AuditLogPort {
  return new DoAuditLogAdapter(doBackend(namespace, options), options);
}

/** Compose the in-memory family (conformance / test doubles). */
export function createInMemoryAuditPorts(
  options: AuditLogPortOptions = {},
): AuditLogPort {
  return new InMemoryAuditLogAdapter(options);
}
