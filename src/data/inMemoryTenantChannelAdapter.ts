/**
 * Issue #3169 — in-memory tenant channel store.
 *
 * A test double with the same port semantics as the D1
 * adapter. It is NOT a production store and NOT a second
 * source of truth — it exists so the port contract is testable
 * without any store at all, and so route tests can run
 * without a D1 binding. A read never materializes a row.
 */
import {
  DEFAULT_TENANT_CHANNELS,
  type TenantChannelConfig,
  type TenantChannelPatch,
  type TenantChannelStore,
} from "./tenantChannelPorts";

export class InMemoryTenantChannelAdapter implements TenantChannelStore {
  private rows = new Map<string, TenantChannelConfig>();

  async getTenantChannels(tenantId: string): Promise<TenantChannelConfig> {
    return { ...(this.rows.get(tenantId) ?? DEFAULT_TENANT_CHANNELS) };
  }

  async setTenantChannels(tenantId: string, patch: TenantChannelPatch): Promise<TenantChannelConfig> {
    const next = { ...(this.rows.get(tenantId) ?? DEFAULT_TENANT_CHANNELS), ...patch };
    this.rows.set(tenantId, next);
    return { ...next };
  }
}
