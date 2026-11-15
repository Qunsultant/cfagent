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
  normalizeTenantWebhookUrl,
  type TenantChannelConfig,
  type TenantChannelPatch,
  type TenantChannelStore,
} from "./tenantChannelPorts";

export class InMemoryTenantChannelAdapter implements TenantChannelStore {
  private rows = new Map<string, TenantChannelConfig>();
  private slackChannels = new Map<string, string>();
  private webhookUrls = new Map<string, string>();
  private scheduleWebhookUrls = new Map<string, Map<string, string>>();

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

  async getTenantWebhookUrl(tenantId: string, scheduleId?: string | null): Promise<string | null> {
    const trimmedSchedule = typeof scheduleId === "string" ? scheduleId.trim() : "";
    if (trimmedSchedule) {
      const scheduleMap = this.scheduleWebhookUrls.get(tenantId);
      if (scheduleMap && scheduleMap.has(trimmedSchedule)) {
        return scheduleMap.get(trimmedSchedule) ?? null;
      }
      if (scheduleMap && scheduleMap.size > 0 && !this.webhookUrls.has(tenantId)) {
        return null;
      }
    }
    return this.webhookUrls.get(tenantId) ?? null;
  }

  async setTenantWebhookUrl(
    tenantId: string,
    webhookUrl: string | null,
    scheduleId?: string | null,
  ): Promise<string | null> {
    const normalized = normalizeTenantWebhookUrl(webhookUrl);
    if (!normalized.ok) {
      throw new Error(normalized.error);
    }
    const trimmedSchedule = typeof scheduleId === "string" ? scheduleId.trim() : "";
    if (trimmedSchedule) {
      let scheduleMap = this.scheduleWebhookUrls.get(tenantId);
      if (normalized.webhookUrl === null) {
        scheduleMap?.delete(trimmedSchedule);
        if (scheduleMap && scheduleMap.size === 0) {
          this.scheduleWebhookUrls.delete(tenantId);
        }
        return null;
      }
      if (!scheduleMap) {
        scheduleMap = new Map<string, string>();
        this.scheduleWebhookUrls.set(tenantId, scheduleMap);
      }
      scheduleMap.set(trimmedSchedule, normalized.webhookUrl);
      return normalized.webhookUrl;
    }
    if (normalized.webhookUrl === null) {
      this.webhookUrls.delete(tenantId);
      return null;
    }
    this.webhookUrls.set(tenantId, normalized.webhookUrl);
    return normalized.webhookUrl;
  }

  async getTenantScheduleWebhookUrls(tenantId: string): Promise<Readonly<Record<string, string>>> {
    const scheduleMap = this.scheduleWebhookUrls.get(tenantId);
    if (!scheduleMap) return {};
    return Object.fromEntries(scheduleMap.entries());
  }
}
