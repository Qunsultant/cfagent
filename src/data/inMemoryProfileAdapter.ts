/**
 * Issue #3261 — in-memory user profile store.
 * Issue #5160 — extended to the (internalUserId, tenantId) key,
 * the IDP attribute set, provenance, lookup, and retention.
 *
 * A test double with the same port semantics as the D1 adapter. It
 * is NOT a production store and NOT a second source of truth — it
 * exists so the port contract is testable without any store at all,
 * and so route tests can run without a D1 binding. A read never
 * materializes a row. saveProfileOnce mirrors the D1 batch
 * atomically (single-threaded: check + write + key record with no
 * await between them).
 *
 * Legacy rows (pre-0088, NULL keys) live in a separate login-keyed
 * map: a refresh re-keys one in place the first time its owner
 * signs in. A tenant-scoped lookup never matches a legacy row —
 * its tenant is unknown until it is re-keyed; a cross-tenant
 * lookup does.
 */
import type {
  AttributeMatch,
  IdpRefreshInput,
  IdpRefreshResult,
  UserProfile,
  UserProfileStore,
} from "./profilePorts";
import {
  lookupCandidates,
  normalizeLookupValue,
  refreshStoredProfile,
  type FieldProvenance,
} from "../security/idpAttributes";

const PROFILE_FIELDS = ["displayName", "phone", "email"] as const;
type ProfileField = (typeof PROFILE_FIELDS)[number];

function copyProfile(row: UserProfile): UserProfile {
  return {
    ...row,
    idpAttributes: JSON.parse(JSON.stringify(row.idpAttributes)) as Record<string, unknown>,
    provenance: JSON.parse(JSON.stringify(row.provenance)) as Record<string, FieldProvenance>,
  };
}

function keyOf(internalUserId: string, tenantId: string): string {
  return `${internalUserId}\0${tenantId}`;
}

export class InMemoryProfileAdapter implements UserProfileStore {
  private rows = new Map<string, UserProfile>();
  private legacyRows = new Map<string, UserProfile>();
  private keys = new Set<string>();

  constructor(
    private readonly aliasLookup?: (login: string) => Promise<string | null>,
  ) {}

  async getProfile(internalUserId: string, tenantId: string): Promise<UserProfile | null> {
    const row = this.rows.get(keyOf(internalUserId, tenantId));
    return row ? copyProfile(row) : null;
  }

  async getProfileByLogin(userLogin: string, tenantId: string): Promise<UserProfile | null> {
    const internalUserId = (await this.aliasLookup?.(userLogin)) ?? null;
    if (internalUserId) {
      const keyed = await this.getProfile(internalUserId, tenantId);
      if (keyed) return keyed;
      // A keyed row exists in another tenant but not this one:
      // the identity has a profile, just not here — never show
      // another tenant's row as this tenant's.
      if ([...this.rows.values()].some((r) => r.internalUserId === internalUserId)) {
        return null;
      }
    }
    // No alias resolver (or an unresolvable login): the login
    // column is the fallback — the same read the D1 adapter
    // does over its login column.
    const byLogin = [...this.rows.values()].find(
      (r) => r.userLogin === userLogin && r.tenantId === tenantId,
    );
    if (byLogin) return copyProfile(byLogin);
    if ([...this.rows.values()].some((r) => r.userLogin === userLogin)) return null;
    const legacy = this.legacyRows.get(userLogin);
    return legacy ? copyProfile(legacy) : null;
  }

  async getProfilesByInternalUserId(internalUserId: string): Promise<UserProfile[]> {
    return [...this.rows.values()]
      .filter((r) => r.internalUserId === internalUserId)
      .map(copyProfile);
  }

  async saveProfile(profile: UserProfile): Promise<UserProfile> {
    const next = copyProfile(profile);
    this.putRow(next);
    return copyProfile(next);
  }

  private putRow(next: UserProfile): void {
    if (next.internalUserId && next.tenantId) {
      this.rows.set(keyOf(next.internalUserId, next.tenantId), next);
      // A keyed save supersedes the legacy login row for the same
      // login — one identity, one row per tenant, never two.
      this.legacyRows.delete(next.userLogin);
      return;
    }
    this.legacyRows.set(next.userLogin, next);
  }

  async saveProfileOnce(
    profile: UserProfile,
    idempotencyKey: string,
    _createdAtMs: number,
  ): Promise<{ duplicate: boolean; profile: UserProfile | null }> {
    if (this.keys.has(idempotencyKey)) {
      return { duplicate: true, profile: null };
    }
    const next = copyProfile(profile);
    this.putRow(next);
    this.keys.add(idempotencyKey);
    return { duplicate: false, profile: copyProfile(next) };
  }

  async refreshFromIdp(input: IdpRefreshInput): Promise<IdpRefreshResult> {
    const key = keyOf(input.internalUserId, input.tenantId);
    let row = this.rows.get(key) ?? null;
    if (!row) {
      const legacy = this.legacyRows.get(input.userLogin);
      if (legacy) {
        row = { ...copyProfile(legacy) };
        this.legacyRows.delete(input.userLogin);
        // Legacy columns hold user-saved values by definition
        // (pre-0088 nothing else ever wrote them): stamp them
        // 'user' so the refresh below cannot clobber them.
        for (const field of PROFILE_FIELDS) {
          if (row[field] !== null && !row.provenance[field]) {
            row.provenance[field] = { source: "user", updatedAtMs: row.updatedAtMs };
          }
        }
      }
    }
    if (!row) {
      row = {
        userLogin: input.userLogin,
        displayName: null,
        phone: null,
        email: null,
        updatedAtMs: input.nowMs,
        internalUserId: input.internalUserId,
        tenantId: input.tenantId,
        idpIssuer: input.idpIssuer,
        idpAttributes: {},
        provenance: {},
        idpUpdatedAtMs: null,
      };
    }
    const refreshed = refreshStoredProfile(row, input.attributes, input.nowMs);
    const next: UserProfile = {
      ...copyProfile(row),
      userLogin: input.userLogin,
      internalUserId: input.internalUserId,
      tenantId: input.tenantId,
      idpIssuer: input.idpIssuer,
      idpAttributes: refreshed.idpAttributes,
      provenance: refreshed.provenance,
      idpUpdatedAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
    this.rows.set(key, next);
    return { profile: copyProfile(next), diverged: refreshed.diverged };
  }

  async syncFromProvider(
    internalUserId: string,
    tenantId: string,
    nowMs: number,
  ): Promise<UserProfile | null> {
    const row = this.rows.get(keyOf(internalUserId, tenantId));
    if (!row) return null;
    const next = copyProfile(row);
    // User-owned fields go back to their IDP values: the column
    // clears (null) and the provenance returns to 'idp', so the
    // effective value is the provider value again — including a
    // field the user had cleared.
    for (const field of PROFILE_FIELDS) {
      if (next.provenance[field]?.source === "user") {
        next[field] = null;
        next.provenance[field] = { source: "idp", updatedAtMs: nowMs };
      }
    }
    next.updatedAtMs = nowMs;
    this.rows.set(keyOf(internalUserId, tenantId), next);
    return copyProfile(next);
  }

  async seedTenantProfile(
    internalUserId: string,
    tenantId: string,
    userLogin: string,
    nowMs: number,
  ): Promise<UserProfile> {
    const existing = await this.getProfile(internalUserId, tenantId);
    if (existing) return existing;
    const home = (await this.getProfilesByInternalUserId(internalUserId)).find(
      (r) => Object.keys(r.idpAttributes).length > 0,
    );
    const seeded: UserProfile = {
      userLogin,
      displayName: null,
      phone: null,
      email: null,
      updatedAtMs: nowMs,
      internalUserId,
      tenantId,
      idpIssuer: home?.idpIssuer ?? null,
      idpAttributes: home ? JSON.parse(JSON.stringify(home.idpAttributes)) : {},
      provenance: home
        ? Object.fromEntries(
            Object.keys(home.idpAttributes).map((k) => [
              k,
              { source: "idp" as const, updatedAtMs: nowMs },
            ]),
          )
        : {},
      idpUpdatedAtMs: home?.idpUpdatedAtMs ?? null,
    };
    this.rows.set(keyOf(internalUserId, tenantId), copyProfile(seeded));
    return copyProfile(seeded);
  }

  async lookupByAttribute(
    tenantId: string | null,
    attributeName: string,
    queryValue: string,
  ): Promise<AttributeMatch[]> {
    // The lookup normalizes the query value itself (a caller
    // passes the value as typed, not pre-normalized) and, for
    // phones, tries the country-code variants.
    const candidates = new Set(
      lookupCandidates(attributeName, normalizeLookupValue(attributeName, queryValue)),
    );
    const matches: AttributeMatch[] = [];
    const seen = new Set<string>();
    const consider = (row: UserProfile, source: "idp" | "user", value: unknown) => {
      if (typeof value !== "string") return;
      if (!candidates.has(normalizeLookupValue(attributeName, value))) return;
      const rowTenant = row.tenantId;
      if (tenantId !== null && rowTenant !== tenantId) return;
      if (!row.internalUserId) return;
      const dedupe = `${row.internalUserId}\0${row.tenantId ?? ""}\0${source}`;
      if (seen.has(dedupe)) return;
      seen.add(dedupe);
      matches.push({
        internalUserId: row.internalUserId,
        tenantId: row.tenantId ?? "",
        source,
      });
    };
    const rows = [...this.rows.values(), ...this.legacyRows.values()];
    for (const row of rows) {
      // IDP-sourced value for the attribute.
      const idpValue = row.idpAttributes[attributeName];
      const idpMatched =
        typeof idpValue === "string" &&
        candidates.has(normalizeLookupValue(attributeName, idpValue));
      consider(row, "idp", idpValue);
      // User-edited value for the same attribute (the three
      // profile fields map to their IDP keys). When the user
      // value equals the IDP value, only the 'idp' match is
      // returned — the provider-verified claim is the stronger
      // one (the D1 index writes the same single row).
      if (idpMatched) continue;
      const field =
        attributeName === "name"
          ? "displayName"
          : attributeName === "phone_number"
            ? "phone"
            : attributeName === "email"
              ? "email"
              : null;
      if (field) consider(row, "user", row[field] as string | null);
    }
    return matches;
  }

  async purgeExpiredProfiles(input: {
    cutoffMs: number;
    hasLiveMembership: (internalUserId: string, tenantId: string) => Promise<boolean>;
  }): Promise<{ deleted: number }> {
    let deleted = 0;
    for (const [key, row] of [...this.rows.entries()]) {
      const lastSeen = row.idpUpdatedAtMs ?? row.updatedAtMs;
      if (lastSeen >= input.cutoffMs) continue;
      if (!row.internalUserId || !row.tenantId) continue;
      if (await input.hasLiveMembership(row.internalUserId, row.tenantId)) continue;
      this.rows.delete(key);
      deleted += 1;
    }
    return { deleted };
  }
}
