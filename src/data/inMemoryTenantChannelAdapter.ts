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
  normalizeTenantSlackChannel,
  type TenantChannelConfig,
  type TenantChannelPatch,
  type TenantChannelStore,
} from "./tenantChannelPorts";

export class InMemoryTenantChannelAdapter implements TenantChannelStore {
  private rows = new Map<string, TenantChannelConfig>();
  private slackChannels = new Map<string, string>();

  async getTenantChannels(tenantId: string): Promise<TenantChannelConfig> {
    return { ...(this.rows.get(tenantId) ?? DEFAULT_TENANT_CHANNELS) };
  }

  async setTenantChannels(tenantId: string, patch: TenantChannelPatch): Promise<TenantChannelConfig> {
    const next = { ...(this.rows.get(tenantId) ?? DEFAULT_TENANT_CHANNELS), ...patch };
    this.rows.set(tenantId, next);
    return { ...next };
  }

  async getTenantSlackChannel(tenantId: string): Promise<string | null> {
    return this.slackChannels.get(tenantId) ?? null;
  }

  async setTenantSlackChannel(tenantId: string, slackChannel: string | null): Promise<string | null> {
    const normalized = normalizeTenantSlackChannel(slackChannel);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }
    if (normalized.slackChannel === null) {
      this.slackChannels.delete(tenantId);
      return null;
    }
    this.slackChannels.set(tenantId, normalized.slackChannel);
    return normalized.slackChannel;
  }
}
