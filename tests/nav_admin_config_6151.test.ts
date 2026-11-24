// @vitest-environment node
/**
 * #6151 S4 — admin config for nav presets and allowances (parts 4, 5, 6-UX).
 *
 * Rules pinned here:
 * - Storage (in-memory adapter contract; the D1 adapter shares the
 *   port): tenant allowance rows (tenant → allowed nav ids),
 *   per-user allow-list rows (user → allowed nav ids + saved-preset
 *   availability), persona-default override rows (persona →
 *   built-in preset key). Unknown nav ids are dropped on write;
 *   the stored lists follow config order.
 * - The tenant-allowance cap is enforced IN THE STORE: a
 *   per-user allow-list write whose ids exceed the tenant's
 *   allowance is refused (FAILURE_NAV_ALLOWLIST_EXCEEDS_ALLOWANCE),
 *   never clipped. No allowance means no cap.
 * - Persona defaults accept built-in preset keys only — a
 *   saved-preset id is rejected (saved presets are per-user).
 * - Endpoint (admin routes + availability narrowing): non-admins
 *   get 403 on every admin route; tenant admins write per-user
 *   rows only for their own tenant's users and cannot write
 *   tenant allowances or persona defaults; the allowance and the
 *   allow-list narrow the availability read for regular users
 *   (admins see the entire menu); a per-user allow-list with
 *   savedPresetsAllowed false hides the user's saved presets and
 *   ignores the active preset; a persona-default edit takes
 *   effect on the next availability call.
 *
 * Harness mirrors the S1 route-test idiom (a Map-backed DO
 * namespace stub, the KV membership store over it, and the
 * in-memory commercial/subscription adapters passed as deps).
 */
import { describe, expect, it } from "vitest";
import {
  InMemoryNavAdminConfigAdapter,
} from "../src/data/inMemoryNavAdminConfigAdapter";
import {
  assertPersonaPresetKey,
  isNavPersona,
  normalizeNavIdList,
} from "../src/data/navAdminConfigPorts";
import { handleNavRoutes } from "../src/server/routes/nav";
import { expandPresetKey } from "../src/client/navPresets";
import { enumerateNavAvailabilityIds } from "../src/client/navConfig";
import { NAV_TAB_PRESETS } from "../src/client/navPresets";
import { InMemoryCommercialAdapter } from "../src/data/inMemoryCommercialAdapter";
import { InMemorySubscriptionAdapter } from "../src/data/inMemorySubscriptionAdapter";
import { InMemoryNavPresetAdapter } from "../src/data/inMemoryNavPresetAdapter";
import { createKvMembershipStore } from "../src/security/iaaaMembershipStore";
import { createMembership, type MembershipStore } from "../src/security/authorization";
import { sessionStore, createSession } from "../src/security/session";
import type { Env } from "../src/types";

describe("nav admin config port — pure helpers (#6151 S4)", () => {
  it("normalizeNavIdList drops unknown ids, dedupes, follows config order", () => {
    const ids = enumerateNavAvailabilityIds();
    expect(ids.length).toBeGreaterThan(0);
    const out = normalizeNavIdList(["order", "no-such-tab", "chat", "order", "data-hub:data-providers"]);
    expect(out).toEqual(
      ids.filter((id) =>
        ["order", "chat", "data-hub:data-providers"].includes(id),
      ),
    );
    expect(normalizeNavIdList([])).toEqual([]);
    expect(normalizeNavIdList(null)).toEqual([]);
    expect(normalizeNavIdList("order")).toEqual([]);
    expect(normalizeNavIdList([42, null])).toEqual([]);
  });

  it("isNavPersona names exactly the four personas", () => {
    for (const persona of ["platform-admin", "tenant-admin", "paid", "non-paid"]) {
      expect(isNavPersona(persona)).toBe(true);
    }
    expect(isNavPersona("member")).toBe(false);
    expect(isNavPersona("")).toBe(false);
    expect(isNavPersona(null)).toBe(false);
  });

  it("assertPersonaPresetKey accepts built-in keys and rejects saved-preset ids", () => {
    for (const key of Object.keys(NAV_TAB_PRESETS)) {
      expect(assertPersonaPresetKey(key)).toBe(key);
    }
    expect(() => assertPersonaPresetKey("preset-abcdef12")).toThrow();
    expect(() => assertPersonaPresetKey("")).toThrow();
    expect(() => assertPersonaPresetKey(null)).toThrow();
  });
});

describe("nav admin config store — in-memory contract (#6151 S4)", () => {
  it("round-trips tenant allowances", async () => {
    const store = new InMemoryNavAdminConfigAdapter();
    expect(await store.getTenantAllowance("tenant-a")).toBeNull();
    expect(await store.listTenantAllowances()).toEqual([]);
    const row = await store.setTenantAllowance(
      "tenant-a",
      ["order", "no-such-tab", "chat"],
      "admin-1",
    );
    expect(row.tenantId).toBe("tenant-a");
    expect(row.allowedIds).toEqual(["order", "chat"]);
    expect(row.updatedBy).toBe("admin-1");
    expect(await store.getTenantAllowance("tenant-a")).toEqual(row);
    const updated = await store.setTenantAllowance("tenant-a", ["order"], "admin-1");
    expect(updated.allowedIds).toEqual(["order"]);
    expect((await store.listTenantAllowances()).map((r) => r.tenantId)).toEqual(["tenant-a"]);
  });

  it("round-trips per-user allow-lists, saved-preset availability included", async () => {
    const store = new InMemoryNavAdminConfigAdapter();
    expect(await store.getUserAllowlist("user-1")).toBeNull();
    const row = await store.setUserAllowlist(
      "user-1",
      { tenantId: "tenant-a", allowedIds: ["order", "chat"], savedPresetsAllowed: false },
      "admin-1",
    );
    expect(row.userId).toBe("user-1");
    expect(row.tenantId).toBe("tenant-a");
    expect(row.allowedIds).toEqual(["order", "chat"]);
    expect(row.savedPresetsAllowed).toBe(false);
    expect(await store.getUserAllowlist("user-1")).toEqual(row);
    // savedPresetsAllowed defaults to true when omitted.
    const row2 = await store.setUserAllowlist(
      "user-2",
      { tenantId: null, allowedIds: ["order"] },
      "admin-1",
    );
    expect(row2.savedPresetsAllowed).toBe(true);
    expect(row2.tenantId).toBeNull();
    expect(
      (await store.listUserAllowlists("tenant-a")).map((r) => r.userId),
    ).toEqual(["user-1"]);
    expect((await store.listUserAllowlists()).map((r) => r.userId)).toEqual([
      "user-1",
      "user-2",
    ]);
  });

  it("refuses a per-user allow-list that exceeds the tenant allowance", async () => {
    const store = new InMemoryNavAdminConfigAdapter();
    await store.setTenantAllowance("tenant-a", ["order", "chat"], "admin-1");
    // Within the allowance: fine.
    await store.setUserAllowlist(
      "user-1",
      { tenantId: "tenant-a", allowedIds: ["order"], savedPresetsAllowed: true },
      "admin-1",
    );
    // One id outside the allowance: refused, never clipped.
    await expect(
      store.setUserAllowlist(
        "user-2",
        { tenantId: "tenant-a", allowedIds: ["order", "stock-hub"], savedPresetsAllowed: true },
        "admin-1",
      ),
    ).rejects.toThrow("FAILURE_NAV_ALLOWLIST_EXCEEDS_ALLOWANCE");
    expect(await store.getUserAllowlist("user-2")).toBeNull();
    // No allowance for the tenant: no cap.
    await store.setUserAllowlist(
      "user-3",
      { tenantId: "tenant-b", allowedIds: ["order", "stock-hub"], savedPresetsAllowed: true },
      "admin-1",
    );
    expect((await store.getUserAllowlist("user-3"))?.allowedIds).toEqual([
      "order",
      "stock-hub",
    ]);
  });

  it("round-trips persona-default overrides and deletes them", async () => {
    const store = new InMemoryNavAdminConfigAdapter();
    expect(await store.getPersonaDefault("paid")).toBeNull();
    const row = await store.setPersonaDefault("paid", "research", "admin-1");
    expect(row.persona).toBe("paid");
    expect(row.presetKey).toBe("research");
    expect(await store.getPersonaDefault("paid")).toEqual(row);
    await expect(store.setPersonaDefault("paid", "preset-abcdef12", "admin-1")).rejects.toThrow();
    expect((await store.getPersonaDefault("paid"))?.presetKey).toBe("research");
    expect(await store.listPersonaDefaults()).toHaveLength(1);
    expect(await store.deletePersonaDefault("paid")).toBe(true);
    expect(await store.getPersonaDefault("paid")).toBeNull();
    expect(await store.deletePersonaDefault("paid")).toBe(false);
  });
});

function makeMemoryDoNamespace() {
  const store = new Map<string, string>();
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const payload = (await request.json()) as {
        op: string;
        key: string;
        value?: string;
      };
      if (payload.op === "get") {
        return Response.json({ ok: true, value: store.get(payload.key) ?? null });
      }
      if (payload.op === "put" && payload.value !== undefined) {
        store.set(payload.key, payload.value);
        return Response.json({ ok: true });
      }
      if (payload.op === "delete") {
        store.delete(payload.key);
        return Response.json({ ok: true });
      }
      if (payload.op === "list") {
        const entries = [...store.entries()]
          .filter(([k]) => k.startsWith(payload.key ?? ""))
          .map(([key, value]) => ({ key, value }));
        return Response.json({ ok: true, entries });
      }
      return new Response("Bad request", { status: 400 });
    },
  };
  return {
    idFromName: () => "singleton" as unknown as DurableObjectId,
    get: () => stub as unknown as DurableObjectStub,
  };
}

interface World {
  env: Env;
  memberships: MembershipStore;
  commercial: InMemoryCommercialAdapter;
  subscriptions: InMemorySubscriptionAdapter;
  adminConfig: InMemoryNavAdminConfigAdapter;
  presets: InMemoryNavPresetAdapter;
}

function makeWorld(): World {
  const env = { SESSION_STORE: makeMemoryDoNamespace() } as unknown as Env;
  return {
    env,
    memberships: createKvMembershipStore(sessionStore(env)),
    commercial: new InMemoryCommercialAdapter(),
    subscriptions: new InMemorySubscriptionAdapter(),
    adminConfig: new InMemoryNavAdminConfigAdapter(),
    presets: new InMemoryNavPresetAdapter(),
  };
}

async function seedMember(
  world: World,
  overrides: {
    internalUserId?: string;
    tenantId?: string;
    role?: string;
    scope?: string;
  } = {},
): Promise<void> {
  const result = await createMembership(world.memberships, {
    internalUserId: overrides.internalUserId ?? "user-1",
    tenantId: overrides.tenantId ?? "tenant-a",
    roleBindings: [
      {
        role: (overrides.role ?? "member") as never,
        scope: (overrides.scope ?? "tenant") as never,
        grantedBy: "seed",
      },
    ],
    createdBy: "seed",
    nowMs: Date.now(),
  });
  if (!result.ok) throw new Error(result.error);
}

async function seedAccount(
  world: World,
  overrides: { login?: string; tier?: string; tierSource?: string } = {},
): Promise<void> {
  await world.commercial.upsertAccount({
    userId: overrides.login ?? "user-1",
    tenantId: "tenant-a",
    tier: overrides.tier ?? "Free",
    tierSource: overrides.tierSource ?? "operator",
  });
}

async function mintSession(
  world: World,
  overrides: { login?: string; internalUserId?: string | null } = {},
): Promise<string> {
  const nowMs = Date.now();
  return createSession(world.env, {
    githubLogin: overrides.login ?? "user-1",
    githubAvatar: "",
    githubName: "User One",
    createdAt: nowMs,
    firstCreatedAt: nowMs,
    ...(overrides.internalUserId === null
      ? {}
      : { internalUserId: overrides.internalUserId ?? "user-1" }),
  });
}

function request(
  world: World,
  path: string,
  method: string,
  sessionId?: string,
  body?: unknown,
) {
  return handleNavRoutes(
    new Request(`https://agent.test${path}`, {
      method,
      ...(sessionId
        ? { headers: { Cookie: `session_id=${sessionId}`, "Content-Type": "application/json" } }
        : {}),
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    world.env,
    new URL(`https://agent.test${path}`),
    path,
    {
      commercial: world.commercial,
      subscriptions: world.subscriptions,
      adminConfig: world.adminConfig,
      presets: world.presets,
    },
  );
}

async function callJson(
  world: World,
  path: string,
  method: string,
  sessionId?: string,
  body?: unknown,
) {
  const res = await request(world, path, method, sessionId, body);
  const data = (await res?.json()) as Record<string, unknown>;
  return { status: res?.status, body: data };
}

async function seedPlatformAdmin(world: World): Promise<string> {
  await seedMember(world);
  await seedMember(world, { role: "platform-admin", scope: "platform" });
  await seedAccount(world, { tier: "Free" });
  return mintSession(world);
}

async function seedTenantAdmin(world: World, tenantId = "tenant-a"): Promise<string> {
  await seedMember(world, { role: "tenant-admin", tenantId });
  await seedAccount(world, { tier: "Free" });
  return mintSession(world);
}

describe("admin-config routes (#6151 S4)", () => {
  it("a non-admin gets 403 on every admin route", async () => {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Free" });
    const sessionId = await mintSession(world);
    for (const [path, method, body] of [
      ["/api/platform/nav-admin/config", "GET", undefined],
      ["/api/platform/nav-admin/tenant-allowance", "PUT", { tenantId: "tenant-a", allowedIds: ["order"] }],
      ["/api/platform/nav-admin/user-allowlist", "PUT", { userId: "user-1", allowedIds: ["order"] }],
      ["/api/platform/nav-admin/persona-default", "PUT", { persona: "paid", presetKey: "research" }],
      ["/api/platform/nav-admin/persona-default/paid", "DELETE", undefined],
    ] as const) {
      const { status, body: data } = await callJson(world, path, method, sessionId, body);
      expect(status).toBe(403);
      expect(data.code).toBe("FAILURE_NAV_ADMIN_FORBIDDEN");
    }
  });

  it("a platform admin reads the empty config, then the written rows", async () => {
    const world = makeWorld();
    const sessionId = await seedPlatformAdmin(world);
    const first = await callJson(world, "/api/platform/nav-admin/config", "GET", sessionId);
    expect(first.status).toBe(200);
    expect(first.body.scope).toBe("platform");
    expect(first.body.allowances).toEqual([]);
    expect(first.body.allowlists).toEqual([]);
    expect(first.body.tenantMembers).toEqual([
      { tenantId: "tenant-a", userIds: ["user-1"] },
    ]);
    expect(
      (first.body.personaDefaults as { persona: string; presetKey: string; overridden: boolean }[]),
    ).toEqual([
      { persona: "platform-admin", presetKey: "alltabs", overridden: false },
      { persona: "tenant-admin", presetKey: "alltabs", overridden: false },
      { persona: "paid", presetKey: "alltabs", overridden: false },
      { persona: "non-paid", presetKey: "alltabs", overridden: false },
    ]);

    const allowance = await callJson(
      world,
      "/api/platform/nav-admin/tenant-allowance",
      "PUT",
      sessionId,
      { tenantId: "tenant-a", allowedIds: ["order", "chat", "no-such-tab"] },
    );
    expect(allowance.status).toBe(200);
    expect(allowance.body.allowance).toMatchObject({ allowedIds: ["order", "chat"] });

    const allowlist = await callJson(
      world,
      "/api/platform/nav-admin/user-allowlist",
      "PUT",
      sessionId,
      { userId: "user-1", allowedIds: ["order"], savedPresetsAllowed: false },
    );
    expect(allowlist.status).toBe(200);
    expect(allowlist.body.allowlist).toMatchObject({
      tenantId: "tenant-a",
      savedPresetsAllowed: false,
    });

    const second = await callJson(world, "/api/platform/nav-admin/config", "GET", sessionId);
    expect(
      (second.body.allowances as { tenantId: string }[]).map((r) => r.tenantId),
    ).toEqual(["tenant-a"]);
    expect(
      (second.body.allowlists as { userId: string }[]).map((r) => r.userId),
    ).toEqual(["user-1"]);
  });

  it("a tenant admin reads only their own tenant and cannot write allowances or persona defaults", async () => {
    const world = makeWorld();
    const sessionId = await seedTenantAdmin(world);
    // user-2 belongs to tenant-a; user-3 belongs to tenant-b.
    await seedMember(world, { internalUserId: "user-2", tenantId: "tenant-a" });
    await seedMember(world, { internalUserId: "user-3", tenantId: "tenant-b" });
    // Another tenant's rows exist (written by the platform admin
    // through the store) — the tenant admin never sees them.
    await world.adminConfig.setTenantAllowance("tenant-b", ["order"], "admin-1");
    await world.adminConfig.setUserAllowlist(
      "user-9",
      { tenantId: "tenant-b", allowedIds: ["order"] },
      "admin-1",
    );
    await world.adminConfig.setTenantAllowance("tenant-a", ["order", "chat"], "admin-1");
    const config = await callJson(world, "/api/platform/nav-admin/config", "GET", sessionId);
    expect(config.status).toBe(200);
    expect(config.body.scope).toBe("tenant");
    expect(config.body.tenantId).toBe("tenant-a");
    expect(
      (config.body.allowances as { tenantId: string }[]).map((r) => r.tenantId),
    ).toEqual(["tenant-a"]);
    expect(config.body.allowlists).toEqual([]);
    // Members are scoped the same way: own tenant only.
    expect(config.body.tenantMembers).toEqual([
      { tenantId: "tenant-a", userIds: ["user-1", "user-2"] },
    ]);

    const allowance = await callJson(
      world,
      "/api/platform/nav-admin/tenant-allowance",
      "PUT",
      sessionId,
      { tenantId: "tenant-a", allowedIds: ["order"] },
    );
    expect(allowance.status).toBe(403);
    const persona = await callJson(
      world,
      "/api/platform/nav-admin/persona-default",
      "PUT",
      sessionId,
      { persona: "paid", presetKey: "research" },
    );
    expect(persona.status).toBe(403);
  });

  it("a tenant admin writes per-user rows only for their own tenant's users", async () => {
    const world = makeWorld();
    const sessionId = await seedTenantAdmin(world);
    // user-2 belongs to tenant-a; user-3 belongs to tenant-b.
    await seedMember(world, { internalUserId: "user-2", tenantId: "tenant-a" });
    await seedMember(world, { internalUserId: "user-3", tenantId: "tenant-b" });
    const own = await callJson(
      world,
      "/api/platform/nav-admin/user-allowlist",
      "PUT",
      sessionId,
      { userId: "user-2", allowedIds: ["order"] },
    );
    expect(own.status).toBe(200);
    expect(
      (own.body.allowlist as { tenantId: string }).tenantId,
    ).toBe("tenant-a");
    const foreign = await callJson(
      world,
      "/api/platform/nav-admin/user-allowlist",
      "PUT",
      sessionId,
      { userId: "user-3", allowedIds: ["order"] },
    );
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe("FAILURE_NAV_ADMIN_FORBIDDEN");
  });

  it("the server refuses a per-user allow-list that exceeds the tenant allowance", async () => {
    const world = makeWorld();
    const sessionId = await seedPlatformAdmin(world);
    await callJson(
      world,
      "/api/platform/nav-admin/tenant-allowance",
      "PUT",
      sessionId,
      { tenantId: "tenant-a", allowedIds: ["order"] },
    );
    const refused = await callJson(
      world,
      "/api/platform/nav-admin/user-allowlist",
      "PUT",
      sessionId,
      { userId: "user-1", allowedIds: ["order", "chat"] },
    );
    expect(refused.status).toBe(403);
    expect(refused.body.code).toBe("FAILURE_NAV_ALLOWLIST_EXCEEDS_ALLOWANCE");
    // Within the allowance: fine.
    const allowed = await callJson(
      world,
      "/api/platform/nav-admin/user-allowlist",
      "PUT",
      sessionId,
      { userId: "user-1", allowedIds: ["order"] },
    );
    expect(allowed.status).toBe(200);
  });

  it("persona defaults validate the key and reset by delete", async () => {
    const world = makeWorld();
    const sessionId = await seedPlatformAdmin(world);
    const bad = await callJson(
      world,
      "/api/platform/nav-admin/persona-default",
      "PUT",
      sessionId,
      { persona: "paid", presetKey: "preset-abcdef12" },
    );
    expect(bad.status).toBe(400);
    const badPersona = await callJson(
      world,
      "/api/platform/nav-admin/persona-default",
      "PUT",
      sessionId,
      { persona: "member", presetKey: "research" },
    );
    expect(badPersona.status).toBe(400);
    const set = await callJson(
      world,
      "/api/platform/nav-admin/persona-default",
      "PUT",
      sessionId,
      { persona: "paid", presetKey: "research" },
    );
    expect(set.status).toBe(200);
    expect(set.body.personaDefault).toMatchObject({
      persona: "paid",
      presetKey: "research",
    });
    const deleted = await callJson(
      world,
      "/api/platform/nav-admin/persona-default/paid",
      "DELETE",
      sessionId,
    );
    expect(deleted.status).toBe(200);
    expect(deleted.body.deleted).toBe(true);
    const deletedAgain = await callJson(
      world,
      "/api/platform/nav-admin/persona-default/paid",
      "DELETE",
      sessionId,
    );
    expect(deletedAgain.body.deleted).toBe(false);
  });
});

describe("availability narrowing (#6151 S4)", () => {
  async function memberWorld(): Promise<{ world: World; sessionId: string }> {
    const world = makeWorld();
    await seedMember(world);
    await seedAccount(world, { tier: "Free" });
    const sessionId = await mintSession(world);
    return { world, sessionId };
  }

  async function availability(world: World, sessionId: string) {
    const res = await request(world, "/api/platform/nav-availability", "GET", sessionId);
    expect(res?.status).toBe(200);
    return (await res?.json()) as Record<string, unknown>;
  }

  it("the tenant allowance narrows a regular user's menu; admins still see all", async () => {
    const { world, sessionId } = await memberWorld();
    await world.adminConfig.setTenantAllowance("tenant-a", ["order", "chat"], "admin-1");
    const body = await availability(world, sessionId);
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["order"]).toBe(true);
    expect(visibleTabs["chat"]).toBe(true);
    expect(visibleTabs["stock-hub"]).toBe(false);
    expect(visibleTabs["options-screener"]).toBe(false);

    // The same allowance does not narrow an admin.
    const adminWorld = makeWorld();
    const adminSession = await seedPlatformAdmin(adminWorld);
    await adminWorld.adminConfig.setTenantAllowance("tenant-a", ["order", "chat"], "admin-1");
    const adminBody = await availability(adminWorld, adminSession);
    expect(
      Object.values(adminBody.visibleTabs as Record<string, boolean>).every((v) => v === true),
    ).toBe(true);
  });

  it("the per-user allow-list narrows on top of the allowance; a regular user sees only allowed presets", async () => {
    const { world, sessionId } = await memberWorld();
    await world.adminConfig.setTenantAllowance(
      "tenant-a",
      ["order", "chat", "stock-hub"],
      "admin-1",
    );
    await world.adminConfig.setUserAllowlist(
      "user-1",
      { tenantId: "tenant-a", allowedIds: ["order"], savedPresetsAllowed: true },
      "admin-1",
    );
    const body = await availability(world, sessionId);
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["order"]).toBe(true);
    expect(visibleTabs["chat"]).toBe(false);
    expect(visibleTabs["stock-hub"]).toBe(false);
    expect(body.availablePresets).toEqual(Object.keys(NAV_TAB_PRESETS));
  });

  it("savedPresetsAllowed false hides saved presets and ignores the active preset", async () => {
    const { world, sessionId } = await memberWorld();
    // The user saved a preset (research) and made it active. The
    // stored map is deliberately a DIFFERENT map (alltabs) than
    // the preset's — that pins the read path's preference: with
    // saved presets allowed the base is the PRESET's map, with
    // them disallowed the base falls back to the stored map.
    const preset = await world.presets.createPreset(
      "user-1",
      "Morning",
      expandPresetKey("research"),
    );
    await world.presets.setState("user-1", {
      activePresetId: preset.id,
      map: expandPresetKey("alltabs"),
    });
    // With saved presets allowed, the active preset is the base
    // and its id is listed.
    const allowed = await availability(world, sessionId);
    expect(allowed.availablePresets).toContain(preset.id);
    expect(
      (allowed.visibleTabs as Record<string, boolean>)["options-screener"],
    ).toBe(true);
    expect((allowed.visibleTabs as Record<string, boolean>)["order"]).toBe(false);
    // With saved presets disallowed, the available list is
    // built-ins only, the active preset is ignored (the base is
    // the stored map, capped by the allow-list), and applying a
    // saved preset is refused outright.
    await world.adminConfig.setUserAllowlist(
      "user-1",
      { tenantId: "tenant-a", allowedIds: ["order", "chat"], savedPresetsAllowed: false },
      "admin-1",
    );
    const body = await availability(world, sessionId);
    expect(body.availablePresets).toEqual(Object.keys(NAV_TAB_PRESETS));
    const visibleTabs = body.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["order"]).toBe(true);
    expect(visibleTabs["chat"]).toBe(true);
    expect(visibleTabs["options-screener"]).toBe(false);
    const apply = await callJson(
      world,
      `/api/platform/nav-presets/${preset.id}/apply`,
      "POST",
      sessionId,
      {},
    );
    expect(apply.status).toBe(403);
    expect(apply.body.code).toBe("FAILURE_NAV_PRESET_NOT_ALLOWED");
  });

  it("a persona-default edit takes effect on the next availability call", async () => {
    const { world, sessionId } = await memberWorld();
    const before = await availability(world, sessionId);
    expect(before.personaDefault).toBe("alltabs");
    await world.adminConfig.setPersonaDefault("non-paid", "research", "admin-1");
    const after = await availability(world, sessionId);
    expect(after.personaDefault).toBe("research");
    const visibleTabs = after.visibleTabs as Record<string, boolean>;
    expect(visibleTabs["options-screener"]).toBe(true);
    expect(visibleTabs["order"]).toBe(false);
    // Deleting the override restores the shipped default.
    await world.adminConfig.deletePersonaDefault("non-paid");
    const restored = await availability(world, sessionId);
    expect(restored.personaDefault).toBe("alltabs");
  });
});
