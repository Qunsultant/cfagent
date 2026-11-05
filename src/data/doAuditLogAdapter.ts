/**
 * Issue #2435 (#1976 step 5d) — the production (DO
 * wire-protocol) adapter for the audit log family. It is a
 * client of the existing funnel exactly as today's atomic
 * client in security/iaaaAuditStore.ts is: the audit-append
 * sender and the entry lister are built by the composition
 * root (createAuditPorts.ts) from createStoreSender /
 * listStoreEntries over the SAME SessionStore instance,
 * bucket "sessions" — so wire payloads and store_op metrics
 * behaviour are byte-identical to the flag-off path by
 * construction (same funnel, same payload shapes, and the
 * append remains the DO's own `audit-append` op: Q-1, the
 * mechanism does not move).
 *
 * #CDO-mha7
 */
import type {
  AuditResult,
  CreateIaaaAuditEventInput,
  IaaaAuditEvent,
} from "../security/iaaaAudit";
import type { AuditLogPort, AuditLogPortOptions } from "./auditLogPorts";
import {
  createAuditLogStore,
  type AuditLogBackend,
} from "./auditLogStoreImpl";

export class DoAuditLogAdapter implements AuditLogPort {
  readonly legacyFallback = false as const;
  private readonly store: AuditLogPort;

  constructor(backend: AuditLogBackend, options: AuditLogPortOptions = {}) {
    this.store = createAuditLogStore(backend, options);
  }

  append(event: IaaaAuditEvent): Promise<void> {
    return this.store.append(event);
  }

  appendAtomic(input: CreateIaaaAuditEventInput): Promise<AuditResult> {
    return this.store.appendAtomic!(input);
  }

  list(): Promise<IaaaAuditEvent[]> {
    return this.store.list();
  }
}
