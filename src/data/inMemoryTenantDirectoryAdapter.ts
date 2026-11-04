/**
 * Issue #2221 — in-memory tenant directory.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth —
 * it exists so the port contract is testable without any store
 * at all, and so route tests can run without a D1 binding.
 * Seeding is explicit (seedTenant) because this adapter owns no
 * commercial state of its own: production consistency comes
 * from both D1 adapters reading the same database.
 */
import type { TenantDirectory } from "./tenantDirectoryPorts";

export class InMemoryTenantDirectoryAdapter implements TenantDirectory {
  private members = new Map<string, Set<string>>();

  /** Seed one tenant and its account-row member userIds (sorted on read). */
  seedTenant(tenantId: string, memberUserIds: string[]): void {
    this.members.set(tenantId, new Set(memberUserIds));
  }

  async listTenantIds(): Promise<string[]> {
    return [...this.members.keys()].sort();
  }

  async listTenantMembers(tenantId: string): Promise<string[]> {
    return [...(this.members.get(tenantId) ?? new Set<string>())].sort();
  }
}
