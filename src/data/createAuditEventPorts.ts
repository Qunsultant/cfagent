/**
 * Issue #6102 — composition root for the D1 audit-event port. This
 * is the ONLY module that maps a Worker binding to the event-log
 * port implementation: domain code imports this helper and the port
 * types, never a store client. Mirrors
 * src/data/createAuditPolicyPorts.ts.
 *
 * Absence of the binding is a normal, non-error state:
 * `createAuditEventAdapter` returns null and callers keep their
 * fail direction — best-effort writes skip, blocking writes throw
 * (recordBlockingAuditAsync), reads return empty / 404 / 500 per
 * their own contract. Never fall back to the DO mas_events table:
 * after cutover the DO table is frozen pre-cutover history, and
 * the only DO reads left are the retention drain.
 *
 * #CDO-mha7
 */
import {
  createD1AuditEventDb,
  D1AuditEventStore,
  ensureAuditEventSchema,
  type AuditEventDb,
} from "./d1AuditEventAdapter";
import type { AsyncEventLogPort } from "./asyncEventLogPorts";

/** Build the audit-event adapter from Worker env, or null if unbound. */
export function createAuditEventAdapter(env: {
  AGENT_DB?: unknown;
}): D1AuditEventStore | null {
  if (!env.AGENT_DB) return null;
  return new D1AuditEventStore(createD1AuditEventDb(env.AGENT_DB as D1Database));
}

/**
 * Build the adapter AND ensure its schema (idempotent — migration
 * 0089 applies once), so a first audit write never fails closed
 * merely because the migration was never applied to this D1.
 * Returns null if unbound.
 */
export async function createEnsuredAuditEventAdapter(env: {
  AGENT_DB?: unknown;
}): Promise<D1AuditEventStore | null> {
  if (!env.AGENT_DB) return null;
  const db = createD1AuditEventDb(env.AGENT_DB as D1Database);
  await ensureAuditEventSchema(db);
  return new D1AuditEventStore(db);
}

/**
 * The memoized ensured port per env object (one adapter per
 * isolate — env is stable per isolate, so the WeakMap is
 * effectively per-isolate). Every audit-event call site resolves
 * the port through here; the ensure runs once per env, and a
 * failed ensure stays failed (fail-closed, same as the
 * audit-policy port's per-instance memo).
 */
const ensuredPorts = new WeakMap<object, Promise<D1AuditEventStore | null>>();

export function auditEventPort(
  env: { AGENT_DB?: unknown } | undefined | null,
): Promise<AsyncEventLogPort | null> {
  if (!env || !env.AGENT_DB) return Promise.resolve(null);
  let port = ensuredPorts.get(env);
  if (!port) {
    port = createEnsuredAuditEventAdapter(env);
    ensuredPorts.set(env, port);
  }
  return port;
}

export { ensureAuditEventSchema };
export type { AuditEventDb, AsyncEventLogPort };
