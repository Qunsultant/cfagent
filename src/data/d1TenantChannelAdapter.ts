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
  constructor(readonly db: TenantChannelDb) {}

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
