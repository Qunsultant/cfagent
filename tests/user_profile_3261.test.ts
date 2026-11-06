/**
 * Issue #3261 — Profile management: change email, phone, and profile
 * from the account flow (#3256).
 *
 * RED first: the profile port, migration 0050, the
 * /platform/accounts/profile routes, and the validation service do
 * not exist yet.
 *
 * Scope of THIS slice (the email gate): email change needs CISO
 * review before build (review requested as #3261 comment
 * 6681436382, refs #945). There is NO email field, NO email route,
 * and NO email input here — if the review does not land, email is
 * recorded as explicitly deferred and #3261 stays open.
 *
 * What IS built: display name + phone, self-only, keyed by the
 * verified session login. Phone lives in D1 alongside account data
 * (new agent_user_profiles table, migration 0050) and is editable
 * in the profile UI. Display name unset displays as the login
 * (PROPOSED default, display-only, never stored). Phone is an
 * UNVERIFIED contact field, never used for auth or recovery.
 *
 * AOP amendment (owner direction 2026-11-06): every profile
 * response carries {code, message} resolved from the outcome
 * catalog — tests assert the message FROM the catalog (getOutcome),
 * never a hardcoded string. Validation is structural (field +
 * kind, no throws); saves are idempotent on a client key
 * (standards §7.2, replay → 409); writes audit code + message +
 * login + changed-flags, never values.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { getTableColumns, getTableName, isTable } from "drizzle-orm";
import { ALL_MIGRATIONS, MIGRATION_0050_USER_PROFILES } from "../src/data/migrationRunner";
import * as drizzleSchema from "../src/data/drizzleSchema";
import { agentProfileIdempotencyKeys, agentUserProfiles } from "../src/data/drizzleSchema";
import {
  createD1ProfileDb,
  D1ProfileAdapter,
  ensureUserProfileSchema,
} from "../src/data/d1ProfileAdapter";
import { InMemoryProfileAdapter } from "../src/data/inMemoryProfileAdapter";
import type { UserProfileStore } from "../src/data/profilePorts";
import { PROFILE_LIMITS } from "../src/config/profileLimits";
import { getOutcome } from "../src/outcomes/outcomeAspects";
import { MockD1Database } from "./mock-d1";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemoryPriceCatalogueAdapter } from "../src/data/inMemoryPriceCatalogueAdapter";
import { InMemoryStoreOperatorsAdapter } from "../src/data/inMemoryStoreOperatorsAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { InMemoryOnboardingAdapter } from "../src/data/inMemoryOnboardingAdapter";
import type { PlatformAccountPorts } from "../src/agents/routes/platformAccounts";
import {
  handlePlatformAccountRoutes,
  type PlatformAccountRouteContext,
} from "../src/agents/routes/platformAccounts";
import {
  extractIdempotencyKey,
  validateProfileInput,
  toUserProfileView,
} from "../src/services/userProfile";

// Migration 0050 ------------------------------------------------------------

describe("migration 0050 — user profiles (#3261)", () => {
  it("is registered with CREATE TABLEs for agent_user_profiles + idempotency keys, and both tables exist in the drizzle schema", () => {
    const migration = ALL_MIGRATIONS.find((m) => m.version === 50);
    expect(migration).toBeDefined();
    expect(migration!.name).toBe("0050_user_profiles");
    expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS agent_user_profiles");
    expect(migration!.sql).toContain("user_login TEXT PRIMARY KEY");
    expect(migration!.sql).toContain("CREATE TABLE IF NOT EXISTS agent_profile_idempotency_keys");
    expect(migration!.sql).toContain("idempotency_key TEXT PRIMARY KEY");
    const drizzleNames = new Set(
      Object.values(drizzleSchema)
        .filter(isTable)
        .map((t) => getTableName(t)),
    );
    expect(drizzleNames.has("agent_user_profiles")).toBe(true);
    expect(drizzleNames.has("agent_profile_idempotency_keys")).toBe(true);
  });

  it("DDL and the Drizzle schema agree on both tables and columns", () => {
    const columns = Object.keys(getTableColumns(agentUserProfiles));
    expect(columns).toEqual(["userLogin", "displayName", "phone", "updatedAtMs"]);
    expect(MIGRATION_0050_USER_PROFILES.sql).toContain("display_name TEXT");
    expect(MIGRATION_0050_USER_PROFILES.sql).toContain("phone TEXT");
    const keyColumns = Object.keys(getTableColumns(agentProfileIdempotencyKeys));
    expect(keyColumns).toEqual(["idempotencyKey", "userLogin", "createdAtMs"]);
    expect(MIGRATION_0050_USER_PROFILES.sql).toContain("user_login TEXT NOT NULL");
    expect(MIGRATION_0050_USER_PROFILES.sql).toContain("created_at_ms INTEGER NOT NULL");
  });
});

// Port ----------------------------------------------------------------------

describe.each([
  ["in-memory", (): { store: UserProfileStore; setup?: () => Promise<unknown> } => ({ store: new InMemoryProfileAdapter() })],
  [
    "D1",
    (): { store: UserProfileStore; setup?: () => Promise<unknown> } => {
      const mock = new MockD1Database();
      const db = createD1ProfileDb(mock as unknown as D1Database);
      return {
        store: new D1ProfileAdapter(db, mock as unknown as D1Database),
        setup: () => ensureUserProfileSchema(db),
      };
    },
  ],
])("profile port contract (%s) (#3261)", (_label, make) => {
  it("reads absent as null, round-trips per login, and isolates a second login", async () => {
    const { store, setup } = make();
    if (setup) await setup();
    expect(await store.getProfile("prof-user-a")).toBeNull();
    const saved = await store.saveProfile({
      userLogin: "prof-user-a",
      displayName: "Ada",
      phone: "+1 555-0100",
      updatedAtMs: 1234,
    });
    expect(saved.displayName).toBe("Ada");
    expect(saved.phone).toBe("+1 555-0100");
    const reread = await store.getProfile("prof-user-a");
    expect(reread?.displayName).toBe("Ada");
    // A second login starts fresh: no shared display name, no shared phone.
    expect(await store.getProfile("prof-user-b")).toBeNull();
  });

  it("upsert overwrites the previous row, and a null clear persists", async () => {
    const { store, setup } = make();
    if (setup) await setup();
    await store.saveProfile({
      userLogin: "prof-user-a",
      displayName: "Ada",
      phone: "+1 555-0100",
      updatedAtMs: 1234,
    });
    const updated = await store.saveProfile({
      userLogin: "prof-user-a",
      displayName: "Grace",
      phone: null,
      updatedAtMs: 1235,
    });
    expect(updated.displayName).toBe("Grace");
    expect(updated.phone).toBeNull();
    expect((await store.getProfile("prof-user-a"))?.phone).toBeNull();
  });

  it("saveProfileOnce writes once and replays the key as a duplicate without overwriting", async () => {
    const { store, setup } = make();
    if (setup) await setup();
    const first = await store.saveProfileOnce(
      { userLogin: "prof-user-a", displayName: "Ada", phone: "+1 555-0100", updatedAtMs: 1234 },
      "key-once-1",
      1234,
    );
    expect(first.duplicate).toBe(false);
    expect(first.profile?.displayName).toBe("Ada");
    const replay = await store.saveProfileOnce(
      { userLogin: "prof-user-a", displayName: "Mallory", phone: null, updatedAtMs: 1235 },
      "key-once-1",
      1235,
    );
    expect(replay).toEqual({ duplicate: true, profile: null });
    // The replay wrote nothing: the first values stand.
    expect(await store.getProfile("prof-user-a")).toEqual({
      userLogin: "prof-user-a",
      displayName: "Ada",
      phone: "+1 555-0100",
      updatedAtMs: 1234,
    });
    const secondKey = await store.saveProfileOnce(
      { userLogin: "prof-user-a", displayName: "Grace", phone: null, updatedAtMs: 1236 },
      "key-once-2",
      1236,
    );
    expect(secondKey.duplicate).toBe(false);
    expect((await store.getProfile("prof-user-a"))?.displayName).toBe("Grace");
  });

  it("saveProfileOnce keys are global: a key seen for login A is a duplicate for login B", async () => {
    const { store, setup } = make();
    if (setup) await setup();
    await store.saveProfileOnce(
      { userLogin: "prof-user-a", displayName: "Ada", phone: null, updatedAtMs: 1234 },
      "key-shared-1",
      1234,
    );
    const cross = await store.saveProfileOnce(
      { userLogin: "prof-user-b", displayName: "Bob", phone: null, updatedAtMs: 1235 },
      "key-shared-1",
      1235,
    );
    expect(cross).toEqual({ duplicate: true, profile: null });
    expect(await store.getProfile("prof-user-b")).toBeNull();
  });
});

// Validation ----------------------------------------------------------------

describe("validateProfileInput (#3261)", () => {
  it("accepts a valid display name and phone, trimming both", () => {
    expect(
      validateProfileInput({ displayName: "  Ada Lovelace  ", phone: " +1 555-0100 " }),
    ).toEqual({ ok: true, value: { displayName: "Ada Lovelace", phone: "+1 555-0100" } });
  });

  it("accepts null as an explicit clear and omits absent fields", () => {
    expect(validateProfileInput({ displayName: null })).toEqual({
      ok: true,
      value: { displayName: null },
    });
    expect(validateProfileInput({})).toEqual({ ok: true, value: {} });
    expect(validateProfileInput({ phone: null })).toEqual({ ok: true, value: { phone: null } });
  });

  it("ignores unknown fields (including any client-supplied email)", () => {
    expect(
      validateProfileInput({ displayName: "Ada", email: "ada@example.com", userLogin: "mallory" }),
    ).toEqual({ ok: true, value: { displayName: "Ada" } });
  });

  it("rejects an empty display name, one over the configured max, and control characters — structurally, never a throw", () => {
    const max = PROFILE_LIMITS.displayNameMaxLength;
    expect(validateProfileInput({ displayName: "   " })).toEqual({
      ok: false,
      failure: { field: "displayName", kind: "empty" },
    });
    expect(validateProfileInput({ displayName: "x".repeat(max) })).toEqual({
      ok: true,
      value: { displayName: "x".repeat(max) },
    });
    expect(validateProfileInput({ displayName: "x".repeat(max + 1) })).toEqual({
      ok: false,
      failure: { field: "displayName", kind: "tooLong" },
    });
    expect(validateProfileInput({ displayName: "Ada\tLovelace" })).toEqual({
      ok: false,
      failure: { field: "displayName", kind: "controlChars" },
    });
    expect(validateProfileInput({ displayName: 42 })).toEqual({
      ok: false,
      failure: { field: "displayName", kind: "wrongType" },
    });
  });

  it("rejects a phone with no digit, bad characters, or over the configured max — structurally", () => {
    const max = PROFILE_LIMITS.phoneMaxLength;
    expect(validateProfileInput({ phone: "+---" })).toEqual({
      ok: false,
      failure: { field: "phone", kind: "noDigit" },
    });
    expect(validateProfileInput({ phone: "call me" })).toEqual({
      ok: false,
      failure: { field: "phone", kind: "badChars" },
    });
    expect(validateProfileInput({ phone: "1".repeat(max) })).toEqual({
      ok: true,
      value: { phone: "1".repeat(max) },
    });
    expect(validateProfileInput({ phone: "1".repeat(max + 1) })).toEqual({
      ok: false,
      failure: { field: "phone", kind: "tooLong" },
    });
    expect(validateProfileInput({ phone: "   " })).toEqual({
      ok: false,
      failure: { field: "phone", kind: "empty" },
    });
    expect(validateProfileInput({ phone: 5550100 })).toEqual({
      ok: false,
      failure: { field: "phone", kind: "wrongType" },
    });
  });
});

describe("extractIdempotencyKey (#3261)", () => {
  it("accepts a non-empty string (trimmed), and fails structurally otherwise", () => {
    expect(extractIdempotencyKey({ idempotencyKey: "  key-1  " })).toEqual({
      ok: true,
      key: "key-1",
    });
    expect(extractIdempotencyKey({})).toEqual({ ok: false, kind: "missing" });
    expect(extractIdempotencyKey({ idempotencyKey: "   " })).toEqual({
      ok: false,
      kind: "missing",
    });
    expect(extractIdempotencyKey({ idempotencyKey: 42 })).toEqual({
      ok: false,
      kind: "wrongType",
    });
  });
});

// Outcome codes -------------------------------------------------------------

describe("profile outcome codes (#3261)", () => {
  it("all six codes resolve in the catalog with the route's httpStatus", () => {
    const cases: [string, number][] = [
      ["SUCCESS_PROFILE_READ", 200],
      ["SUCCESS_PROFILE_UPDATED", 200],
      ["FAILURE_PROFILE_VALIDATION", 400],
      ["FAILURE_PROFILE_NOT_SIGNED_IN", 401],
      ["FAILURE_PROFILE_STORE_UNAVAILABLE", 503],
      ["FAILURE_PROFILE_DUPLICATE", 409],
    ];
    for (const [code, status] of cases) {
      const entry = getOutcome(code);
      expect(entry, code).not.toBeNull();
      expect(entry!.httpStatus).toBe(status);
      expect(entry!.businessMessage.length).toBeGreaterThan(0);
      expect(entry!.technicalDetail.length).toBeGreaterThan(0);
    }
  });
});

// View ----------------------------------------------------------------------

describe("toUserProfileView (#3261)", () => {
  it("returns nulls (not an error) when no profile row exists", () => {
    expect(toUserProfileView("prof-user-a", null)).toEqual({
      userLogin: "prof-user-a",
      displayName: null,
      phone: null,
      updatedAtMs: null,
    });
  });
});

// Routes --------------------------------------------------------------------

function makePorts(overrides: Partial<PlatformAccountPorts> = {}): PlatformAccountPorts {
  return {
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
    prices: new InMemoryPriceCatalogueAdapter({ stock: 0.02, options: 0.05 }),
    operators: new InMemoryStoreOperatorsAdapter(),
    onboarding: new InMemoryOnboardingAdapter(),
    profile: new InMemoryProfileAdapter(),
    ...overrides,
  };
}

function makeCtx(
  ports: PlatformAccountPorts,
  env: Record<string, unknown> = {},
): PlatformAccountRouteContext & { audit: ReturnType<typeof vi.fn> } {
  return { env: env as never, audit: vi.fn(), ports } as PlatformAccountRouteContext & {
    audit: ReturnType<typeof vi.fn>;
  };
}

function req(method: string, path: string, login?: string, body?: unknown): Request {
  return new Request(`https://agent.internal${path}`, {
    method,
    headers: {
      ...(login ? { "x-user-login": login } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function call(
  ctx: PlatformAccountRouteContext,
  request: Request,
): Promise<{ status: number; body: Record<string, unknown> } | null> {
  const url = new URL(request.url);
  const res = await handlePlatformAccountRoutes(request, url, url.pathname, "session-1", ctx);
  if (!res) return null;
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

let keySeq = 0;
const nextKey = () => `test-key-${++keySeq}`;

/** The catalog message for a code — the test asserts FROM the catalog, never a hardcoded string. */
const catalogMessage = (code: string): string => getOutcome(code)!.businessMessage;

class ThrowingProfileStore implements UserProfileStore {
  async getProfile(): Promise<null> {
    throw new Error("boom: store exploded");
  }
  async saveProfile(): Promise<never> {
    throw new Error("boom: store exploded");
  }
  async saveProfileOnce(): Promise<never> {
    throw new Error("boom: store exploded");
  }
}

describe("profile routes (#3261)", () => {
  it("GET returns nulls for a user with no profile, and POST then GET round-trips — both coded", async () => {
    const ctx = makeCtx(makePorts());
    const empty = await call(ctx, req("GET", "/platform/accounts/profile", "prof-route-a"));
    expect(empty?.status).toBe(200);
    expect(empty?.body.code).toBe("SUCCESS_PROFILE_READ");
    expect(empty?.body.message).toBe(catalogMessage("SUCCESS_PROFILE_READ"));
    expect(empty?.body.userLogin).toBe("prof-route-a");
    expect(empty?.body.displayName).toBeNull();
    expect(empty?.body.phone).toBeNull();
    expect(empty?.body.updatedAtMs).toBeNull();

    const saved = await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-a", {
        idempotencyKey: nextKey(),
        displayName: "Ada",
        phone: "+1 555-0100",
      }),
    );
    expect(saved?.status).toBe(200);
    expect(saved?.body.code).toBe("SUCCESS_PROFILE_UPDATED");
    expect(saved?.body.message).toBe(catalogMessage("SUCCESS_PROFILE_UPDATED"));
    expect(saved?.body.userLogin).toBe("prof-route-a");
    expect(saved?.body.displayName).toBe("Ada");
    expect(saved?.body.phone).toBe("+1 555-0100");
    expect(typeof saved?.body.updatedAtMs).toBe("number");

    const reread = await call(ctx, req("GET", "/platform/accounts/profile", "prof-route-a"));
    expect(reread?.body.code).toBe("SUCCESS_PROFILE_READ");
    expect(reread?.body.displayName).toBe("Ada");
    expect(reread?.body.phone).toBe("+1 555-0100");
  });

  it("POST is a partial update: absent fields keep their values, null clears a field", async () => {
    const ctx = makeCtx(makePorts());
    await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-b", {
        idempotencyKey: nextKey(),
        displayName: "Ada",
        phone: "+1 555-0100",
      }),
    );
    const renamed = await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-b", {
        idempotencyKey: nextKey(),
        displayName: "Grace",
      }),
    );
    expect(renamed?.body.displayName).toBe("Grace");
    expect(renamed?.body.phone).toBe("+1 555-0100");
    const cleared = await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-b", {
        idempotencyKey: nextKey(),
        phone: null,
      }),
    );
    expect(cleared?.body.displayName).toBe("Grace");
    expect(cleared?.body.phone).toBeNull();
  });

  it("POST with no profile fields is a no-op read: it writes nothing and audits nothing", async () => {
    const ctx = makeCtx(makePorts());
    const res = await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-g", { idempotencyKey: nextKey() }),
    );
    expect(res?.status).toBe(200);
    expect(res?.body.code).toBe("SUCCESS_PROFILE_READ");
    expect(res?.body.message).toBe(catalogMessage("SUCCESS_PROFILE_READ"));
    expect(res?.body.userLogin).toBe("prof-route-g");
    expect(res?.body.displayName).toBeNull();
    expect(res?.body.phone).toBeNull();
    expect(res?.body.updatedAtMs).toBeNull();
    expect(ctx.audit).not.toHaveBeenCalled();
  });

  it("POST ignores a client-supplied userLogin/tenantId/email and stamps the verified session instead", async () => {
    const ctx = makeCtx(makePorts());
    const saved = await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-c", {
        idempotencyKey: nextKey(),
        userLogin: "mallory",
        tenantId: "evil-tenant",
        email: "mallory@example.com",
        displayName: "Ada",
      }),
    );
    expect(saved?.status).toBe(200);
    expect(saved?.body.userLogin).toBe("prof-route-c");
    expect(saved?.body).not.toHaveProperty("email");
  });

  it("keeps a second login's profile separate from the first", async () => {
    const ctx = makeCtx(makePorts());
    await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-user-1", {
        idempotencyKey: nextKey(),
        displayName: "Ada",
      }),
    );
    await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-user-2", {
        idempotencyKey: nextKey(),
        displayName: "Grace",
      }),
    );
    const first = await call(ctx, req("GET", "/platform/accounts/profile", "prof-user-1"));
    const second = await call(ctx, req("GET", "/platform/accounts/profile", "prof-user-2"));
    expect(first?.body.displayName).toBe("Ada");
    expect(second?.body.displayName).toBe("Grace");
  });

  it("a second login cannot read or act on the first login's row (tech §6 negative test)", async () => {
    const ctx = makeCtx(makePorts());
    await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-user-1", {
        idempotencyKey: nextKey(),
        displayName: "Ada",
        phone: "+1 555-0100",
      }),
    );
    // Login B reads only B's (empty) profile — A's values never leak.
    const asB = await call(ctx, req("GET", "/platform/accounts/profile", "prof-user-2"));
    expect(asB?.status).toBe(200);
    expect(asB?.body.userLogin).toBe("prof-user-2");
    expect(asB?.body.displayName).toBeNull();
    expect(asB?.body.phone).toBeNull();
    // Login B writes only B's row — A's row is untouched.
    await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-user-2", {
        idempotencyKey: nextKey(),
        displayName: "Grace",
      }),
    );
    const asA = await call(ctx, req("GET", "/platform/accounts/profile", "prof-user-1"));
    expect(asA?.body.displayName).toBe("Ada");
    expect(asA?.body.phone).toBe("+1 555-0100");
  });

  it("rejects invalid display names and phones with coded 400s carrying the failing field", async () => {
    const ctx = makeCtx(makePorts());
    const cases: [Record<string, unknown>, string][] = [
      [{ displayName: "   " }, "displayName"],
      [{ displayName: "x".repeat(PROFILE_LIMITS.displayNameMaxLength + 1) }, "displayName"],
      [{ displayName: "Ada\tLovelace" }, "displayName"],
      [{ phone: "call me" }, "phone"],
      [{ phone: "+---" }, "phone"],
      [{ phone: "1".repeat(PROFILE_LIMITS.phoneMaxLength + 1) }, "phone"],
    ];
    for (const [fields, field] of cases) {
      const res = await call(
        ctx,
        req("POST", "/platform/accounts/profile", "prof-route-d", {
          idempotencyKey: nextKey(),
          ...fields,
        }),
      );
      expect(res?.status).toBe(400);
      expect(res?.body.code).toBe("FAILURE_PROFILE_VALIDATION");
      expect(res?.body.message).toBe(catalogMessage("FAILURE_PROFILE_VALIDATION"));
      expect(res?.body.field).toBe(field);
    }
  });

  it("refuses a save without an idempotency key with a coded 400", async () => {
    const ctx = makeCtx(makePorts());
    const res = await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-h", { displayName: "Ada" }),
    );
    expect(res?.status).toBe(400);
    expect(res?.body.code).toBe("FAILURE_PROFILE_VALIDATION");
    expect(res?.body.message).toBe(catalogMessage("FAILURE_PROFILE_VALIDATION"));
    expect(res?.body.field).toBe("idempotencyKey");
    // The refused save wrote nothing: the profile is still empty.
    const reread = await call(ctx, req("GET", "/platform/accounts/profile", "prof-route-h"));
    expect(reread?.status).toBe(200);
    expect(reread?.body.displayName).toBeNull();
  });

  it("replays an idempotency key with 409 and writes nothing the second time", async () => {
    const ctx = makeCtx(makePorts());
    const key = nextKey();
    const first = await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-i", {
        idempotencyKey: key,
        displayName: "Ada",
        phone: "+1 555-0100",
      }),
    );
    expect(first?.status).toBe(200);
    const replay = await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-i", {
        idempotencyKey: key,
        displayName: "Mallory",
        phone: null,
      }),
    );
    expect(replay?.status).toBe(409);
    expect(replay?.body.code).toBe("FAILURE_PROFILE_DUPLICATE");
    expect(replay?.body.message).toBe(catalogMessage("FAILURE_PROFILE_DUPLICATE"));
    expect(replay?.body.duplicate).toBe(true);
    const reread = await call(ctx, req("GET", "/platform/accounts/profile", "prof-route-i"));
    expect(reread?.body.displayName).toBe("Ada");
    expect(reread?.body.phone).toBe("+1 555-0100");
  });

  it("audits each write once, with code + message + login + changed-flags only — no profile values in the audit payload", async () => {
    const ctx = makeCtx(makePorts());
    await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-e", {
        idempotencyKey: nextKey(),
        displayName: "Ada",
        phone: "+1 555-0100",
      }),
    );
    expect(ctx.audit).toHaveBeenCalledWith(
      "platform.profile.updated",
      "payments",
      expect.objectContaining({
        code: "SUCCESS_PROFILE_UPDATED",
        message: catalogMessage("SUCCESS_PROFILE_UPDATED"),
        userLogin: "prof-route-e",
        displayNameChanged: true,
        phoneChanged: true,
      }),
    );
    const auditCalls = ctx.audit.mock.calls.filter(
      (c) => (c as unknown[])[0] === "platform.profile.updated",
    );
    expect(auditCalls).toHaveLength(1);
    const payload = auditCalls[0][2] as Record<string, unknown>;
    expect(payload).not.toHaveProperty("displayName");
    expect(payload).not.toHaveProperty("phone");
    expect(JSON.stringify(payload)).not.toContain("Ada");
    expect(JSON.stringify(payload)).not.toContain("555-0100");
  });

  it("fails closed: coded 401 with no verified login, coded 503 with the profile store unbound", async () => {
    const ctx = makeCtx(makePorts());
    const anon = await call(ctx, req("GET", "/platform/accounts/profile"));
    expect(anon?.status).toBe(401);
    expect(anon?.body.code).toBe("FAILURE_PROFILE_NOT_SIGNED_IN");
    expect(anon?.body.message).toBe(catalogMessage("FAILURE_PROFILE_NOT_SIGNED_IN"));
    const anonPost = await call(
      ctx,
      req("POST", "/platform/accounts/profile", undefined, {
        idempotencyKey: nextKey(),
        displayName: "Ada",
      }),
    );
    expect(anonPost?.status).toBe(401);
    expect(anonPost?.body.code).toBe("FAILURE_PROFILE_NOT_SIGNED_IN");

    const unbound = makeCtx(makePorts({ profile: null }));
    const get503 = await call(unbound, req("GET", "/platform/accounts/profile", "prof-route-f"));
    expect(get503?.status).toBe(503);
    expect(get503?.body.code).toBe("FAILURE_PROFILE_STORE_UNAVAILABLE");
    expect(get503?.body.message).toBe(catalogMessage("FAILURE_PROFILE_STORE_UNAVAILABLE"));
    const post503 = await call(
      unbound,
      req("POST", "/platform/accounts/profile", "prof-route-f", {
        idempotencyKey: nextKey(),
        displayName: "Ada",
      }),
    );
    expect(post503?.status).toBe(503);
    expect(post503?.body.code).toBe("FAILURE_PROFILE_STORE_UNAVAILABLE");
  });

  it("a store throw fails closed as a coded 503 with no raw error text in the body", async () => {
    const ctx = makeCtx(makePorts({ profile: new ThrowingProfileStore() }));
    const get503 = await call(ctx, req("GET", "/platform/accounts/profile", "prof-route-j"));
    expect(get503?.status).toBe(503);
    expect(get503?.body.code).toBe("FAILURE_PROFILE_STORE_UNAVAILABLE");
    expect(get503?.body.message).toBe(catalogMessage("FAILURE_PROFILE_STORE_UNAVAILABLE"));
    expect(JSON.stringify(get503?.body)).not.toContain("boom");
    const post503 = await call(
      ctx,
      req("POST", "/platform/accounts/profile", "prof-route-j", {
        idempotencyKey: nextKey(),
        displayName: "Ada",
      }),
    );
    expect(post503?.status).toBe(503);
    expect(post503?.body.code).toBe("FAILURE_PROFILE_STORE_UNAVAILABLE");
    expect(JSON.stringify(post503?.body)).not.toContain("boom");
  });
});
