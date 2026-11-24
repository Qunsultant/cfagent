/**
 * #6151 S4 — admin config for nav presets and allowances (parts 4, 5, 6-UX).
 *
 * The admin-config store is a UX store, not an auth store — the same
 * standing as the saved-preset store (S3): it narrows what the
 * nav-availability endpoint returns, never gates authorization (the
 * PDP decision is the boundary). Three row kinds, one port:
 *
 * - Tenant allowance: one row per tenant — the nav ids the tenant
 *   gets at all (top-level ids + `<parentId>:<subId>` sub-item keys,
 *   S1's one format). Absent means "the tenant gets everything the
 *   platform enables" (the S1 endpoint rule — the store never
 *   re-derives it). Platform admin writes.
 * - Per-user allow-list: one row per user — the nav ids that user
 *   may see, plus whether saved presets are available to them at
 *   all. The row NEVER widens beyond the tenant allowance: the
 *   store refuses a write whose ids exceed the allowance (server
 *   enforcement, not a UI rule — the cap lives in
 *   setUserAllowlist, so every caller is bound by it). Platform
 *   admin writes any user; tenant admin writes only users of their
 *   own tenant (the route enforces the scope; the store enforces
 *   the cap).
 * - Persona-default override: one row per persona — the built-in
 *   preset key that persona's fresh users start from. Absent means
 *   the shipped config (nav-config.json `personaDefaults`); the
 *   endpoint reads the override first and falls back to shipped,
 *   so an edit takes effect on the user's next load with no
 *   redeploy. Platform admin writes.
 *
 * Port idiom: same as SubscriptionStore / NavPresetStore (ADR
 * 0002) — the port interface here, a D1 adapter
 * (d1NavAdminConfigAdapter) and an in-memory adapter
 * (inMemoryNavAdminConfigAdapter) behind it, composed by
 * createNavAdminConfigPorts. No new store type, no second context.
 */
import { BusinessError } from "../outcomes/outcomeAspects";
import {
  builtinPresetKeys,
  enumerateNavAvailabilityIds,
  type NavPersona,
} from "../client/navConfig";

/** One tenant allowance row. */
export interface TenantAllowanceRecord {
  tenantId: string;
  /** Normalized over enumerateNavAvailabilityIds() (sub-item keys included). */
  allowedIds: string[];
  updatedAtMs: number;
  updatedBy: string;
}

/** One per-user allow-list row. */
export interface UserAllowlistRecord {
  userId: string;
  /** The tenant the row belongs to (null when the user holds no tenant membership). */
  tenantId: string | null;
  /** Normalized over enumerateNavAvailabilityIds() (sub-item keys included). */
  allowedIds: string[];
  /** False hides the user's saved presets entirely (built-ins only). */
  savedPresetsAllowed: boolean;
  updatedAtMs: number;
  updatedBy: string;
}

/** One persona-default override row. */
export interface PersonaDefaultRecord {
  persona: NavPersona;
  /** A built-in preset key (never a saved-preset id — those are per-user). */
  presetKey: string;
  updatedAtMs: number;
  updatedBy: string;
}

export interface NavAdminConfigStore {
  getTenantAllowance(tenantId: string): Promise<TenantAllowanceRecord | null>;
  setTenantAllowance(
    tenantId: string,
    allowedIds: string[],
    updatedBy: string,
  ): Promise<TenantAllowanceRecord>;
  listTenantAllowances(): Promise<TenantAllowanceRecord[]>;
  getUserAllowlist(userId: string): Promise<UserAllowlistRecord | null>;
  /**
   * Upsert a per-user allow-list. The write is REFUSED
   * (FAILURE_NAV_ALLOWLIST_EXCEEDS_ALLOWANCE) when the tenant the
   * row belongs to has an allowance and the ids exceed it — the
   * cap is enforced here, in the store, so no caller can widen
   * beyond the allowance.
   */
  setUserAllowlist(
    userId: string,
    input: {
      tenantId: string | null;
      allowedIds: string[];
      savedPresetsAllowed?: boolean;
    },
    updatedBy: string,
  ): Promise<UserAllowlistRecord>;
  listUserAllowlists(tenantId?: string): Promise<UserAllowlistRecord[]>;
  getPersonaDefault(persona: NavPersona): Promise<PersonaDefaultRecord | null>;
  setPersonaDefault(
    persona: NavPersona,
    presetKey: string,
    updatedBy: string,
  ): Promise<PersonaDefaultRecord>;
  deletePersonaDefault(persona: NavPersona): Promise<boolean>;
  listPersonaDefaults(): Promise<PersonaDefaultRecord[]>;
  /** Idempotent schema-ensure (D1 applies migration 0087; in-memory is a no-op). */
  ensureSchema(): Promise<void>;
}

/** The four personas the nav-availability endpoint classifies (S1). */
export const NAV_PERSONAS: NavPersona[] = [
  "platform-admin",
  "tenant-admin",
  "paid",
  "non-paid",
];

/** True iff the value names one of the four nav personas. */
export function isNavPersona(value: unknown): value is NavPersona {
  return (
    typeof value === "string" &&
    (NAV_PERSONAS as string[]).includes(value)
  );
}

/**
 * Normalize an untrusted id list over the availability ids.
 * Unknown ids are dropped (they name no menu); duplicates are
 * removed; the result follows config order. A non-array reads as
 * empty — an allowance that names nothing allows nothing.
 * Pure — the S4 test pins the filtering through this function.
 */
export function normalizeNavIdList(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const known = enumerateNavAvailabilityIds();
  const wanted = new Set(
    input.filter((id): id is string => typeof id === "string"),
  );
  return known.filter((id) => wanted.has(id));
}

/** Validate a tenant/user id (trimmed, non-empty). */
export function assertNavAdminId(value: unknown): string {
  if (typeof value !== "string") {
    throw new BusinessError("FAILURE_NAV_ADMIN_REQUEST_INVALID");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new BusinessError("FAILURE_NAV_ADMIN_REQUEST_INVALID");
  }
  return trimmed;
}

/**
 * Validate a persona-default preset key: it must be one of the
 * built-in preset keys. A saved-preset id is rejected — saved
 * presets are per-user, so a persona (shared by many users) can
 * never default to one.
 */
export function assertPersonaPresetKey(value: unknown): string {
  if (typeof value !== "string") {
    throw new BusinessError("FAILURE_NAV_ADMIN_REQUEST_INVALID");
  }
  const key = value.trim();
  if (!builtinPresetKeys().includes(key)) {
    throw new BusinessError("FAILURE_NAV_ADMIN_REQUEST_INVALID");
  }
  return key;
}
