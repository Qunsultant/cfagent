/**
 * Issue #3169 — Drizzle D1 adapter for the tenant channel port.
 * This module is the ONLY place tenant-channel code touches a
 * store client: all SQL-adjacent code (the Drizzle query
 * builder) lives here, behind the port interface. Single
 * statement ops only (ADR 0002). A read never creates a row:
 * an absent row reads as DEFAULT_TENANT_CHANNELS.
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { agentTenantChannels } from "./drizzleSchema";
import {
  DEFAULT_TENANT_CHANNELS,
  normalizeTenantSlackChannel,
  normalizeTenantWebhookUrl,
  type TenantChannelConfig,
  type TenantChannelPatch,
  type TenantChannelStore,
} from "./tenantChannelPorts";

/** Drizzle D1 database object carrying the tenant channels table. */
export type TenantChannelDb = DrizzleD1Database<{
  agentTenantChannels: typeof agentTenantChannels;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1TenantChannelDb(d1: D1Database): TenantChannelDb {
  return drizzle(d1, {
    schema: { agentTenantChannels },
  });
}

function toConfig(row: typeof agentTenantChannels.$inferSelect): TenantChannelConfig {
  return {
    email: row.emailEnabled === 1,
    slack: row.slackEnabled === 1,
    webhook: row.webhookEnabled === 1,
    copilot: row.copilotEnabled === 1,
    docs: row.docsEnabled === 1,
  };
}

/** Tenant channel flags over D1 via Drizzle. */
export class D1TenantChannelAdapter implements TenantChannelStore {
  private slackChannels = new Map<string, string>();
  private webhookUrls = new Map<string, string>();
  private scheduleWebhookUrls = new Map<string, Map<string, string>>();

  constructor(readonly db: TenantChannelDb) {}

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

  async getTenantChannels(tenantId: string): Promise<TenantChannelConfig> {
    const rows = await this.db
      .select()
      .from(agentTenantChannels)
      .where(eq(agentTenantChannels.tenantId, tenantId));
    if (rows.length === 0) return { ...DEFAULT_TENANT_CHANNELS };
    return toConfig(rows[0]);
  }

  async setTenantChannels(tenantId: string, patch: TenantChannelPatch): Promise<TenantChannelConfig> {
    const current = await this.getTenantChannels(tenantId);
    const next = { ...current, ...patch };
    await this.db
      .insert(agentTenantChannels)
      .values({
        tenantId,
        emailEnabled: next.email ? 1 : 0,
        slackEnabled: next.slack ? 1 : 0,
        webhookEnabled: next.webhook ? 1 : 0,
        copilotEnabled: next.copilot ? 1 : 0,
        docsEnabled: next.docs ? 1 : 0,
        updatedAtMs: Date.now(),
      })
      .onConflictDoUpdate({
        target: agentTenantChannels.tenantId,
        set: {
          emailEnabled: next.email ? 1 : 0,
          slackEnabled: next.slack ? 1 : 0,
          webhookEnabled: next.webhook ? 1 : 0,
          copilotEnabled: next.copilot ? 1 : 0,
          docsEnabled: next.docs ? 1 : 0,
          updatedAtMs: Date.now(),
        },
      });
    return { ...next };
  }
}
