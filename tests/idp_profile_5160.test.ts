/**
 * Issue #5160 — store ALL IDP-provided user attributes at sign-in
 * (email, phone, any identifier) for user identification, persisted
 * as a durable, multi-tenant, user-updatable profile.
 *
 * RED first: the IDP attribute sanitizer, the extended profile
 * port (migration 0088), the sign-in refresh hook, the
 * tenant-aware lookup, the config, and the retention pass do not
 * exist yet.
 *
 * Owner directive (2026-11-17): "we must store everything that we
 * get from IDP for a user to identify that user with email, phone,
 * any other identifier from IDP, etc." Owner refinements for THIS
 * build (2026-11-23): the attributes persist as a user PROFILE the
 * user can update later (sign-in refresh must not silently clobber
 * a user edit), and the profile is MULTI-TENANT — the same user
 * (same internal user id) can sign up with multiple tenants.
 *
 * What IS built: the full sanitized IDP userinfo doc is persisted
 * on the durable D1 profile (agent_user_profiles, migration 0088),
 * keyed by (internalUserId, tenantId); per-field provenance
 * (idp|user) decides refresh-vs-edit; lookup by any stored
 * identifier is exact-match, tenant-aware, and fails closed on
 * ambiguity; the existing Profile view is THE editor (no second
 * one); config is externalized (config/idp-profile.json defaults
 * + mas_settings runtime overrides, admin-gated, audited).
 *
 * What is NOT built: provider access tokens (never stored); a
 * change to the identity KEY (still (issuer, subject)); the #5159
 * panel/traceability build; the #6181 D1 move of privilege state;
 * a tenant switcher for the Profile view (follow-up issue); the
 * #6308 reverse-alias fix (holds until this lands).
 */
import { describe, expect, it } from "vitest";
import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import {
  ALL_MIGRATIONS,
  MIGRATION_0088_IDP_ATTRIBUTES_PROFILE,
} from "../src/data/migrationRunner";
import * as drizzleSchema from "../src/data/drizzleSchema";
import {
  agentIdentityAttributeIndex,
  agentUserProfiles,
} from "../src/data/drizzleSchema";
import {
  createD1ProfileDb,
  D1ProfileAdapter,
  ensureUserProfileSchema,
} from "../src/data/d1ProfileAdapter";
import { InMemoryProfileAdapter } from "../src/data/inMemoryProfileAdapter";
import type {
  IdpRefreshInput,
  UserProfile,
  UserProfileStore,
} from "../src/data/profilePorts";
import {
  IDP_ATTRIBUTE_MAX_BYTES,
  effectiveProfileValue,
  idpFieldValue,
  mergeIdpAttributes,
  normalizeLookupValue,
  sanitizeIdpAttributes,
} from "../src/security/idpAttributes";
import {
  DEFAULT_IDP_PROFILE_CONFIG,
  loadIdpProfileConfig,
  validateIdpProfileConfig,
} from "../src/security/idpProfileConfig";
import type { SettingsPort } from "../src/data/settingsReadPorts";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import {
  createMemoryIdentityBindingStore,
  deriveInternalUserId,
} from "../src/security/identityBinding";
import {
  createMemoryMembershipStore,
  createMembership,
} from "../src/security/authorization";
import { runWiredPostLogin } from "../src/security/iaaaGithubEndToEnd";
import { recordLoginAlias } from "../src/security/iaaaMigration";
import type { KvLike } from "../src/security/kvResilience";
import { MockD1Database } from "./mock-d1";
import { toUserProfileView } from "../src/services/userProfile";
import { getOutcome } from "../src/outcomes/outcomeAspects";

const GITHUB_ISSUER = "https://github.com";
const GOOGLE_ISSUER = "https://accounts.google.com";
const NOW = 1_790_000_000_000;

function memoryKv(): KvLike & { keys(): string[] } {
  const map = new Map<string, string>();
  return {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async put(key: string, value: string) {
      map.set(key, value);
    },
    async delete(key: string) {
      map.delete(key);
    },
    keys() {
      return [...map.keys()];
    },
  };
}

const GITHUB_DOC = {
  id: 82253453,
  login: "OpenAIMP",
  email: "octo@example.com",
  name: "Mubasher Ahmed",
  avatar_url: "https://avatars.example.com/u/82253453",
  company: "OpenAIMP",
  blog: "https://example.com",
};

const GOOGLE_DOC = {
  sub: "116080816274398642624",
  email: "dhmprstw@gmail.com",
  email_verified: true,
  name: "D H",
  picture: "https://lh3.example.com/photo",
  phone_number: "+1 (555) 010-2030",
};

function githubId(): Promise<string> {
  return deriveInternalUserId(GITHUB_ISSUER, "82253453");
}

function googleId(): Promise<string> {
  return deriveInternalUserId(GOOGLE_ISSUER, "116080816274398642624");
}

function emptyProfile(overrides: Partial<UserProfile>): UserProfile {
  return {
    userLogin: "OpenAIMP",
    displayName: null,
    phone: null,
    email: null,
    updatedAtMs: NOW,
    internalUserId: null,
    tenantId: null,
    idpIssuer: null,
    idpAttributes: {},
    provenance: {},
    idpUpdatedAtMs: null,
    ...overrides,
  };
}

// Sanitizer ---------------------------------------------------------------

describe("sanitizer — the raw IDP doc is stored whole, minus tokens (#5160)", () => {
  it("keeps every GitHub field, including an unknown extra field", () => {
    const doc = { ...GITHUB_DOC, hireable: true, followers: 12 };
    const result = sanitizeIdpAttributes(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attributes).toEqual(doc);
  });

  it("keeps every Google field, including phone_number", () => {
    const result = sanitizeIdpAttributes(GOOGLE_DOC);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attributes).toEqual(GOOGLE_DOC);
  });

  it("drops token-ish keys and never stores a token", () => {
    const doc = {
      ...GITHUB_DOC,
      access_token: "gho_secret",
      id_token: "eyJ.secret",
      refresh_token: "ghr_secret",
      client_secret: "shh",
      token: "tok",
      api_token: "tok2",
    };
    const result = sanitizeIdpAttributes(doc);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attributes).not.toHaveProperty("access_token");
    expect(result.attributes).not.toHaveProperty("id_token");
    expect(result.attributes).not.toHaveProperty("refresh_token");
    expect(result.attributes).not.toHaveProperty("client_secret");
    expect(result.attributes).not.toHaveProperty("token");
    expect(result.attributes).not.toHaveProperty("api_token");
    expect(JSON.stringify(result.attributes)).not.toContain("secret");
    expect(result.attributes.login).toBe("OpenAIMP");
  });

  it("fails closed on a non-object doc", () => {
    expect(sanitizeIdpAttributes(null).ok).toBe(false);
    expect(sanitizeIdpAttributes("nope").ok).toBe(false);
    expect(sanitizeIdpAttributes([1, 2]).ok).toBe(false);
  });

  it("fails closed on an oversize doc (64 KB cap)", () => {
    const big = { login: "x", blob: "y".repeat(IDP_ATTRIBUTE_MAX_BYTES) };
    const result = sanitizeIdpAttributes(big);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("oversize");
  });

  it("drops non-JSON values instead of storing them", () => {
    const doc = {
      login: "x",
      fn: () => 1,
      undef: undefined,
      big: 10n,
      nested: { ok: 1, bad: () => 2 },
    };
    const result = sanitizeIdpAttributes(doc as unknown as Record<string, unknown>);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attributes).toEqual({ login: "x", nested: { ok: 1 } });
  });
});

// Normalization -----------------------------------------------------------

describe("lookup normalization — exact match after normalization (#5160)", () => {
  it("email is lowercased and trimmed", () => {
    expect(normalizeLookupValue("email", "  Octo@Example.COM ")).toBe("octo@example.com");
  });

  it("phone keeps digits only with a leading + preserved", () => {
    expect(normalizeLookupValue("phone_number", "+1 (555) 010-2030")).toBe("+15550102030");
    expect(normalizeLookupValue("phone", "555.010.2030")).toBe("5550102030");
  });

  it("login is trimmed; other strings are trimmed and case-sensitive", () => {
    expect(normalizeLookupValue("login", "  OpenAIMP ")).toBe("OpenAIMP");
    expect(normalizeLookupValue("company", "  OpenAIMP ")).toBe("OpenAIMP");
    expect(normalizeLookupValue("company", "openaimp")).toBe("openaimp");
  });
});

// Provenance merge ----------------------------------------------------------

describe("provenance merge — refresh writes IDP fields only (#5160)", () => {
  it("writes IDP-sourced fields and marks them idp", () => {
    const merged = mergeIdpAttributes({}, {}, { name: "Mubasher", email: "a@b.c" }, NOW);
    expect(merged.attributes).toEqual({ name: "Mubasher", email: "a@b.c" });
    expect(merged.provenance.name).toEqual({ source: "idp", updatedAtMs: NOW });
    expect(merged.diverged).toEqual([]);
    expect(merged.removed).toEqual([]);
  });

  it("leaves user-owned fields alone and records the divergence", () => {
    const current = { name: "User Name", email: "a@b.c" };
    const provenance = {
      name: { source: "user" as const, updatedAtMs: NOW - 1000 },
      email: { source: "idp" as const, updatedAtMs: NOW - 1000 },
    };
    const merged = mergeIdpAttributes(current, provenance, { name: "IDP Name", email: "new@b.c" }, NOW);
    expect(merged.attributes.name).toBe("User Name");
    expect(merged.attributes.email).toBe("new@b.c");
    expect(merged.diverged).toEqual(["name"]);
  });

  it("drops an IDP-removed field, keeps a user-owned field the IDP dropped", () => {
    const current = { name: "IDP Name", blog: "https://x.example" };
    const provenance = {
      name: { source: "idp" as const, updatedAtMs: NOW - 1000 },
      blog: { source: "user" as const, updatedAtMs: NOW - 1000 },
    };
    const merged = mergeIdpAttributes(current, provenance, {}, NOW);
    expect(merged.attributes).toEqual({ blog: "https://x.example" });
    expect(merged.removed).toEqual(["name"]);
  });

  it("derives effective values: user wins, else IDP, else null", () => {
    const attrs = { name: "IDP Name", phone_number: "+15550102030", email: "idp@b.c" };
    expect(effectiveProfileValue("displayName", null, undefined, attrs)).toBe("IDP Name");
    expect(effectiveProfileValue("displayName", "User Name", { source: "user", updatedAtMs: NOW }, attrs)).toBe("User Name");
    expect(effectiveProfileValue("phone", null, undefined, attrs)).toBe("+15550102030");
    expect(effectiveProfileValue("email", null, undefined, attrs)).toBe("idp@b.c");
    expect(effectiveProfileValue("email", "contact@b.c", { source: "user", updatedAtMs: NOW }, attrs)).toBe("contact@b.c");
    expect(effectiveProfileValue("displayName", null, undefined, {})).toBeNull();
    expect(idpFieldValue("displayName", attrs)).toBe("IDP Name");
    expect(idpFieldValue("phone", attrs)).toBe("+15550102030");
    expect(idpFieldValue("email", attrs)).toBe("idp@b.c");
  });
});

// Migration 0088 ----------------------------------------------------------

describe("migration 0088 — IDP attributes on the profile (#5160)", () => {
  it("is registered with the rebuild + the lookup-index table, and both tables exist in the drizzle schema", () => {
    const migration = ALL_MIGRATIONS.find((m) => m.version === 88);
    expect(migration).toBeDefined();
    expect(migration!.name).toBe("0088_idp_attributes_profile");
    expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS agent_identity_attribute_index");
    expect(migration!.sql).toContain("PRIMARY KEY (internal_user_id, tenant_id)");
    expect(migration!.sql).toContain("internal_user_id TEXT");
    expect(migration!.sql).toContain("idp_attributes_json TEXT");
    expect(migration!.sql).toContain("provenance_json TEXT");
    const drizzleNames = new Set(
      Object.values(drizzleSchema)
        .filter(isTable)
        .map((t) => getTableName(t)),
    );
    expect(drizzleNames.has("agent_user_profiles")).toBe(true);
    expect(drizzleNames.has("agent_identity_attribute_index")).toBe(true);
  });

  it("DDL and the Drizzle schema agree on the rebuilt profile table and the index table", () => {
    const columns = Object.keys(getTableColumns(agentUserProfiles));
    expect(columns).toEqual([
      "userLogin",
      "displayName",
      "phone",
      "email",
      "updatedAtMs",
      "internalUserId",
      "tenantId",
      "idpIssuer",
      "idpAttributes",
      "provenance",
      "idpUpdatedAtMs",
    ]);
    const indexColumns = Object.keys(getTableColumns(agentIdentityAttributeIndex));
    expect(indexColumns).toEqual([
      "tenantId",
      "attributeName",
      "attributeValueNormalized",
      "internalUserId",
      "source",
      "updatedAtMs",
    ]);
  });

  it("ensureUserProfileSchema applies migration 0088", async () => {
    const mock = new MockD1Database();
    const db = createD1ProfileDb(mock as unknown as D1Database);
    const applied = await ensureUserProfileSchema(db);
    expect(applied).toContain(88);
    const rows = mock.sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='agent_identity_attribute_index'")
      .all();
    expect(rows.length).toBe(1);
  });
});

// Port — persistence + refresh --------------------------------------------

function refreshInput(
  overrides: Partial<IdpRefreshInput> & { internalUserId: string },
): IdpRefreshInput {
  return {
    tenantId: "primary",
    userLogin: "OpenAIMP",
    idpIssuer: GITHUB_ISSUER,
    attributes: { ...GITHUB_DOC },
    nowMs: NOW,
    ...overrides,
  };
}

describe.each([
  [
    "in-memory",
    (): { store: UserProfileStore; setup?: () => Promise<unknown> } => ({
      store: new InMemoryProfileAdapter(),
    }),
  ],
  [
    "D1",
    (): { store: UserProfileStore; setup?: () => Promise<unknown> } => {
      const mock = new MockD1Database();
      const db = createD1ProfileDb(mock as unknown as D1Database);
      return {
        store: new D1ProfileAdapter(db),
        setup: () => ensureUserProfileSchema(db),
      };
    },
  ],
])("profile port — %s (#5160)", (_label, makeStore) => {
  it("persists the full GitHub doc, including an unknown extra field", async () => {
    const { store, setup } = makeStore();
    if (setup) await setup();
    const id = await githubId();
    const doc = { ...GITHUB_DOC, hireable: true };
    const result = await store.refreshFromIdp(refreshInput({ internalUserId: id, attributes: doc }));
    expect(result.diverged).toEqual([]);
    expect(result.profile.internalUserId).toBe(id);
    expect(result.profile.tenantId).toBe("primary");
    expect(result.profile.idpIssuer).toBe(GITHUB_ISSUER);
    expect(result.profile.idpAttributes).toEqual(doc);
    expect(result.profile.idpUpdatedAtMs).toBe(NOW);
    const read = await store.getProfile(id, "primary");
    expect(read?.idpAttributes).toEqual(doc);
    const byLogin = await store.getProfileByLogin("OpenAIMP", "primary");
    expect(byLogin?.internalUserId).toBe(id);
  });

  it("persists the full Google doc, including phone_number", async () => {
    const { store, setup } = makeStore();
    if (setup) await setup();
    const id = await googleId();
    const result = await store.refreshFromIdp(
      refreshInput({
        internalUserId: id,
        userLogin: "dhmprstw@gmail.com",
        idpIssuer: GOOGLE_ISSUER,
        attributes: { ...GOOGLE_DOC },
      }),
    );
    expect(result.profile.idpAttributes).toEqual(GOOGLE_DOC);
    expect(await store.lookupByAttribute("primary", "email", "dhmprstw@gmail.com")).toEqual([
      { internalUserId: id, tenantId: "primary", source: "idp" },
    ]);
    expect(await store.lookupByAttribute("primary", "phone_number", "+15550102030")).toEqual([
      { internalUserId: id, tenantId: "primary", source: "idp" },
    ]);
  });

  it("stores a brand-new IDP field with no code change (forward-compatible)", async () => {
    const { store, setup } = makeStore();
    if (setup) await setup();
    const id = await githubId();
    const doc = { ...GITHUB_DOC, brand_new_field_xyz: "shiny" };
    await store.refreshFromIdp(refreshInput({ internalUserId: id, attributes: doc }));
    const read = await store.getProfile(id, "primary");
    expect(read?.idpAttributes.brand_new_field_xyz).toBe("shiny");
    expect(await store.lookupByAttribute("primary", "brand_new_field_xyz", "shiny")).toEqual([
      { internalUserId: id, tenantId: "primary", source: "idp" },
    ]);
  });

  it("an IDP email change keeps the SAME internal user id; the old email stops resolving", async () => {
    const { store, setup } = makeStore();
    if (setup) await setup();
    const id = await githubId();
    await store.refreshFromIdp(refreshInput({ internalUserId: id }));
    await store.refreshFromIdp(
      refreshInput({ internalUserId: id, attributes: { ...GITHUB_DOC, email: "new@example.com" }, nowMs: NOW + 1000 }),
    );
    const read = await store.getProfile(id, "primary");
    expect(read?.internalUserId).toBe(id);
    expect(read?.idpAttributes.email).toBe("new@example.com");
    expect(await store.lookupByAttribute("primary", "email", "octo@example.com")).toEqual([]);
    expect(await store.lookupByAttribute("primary", "email", "new@example.com")).toEqual([
      { internalUserId: id, tenantId: "primary", source: "idp" },
    ]);
    expect(await deriveInternalUserId(GITHUB_ISSUER, "82253453")).toBe(id);
  });

  it("a user-edited displayName survives a sign-in that changes the IDP name; the IDP field updates", async () => {
    const { store, setup } = makeStore();
    if (setup) await setup();
    const id = await githubId();
    await store.refreshFromIdp(refreshInput({ internalUserId: id }));
    // User edits the display name through the Profile view.
    const edited = await store.saveProfile(
      emptyProfile({
        userLogin: "OpenAIMP",
        displayName: "My Name",
        internalUserId: id,
        tenantId: "primary",
        idpIssuer: GITHUB_ISSUER,
        idpAttributes: { ...GITHUB_DOC },
        provenance: { displayName: { source: "user", updatedAtMs: NOW + 10 } },
        idpUpdatedAtMs: NOW,
      }),
    );
    expect(edited.displayName).toBe("My Name");
    const result = await store.refreshFromIdp(
      refreshInput({
        internalUserId: id,
        attributes: { ...GITHUB_DOC, name: "Changed By Provider" },
        nowMs: NOW + 2000,
      }),
    );
    expect(result.diverged).toEqual(["displayName"]);
    const read = await store.getProfile(id, "primary");
    expect(read?.displayName).toBe("My Name");
    expect(read?.idpAttributes.name).toBe("Changed By Provider");
  });

  it("a user-cleared phone stays cleared after refresh", async () => {
    const { store, setup } = makeStore();
    if (setup) await setup();
    const id = await githubId();
    await store.refreshFromIdp(
      refreshInput({ internalUserId: id, attributes: { ...GOOGLE_DOC, login: "x" }, idpIssuer: GOOGLE_ISSUER }),
    );
    await store.saveProfile(
      emptyProfile({
        userLogin: "dhmprstw@gmail.com",
        phone: null,
        internalUserId: id,
        tenantId: "primary",
        idpIssuer: GOOGLE_ISSUER,
        idpAttributes: { ...GOOGLE_DOC },
        provenance: { phone: { source: "user", updatedAtMs: NOW + 10 } },
        idpUpdatedAtMs: NOW,
      }),
    );
    const result = await store.refreshFromIdp(
      refreshInput({
        internalUserId: id,
        userLogin: "dhmprstw@gmail.com",
        idpIssuer: GOOGLE_ISSUER,
        attributes: { ...GOOGLE_DOC },
        nowMs: NOW + 2000,
      }),
    );
    // The cleared value survives, and the divergence is recorded:
    // the provider still reports a phone the user chose to clear.
    expect(result.diverged).toEqual(["phone"]);
    const read = await store.getProfile(id, "primary");
    expect(read?.phone).toBeNull();
    expect(read?.provenance.phone?.source).toBe("user");
  });

  it("sync-from-provider restores IDP values for user-owned fields", async () => {
    const { store, setup } = makeStore();
    if (setup) await setup();
    const id = await githubId();
    await store.refreshFromIdp(refreshInput({ internalUserId: id }));
    await store.saveProfile(
      emptyProfile({
        userLogin: "OpenAIMP",
        displayName: "My Name",
        internalUserId: id,
        tenantId: "primary",
        idpIssuer: GITHUB_ISSUER,
        idpAttributes: { ...GITHUB_DOC },
        provenance: { displayName: { source: "user", updatedAtMs: NOW + 10 } },
        idpUpdatedAtMs: NOW,
      }),
    );
    const synced = await store.syncFromProvider(id, "primary", NOW + 3000);
    expect(synced?.displayName).toBeNull();
    expect(synced?.provenance.displayName?.source).toBe("idp");
    const view = toUserProfileView("OpenAIMP", synced);
    expect(view.displayName).toBe("Mubasher Ahmed");
  });

  it("re-keys a legacy login-keyed row on the next sign-in", async () => {
    const { store, setup } = makeStore();
    if (setup) await setup();
    const id = await githubId();
    // Legacy row: written by the pre-#5160 profile save (login key only).
    await store.saveProfile(
      emptyProfile({ userLogin: "OpenAIMP", displayName: "Legacy Name" }),
    );
    const result = await store.refreshFromIdp(refreshInput({ internalUserId: id }));
    expect(result.profile.internalUserId).toBe(id);
    expect(result.profile.tenantId).toBe("primary");
    expect(result.profile.displayName).toBe("Legacy Name");
    expect(result.profile.provenance.displayName?.source).toBe("user");
    const read = await store.getProfile(id, "primary");
    expect(read?.displayName).toBe("Legacy Name");
  });

  it("a user-edited contact email is indexed with source=user and resolves by lookup", async () => {
    const { store, setup } = makeStore();
    if (setup) await setup();
    const id = await githubId();
    await store.refreshFromIdp(refreshInput({ internalUserId: id }));
    await store.saveProfile(
      emptyProfile({
        userLogin: "OpenAIMP",
        email: "contact@example.com",
        internalUserId: id,
        tenantId: "primary",
        idpIssuer: GITHUB_ISSUER,
        idpAttributes: { ...GITHUB_DOC },
        provenance: { email: { source: "user", updatedAtMs: NOW + 10 } },
        idpUpdatedAtMs: NOW,
      }),
    );
    expect(await store.lookupByAttribute("primary", "email", "contact@example.com")).toEqual([
      { internalUserId: id, tenantId: "primary", source: "user" },
    ]);
    expect(await store.lookupByAttribute("primary", "email", "octo@example.com")).toEqual([
      { internalUserId: id, tenantId: "primary", source: "idp" },
    ]);
  });
});

// Multi-tenant -------------------------------------------------------------

describe("multi-tenant — one identity, one row per tenant (#5160)", () => {
  it("same identity, two tenants → two rows; tenant-2 seeded with IDP fields only", async () => {
    const store = new InMemoryProfileAdapter();
    const id = await githubId();
    await store.refreshFromIdp(refreshInput({ internalUserId: id }));
    await store.saveProfile(
      emptyProfile({
        userLogin: "OpenAIMP",
        displayName: "My Name",
        internalUserId: id,
        tenantId: "primary",
        idpIssuer: GITHUB_ISSUER,
        idpAttributes: { ...GITHUB_DOC },
        provenance: { displayName: { source: "user", updatedAtMs: NOW + 10 } },
        idpUpdatedAtMs: NOW,
      }),
    );
    // Second-tenant join: the provisioning seed copies IDP fields
    // only — the tenant-1 user edit NEVER crosses over.
    const seeded = await store.seedTenantProfile(id, "tenant-2", "OpenAIMP", NOW + 100);
    expect(seeded.internalUserId).toBe(id);
    expect(seeded.tenantId).toBe("tenant-2");
    expect(seeded.displayName).toBeNull();
    expect(seeded.idpAttributes).toEqual({ ...GITHUB_DOC });
    expect(seeded.provenance.displayName).toBeUndefined();
    const primary = await store.getProfile(id, "primary");
    expect(primary?.displayName).toBe("My Name");
    const second = await store.getProfile(id, "tenant-2");
    expect(second?.displayName).toBeNull();
    const view = toUserProfileView("OpenAIMP", second);
    expect(view.displayName).toBe("Mubasher Ahmed");
    expect(view.tenantId).toBe("tenant-2");
  });

  it("a user edit in tenant 1 is invisible in tenant 2, and lookup is tenant-scoped", async () => {
    const store = new InMemoryProfileAdapter();
    const id = await githubId();
    await store.refreshFromIdp(refreshInput({ internalUserId: id }));
    await store.saveProfile(
      emptyProfile({
        userLogin: "OpenAIMP",
        email: "tenant1-only@example.com",
        internalUserId: id,
        tenantId: "primary",
        idpIssuer: GITHUB_ISSUER,
        idpAttributes: { ...GITHUB_DOC },
        provenance: { email: { source: "user", updatedAtMs: NOW + 10 } },
        idpUpdatedAtMs: NOW,
      }),
    );
    await store.seedTenantProfile(id, "tenant-2", "OpenAIMP", NOW + 100);
    expect(await store.lookupByAttribute("primary", "email", "tenant1-only@example.com")).toEqual([
      { internalUserId: id, tenantId: "primary", source: "user" },
    ]);
    expect(await store.lookupByAttribute("tenant-2", "email", "tenant1-only@example.com")).toEqual([]);
    expect(await store.lookupByAttribute("tenant-2", "email", "octo@example.com")).toEqual([
      { internalUserId: id, tenantId: "tenant-2", source: "idp" },
    ]);
  });

  it("a cross-tenant collision returns both, labeled — no silent winner", async () => {
    const store = new InMemoryProfileAdapter();
    const gh = await githubId();
    const go = await googleId();
    await store.refreshFromIdp(refreshInput({ internalUserId: gh }));
    await store.refreshFromIdp(
      refreshInput({
        internalUserId: go,
        userLogin: "dhmprstw@gmail.com",
        idpIssuer: GOOGLE_ISSUER,
        attributes: { ...GOOGLE_DOC, email: "octo@example.com" },
        tenantId: "tenant-2",
      }),
    );
    const matches = await store.lookupByAttribute("primary", "email", "octo@example.com");
    expect(matches).toEqual([{ internalUserId: gh, tenantId: "primary", source: "idp" }]);
    const cross = await store.lookupByAttribute(null, "email", "octo@example.com");
    expect(cross).toHaveLength(2);
    expect(cross.map((m) => m.tenantId).sort()).toEqual(["primary", "tenant-2"]);
  });

  it("getProfilesByInternalUserId lists every tenant row for one identity", async () => {
    const store = new InMemoryProfileAdapter();
    const id = await githubId();
    await store.refreshFromIdp(refreshInput({ internalUserId: id }));
    await store.seedTenantProfile(id, "tenant-2", "OpenAIMP", NOW + 100);
    const rows = await store.getProfilesByInternalUserId(id);
    expect(rows.map((r) => r.tenantId).sort()).toEqual(["primary", "tenant-2"]);
  });
});

// Lookup --------------------------------------------------------------------

describe("lookup semantics — exact match, no silent winner (#5160)", () => {
  it("normalizes before matching (email case, phone formatting)", async () => {
    const store = new InMemoryProfileAdapter();
    const id = await googleId();
    await store.refreshFromIdp(
      refreshInput({
        internalUserId: id,
        userLogin: "dhmprstw@gmail.com",
        idpIssuer: GOOGLE_ISSUER,
        attributes: { ...GOOGLE_DOC },
      }),
    );
    expect(await store.lookupByAttribute("primary", "email", "DHMPRSTW@GMAIL.COM")).toEqual([
      { internalUserId: id, tenantId: "primary", source: "idp" },
    ]);
    expect(await store.lookupByAttribute("primary", "phone_number", "5550102030")).toEqual([
      { internalUserId: id, tenantId: "primary", source: "idp" },
    ]);
    expect(await store.lookupByAttribute("primary", "email", "nobody@example.com")).toEqual([]);
  });

  it("two identities claiming the same value both match — resolution fails closed", async () => {
    const store = new InMemoryProfileAdapter();
    const gh = await githubId();
    const go = await googleId();
    await store.refreshFromIdp(refreshInput({ internalUserId: gh }));
    await store.refreshFromIdp(
      refreshInput({
        internalUserId: go,
        userLogin: "dhmprstw@gmail.com",
        idpIssuer: GOOGLE_ISSUER,
        attributes: { ...GOOGLE_DOC, email: "octo@example.com" },
      }),
    );
    const matches = await store.lookupByAttribute("primary", "email", "octo@example.com");
    expect(matches).toHaveLength(2);
  });
});

// Sign-in hook --------------------------------------------------------------

describe("sign-in hook — refresh runs after the alias step, best-effort (#5160)", () => {
  function postLogin(
    kv: KvLike,
    profile: UserProfileStore,
    auditStore?: ReturnType<typeof createMemoryAuditStore>,
  ) {
    return runWiredPostLogin(
      {
        kv,
        bindingStore: createMemoryIdentityBindingStore(),
        membershipStore: createMemoryMembershipStore(),
        profile,
        ...(auditStore ? { audit: { store: auditStore, correlationId: "sess-1" } } : {}),
      },
      {
        githubLogin: "OpenAIMP",
        internalUserId: "v1:289a639c644816a2aa087d5f3c37ce5e46f169727ad4d79b4189e0a3fb0c28c2",
        providerIssuer: GITHUB_ISSUER,
        providerSubject: "82253453",
        bootstrapRaw: undefined,
        tenantId: "primary",
        nowMs: NOW,
        idpAttributes: { ...GITHUB_DOC },
      },
    );
  }

  it("a fresh sign-in persists the full IDP doc and audits the refresh", async () => {
    const kv = memoryKv();
    const profile = new InMemoryProfileAdapter();
    const auditStore = createMemoryAuditStore();
    const result = await postLogin(kv, profile, auditStore);
    expect(result.profile.status).toBe("refreshed");
    const id = await githubId();
    const row = await profile.getProfile(id, "primary");
    expect(row?.idpAttributes).toEqual(GITHUB_DOC);
    const events = await auditStore.list();
    const refreshed = events.find((e) => e.type === "iaaa.idp_profile.refreshed");
    expect(refreshed).toBeDefined();
    expect(refreshed?.actorPrincipalId).toBe(id);
    // Audit payloads carry field names + ids only — never values.
    expect(JSON.stringify(refreshed)).not.toContain("octo@example.com");
    expect(JSON.stringify(refreshed)).not.toContain("Mubasher Ahmed");
  });

  it("a user edit survives the next sign-in and the divergence is audited", async () => {
    const kv = memoryKv();
    const profile = new InMemoryProfileAdapter();
    const id = await githubId();
    await profile.refreshFromIdp(refreshInput({ internalUserId: id }));
    await profile.saveProfile(
      emptyProfile({
        userLogin: "OpenAIMP",
        displayName: "My Name",
        internalUserId: id,
        tenantId: "primary",
        idpIssuer: GITHUB_ISSUER,
        idpAttributes: { ...GITHUB_DOC },
        provenance: { displayName: { source: "user", updatedAtMs: NOW + 10 } },
        idpUpdatedAtMs: NOW,
      }),
    );
    const auditStore = createMemoryAuditStore();
    await postLogin(kv, profile, auditStore);
    const row = await profile.getProfile(id, "primary");
    expect(row?.displayName).toBe("My Name");
    const events = await auditStore.list();
    const diverged = events.find((e) => e.type === "iaaa.idp_profile.diverged");
    expect(diverged).toBeDefined();
    expect(JSON.stringify(diverged)).not.toContain("My Name");
  });

  it("a profile refresh failure never fails the login", async () => {
    const kv = memoryKv();
    const failing: UserProfileStore = {
      getProfile: async () => null,
      getProfileByLogin: async () => null,
      getProfilesByInternalUserId: async () => [],
      saveProfile: async (p) => p,
      saveProfileOnce: async (p) => ({ duplicate: false, profile: p }),
      refreshFromIdp: async () => {
        throw new Error("store down");
      },
      syncFromProvider: async () => null,
      seedTenantProfile: async () => {
        throw new Error("store down");
      },
      lookupByAttribute: async () => [],
      purgeExpiredProfiles: async () => ({ deleted: 0 }),
    };
    const result = await postLogin(kv, failing);
    expect(result.profile.status).toBe("refresh-failed");
    expect(result.alias.status).toBe("recorded");
  });

  it("no IDP doc on the input skips the refresh without failing the login", async () => {
    const kv = memoryKv();
    const profile = new InMemoryProfileAdapter();
    const result = await runWiredPostLogin(
      {
        kv,
        bindingStore: createMemoryIdentityBindingStore(),
        membershipStore: createMemoryMembershipStore(),
        profile,
      },
      {
        githubLogin: "OpenAIMP",
        internalUserId: "v1:289a639c644816a2aa087d5f3c37ce5e46f169727ad4d79b4189e0a3fb0c28c2",
        providerIssuer: GITHUB_ISSUER,
        providerSubject: "82253453",
        bootstrapRaw: undefined,
        tenantId: "primary",
        nowMs: NOW,
      },
    );
    expect(result.profile.status).toBe("skipped");
  });
});

// Access control ------------------------------------------------------------

describe("lookup access control — tenant scoping is enforced (#5160)", () => {
  it("the lookup route pins a tenant-admin to their own tenant and 403s a non-admin", async () => {
    const { scopeLookupRequest } = await import("../src/security/idpProfileAccess");
    const id = await githubId();
    // Tenant-admin for tenant-1 asking about tenant-2: pinned to tenant-1.
    expect(scopeLookupRequest({ role: "tenant-admin", tenantId: "tenant-1" }, "tenant-2")).toEqual({
      ok: true,
      tenantId: "tenant-1",
    });
    // Platform-admin may search one tenant or cross-tenant.
    expect(scopeLookupRequest({ role: "platform-admin", tenantId: "primary" }, "tenant-2")).toEqual({
      ok: true,
      tenantId: "tenant-2",
    });
    expect(scopeLookupRequest({ role: "platform-admin", tenantId: "primary" }, null)).toEqual({
      ok: true,
      tenantId: null,
    });
    // No admin role: denied, with no data.
    expect(scopeLookupRequest({ role: "member", tenantId: "primary" }, "primary")).toEqual({
      ok: false,
      code: "FAILURE_IDP_PROFILE_FORBIDDEN",
    });
    expect(scopeLookupRequest(null, "primary")).toEqual({
      ok: false,
      code: "FAILURE_IDP_PROFILE_FORBIDDEN",
    });
    void id;
  });
});

// Config --------------------------------------------------------------------

function memorySettings(values: Record<string, string> = {}): SettingsPort {
  const map = new Map(Object.entries(values));
  return {
    get: (key: string) => map.get(key) ?? null,
    has: (key: string) => map.has(key),
    set: (key: string, value: string) => {
      map.set(key, value);
    },
    delete: (key: string) => {
      map.delete(key);
    },
    ensureSchema: () => {},
  };
}

describe("config — attribute set + retention are externalized, default store-all (#5160)", () => {
  it("defaults are store-all with no retention window", () => {
    expect(DEFAULT_IDP_PROFILE_CONFIG).toEqual({
      storeAll: true,
      excludedAttributes: [],
      retentionDays: 0,
    });
    const loaded = loadIdpProfileConfig(memorySettings());
    expect(loaded).toEqual(DEFAULT_IDP_PROFILE_CONFIG);
  });

  it("runtime overrides come from mas_settings keys", () => {
    const loaded = loadIdpProfileConfig(
      memorySettings({
        "idp_profile.attribute_set": JSON.stringify({ storeAll: false, excludedAttributes: ["company"] }),
        "idp_profile.retention_days": "90",
      }),
    );
    expect(loaded.storeAll).toBe(false);
    expect(loaded.excludedAttributes).toEqual(["company"]);
    expect(loaded.retentionDays).toBe(90);
  });

  it("an invalid runtime value fails closed and the previous value stands", () => {
    const bad = loadIdpProfileConfig(
      memorySettings({ "idp_profile.retention_days": "not-a-number" }),
    );
    expect(bad.retentionDays).toBe(0);
    const invalid = validateIdpProfileConfig({ storeAll: true, excludedAttributes: [], retentionDays: -1 });
    expect(invalid.ok).toBe(false);
    const invalid2 = validateIdpProfileConfig({ storeAll: "yes", excludedAttributes: [], retentionDays: 0 });
    expect(invalid2.ok).toBe(false);
    const invalid3 = validateIdpProfileConfig({ storeAll: true, excludedAttributes: "company", retentionDays: 0 });
    expect(invalid3.ok).toBe(false);
    expect(validateIdpProfileConfig(DEFAULT_IDP_PROFILE_CONFIG).ok).toBe(true);
  });

  it("excluded attributes are dropped by the sanitizer when config excludes them", () => {
    const config = { storeAll: true, excludedAttributes: ["company"], retentionDays: 0 };
    const result = sanitizeIdpAttributes({ ...GITHUB_DOC }, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attributes).not.toHaveProperty("company");
    expect(result.attributes.login).toBe("OpenAIMP");
  });
});

// Retention -----------------------------------------------------------------

describe("retention — purge deletes only expired rows with no live membership (#5160)", () => {
  it("default retention (0) deletes nothing", async () => {
    const store = new InMemoryProfileAdapter();
    const id = await githubId();
    await store.refreshFromIdp(refreshInput({ internalUserId: id, nowMs: NOW - 10_000 }));
    // Retention 0 = retain while the identity exists: the scheduled
    // job computes no expiry cutoff (epoch), so a purge with that
    // cutoff deletes nothing.
    const deleted = await store.purgeExpiredProfiles({
      cutoffMs: 0,
      hasLiveMembership: async () => false,
    });
    expect(deleted).toEqual({ deleted: 0 });
    expect(await store.getProfile(id, "primary")).not.toBeNull();
  });

  it("deletes only rows past the window whose identity has no live membership", async () => {
    const store = new InMemoryProfileAdapter();
    const gh = await githubId();
    const go = await googleId();
    await store.refreshFromIdp(refreshInput({ internalUserId: gh, nowMs: NOW - 100_000 }));
    await store.refreshFromIdp(
      refreshInput({
        internalUserId: go,
        userLogin: "dhmprstw@gmail.com",
        idpIssuer: GOOGLE_ISSUER,
        attributes: { ...GOOGLE_DOC },
        nowMs: NOW - 100_000,
      }),
    );
    const deleted = await store.purgeExpiredProfiles({
      cutoffMs: NOW - 50_000,
      hasLiveMembership: async (internalUserId) => internalUserId === go,
    });
    expect(deleted).toEqual({ deleted: 1 });
    expect(await store.getProfile(gh, "primary")).toBeNull();
    expect(await store.getProfile(go, "primary")).not.toBeNull();
    expect(await store.lookupByAttribute("primary", "email", "octo@example.com")).toEqual([]);
  });
});

// Pins — what must NOT change -----------------------------------------------

describe("pins — identity key, session, and tokens are unchanged (#5160)", () => {
  it("the identity KEY is still (issuer, subject) only — an email change creates no new identity", async () => {
    const before = await deriveInternalUserId(GITHUB_ISSUER, "82253453");
    const after = await deriveInternalUserId(GITHUB_ISSUER, "82253453");
    expect(before).toBe(after);
    expect(before.startsWith("v1:")).toBe(true);
  });

  it("the new outcome codes exist in the catalog", () => {
    for (const code of [
      "FAILURE_IDP_PROFILE_LOOKUP_AMBIGUOUS",
      "FAILURE_IDP_PROFILE_CONFIG_INVALID",
      "FAILURE_IDP_PROFILE_REFRESH_FAILED",
      "FAILURE_IDP_PROFILE_FORBIDDEN",
      "SUCCESS_IDP_PROFILE_REFRESHED",
      "SUCCESS_IDP_PROFILE_LOOKUP",
      "SUCCESS_IDP_PROFILE_CONFIG_UPDATED",
    ]) {
      expect(getOutcome(code)).toBeDefined();
    }
  });
});

// Profile UX — effective view ------------------------------------------------

describe("profile view — effective values + provenance, tenant line (#5160)", () => {
  it("reads effective values: IDP pre-fill, user override wins, tenant shown", async () => {
    const store = new InMemoryProfileAdapter();
    const id = await githubId();
    await store.refreshFromIdp(refreshInput({ internalUserId: id }));
    const row = await store.getProfile(id, "primary");
    const view = toUserProfileView("OpenAIMP", row);
    expect(view.displayName).toBe("Mubasher Ahmed");
    expect(view.email).toBe("octo@example.com");
    expect(view.tenantId).toBe("primary");
    expect(view.provenance.email?.source).toBe("idp");
    expect(view.idpEmail).toBe("octo@example.com");
    expect(view.diverged).toEqual([]);
  });

  it("shows the divergence hint inputs when a user value hides a changed IDP value", async () => {
    const store = new InMemoryProfileAdapter();
    const id = await githubId();
    await store.refreshFromIdp(refreshInput({ internalUserId: id }));
    await store.saveProfile(
      emptyProfile({
        userLogin: "OpenAIMP",
        displayName: "My Name",
        internalUserId: id,
        tenantId: "primary",
        idpIssuer: GITHUB_ISSUER,
        idpAttributes: { ...GITHUB_DOC },
        provenance: { displayName: { source: "user", updatedAtMs: NOW + 10 } },
        idpUpdatedAtMs: NOW,
      }),
    );
    await store.refreshFromIdp(
      refreshInput({
        internalUserId: id,
        attributes: { ...GITHUB_DOC, name: "Changed By Provider" },
        nowMs: NOW + 2000,
      }),
    );
    const row = await store.getProfile(id, "primary");
    const view = toUserProfileView("OpenAIMP", row);
    expect(view.displayName).toBe("My Name");
    expect(view.idpDisplayName).toBe("Changed By Provider");
    expect(view.diverged).toEqual(["displayName"]);
  });

  it("an absent profile reads as no profile (login fallback is display-only)", () => {
    const view = toUserProfileView("OpenAIMP", null);
    expect(view.displayName).toBeNull();
    expect(view.email).toBeNull();
    expect(view.tenantId).toBeNull();
    expect(view.diverged).toEqual([]);
  });
});
