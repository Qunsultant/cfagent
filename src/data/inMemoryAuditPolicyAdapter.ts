/**
 * Issue #2183 — in-memory audit-policy adapter.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth
 * — it exists so the port contract is testable without any store
 * at all. No migration concept applies here (there is no SQL to
 * migrate); the PROPOSED operator data is seeded on
 * construction, mirroring ensureAuditPolicySchema's seeds, and
 * an operator edit via setActionPolicy/setSetting is never
 * overwritten (there is no re-seed path).
 */
import {
  AUDIT_CHAIN_GENESIS_PREV_HASH,
  AUDIT_POLICY_BLOCKING_ACTIONS,
  AUDIT_POLICY_DEFAULT_MODE,
  AUDIT_POLICY_NON_BLOCKING_ACTIONS,
  AUDIT_POLICY_PROPOSED_RETENTION_DAYS,
  AUDIT_POLICY_SETTING_ENFORCEMENT_MODE,
  AUDIT_POLICY_SETTING_RETENTION_DAYS,
  auditChainEntryHash,
  auditPayloadHash,
  type AuditChainEntry,
  type AuditChainEntryInput,
  type AuditPolicyActionRow,
  type AuditPolicyPort,
  type AuditPolicySettingRow,
} from "./auditPolicyPorts";

export class InMemoryAuditPolicyAdapter implements AuditPolicyPort {
  private actions = new Map<string, AuditPolicyActionRow>();
  private settings = new Map<string, AuditPolicySettingRow>();
  private chain = new Map<string, AuditChainEntry>();

  constructor() {
    const now = Date.now();
    for (const action of AUDIT_POLICY_BLOCKING_ACTIONS) {
      this.actions.set(action, { action, blockOnAuditFailure: true, updatedAtMs: now });
    }
    for (const action of AUDIT_POLICY_NON_BLOCKING_ACTIONS) {
      this.actions.set(action, { action, blockOnAuditFailure: false, updatedAtMs: now });
    }
    this.settings.set(AUDIT_POLICY_SETTING_ENFORCEMENT_MODE, {
      key: AUDIT_POLICY_SETTING_ENFORCEMENT_MODE,
      value: AUDIT_POLICY_DEFAULT_MODE,
      updatedAtMs: now,
    });
    this.settings.set(AUDIT_POLICY_SETTING_RETENTION_DAYS, {
      key: AUDIT_POLICY_SETTING_RETENTION_DAYS,
      value: String(AUDIT_POLICY_PROPOSED_RETENTION_DAYS),
      updatedAtMs: now,
    });
  }

  async listActionPolicies(): Promise<AuditPolicyActionRow[]> {
    return [...this.actions.values()].sort((a, b) => (a.action < b.action ? -1 : 1));
  }

  async getActionPolicy(action: string): Promise<AuditPolicyActionRow | null> {
    return this.actions.get(action) ?? null;
  }

  async setActionPolicy(
    action: string,
    blockOnAuditFailure: boolean,
  ): Promise<AuditPolicyActionRow> {
    const row: AuditPolicyActionRow = { action, blockOnAuditFailure, updatedAtMs: Date.now() };
    this.actions.set(action, row);
    return row;
  }

  async getSetting(key: string): Promise<AuditPolicySettingRow | null> {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string): Promise<AuditPolicySettingRow> {
    const row: AuditPolicySettingRow = { key, value, updatedAtMs: Date.now() };
    this.settings.set(key, row);
    return row;
  }

  async getChainHead(tenantId: string): Promise<AuditChainEntry | null> {
    const rows = (await this.listChainEntries(tenantId)).sort(
      (a, b) => b.sequence - a.sequence,
    );
    return rows[0] ?? null;
  }

  async listChainEntries(tenantId: string): Promise<AuditChainEntry[]> {
    return [...this.chain.values()]
      .filter((e) => e.tenantId === tenantId)
      .sort((a, b) => a.sequence - b.sequence);
  }

  /**
   * Per-tenant append queue (#6112). `appendChainEntry` is a
   * read-modify-write (read head, compute sequence, hash, write);
   * two concurrent calls for one tenant used to compute the same
   * sequence and the second entry was lost to the collision throw.
   * Each tenant's appends now run through that tenant's promise
   * chain, so the head read of append N+1 always sees append N.
   * The chain is per tenant (different tenants still append in
   * parallel) and a rejected append never poisons the queue — the
   * stored tail swallows the rejection while the caller still
   * receives it. The collision guard below stays as the invariant
   * check: it must never fire through this path again.
   */
  private chainQueue = new Map<string, Promise<unknown>>();

  async appendChainEntry(input: AuditChainEntryInput): Promise<AuditChainEntry> {
    const tail = this.chainQueue.get(input.tenantId) ?? Promise.resolve();
    const next = tail.then(() => this.appendChainEntrySerialized(input));
    this.chainQueue.set(input.tenantId, next.catch(() => {}));
    return next;
  }

  private async appendChainEntrySerialized(
    input: AuditChainEntryInput,
  ): Promise<AuditChainEntry> {
    const head = await this.getChainHead(input.tenantId);
    const sequence = (head?.sequence ?? 0) + 1;
    const createdAtMs = input.createdAtMs ?? Date.now();
    const payloadHash = await auditPayloadHash(input.payload);
    const prevHash = head?.entryHash ?? AUDIT_CHAIN_GENESIS_PREV_HASH;
    const entryHash = await auditChainEntryHash(
      prevHash,
      payloadHash,
      input.action,
      createdAtMs,
    );
    const entry: AuditChainEntry = {
      id: `${input.tenantId}:${sequence}`,
      tenantId: input.tenantId,
      sequence,
      action: input.action,
      payloadHash,
      prevHash,
      entryHash,
      createdAtMs,
    };
    if (this.chain.has(entry.id)) {
      throw new Error(`audit chain sequence collision for tenant ${input.tenantId} at ${sequence}`);
    }
    this.chain.set(entry.id, entry);
    return entry;
  }

  async listAgedChainEntries(
    tenantId: string,
    cutoffMs: number,
    limit: number,
  ): Promise<AuditChainEntry[]> {
    return [...this.chain.values()]
      .filter((e) => e.tenantId === tenantId && e.createdAtMs < cutoffMs)
      .sort((a, b) => a.createdAtMs - b.createdAtMs)
      .slice(0, Math.max(0, limit));
  }

  async deleteChainEntries(tenantId: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      const entry = this.chain.get(id);
      if (entry && entry.tenantId === tenantId) this.chain.delete(id);
    }
  }
}
