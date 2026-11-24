/**
 * #6151 S4 — in-memory admin-config store.
 *
 * A test double with the same port semantics as the D1 adapter.
 * It is NOT a production store and NOT a second source of truth
 * — it exists so the port contract is testable without any store
 * at all, and so route tests can run without a D1 binding. No
 * migration concept applies here (there is no SQL to migrate).
 *
 * The tenant-allowance cap lives here too (setUserAllowlist reads
 * the allowance and refuses an exceeding write): the invariant
 * holds for every caller of the port, not just the route.
 */
import { BusinessError } from "../outcomes/outcomeAspects";
import {
  assertNavAdminId,
  assertPersonaPresetKey,
  normalizeNavIdList,
  type NavAdminConfigStore,
  type PersonaDefaultRecord,
  type TenantAllowanceRecord,
  type UserAllowlistRecord,
} from "./navAdminConfigPorts";

export class InMemoryNavAdminConfigAdapter implements NavAdminConfigStore {
  private allowances = new Map<string, TenantAllowanceRecord>();
  private allowlists = new Map<string, UserAllowlistRecord>();
  private personaDefaults = new Map<string, PersonaDefaultRecord>();

  async ensureSchema(): Promise<void> {
    // No SQL to migrate in memory.
  }

  async getTenantAllowance(tenantId: string): Promise<TenantAllowanceRecord | null> {
    const row = this.allowances.get(tenantId);
    return row ? { ...row, allowedIds: [...row.allowedIds] } : null;
  }

  async setTenantAllowance(
    tenantId: string,
    allowedIds: string[],
    updatedBy: string,
  ): Promise<TenantAllowanceRecord> {
    const cleanTenant = assertNavAdminId(tenantId);
    const record: TenantAllowanceRecord = {
      tenantId: cleanTenant,
      allowedIds: normalizeNavIdList(allowedIds),
      updatedAtMs: Date.now(),
      updatedBy,
    };
    this.allowances.set(cleanTenant, record);
    return { ...record, allowedIds: [...record.allowedIds] };
  }

  async listTenantAllowances(): Promise<TenantAllowanceRecord[]> {
    return [...this.allowances.values()]
      .sort((a, b) => (a.tenantId < b.tenantId ? -1 : a.tenantId > b.tenantId ? 1 : 0))
      .map((row) => ({ ...row, allowedIds: [...row.allowedIds] }));
  }

  async getUserAllowlist(userId: string): Promise<UserAllowlistRecord | null> {
    const row = this.allowlists.get(userId);
    return row ? { ...row, allowedIds: [...row.allowedIds] } : null;
  }

  async setUserAllowlist(
    userId: string,
    input: {
      tenantId: string | null;
      allowedIds: string[];
      savedPresetsAllowed?: boolean;
    },
    updatedBy: string,
  ): Promise<UserAllowlistRecord> {
    const cleanUser = assertNavAdminId(userId);
    const allowedIds = normalizeNavIdList(input.allowedIds);
    // The cap: a tenant allowance, when present, is the ceiling —
    // a write whose ids exceed it is refused, never clipped.
    if (input.tenantId !== null) {
      const allowance = this.allowances.get(input.tenantId);
      if (allowance) {
        const allowed = new Set(allowance.allowedIds);
        if (allowedIds.some((id) => !allowed.has(id))) {
          throw new BusinessError("FAILURE_NAV_ALLOWLIST_EXCEEDS_ALLOWANCE");
        }
      }
    }
    const record: UserAllowlistRecord = {
      userId: cleanUser,
      tenantId: input.tenantId,
      allowedIds,
      savedPresetsAllowed: input.savedPresetsAllowed !== false,
      updatedAtMs: Date.now(),
      updatedBy,
    };
    this.allowlists.set(cleanUser, record);
    return { ...record, allowedIds: [...record.allowedIds] };
  }

  async listUserAllowlists(tenantId?: string): Promise<UserAllowlistRecord[]> {
    return [...this.allowlists.values()]
      .filter((row) => tenantId === undefined || row.tenantId === tenantId)
      .sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0))
      .map((row) => ({ ...row, allowedIds: [...row.allowedIds] }));
  }

  async getPersonaDefault(
    persona: PersonaDefaultRecord["persona"],
  ): Promise<PersonaDefaultRecord | null> {
    const row = this.personaDefaults.get(persona);
    return row ? { ...row } : null;
  }

  async setPersonaDefault(
    persona: PersonaDefaultRecord["persona"],
    presetKey: string,
    updatedBy: string,
  ): Promise<PersonaDefaultRecord> {
    const record: PersonaDefaultRecord = {
      persona,
      presetKey: assertPersonaPresetKey(presetKey),
      updatedAtMs: Date.now(),
      updatedBy,
    };
    this.personaDefaults.set(persona, record);
    return { ...record };
  }

  async deletePersonaDefault(
    persona: PersonaDefaultRecord["persona"],
  ): Promise<boolean> {
    return this.personaDefaults.delete(persona);
  }

  async listPersonaDefaults(): Promise<PersonaDefaultRecord[]> {
    return [...this.personaDefaults.values()]
      .sort((a, b) => (a.persona < b.persona ? -1 : a.persona > b.persona ? 1 : 0))
      .map((row) => ({ ...row }));
  }
}
