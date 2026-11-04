/**
 * Issue #2221 — Drizzle D1 adapter for the tenant directory port.
 * This module is the ONLY place tenant-directory code touches a
 * store client: all SQL-adjacent code (the Drizzle query builder)
 * lives here, behind the port interface. No new migration: it
 * reads only tables migrations 0007 / 0026 / 0028 already create
 * (agent_commercial_accounts, agent_tenant_settings).
 */
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { agentCommercialAccounts, agentTenantSettings } from "./drizzleSchema";
import type { TenantDirectory } from "./tenantDirectoryPorts";

/** Drizzle D1 database object carrying the two commercial tables. */
export type TenantDirectoryDb = DrizzleD1Database<{
  agentCommercialAccounts: typeof agentCommercialAccounts;
  agentTenantSettings: typeof agentTenantSettings;
}>;

/** Build the Drizzle D1 database object from a bound D1 client. */
export function createD1TenantDirectoryDb(d1: D1Database): TenantDirectoryDb {
  return drizzle(d1, {
    schema: { agentCommercialAccounts, agentTenantSettings },
  });
}

/** Tenant directory over D1 via Drizzle (read-only). */
export class D1TenantDirectoryAdapter implements TenantDirectory {
  constructor(readonly db: TenantDirectoryDb) {}

  async listTenantIds(): Promise<string[]> {
    const fromAccounts = await this.db
      .select({ tenantId: agentCommercialAccounts.tenantId })
      .from(agentCommercialAccounts);
    const fromSettings = await this.db
      .select({ tenantId: agentTenantSettings.tenantId })
      .from(agentTenantSettings);
    const ids = new Set<string>();
    for (const row of [...fromAccounts, ...fromSettings]) ids.add(row.tenantId);
    return [...ids].sort();
  }

  async listTenantMembers(tenantId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: agentCommercialAccounts.id })
      .from(agentCommercialAccounts)
      .where(eq(agentCommercialAccounts.tenantId, tenantId));
    return rows.map((row) => row.id).sort();
  }
}
